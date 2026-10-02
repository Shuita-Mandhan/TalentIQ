-- Phase 5 — JD intelligence: extraction as a suggestion layer.
--
-- The model never writes a requirement. It writes SUGGESTIONS, which a recruiter approves, edits
-- or rejects; only approval creates a row in job_requirements, and that row is an ordinary
-- requirement from then on. Two tables keep that separation structural rather than conventional:
-- there is no path from an extraction to a requirement that does not pass through a person.
--
-- Re-running analysis is additive by construction. A run owns its own suggestions, so a second run
-- cannot touch the first one's work or anything already approved - the recruiter simply has a new
-- set to consider.
--
-- Everything is organization-scoped the same way jobs are: composite (id, organization_id) keys,
-- so a suggestion against another organization's job is unrepresentable. Nothing here carries any
-- authority of its own - the policies require exactly the jobs.view and jobs.manage a recruiter
-- already needed, and AI-originated rows get no privilege whatsoever.
--
-- SQLSTATEs, continuing the project convention:
--   42501 insufficient_privilege   P0002 not found   22023 invalid identifiers
--   TQ010 archived jobs are immutable
--   TQ011 suggestion is not awaiting review

-- =============================================================================================
-- analysis runs
-- =============================================================================================

create table public.job_description_analyses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  job_id uuid not null,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  -- Which provider answered, so a result can be understood later. Never a credential.
  provider text not null check (char_length(btrim(provider)) between 1 and 60),
  model text not null check (char_length(btrim(model)) between 1 and 120),
  -- The job description as supplied. Kept so a failed run can be retried without retyping, and so
  -- a recruiter can see what a suggestion was drawn from.
  source_text text not null check (char_length(btrim(source_text)) between 40 and 20000),
  -- A sanitized reason, written by the application. Provider internals never reach this column.
  error text check (error is null or char_length(error) <= 500),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (job_id, organization_id)
    references public.jobs (id, organization_id) on delete cascade,
  unique (id, organization_id)
);

create index job_description_analyses_job_idx
  on public.job_description_analyses (job_id, created_at desc);

-- =============================================================================================
-- suggestions
--
-- The same vocabulary as job_requirements, deliberately: approving a suggestion copies fields
-- across without translation, and there is no second taxonomy to keep in step.
-- =============================================================================================

create table public.job_requirement_suggestions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  analysis_id uuid not null,
  job_id uuid not null,
  category text not null default 'other'
    check (category in ('skill', 'experience', 'education', 'certification', 'language', 'other')),
  requirement text not null check (char_length(btrim(requirement)) between 1 and 500),
  importance text not null default 'required' check (importance in ('required', 'preferred')),
  weight numeric(4, 2) not null default 1 check (weight >= 0 and weight <= 10),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  -- Set when approval creates the requirement, which is what makes approving twice a no-op.
  approved_requirement_id uuid references public.job_requirements (id) on delete set null,
  -- Advisory only: suggestions sharing a group looked alike under deterministic normalization.
  -- Nothing is merged on this basis; a person decides.
  duplicate_group integer check (duplicate_group is null or duplicate_group >= 0),
  display_order integer not null default 0 check (display_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (analysis_id, organization_id)
    references public.job_description_analyses (id, organization_id) on delete cascade,
  foreign key (job_id, organization_id)
    references public.jobs (id, organization_id) on delete cascade
);

create index job_requirement_suggestions_analysis_idx
  on public.job_requirement_suggestions (analysis_id, display_order);
create index job_requirement_suggestions_job_status_idx
  on public.job_requirement_suggestions (job_id, status);

create trigger set_updated_at before update on public.job_requirement_suggestions
  for each row execute function private.set_updated_at();

-- =============================================================================================
-- archived jobs stay frozen
--
-- An archived job is a record. It cannot be analyzed again and its suggestions cannot move, for
-- the same reason its requirements cannot: later phases will refer back to it.
-- =============================================================================================

create or replace function private.guard_archived_job_intelligence()
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

create trigger guard_archived_job_analyses
  before insert or update or delete on public.job_description_analyses
  for each row execute function private.guard_archived_job_intelligence();

create trigger guard_archived_job_suggestions
  before insert or update or delete on public.job_requirement_suggestions
  for each row execute function private.guard_archived_job_intelligence();

revoke execute on function private.guard_archived_job_intelligence()
  from public, anon, authenticated;

