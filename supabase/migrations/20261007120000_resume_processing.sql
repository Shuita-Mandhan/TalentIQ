-- Phase 8 — resume processing and candidate profiles.
--
-- Phase 7 brought documents in. This turns one of those documents into something a recruiter can
-- read: extracted text, a structured profile, and - the part that matters most - evidence for every
-- fact, quoted from the resume itself.
--
-- Four tables, and the division between them is deliberate:
--
--   candidates          a person, scoped to the organization. Reused across jobs.
--   job_applications    that person against one job. The many-to-many Phase 8 needs.
--   resume_processings  one ATTEMPT at reading one resume. Attempts accumulate; none is destroyed.
--   candidate_evidence  one supporting quote for one fact, with the application's own verdict on
--                       whether that quote actually appears in the document.
--
-- The structured profile is JSONB because its shape genuinely varies - a resume may list no
-- projects and nine roles. Evidence is NOT JSONB, because evidence is the thing that has to be
-- inspectable, countable and trustworthy, and because `quote_verified` is a column the APPLICATION
-- writes after checking the quote against the extracted text. A model asserting its own evidence is
-- not evidence.
--
-- Identity is deterministic or it is absent. There is exactly one unique key on a candidate -
-- normalized email - and there is no lookup by name anywhere in this file, so two people called
-- J. Smith can never be merged by anything here. A phone that points at a candidate holding a
-- different email is a CONFLICT, not a match.
--
-- No new permission key. Reading is jobs.view, processing is jobs.manage: a resume's profile is
-- part of a job's record.
--
-- SQLSTATEs, continuing the project convention:
--   42501 insufficient_privilege   P0002 not found   22023 invalid identifiers   23505 duplicate
--   TQ010 archived jobs are immutable
--   TQ012 this resume has already been processed successfully
--   TQ013 this resume is already being processed

-- =============================================================================================
-- a composite key Phase 7 did not need yet
--
-- job_resumes has id as its primary key, which was enough while nothing referenced it. A processing
-- attempt has to name a resume AND an organization in one foreign key, the way every other child
-- table here does, so that an attempt against another tenant's resume is unrepresentable rather
-- than merely checked. Additive: id is already unique, so this adds a key, not a restriction.
-- =============================================================================================

alter table public.job_resumes
  add constraint job_resumes_id_organization_key unique (id, organization_id);

-- =============================================================================================
-- candidates
--
-- A person as this organization knows them, assembled only from what a resume actually said.
-- Every column is nullable because a resume may omit anything, and an omission is not a statement
-- that the candidate lacks it.
-- =============================================================================================

create table public.candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  full_name text check (full_name is null or char_length(btrim(full_name)) between 1 and 200),
  -- Normalized to lowercase by the application before it arrives. The one deterministic identity.
  email text check (email is null or char_length(email) between 3 and 320),
  -- Digits and a leading +, normalized by the application. A lookup key, never a unique one: two
  -- people can share a household number, and refusing the second of them would be a bug.
  phone text check (phone is null or char_length(phone) between 5 and 32),
  location text check (location is null or char_length(btrim(location)) between 1 and 200),
  headline text check (headline is null or char_length(btrim(headline)) between 1 and 300),
  summary text check (summary is null or char_length(summary) <= 4000),
  linkedin_url text check (linkedin_url is null or char_length(linkedin_url) <= 500),
  website_url text check (website_url is null or char_length(website_url) <= 500),
  -- How certain the system is that this record is one person.
  --   resolved    reached through an exact normalized email, or a phone with nothing contradicting
  --   unresolved  the resume gave nothing deterministic; the record stands alone on purpose
  --   conflicted  something deterministic disagreed and a person must decide
  identity_state text not null default 'unresolved'
    check (identity_state in ('resolved', 'unresolved', 'conflicted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Lets applications reference a candidate together with its organization.
  unique (id, organization_id)
);

-- The whole of deterministic identity reuse. Partial, so the many candidates without an email do
-- not collide with each other on null.
create unique index candidates_organization_email_key
  on public.candidates (organization_id, email) where email is not null;
-- A lookup, deliberately not unique.
create index candidates_organization_phone_idx
  on public.candidates (organization_id, phone) where phone is not null;
create index candidates_organization_created_idx
  on public.candidates (organization_id, created_at desc);
-- There is deliberately NO index or constraint on full_name. Nothing in this schema can find a
-- candidate by name, which is the structural reason name-only merging cannot happen.

create trigger set_updated_at before update on public.candidates
  for each row execute function private.set_updated_at();

-- =============================================================================================
-- applications
--
-- One person against one job. A candidate may hold many of these, which is the point: somebody
-- applying to a second role is a second application, never a second person.
-- =============================================================================================

create table public.job_applications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  job_id uuid not null,
  candidate_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (job_id, organization_id)
    references public.jobs (id, organization_id) on delete cascade,
  foreign key (candidate_id, organization_id)
    references public.candidates (id, organization_id) on delete cascade,
  -- Processing the same person's resume again finds this row instead of making another.
  constraint job_applications_one_per_candidate unique (job_id, candidate_id),
  unique (id, organization_id)
);

