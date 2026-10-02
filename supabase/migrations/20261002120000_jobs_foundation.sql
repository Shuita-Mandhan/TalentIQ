-- Phase 4 — job management foundation.
--
-- The first recruitment domain. Everything here is organization-scoped the same way the access
-- tables are: a composite (id, organization_id) key so child rows can be tied to a parent AND an
-- organization in one foreign key, which makes a cross-organization reference unrepresentable
-- rather than merely checked.
--
-- Requirements are the editable structure a later JD Intelligence phase will populate. They carry
-- a `source` so a machine-written requirement is distinguishable from a recruiter's, but nothing
-- about that gives the machine authority: every requirement is editable and removable by whoever
-- holds jobs.manage, and nothing reads `source` to decide anything.
--
-- SQLSTATEs, continuing the project convention:
--   42501 insufficient_privilege   P0002 not found   22023 invalid identifiers
--   TQ009 invalid job status transition
--   TQ010 archived jobs are immutable

-- =============================================================================================
-- permission catalog
-- =============================================================================================

insert into public.permissions (key, name, description, category) values
  ('jobs.view',   'View jobs',   'See jobs and the requirements defined for them.',             'jobs'),
  ('jobs.manage', 'Manage jobs', 'Create and edit jobs, change their status and archive them, and edit their requirements.', 'jobs')
on conflict (key) do nothing;

-- Provisioning gave each new organization's Organization Admin a hardcoded list of six keys and
-- asserted exactly six rows, so a seventh permission would have been silently withheld from every
-- organization created afterwards. The system role is the organization's full administrator by
-- definition, so it now takes the catalog as it stands and asserts against the catalog rather than
-- a number written in 2026. Nothing else about provisioning changes.
create or replace function private.provision_organization_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  admin_role_id uuid;
  permission_count integer;
  catalog_count integer;
begin
  insert into public.roles (organization_id, name, description, is_system)
  values (
    new.id,
    'Organization Admin',
    'Manages the organization, its members and its roles.',
    true
  )
  returning id into admin_role_id;

  insert into public.role_permissions (role_id, organization_id, permission_key)
  select admin_role_id, new.id, p.key from public.permissions p;

  get diagnostics permission_count = row_count;
  select count(*) into catalog_count from public.permissions;

  -- Two separate things are being checked. That the administrator received the catalog as it
  -- stands, so a permission added later reaches every organization created afterwards without
  -- another migration. And that the catalog is actually complete - a count alone cannot tell a
  -- full catalog from a truncated one, so the keys the application cannot work without are named.
  -- Provisioning an organization whose administrator silently lacks one of these would be a
  -- failure that only surfaces much later.
  if permission_count <> catalog_count
     or catalog_count = 0
     or exists (
       select 1
       from (values
         ('organization.view'), ('organization.update'),
         ('members.view'), ('members.manage'),
         ('roles.view'), ('roles.manage'),
         ('jobs.view'), ('jobs.manage')
       ) as required(key)
       where required.key not in (select p.key from public.permissions p)
     ) then
    raise exception 'Organization default permission catalog is incomplete';
  end if;

  return new;
end;
$$;

revoke execute on function private.provision_organization_defaults()
  from public, anon, authenticated, service_role;

-- Existing organizations: the system role gains the new keys, and nothing else does. A custom role
-- an administrator built stays exactly as they built it - a new capability is theirs to grant, not
-- something that appears in their roles overnight.
insert into public.role_permissions (role_id, organization_id, permission_key)
select r.id, r.organization_id, granted.key
from public.roles r
cross join (values ('jobs.view'), ('jobs.manage')) as granted(key)
where r.is_system
on conflict (role_id, permission_key) do nothing;

-- =============================================================================================
-- jobs
-- =============================================================================================

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 160),
  description text check (description is null or char_length(description) <= 20000),
  status text not null default 'draft'
    check (status in ('draft', 'open', 'paused', 'closed', 'archived')),
  employment_type text
    check (employment_type is null or employment_type in
      ('full_time', 'part_time', 'contract', 'internship', 'temporary')),
  work_mode text check (work_mode is null or work_mode in ('on_site', 'hybrid', 'remote')),
  location text check (location is null or char_length(btrim(location)) between 1 and 160),
  department text check (department is null or char_length(btrim(department)) between 1 and 120),
  openings integer not null default 1 check (openings between 1 and 10000),
  application_deadline date,
  -- Who opened the role, kept for provenance. A departed user must not take the job with them, so
  -- this releases rather than cascades.
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Lets child tables reference a job together with its organization.
  unique (id, organization_id)
);

create index jobs_organization_status_idx on public.jobs (organization_id, status);
create index jobs_organization_updated_idx on public.jobs (organization_id, updated_at desc);

create trigger set_updated_at before update on public.jobs
  for each row execute function private.set_updated_at();

-- =============================================================================================
-- job requirements
-- =============================================================================================

