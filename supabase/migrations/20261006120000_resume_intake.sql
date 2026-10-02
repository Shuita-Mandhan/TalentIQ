-- Phase 7 — resume intake.
--
-- The candidate-document side of the system begins here, and it begins deliberately shallow: a
-- resume is a FILE that belongs to a job. Nothing in this migration knows a candidate's name, and
-- nothing may infer one. A later phase will read what is inside these documents; until it does, the
-- file is the whole of the intake record and its only identity is its checksum.
--
-- Two things carry the authorization, not one:
--   * public.job_resumes  - the metadata, under the same (id, organization_id) composite-key
--     discipline as job_requirements, so a resume against another organization's job cannot be
--     written at all.
--   * storage.objects     - the bytes, in a PRIVATE bucket whose policies resolve the owning job
--     from the object's own path and then ask the same permission catalog. The UI hiding a button
--     is not a boundary; these two are.
--
-- No new permission key. Reading resumes is jobs.view, changing them is jobs.manage: a resume is
-- part of a job's record, so it is governed by the keys that govern the job.
--
-- SQLSTATEs, continuing the project convention:
--   42501 insufficient_privilege   23505 duplicate   23514 out of range
--   TQ010 archived jobs are immutable

-- =============================================================================================
-- private bucket
--
-- Never public. The size limit is stated in three places on purpose: Storage refuses an oversized
-- body before it is stored, the check constraint below refuses metadata that disagrees, and
-- MAX_RESUME_BYTES in frontend/src/lib/resumes/types.ts refuses it before a byte leaves the
-- browser. The application constant is the one a developer edits; the other two must be moved to
-- match it. 10 MiB sits far below the Supabase project-level ceiling, so the bucket limit binds.
-- =============================================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'resumes',
  'resumes',
  false,
  10485760,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
-- If a bucket of this name somehow already exists, it is forced private and narrowed rather than
-- left as whoever created it left it.
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- =============================================================================================
-- intake records
-- =============================================================================================

create table public.job_resumes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  job_id uuid not null,
  -- The batch this arrived in: a grouping label for the intake history and nothing else. There is
  -- no batches table, no foreign key and no authorization meaning, because a batch is something
  -- that happens in a browser over thirty seconds, not something the system needs to remember.
  -- Null for a single upload made outside a batch.
  batch_id uuid,
  -- Where the bytes are. Server-chosen, never accepted from a client, and pinned to this row's own
  -- organization and job by the constraint below, so metadata cannot point into another tenant's
  -- prefix even if every check above it were bypassed.
  storage_path text not null unique check (char_length(storage_path) between 1 and 1024),
  -- What the recruiter's filesystem called it. Display only: a file named John_Smith.pdf does not
  -- make a candidate named John Smith, and nothing here or above reads this to decide anything.
  original_filename text not null check (char_length(btrim(original_filename)) between 1 and 255),
  content_type text not null check (content_type in (
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  -- SHA-256 of the stored bytes, lowercase hex. The only identity a resume has in this phase, and
  -- the whole of the duplicate rule: no name, email or phone is compared, because nothing has read
  -- the document.
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  -- Who brought it in. A departed recruiter must not take the applications with them.
  uploaded_by uuid references auth.users (id) on delete set null,
  -- A row exists only once the bytes are stored and inspected, so this IS the upload time.
  created_at timestamptz not null default now(),
  foreign key (job_id, organization_id)
    references public.jobs (id, organization_id) on delete cascade,
  -- The same file is the same resume for the same job: uploading it again is a duplicate, not a
  -- second applicant. Scoped to the job, so one person applying to two roles is two intakes, which
  -- is the truth, and is why this is deliberately not scoped to the organization.
  constraint job_resumes_file_unique_per_job unique (job_id, checksum),
  -- uuids contain no LIKE metacharacters, so this comparison is literal.
  constraint job_resumes_storage_path_scope check (
    storage_path like organization_id::text || '/' || job_id::text || '/resumes/%'
  )
);

create index job_resumes_job_idx on public.job_resumes (job_id, created_at desc);
create index job_resumes_organization_idx on public.job_resumes (organization_id);
create index job_resumes_batch_idx on public.job_resumes (batch_id) where batch_id is not null;

-- No set_updated_at trigger and no updated_at column: an intake record states that a particular
-- file was received, and that does not change. It is created or it is removed. UPDATE is withheld
-- from the application entirely below, the same way DELETE is withheld from jobs.

-- =============================================================================================
-- archived jobs are frozen
--
-- Same rule and same SQLSTATE as job_requirements: an archived job keeps its record so later
-- phases can refer back to it, which means the record must stop moving. Reads stay open.
-- Operators (no JWT subject: SQL editor, service role) are exempt, exactly as the existing
-- guards are.
-- =============================================================================================

create or replace function private.guard_archived_job_resumes()
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

create trigger guard_archived_job_resumes
  before insert or delete on public.job_resumes
  for each row execute function private.guard_archived_job_resumes();

revoke execute on function private.guard_archived_job_resumes()
  from public, anon, authenticated;

-- =============================================================================================
-- row level security
--
-- Platform administration is absent here for the same reason it is absent from jobs: an applicant's
-- resume is the tenant's own confidential data, not control-plane information. The only way in is a
-- membership carrying the key.
-- =============================================================================================

alter table public.job_resumes enable row level security;

create policy "job_resumes: jobs.view can read"
  on public.job_resumes for select to authenticated
  using (private.has_organization_permission(organization_id, 'jobs.view'));

create policy "job_resumes: jobs.manage can create"
  on public.job_resumes for insert to authenticated
  with check (private.has_organization_permission(organization_id, 'jobs.manage'));

create policy "job_resumes: jobs.manage can remove"
  on public.job_resumes for delete to authenticated
  using (private.has_organization_permission(organization_id, 'jobs.manage'));

-- =============================================================================================
-- storage authorization
--
-- An object's path IS its claim about which job it belongs to:
--
--   <organization_id>/<job_id>/resumes/<intake uuid>/<safe filename>
--
-- so the policies parse that claim and verify it against the jobs table and the permission
-- catalog. A path naming an organization the caller is not in, a job that does not exist, or a job
-- that lives in a different organization than the path's first segment resolves to no row and is
-- refused.
--
-- The fourth segment is a fresh uuid per intake, which is what lets two applicants both send
-- "resume.pdf": the filename is never the key.
-- =============================================================================================

-- A cast that cannot raise. Needed because a policy runs over whatever path exists, including
-- paths this application never wrote, and 'not-a-uuid'::uuid would error instead of denying.
create or replace function private.safe_uuid(value text)
returns uuid
language sql
immutable
parallel safe
-- Pinned like every other private function, even though this one reads nothing: the project's own
-- hardening check asserts that no private function is left resolving names at call time.
set search_path = ''
as $$
  select case
    when value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then value::uuid
  end;
$$;

-- security definer because jobs.manage does not imply jobs.view: whether the job exists and
-- whether it is archived must be readable in order to decide a write, even for someone who cannot
-- list jobs. The permission is then asked for explicitly, so this grants sight of nothing by
-- itself - it answers one yes/no question about one path.
create or replace function private.can_read_job_resume_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.jobs j
    where j.organization_id = private.safe_uuid(split_part(object_name, '/', 1))
      and j.id = private.safe_uuid(split_part(object_name, '/', 2))
      and split_part(object_name, '/', 3) = 'resumes'
      and private.has_organization_permission(j.organization_id, 'jobs.view')
  );