create index job_applications_job_idx on public.job_applications (job_id, created_at desc);
create index job_applications_candidate_idx on public.job_applications (candidate_id);

create trigger set_updated_at before update on public.job_applications
  for each row execute function private.set_updated_at();

-- =============================================================================================
-- processing attempts
--
-- One row per attempt at reading one resume. Attempts are never overwritten and never deleted, so
-- a failure stays inspectable after the retry that followed it. `is_current` names the attempt the
-- interface shows; the partial unique index below makes "exactly one current attempt per resume"
-- a fact about the database rather than a convention the application tries to keep.
-- =============================================================================================

create table public.resume_processings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  job_id uuid not null,
  resume_id uuid not null,
  attempt integer not null default 1 check (attempt >= 1),
  -- The attempt the interface reads. Set false when a later attempt supersedes it.
  is_current boolean not null default true,
  --   waiting       created but not started
  --   processing    in flight
  --   succeeded     text extracted, profile parsed, identity deterministic
  --   needs_review  usable but something needs a person: no extractable text, or unresolved or
  --                 conflicting identity
  --   failed        could not be completed
  status text not null default 'waiting'
    check (status in ('waiting', 'processing', 'succeeded', 'needs_review', 'failed')),
  -- Which extractor read the document, and the version of it, so a future parser change is
  -- identifiable in rows written before it.
  parser text not null check (parser in ('pdf', 'docx')),
  parser_version text not null check (char_length(btrim(parser_version)) between 1 and 40),
  -- A deterministic key for "this document, read this way, by this schema". Changing an extractor
  -- or the profile schema changes it, which is how stale results are recognised later.
  processing_version text not null check (char_length(btrim(processing_version)) between 1 and 120),
  -- Null until a provider has actually answered. Never a credential.
  provider text check (provider is null or char_length(btrim(provider)) between 1 and 60),
  model text check (model is null or char_length(btrim(model)) between 1 and 120),
  -- The normalized text the profile was drawn from, kept so every quote can be checked against it
  -- and so a recruiter can see what the model was actually given.
  extracted_text text check (extracted_text is null or char_length(extracted_text) <= 200000),
  page_count integer check (page_count is null or page_count >= 0),
  -- The structured profile. JSONB because its arity genuinely varies.
  structured_profile jsonb,
  -- A controlled reason, chosen by the application from a fixed list. Not a provider's wording.
  error_code text check (error_code is null or error_code in (
    'no_text', 'extract_failed', 'unsupported', 'too_large', 'extract_timeout',
    'ai_unavailable', 'ai_timeout', 'ai_malformed',
    'identity_conflict', 'identity_unresolved', 'database'
  )),
  -- The sanitized sentence a recruiter sees. Provider internals never reach this column.
  error text check (error is null or char_length(error) <= 500),
  -- Set once an attempt has produced a person to attach the result to.
  application_id uuid,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (job_id, organization_id)
    references public.jobs (id, organization_id) on delete cascade,
  -- Removing a resume removes what was read from it. Phase 7's delete therefore still works
  -- exactly as it did, and cannot leave a profile behind pointing at a document that is gone.
  foreign key (resume_id, organization_id)
    references public.job_resumes (id, organization_id) on delete cascade,
  foreign key (application_id, organization_id)
    references public.job_applications (id, organization_id) on delete set null,
  unique (id, organization_id),
  constraint resume_processings_attempt_unique unique (resume_id, attempt)
);