create table public.job_requirements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  job_id uuid not null,
  category text not null default 'other'
    check (category in ('skill', 'experience', 'education', 'certification', 'language', 'other')),
  requirement text not null check (char_length(btrim(requirement)) between 1 and 500),
  importance text not null default 'required' check (importance in ('required', 'preferred')),
  -- Carried for the matching phase to consume; nothing scores anything yet.
  weight numeric(4, 2) not null default 1 check (weight >= 0 and weight <= 10),
  -- Where the text came from. Descriptive only: no policy, function or constraint reads it, so a
  -- machine-written requirement has exactly the standing of a typed one.
  source text not null default 'manual' check (source in ('manual', 'ai')),
  display_order integer not null default 0 check (display_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The integrity that matters: a requirement names a job AND an organization in one key, so a
  -- requirement against another organization's job cannot be written at all.
  foreign key (job_id, organization_id)
    references public.jobs (id, organization_id) on delete cascade
);

create index job_requirements_job_idx on public.job_requirements (job_id, display_order);
create index job_requirements_organization_idx on public.job_requirements (organization_id);

create trigger set_updated_at before update on public.job_requirements
  for each row execute function private.set_updated_at();

-- =============================================================================================
-- lifecycle
--
-- draft -> open | archived
-- open  -> paused | closed
-- paused-> open | closed
-- closed-> archived
-- archived is terminal, and an archived row is frozen outright: later phases will hang candidates
-- and screening results off these rows, so the history they refer to must stop moving.
--
-- Operators (no JWT subject: SQL editor, service role) are exempt, exactly as the organization and
-- system-role guards already are.
-- =============================================================================================

create or replace function private.guard_job_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if old.status = 'archived' then
    raise exception 'archived jobs cannot be modified' using errcode = 'TQ010';
  end if;

  if new.status is distinct from old.status
     and not (old.status, new.status) in (
       ('draft', 'open'), ('draft', 'archived'),
       ('open', 'paused'), ('open', 'closed'),
       ('paused', 'open'), ('paused', 'closed'),
       ('closed', 'archived')
     ) then
    raise exception 'a % job cannot become %', old.status, new.status using errcode = 'TQ009';
  end if;

  return new;
end;
$$;

create trigger guard_job_status before update on public.jobs
  for each row execute function private.guard_job_status();

-- A requirement is part of the job's record, so it freezes with it.
create or replace function private.guard_archived_job_requirements()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  job_status text;
begin
  if auth.uid() is null then
    return coalesce(new, old);
  end if;
  select j.status into job_status
  from public.jobs j where j.id = coalesce(new.job_id, old.job_id);
  if job_status = 'archived' then
    raise exception 'archived jobs cannot be modified' using errcode = 'TQ010';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger guard_archived_job_requirements
  before insert or update or delete on public.job_requirements
  for each row execute function private.guard_archived_job_requirements();

revoke execute on function
  private.guard_job_status(), private.guard_archived_job_requirements()
from public, anon, authenticated;

-- =============================================================================================
-- row level security
--
-- Platform administration is deliberately absent from these policies. The control plane inspects
-- the shape of a tenant - its organizations, memberships and roles - and the existing policies on
-- those tables reflect that. A job description is the tenant's own business data, not control-plane
-- information, so platform status grants no sight of it: the only way in is a membership carrying
-- jobs.view, which a platform admin can hold only by being given one.
-- =============================================================================================

alter table public.jobs enable row level security;
alter table public.job_requirements enable row level security;

create policy "jobs: jobs.view can read"
  on public.jobs for select to authenticated
  using (private.has_organization_permission(organization_id, 'jobs.view'));

create policy "jobs: jobs.manage can create"
  on public.jobs for insert to authenticated
  with check (private.has_organization_permission(organization_id, 'jobs.manage'));

-- The organization is fixed on both sides, so an update can never carry a job to another tenant.
create policy "jobs: jobs.manage can update"
  on public.jobs for update to authenticated
  using (private.has_organization_permission(organization_id, 'jobs.manage'))
  with check (private.has_organization_permission(organization_id, 'jobs.manage'));

create policy "job_requirements: jobs.view can read"
  on public.job_requirements for select to authenticated
  using (private.has_organization_permission(organization_id, 'jobs.view'));

create policy "job_requirements: jobs.manage can create"
  on public.job_requirements for insert to authenticated
  with check (private.has_organization_permission(organization_id, 'jobs.manage'));

create policy "job_requirements: jobs.manage can update"
  on public.job_requirements for update to authenticated
  using (private.has_organization_permission(organization_id, 'jobs.manage'))
  with check (private.has_organization_permission(organization_id, 'jobs.manage'));

create policy "job_requirements: jobs.manage can delete"
  on public.job_requirements for delete to authenticated
  using (private.has_organization_permission(organization_id, 'jobs.manage'));

-- =============================================================================================
-- privileges
--
-- Jobs are archived, never deleted: later phases will refer back to them, so DELETE is withheld
-- from the application entirely rather than guarded. Requirements are ordinary editable content
-- and may be removed.
-- =============================================================================================

revoke all on public.jobs, public.job_requirements from anon, authenticated;
grant select, insert, update on public.jobs to authenticated;
grant select, insert, update, delete on public.job_requirements to authenticated;