$$;

-- Writing additionally requires the job to be live. An archived job's resumes stay readable and
-- stop being removable, which is the same bargain job_requirements makes.
create or replace function private.can_write_job_resume_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.jobs j
    where j.organization_id = private.safe_uuid(split_part(object_name, '/', 1))
      and j.id = private.safe_uuid(split_part(object_name, '/', 2))
      and split_part(object_name, '/', 3) = 'resumes'
      and j.status <> 'archived'
      and private.has_organization_permission(j.organization_id, 'jobs.manage')
  );
$$;

revoke execute on function
  private.safe_uuid(text),
  private.can_read_job_resume_object(text),
  private.can_write_job_resume_object(text)
from public;

-- Only the two the storage policies name are reachable by the querying role. safe_uuid is granted
-- to nobody: it is called from inside those two, which are security definer, so it runs as the
-- owner there and needs no privilege of its own. The smallest surface that works.
grant execute on function
  private.can_read_job_resume_object(text),
  private.can_write_job_resume_object(text)
to authenticated, service_role;

drop policy if exists "resumes: jobs.view can read" on storage.objects;
drop policy if exists "resumes: jobs.manage can upload" on storage.objects;
drop policy if exists "resumes: jobs.manage can remove" on storage.objects;

create policy "resumes: jobs.view can read"
  on storage.objects for select to authenticated
  using (bucket_id = 'resumes' and private.can_read_job_resume_object(name));

create policy "resumes: jobs.manage can upload"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'resumes' and private.can_write_job_resume_object(name));

create policy "resumes: jobs.manage can remove"
  on storage.objects for delete to authenticated
  using (bucket_id = 'resumes' and private.can_write_job_resume_object(name));

-- Deliberately no UPDATE policy. An uploaded resume is never overwritten, moved or renamed in
-- place: a second upload of the same file is reported as a duplicate and the original is left
-- exactly as it was. Without this policy an attempt to upsert over an existing object is refused by
-- the database, rather than only by a code path somebody could forget to write.

-- =============================================================================================
-- privileges
--
-- No UPDATE: see the note on the table. Jobs still have no DELETE, so a job's resumes go away by
-- being removed one at a time, or with the organization cascade.
-- =============================================================================================

revoke all on public.job_resumes from anon, authenticated;
grant select, insert, delete on public.job_resumes to authenticated;