-- Exactly one current attempt per resume. This is the idempotency guarantee: a double-click, a
-- page refresh or two recruiters pressing Process cannot produce two live attempts.
create unique index resume_processings_current_key
  on public.resume_processings (resume_id) where is_current;
create index resume_processings_job_idx on public.resume_processings (job_id, created_at desc);
create index resume_processings_organization_idx on public.resume_processings (organization_id);
create index resume_processings_application_idx
  on public.resume_processings (application_id) where application_id is not null;

-- =============================================================================================
-- evidence
--
-- Why the system believes a fact. One row per supporting quote.
--
-- `quote_verified` is the column that makes this trustworthy: the application searches the
-- extracted text for the quote the model supplied and records what it found. A model cannot set
-- it by asserting anything, which is what stops a resume that says "mark this candidate as
-- perfect" from producing a verified fact - there is no quote in the document to support one.
-- =============================================================================================

create table public.candidate_evidence (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  processing_id uuid not null,
  fact_type text not null check (fact_type in (
    'identity', 'skill', 'experience', 'education', 'certification',
    'project', 'language', 'achievement', 'summary'
  )),
  -- What the fact is about: "email", "Python", "Acme Corp".
  fact_key text not null check (char_length(btrim(fact_key)) between 1 and 200),
  fact_value text check (fact_value is null or char_length(fact_value) <= 500),
  -- The controlled vocabulary. A number alone is not evidence, which is why confidence is
  -- nullable and this is not.
  evidence_status text not null check (evidence_status in (
    'verified', 'likely', 'indirect', 'not_found', 'contradictory', 'unable_to_determine'
  )),
  confidence numeric(3, 2) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  source_page integer check (source_page is null or source_page >= 1),
  source_section text check (source_section is null or char_length(btrim(source_section)) between 1 and 200),
  -- The exact wording from the resume. Not the model's paraphrase of it.
  source_quote text check (source_quote is null or char_length(source_quote) <= 2000),
  -- The application's own finding, not the model's claim: was that quote actually in the document?
  quote_verified boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (processing_id, organization_id)
    references public.resume_processings (id, organization_id) on delete cascade
);

create index candidate_evidence_processing_idx
  on public.candidate_evidence (processing_id, fact_type, fact_key);
create index candidate_evidence_organization_idx on public.candidate_evidence (organization_id);

-- =============================================================================================
-- archived jobs stay frozen
--
-- Same rule, same SQLSTATE as everywhere else: an archived job is a record, so nothing may be
-- processed into it and nothing already there may move. Reads stay open. Operators (no JWT
-- subject) are exempt, as the existing guards are.
--
-- Candidates deliberately have no guard: a candidate belongs to the organization rather than to
-- one job, so freezing a job must not freeze a person who also applied elsewhere. The only path
-- that writes a candidate is processing, and processing is guarded here.
-- =============================================================================================

create or replace function private.guard_archived_job_processing()
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

create trigger guard_archived_job_processings
  before insert or update or delete on public.resume_processings
  for each row execute function private.guard_archived_job_processing();

create trigger guard_archived_job_applications
  before insert or update or delete on public.job_applications
  for each row execute function private.guard_archived_job_processing();

