-- Phase 6 — the screening rubric.
--
-- The rubric is not a new thing to store. It is the approved job_requirements read as a weighted
-- configuration: which requirements matter, whether each is required or preferred, how much each
-- carries, and in what order. There is no rubric table, no rubric_requirements, no shadow copy -
-- a second source of truth for the same rows would only be something to keep in step.
--
-- Two changes are genuinely needed, and nothing else:
--
--   1. weight was numeric(4,2) capped at 10. A 100-point rubric cannot be expressed in that column
--      at all - the type itself tops out at 99.99 - so the range widens to 0-100.
--   2. Setting several weights at once must be one statement. Spreading a rubric across a dozen
--      round trips leaves it half-adjusted if any of them fails, and a half-adjusted rubric is
--      exactly the thing a recruiter must never be shown as ready.
--
-- Readiness itself is derived, not stored. Whether the weights total 100 is a question about the
-- rows, answerable at any moment, and storing the answer would only create a value that can
-- disagree with them.

-- =============================================================================================
-- weight range
-- =============================================================================================

alter table public.job_requirements
  drop constraint job_requirements_weight_check,
  alter column weight type numeric(5, 2),
  add constraint job_requirements_weight_check check (weight >= 0 and weight <= 100);

-- Suggestions keep the same range so a recruiter can set a rubric weight while reviewing, rather
-- than approving at the model's 0-10 centrality hint and immediately having to re-edit it.
alter table public.job_requirement_suggestions
  drop constraint job_requirement_suggestions_weight_check,
  alter column weight type numeric(5, 2),
  add constraint job_requirement_suggestions_weight_check check (weight >= 0 and weight <= 100);

-- =============================================================================================
-- setting several weights together
--
-- Deliberately NOT security definer, matching reorder_job_requirements: it runs as the caller, so
-- the UPDATE policy on job_requirements still requires jobs.manage, the composite scoping still
-- confines it to one organization, and the archived-job trigger still fires. It adds atomicity,
-- not authority - there is nothing here a caller could not already do one row at a time.
--
-- Returns the number of rows actually changed, so the caller can tell a refused write from a
-- write that matched nothing.
-- =============================================================================================

create or replace function public.set_job_requirement_weights(
  target_organization_id uuid,
  target_job_id uuid,
  requirement_ids uuid[],
  requirement_weights numeric[]
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  changed integer;
begin
  if array_length(requirement_ids, 1) is distinct from array_length(requirement_weights, 1) then
    raise exception 'each requirement needs exactly one weight' using errcode = 'invalid_parameter_value';
  end if;

  -- Paired by position. A row outside this job or this organization matches nothing, so a foreign
  -- id reweights no one else's rubric.
  update public.job_requirements r
  set weight = paired.weight
  from (
    select
      ids.id,
      weights.weight
    from unnest(requirement_ids) with ordinality as ids(id, position)
    join unnest(requirement_weights) with ordinality as weights(weight, position)
      on weights.position = ids.position
  ) as paired
  where r.id = paired.id
    and r.job_id = target_job_id
    and r.organization_id = target_organization_id;

  get diagnostics changed = row_count;
  return changed;
end;
$$;

revoke execute on function public.set_job_requirement_weights(uuid, uuid, uuid[], numeric[])
  from public, anon;
grant execute on function public.set_job_requirement_weights(uuid, uuid, uuid[], numeric[])
  to authenticated, service_role;