-- =============================================================================================
-- approval
--
-- Creating the requirement and marking the suggestion must happen together, or a crash between
-- them leaves a requirement nobody can trace or a suggestion that claims an approval that never
-- landed. One function, one transaction.
--
-- Deliberately NOT security definer: it runs as the caller, so the existing policies decide
-- everything. jobs.manage is required to insert the requirement and to update the suggestion, the
-- archived trigger still fires, and the composite scoping still confines it to one organization.
-- An AI-originated requirement is created through the same policy as a typed one.
--
-- Idempotent: approving twice returns the requirement the first approval created.
-- =============================================================================================

create or replace function public.approve_job_requirement_suggestion(
  target_organization_id uuid,
  target_suggestion_id uuid,
  final_requirement text default null,
  final_category text default null,
  final_importance text default null,
  final_weight numeric default null
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  suggestion public.job_requirement_suggestions;
  next_order integer;
  created_id uuid;
begin
  select * into suggestion
  from public.job_requirement_suggestions s
  where s.id = target_suggestion_id and s.organization_id = target_organization_id
  for update;

  if suggestion.id is null then
    raise exception 'suggestion not found' using errcode = 'no_data_found';
  end if;

  -- Already approved: hand back what that approval created rather than creating a second one.
  if suggestion.status = 'approved' and suggestion.approved_requirement_id is not null then
    return suggestion.approved_requirement_id;
  end if;
  if suggestion.status <> 'pending' then
    raise exception 'this suggestion is not awaiting review' using errcode = 'TQ011';
  end if;

  select coalesce(max(r.display_order) + 1, 0) into next_order
  from public.job_requirements r where r.job_id = suggestion.job_id;

  -- The recruiter's edits win where they made any; otherwise the suggestion stands as extracted.
  -- source is 'ai' for provenance only: nothing reads it to decide anything.
  insert into public.job_requirements (
    organization_id, job_id, category, requirement, importance, weight, source, display_order
  )
  values (
    suggestion.organization_id,
    suggestion.job_id,
    coalesce(nullif(btrim(final_category), ''), suggestion.category),
    coalesce(nullif(btrim(final_requirement), ''), suggestion.requirement),
    coalesce(nullif(btrim(final_importance), ''), suggestion.importance),
    coalesce(final_weight, suggestion.weight),
    'ai',
    next_order
  )
  returning id into created_id;

  update public.job_requirement_suggestions s
  set status = 'approved', approved_requirement_id = created_id
  where s.id = suggestion.id;

  return created_id;
end;
$$;

revoke execute on function public.approve_job_requirement_suggestion(uuid, uuid, text, text, text, numeric)
  from public, anon;
grant execute on function public.approve_job_requirement_suggestion(uuid, uuid, text, text, text, numeric)
  to authenticated, service_role;

-- =============================================================================================
-- row level security
--
-- The same two keys the rest of the job module uses, and no others. Platform administration is
-- absent here exactly as it is on jobs: a job description is the tenant's business data.
-- =============================================================================================

alter table public.job_description_analyses enable row level security;
alter table public.job_requirement_suggestions enable row level security;

create policy "analyses: jobs.view can read"
  on public.job_description_analyses for select to authenticated
  using (private.has_organization_permission(organization_id, 'jobs.view'));

create policy "analyses: jobs.manage can create"
  on public.job_description_analyses for insert to authenticated
  with check (private.has_organization_permission(organization_id, 'jobs.manage'));

create policy "analyses: jobs.manage can update"
  on public.job_description_analyses for update to authenticated
  using (private.has_organization_permission(organization_id, 'jobs.manage'))
  with check (private.has_organization_permission(organization_id, 'jobs.manage'));

create policy "suggestions: jobs.view can read"
  on public.job_requirement_suggestions for select to authenticated
  using (private.has_organization_permission(organization_id, 'jobs.view'));

create policy "suggestions: jobs.manage can create"
  on public.job_requirement_suggestions for insert to authenticated
  with check (private.has_organization_permission(organization_id, 'jobs.manage'));

create policy "suggestions: jobs.manage can update"
  on public.job_requirement_suggestions for update to authenticated
  using (private.has_organization_permission(organization_id, 'jobs.manage'))
  with check (private.has_organization_permission(organization_id, 'jobs.manage'));

-- =============================================================================================
-- privileges
--
-- No DELETE on either table: a run and its suggestions are the record of what was considered.
-- Rejecting is a status, not an erasure, which is also what stops a rejected suggestion from
-- quietly coming back.
-- =============================================================================================

revoke all on public.job_description_analyses, public.job_requirement_suggestions
  from anon, authenticated;
grant select, insert, update on public.job_description_analyses to authenticated;
grant select, insert, update on public.job_requirement_suggestions to authenticated;