-- Evidence carries no job_id of its own, so it reaches the job through its attempt.
create or replace function private.guard_archived_job_evidence()
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
  from public.jobs j
  join public.resume_processings p on p.job_id = j.id
  where p.id = coalesce(new.processing_id, old.processing_id);
  if job_status = 'archived' then
    raise exception 'archived jobs cannot be modified' using errcode = 'TQ010';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger guard_archived_job_evidence
  before insert or update or delete on public.candidate_evidence
  for each row execute function private.guard_archived_job_evidence();

revoke execute on function
  private.guard_archived_job_processing(), private.guard_archived_job_evidence()
from public, anon, authenticated;

-- =============================================================================================
-- starting an attempt
--
-- SECURITY INVOKER, so RLS and the archive guard above both still apply - this function gives the
-- caller no authority they did not already have. What it gives is atomicity: deciding whether an
-- attempt may start and creating it have to happen together, or two requests both decide yes.
--
-- `stale_before` lets an attempt that is still marked processing be superseded once it can no
-- longer be alive. It is derived from the provider timeout on the server, never sent by a browser.
-- =============================================================================================

create or replace function public.start_resume_processing(
  target_organization_id uuid,
  target_job_id uuid,
  target_resume_id uuid,
  parser_name text,
  parser_version text,
  processing_version text,
  stale_before timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row public.resume_processings;
  next_attempt integer;
  created uuid;
begin
  -- The permission is checked HERE, explicitly, because this function writes as its owner: the
  -- policies on resume_processings no longer stand behind it. Processing is the only writer of
  -- derived data, so the authorization that used to live in a policy lives in these three lines.
  if not private.has_organization_permission(target_organization_id, 'jobs.manage') then
    raise exception 'jobs.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- The resume is re-read in the named organization: this both proves it is ours and ties the attempt
  -- to a job that actually holds it. A resume id from another tenant matches nothing.
  if not exists (
    select 1 from public.job_resumes r
    where r.id = target_resume_id
      and r.job_id = target_job_id
      and r.organization_id = target_organization_id
  ) then
    raise exception 'resume not found' using errcode = 'no_data_found';
  end if;

  -- Asked before anything else, so an archived job is refused for being archived rather than for
  -- whatever else also happens to be true of it - a recruiter told "already processed" when the real
  -- reason is "this job is frozen" has been told the wrong thing. The insert trigger enforces the
  -- same rule regardless; this decides which refusal comes first. Operators (no JWT subject) are
  -- exempt here exactly as they are in the trigger.
  if auth.uid() is not null and exists (
    select 1 from public.jobs j where j.id = target_job_id and j.status = 'archived'
  ) then
    raise exception 'archived jobs cannot be modified' using errcode = 'TQ010';
  end if;

  select * into current_row
  from public.resume_processings p
  where p.resume_id = target_resume_id and p.is_current
  for update;

  if found then
    -- A success is not retried. Nothing may overwrite a profile that was read correctly.
    if current_row.status = 'succeeded' then
      raise exception 'this resume has already been processed'
        using errcode = 'TQ012';
    end if;
    -- An attempt that is genuinely in flight blocks another, which is what makes a refresh or a
    -- double press harmless. One that cannot still be alive does not.
    if current_row.status in ('waiting', 'processing')
       and current_row.created_at > stale_before then
      raise exception 'this resume is already being processed'
        using errcode = 'TQ013';
    end if;
    update public.resume_processings set is_current = false where id = current_row.id;
  end if;

  select coalesce(max(p.attempt), 0) + 1 into next_attempt
  from public.resume_processings p where p.resume_id = target_resume_id;

  insert into public.resume_processings (
    organization_id, job_id, resume_id, attempt, is_current, status,
    parser, parser_version, processing_version, created_by
  ) values (
    target_organization_id, target_job_id, target_resume_id, next_attempt, true, 'processing',
    parser_name, parser_version, processing_version, auth.uid()
  )
  returning id into created;

  return created;
end;
$$;

revoke execute on function
  public.start_resume_processing(uuid, uuid, uuid, text, text, text, timestamptz)
from public, anon;
grant execute on function
  public.start_resume_processing(uuid, uuid, uuid, text, text, text, timestamptz)
to authenticated;

-- =============================================================================================
-- finishing an attempt
--
-- One statement from the application's point of view, because the four things it does have to
-- happen together or not at all: resolve the person, attach the application, record the evidence,
-- settle the attempt. Half of that would leave a profile with no evidence, or evidence belonging
-- to nobody.
--
-- The identity rules live here rather than in TypeScript because they are decisions about rows and
-- have to be race-safe. They are, in full:
--
--   an exact normalized email      -> reuse that candidate, or create one. resolved.
--   no email, but a phone that
--     matches a candidate with
--     no email of its own          -> reuse it. resolved.
--   no email, but a phone that
--     matches a candidate that
--     HAS an email                 -> conflicted. A new candidate, and the attempt needs review.
--   neither                        -> a candidate of its own. unresolved, and needs review.
--
-- A name is never looked up. There is no branch here that could merge two people by name, and no
-- index that would let one be written.
-- =============================================================================================

create or replace function public.complete_resume_processing(
  target_organization_id uuid,
  target_processing_id uuid,
  resume_text text,
  pages integer,
  provider_name text,
  model_name text,
  profile jsonb,
  evidence jsonb,
  identity_name text,
  identity_email text,
  identity_phone text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt_row public.resume_processings;
  candidate uuid;
  matched_email text;
  state text;
  application uuid;
  final_status text;
  item jsonb;
begin
  if not private.has_organization_permission(target_organization_id, 'jobs.manage') then
    raise exception 'jobs.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- Scoped by organization as well as id. Without this the caller could name any attempt in the
  -- database and have their own organization's permission accepted for it.
  select * into attempt_row
  from public.resume_processings p
  where p.id = target_processing_id and p.organization_id = target_organization_id
  for update;
  if not found then
    raise exception 'processing attempt not found' using errcode = 'no_data_found';
  end if;

  -- --- the person ---------------------------------------------------------------------------
  if identity_email is not null then
    select c.id into candidate
    from public.candidates c
    where c.organization_id = target_organization_id and c.email = identity_email;
    if candidate is null then
      insert into public.candidates (organization_id, full_name, email, phone, identity_state)
      values (target_organization_id, identity_name, identity_email, identity_phone, 'resolved')
      returning id into candidate;
    end if;
    state := 'resolved';
  elsif identity_phone is not null then
    -- The first match only, and only when it carries no email of its own. A candidate that has an
    -- email is identified by that email, so a bare phone pointing at them is a disagreement.
    select c.id, c.email into candidate, matched_email
    from public.candidates c
    where c.organization_id = target_organization_id and c.phone = identity_phone
    order by c.created_at
    limit 1;
    if candidate is not null and matched_email is not null then
      candidate := null;
      insert into public.candidates (organization_id, full_name, phone, identity_state)
      values (target_organization_id, identity_name, identity_phone, 'conflicted')
      returning id into candidate;
      state := 'conflicted';
    elsif candidate is null then
      insert into public.candidates (organization_id, full_name, phone, identity_state)
      values (target_organization_id, identity_name, identity_phone, 'resolved')
      returning id into candidate;
      state := 'resolved';
    else
      state := 'resolved';
    end if;
  else
    -- Nothing deterministic. A record is still created, because the resume is real and belongs to
    -- somebody; it simply does not claim to be anyone in particular.
    insert into public.candidates (organization_id, full_name, identity_state)
    values (target_organization_id, identity_name, 'unresolved')
    returning id into candidate;
    state := 'unresolved';
  end if;

  -- Fills gaps only. A later resume may add a phone the first one omitted; it never overwrites
  -- something already known, because the earlier document is not less true than the later one.
  update public.candidates c set
    full_name = coalesce(c.full_name, identity_name),
    phone = coalesce(c.phone, identity_phone),
    location = coalesce(c.location, nullif(btrim(profile #>> '{candidate,location}'), '')),
    headline = coalesce(c.headline, nullif(btrim(profile #>> '{candidate,headline}'), '')),
    summary = coalesce(c.summary, nullif(btrim(profile #>> '{candidate,summary}'), '')),
    linkedin_url = coalesce(c.linkedin_url, nullif(btrim(profile #>> '{candidate,linkedin_url}'), '')),
    website_url = coalesce(c.website_url, nullif(btrim(profile #>> '{candidate,website_url}'), '')),
    identity_state = case when state = 'conflicted' then 'conflicted' else c.identity_state end
  where c.id = candidate;

  -- --- the application ----------------------------------------------------------------------
  insert into public.job_applications (organization_id, job_id, candidate_id)
  values (target_organization_id, attempt_row.job_id, candidate)
  on conflict on constraint job_applications_one_per_candidate do nothing;

  select a.id into application
  from public.job_applications a
  where a.job_id = attempt_row.job_id and a.candidate_id = candidate;

  -- --- the evidence -------------------------------------------------------------------------
  -- Replaced wholesale for this attempt, so a retry cannot leave the previous attempt's quotes
  -- attached to this one. Other attempts' evidence is untouched.
  delete from public.candidate_evidence where processing_id = attempt_row.id;

  if evidence is not null and jsonb_typeof(evidence) = 'array' then
    for item in select * from jsonb_array_elements(evidence) loop
      insert into public.candidate_evidence (
        organization_id, processing_id, fact_type, fact_key, fact_value,
        evidence_status, confidence, source_page, source_section, source_quote, quote_verified
      ) values (
        target_organization_id,
        attempt_row.id,
        item ->> 'fact_type',
        item ->> 'fact_key',
        nullif(item ->> 'fact_value', ''),
        item ->> 'evidence_status',
        (item ->> 'confidence')::numeric,
        (item ->> 'source_page')::integer,
        nullif(item ->> 'source_section', ''),
        nullif(item ->> 'source_quote', ''),
        coalesce((item ->> 'quote_verified')::boolean, false)
      );
    end loop;
  end if;

  -- --- the verdict --------------------------------------------------------------------------
  -- Anything less than a deterministic identity is a review, not a success. The profile is kept
  -- either way: needs_review means a person has to look, not that the work was wasted.
  final_status := case when state = 'resolved' then 'succeeded' else 'needs_review' end;

  update public.resume_processings p set
    status = final_status,
    provider = provider_name,
    model = model_name,
    extracted_text = resume_text,
    page_count = pages,
    structured_profile = profile,
    application_id = application,
    error_code = case
      when state = 'conflicted' then 'identity_conflict'
      when state = 'unresolved' then 'identity_unresolved'
      else null end,
    error = case
      when state = 'conflicted' then 'The contact details in this resume disagree with an existing candidate. Confirm who this is.'
      when state = 'unresolved' then 'This resume gave no email or phone number, so it could not be matched to a candidate.'
      else null end,
    completed_at = now()
  where p.id = attempt_row.id;

  return application;
end;
$$;

revoke execute on function public.complete_resume_processing(
  uuid, uuid, text, integer, text, text, jsonb, jsonb, text, text, text
) from public, anon;
grant execute on function public.complete_resume_processing(
  uuid, uuid, text, integer, text, text, jsonb, jsonb, text, text, text
) to authenticated;

-- =============================================================================================
-- failing an attempt
--
-- Separate from completion because a failure writes no candidate, no application and no evidence.
-- The reason is a code from the table's own list plus a sentence the application composed; no
-- provider wording, no exception text, no stack.
-- =============================================================================================

create or replace function public.fail_resume_processing(
  target_organization_id uuid,
  target_processing_id uuid,
  failure_code text,
  failure_message text,
  resume_text text,
  pages integer,
  provider_name text,
  model_name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  touched integer;
begin
  if not private.has_organization_permission(target_organization_id, 'jobs.manage') then
    raise exception 'jobs.manage is required' using errcode = 'insufficient_privilege';
  end if;

  update public.resume_processings p set
    -- A document with no readable text has not failed; it needs a person, possibly with a scanner.
    status = case when failure_code = 'no_text' then 'needs_review' else 'failed' end,
    error_code = failure_code,
    error = failure_message,
    -- Whatever text there was is kept, because "almost nothing" is itself the useful finding.
    extracted_text = coalesce(resume_text, p.extracted_text),
    page_count = coalesce(pages, p.page_count),
    provider = coalesce(provider_name, p.provider),
    model = coalesce(model_name, p.model),
    completed_at = now()
  where p.id = target_processing_id
    and p.organization_id = target_organization_id;
  get diagnostics touched = row_count;
  if touched = 0 then
    raise exception 'processing attempt not found' using errcode = 'no_data_found';
  end if;
end;
$$;

revoke execute on function
  public.fail_resume_processing(uuid, uuid, text, text, text, integer, text, text)
from public, anon;
grant execute on function
  public.fail_resume_processing(uuid, uuid, text, text, text, integer, text, text)
to authenticated;

-- =============================================================================================
-- row level security
--
-- The same shape as every tenant table here, and platform administration is absent for the same
-- reason: an applicant's extracted profile is the tenant's own confidential data, not control-plane
-- information. The only way in is a membership carrying the key.
-- =============================================================================================

alter table public.candidates enable row level security;
alter table public.job_applications enable row level security;
alter table public.resume_processings enable row level security;
alter table public.candidate_evidence enable row level security;

-- SELECT only. Everything below is readable with jobs.view and writable by nobody: there is no
-- insert, update or delete policy on any of these four tables, and no insert, update or delete
-- privilege either. The privileges section at the end of this file explains why.

create policy "candidates: jobs.view can read"
  on public.candidates for select to authenticated
  using (private.has_organization_permission(organization_id, 'jobs.view'));

create policy "job_applications: jobs.view can read"
  on public.job_applications for select to authenticated
  using (private.has_organization_permission(organization_id, 'jobs.view'));

create policy "resume_processings: jobs.view can read"
  on public.resume_processings for select to authenticated
  using (private.has_organization_permission(organization_id, 'jobs.view'));

create policy "candidate_evidence: jobs.view can read"
  on public.candidate_evidence for select to authenticated
  using (private.has_organization_permission(organization_id, 'jobs.view'));

-- =============================================================================================
-- privileges
--
-- SELECT, and nothing else, on all four tables.
--
-- Everything in them is DERIVED: a profile is what a document said, an evidence row is where in the
-- document it said it, a candidate is who the document identified, and an attempt is the record of
-- that work having been done. None of it is a recruiter's opinion to type in, and all of it is only
-- meaningful because of the pipeline that produced it.
--
-- With INSERT and UPDATE granted, a recruiter holding jobs.manage could call the table API directly
-- and write an attempt with status 'succeeded', a profile of their choosing, a provider that never
-- ran, and an evidence row claiming quote_verified = true for a sentence appearing in no document.
-- Every policy was satisfied, because a policy can say WHO may write but not WHAT a write has to
-- mean. Removing the privilege is what closes that, and it costs nothing: the application makes no
-- direct write to any of these tables, only the three functions above do.
--
-- Those functions are therefore SECURITY DEFINER, and each asks
-- private.has_organization_permission for jobs.manage itself rather than leaning on a policy that no
-- longer stands behind it. The archive triggers still fire, because they read auth.uid() rather than
-- the current role, so an archived job still refuses all of this with TQ010.
--
-- Reads are unchanged: jobs.view, organization-scoped, platform administration excluded.
--
-- A consequence worth stating: nothing can delete an attempt, a candidate or an application, and
-- evidence is replaced only by completing the attempt that owns it. Attempts go when the resume goes,
-- by cascade.
-- =============================================================================================

revoke all on
  public.candidates, public.job_applications, public.resume_processings, public.candidate_evidence
from anon, authenticated;

grant select on public.candidates to authenticated;
grant select on public.job_applications to authenticated;
grant select on public.resume_processings to authenticated;
grant select on public.candidate_evidence to authenticated;
