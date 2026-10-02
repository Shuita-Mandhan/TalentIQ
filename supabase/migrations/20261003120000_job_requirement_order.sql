-- Phase 4 completion — reordering job requirements.
--
-- Ordering is the one requirement mutation that is not a single row: moving one requirement
-- renumbers its neighbours, and doing that as a sequence of round trips would leave the list
-- half-renumbered if any of them failed. One statement, one transaction.
--
-- Deliberately NOT security definer. It runs as the caller, so the existing policies decide
-- everything: the UPDATE policy on job_requirements already requires jobs.manage, the composite
-- scoping already confines it to one organization, and the archived-job trigger still fires. This
-- function adds a shape, not a privilege - there is nothing it can do that a caller could not
-- already do one row at a time.

create or replace function public.reorder_job_requirements(
  target_organization_id uuid,
  target_job_id uuid,
  ordered_ids uuid[]
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  moved integer;
begin
  -- Position in the array becomes the order. Rows outside this job or this organization match
  -- nothing, so a foreign id is ignored rather than renumbering somebody else's list.
  update public.job_requirements r
  set display_order = ranked.ordinality - 1
  from unnest(ordered_ids) with ordinality as ranked(id, ordinality)
  where r.id = ranked.id
    and r.job_id = target_job_id
    and r.organization_id = target_organization_id;

  get diagnostics moved = row_count;
  return moved;
end;
$$;

revoke execute on function public.reorder_job_requirements(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.reorder_job_requirements(uuid, uuid, uuid[]) to authenticated, service_role;
