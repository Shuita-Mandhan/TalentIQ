-- Phase 2G — security & integrity hardening.
--
-- 1. Role input integrity: a database-level bound on roles.description.
-- 2. Management-lockout prevention: an organization that currently has someone able to manage both
--    members and roles may not be left without one. Defined purely in terms of effective
--    permissions - never role names, never Platform Admin.
-- 3. Closing the direct-write bypass: authenticated users kept full DML on the tenant integrity
--    tables, so every RPC-level invariant (including the Phase 2F self-deactivation guard) could be
--    sidestepped through the Data API. Those tables are now RPC-only.
-- 4. Delegation ceiling: a tenant caller can never INTRODUCE an organization permission they do not
--    themselves hold, so members.manage alone can no longer be used to assign a more powerful role
--    (to anyone, including oneself) and roles.manage alone can no longer mint one. Only the newly
--    granted permissions are measured, so a limited manager may still strip roles from someone more
--    powerful without having to hold what that person keeps.
-- 5. Invitation lifecycle recovery: resend a pending invitation, re-invite an address left stranded
--    by a revoked invitation, and let a confirmed recipient find their own pending invitations.
--
-- SQLSTATEs, continuing the project convention:
--   42501 insufficient_privilege   P0002 not found   22023 invalid identifiers
--   TQ001 system role immutable    TQ002 role still assigned   TQ003 self-deactivation
--   TQ004 organization would lose management recovery
--   TQ005 cannot grant permissions the caller does not hold

-- =============================================================================================
-- role input integrity
-- =============================================================================================

-- Matches the 500 characters the role editor already enforces; nothing is truncated, over-long
-- input is refused at the boundary so a direct RPC caller cannot exceed it either.
alter table public.roles
  add constraint roles_description_length
  check (description is null or char_length(description) <= 500);

-- =============================================================================================
-- management recovery invariant
-- =============================================================================================

-- True when at least one ACTIVE membership holds BOTH members.manage and roles.manage, whether
-- through one role or the union of several. Role names are irrelevant and platform administrators
-- are not tenant managers, so neither can satisfy this.
create or replace function private.organization_has_recovery_manager(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_memberships m
    join public.membership_roles mr on mr.membership_id = m.id
    join public.role_permissions rp on rp.role_id = mr.role_id
    where m.organization_id = org_id
      and m.is_active
    group by m.id
    having count(*) filter (where rp.permission_key = 'members.manage') > 0
       and count(*) filter (where rp.permission_key = 'roles.manage') > 0
  );
$$;

-- Internal to the management RPCs below, which are SECURITY DEFINER and therefore execute it as
-- their owner. No application role needs it directly, so nobody is granted it.
revoke execute on function private.organization_has_recovery_manager(uuid)
  from public, anon, authenticated;

-- Serializes management-sensitive mutations for one organization and re-checks the caller's
-- permission after the lock: a caller that waited may have lost its own access while blocked, and a
-- stale pre-lock decision must never authorize the write.
create or replace function private.lock_organization_for_management(org_id uuid, required_permission text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from public.organizations o where o.id = org_id for update;
  if not private.has_organization_permission(org_id, required_permission) then
    raise exception '% is required', required_permission using errcode = 'insufficient_privilege';
  end if;
end;
$$;

-- Likewise internal: reached only from the SECURITY DEFINER RPCs, never by a caller directly.
revoke execute on function private.lock_organization_for_management(uuid, text)
  from public, anon, authenticated;

-- Which of the given permission keys the caller does NOT currently hold in this organization.
-- Authority to manage members or roles is not authority to create authority: anything a caller
-- newly introduces must already be within their own effective permissions. Callers pass only the
-- delta, never the retained set. Purely key-based - role names and platform-admin status mean
-- nothing here.
create or replace function private.ungrantable_permissions(org_id uuid, requested text[])
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct k order by k), '{}')
  from unnest(requested) as t(k)
  where not private.has_organization_permission(org_id, k);
$$;

revoke execute on function private.ungrantable_permissions(uuid, text[])
  from public, anon, authenticated;

-- =============================================================================================
-- management mutations: lock, re-check, mutate, verify recovery is still possible
--
-- The transition rule is deliberately one-directional: safe -> unsafe is refused, while an
-- organization that is already without a manager (a freshly provisioned one, for instance) can
-- still be worked on and moved toward a safe state.
-- =============================================================================================

create or replace function public.set_organization_member_status(
  target_organization_id uuid,
  target_membership_id uuid,
  active boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_user_id uuid;
  was_safe boolean;
begin
  if not private.has_organization_permission(target_organization_id, 'members.manage') then
    raise exception 'members.manage is required' using errcode = 'insufficient_privilege';
  end if;
  perform private.lock_organization_for_management(target_organization_id, 'members.manage');

  select m.user_id into target_user_id
  from public.organization_memberships m
  where m.id = target_membership_id and m.organization_id = target_organization_id;
  if target_user_id is null then
    raise exception 'member not found' using errcode = 'no_data_found';
  end if;
  if not active and target_user_id = auth.uid() then
    raise exception 'callers cannot deactivate their own membership' using errcode = 'TQ003';
  end if;

  was_safe := private.organization_has_recovery_manager(target_organization_id);
  update public.organization_memberships m set is_active = active where m.id = target_membership_id;
  if was_safe and not private.organization_has_recovery_manager(target_organization_id) then
    raise exception 'organization would lose management recovery' using errcode = 'TQ004';
  end if;
end;
$$;

create or replace function public.set_organization_member_roles(
  target_organization_id uuid,
  target_membership_id uuid,
  target_role_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  distinct_role_ids uuid[] := (
    select coalesce(array_agg(distinct id), '{}') from unnest(target_role_ids) as t(id)
  );
  newly_granted text[];
  was_safe boolean;
begin
  if not private.has_organization_permission(target_organization_id, 'members.manage') then
    raise exception 'members.manage is required' using errcode = 'insufficient_privilege';
  end if;
  perform private.lock_organization_for_management(target_organization_id, 'members.manage');

  if not exists (
    select 1 from public.organization_memberships m
    where m.id = target_membership_id and m.organization_id = target_organization_id
  ) then
    raise exception 'member not found' using errcode = 'no_data_found';
  end if;
  if (
    select count(*) from public.roles r
    where r.organization_id = target_organization_id and r.id = any (distinct_role_ids)
  ) <> cardinality(distinct_role_ids) then
    raise exception 'roles must belong to the organization' using errcode = 'invalid_parameter_value';
  end if;

  -- Delegation ceiling on the DELTA only. Both sides are read after the lock and re-check, so the
  -- comparison uses the caller's current permissions and a target state no concurrent management
  -- transaction can be changing. Permissions the member already effectively has are retained, not
  -- granted, so a limited manager can still remove roles from someone more powerful.
  select coalesce(array_agg(k), '{}') into newly_granted from (
    select rp.permission_key
    from public.role_permissions rp
    where rp.role_id = any (distinct_role_ids)
    except
    select rp.permission_key
    from public.membership_roles mr
    join public.role_permissions rp on rp.role_id = mr.role_id
    where mr.membership_id = target_membership_id
  ) as delta(k);

  if array_length(private.ungrantable_permissions(target_organization_id, newly_granted), 1) is not null then
    raise exception 'cannot grant permissions you do not hold' using errcode = 'TQ005';
  end if;

  was_safe := private.organization_has_recovery_manager(target_organization_id);
  delete from public.membership_roles mr where mr.membership_id = target_membership_id;
  insert into public.membership_roles (membership_id, role_id, organization_id)
  select target_membership_id, id, target_organization_id from unnest(distinct_role_ids) as t(id);
  if was_safe and not private.organization_has_recovery_manager(target_organization_id) then
    raise exception 'organization would lose management recovery' using errcode = 'TQ004';
  end if;
end;
$$;

-- Replaces the Phase 2F function unchanged except for two additions: the organization lock with a
-- post-lock re-check (so a caller cannot mint a role using authority lost while blocked) and the
-- delegation ceiling. Dynamic names, case-insensitive uniqueness, description handling and
-- is_system = false are all preserved.
create or replace function public.create_organization_role(
  target_organization_id uuid,
  role_name text,
  role_description text,
  permission_keys text[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  distinct_keys text[] := (
    select coalesce(array_agg(distinct k), '{}') from unnest(permission_keys) as t(k)
  );
  new_role_id uuid;
begin
  if not private.has_organization_permission(target_organization_id, 'roles.manage') then
    raise exception 'roles.manage is required' using errcode = 'insufficient_privilege';
  end if;
  perform private.lock_organization_for_management(target_organization_id, 'roles.manage');

  if (select count(*) from public.permissions p where p.key = any (distinct_keys))
     <> cardinality(distinct_keys) then
    raise exception 'unknown permission' using errcode = 'invalid_parameter_value';
  end if;
  -- A new role has no pre-existing permissions, so every requested key is newly introduced.
  if array_length(private.ungrantable_permissions(target_organization_id, distinct_keys), 1) is not null then
    raise exception 'cannot grant permissions you do not hold' using errcode = 'TQ005';
  end if;

  insert into public.roles (organization_id, name, description, is_system)
  values (target_organization_id, btrim(role_name), nullif(btrim(role_description), ''), false)
  returning roles.id into new_role_id;

  insert into public.role_permissions (role_id, organization_id, permission_key)
  select new_role_id, target_organization_id, k from unnest(distinct_keys) as t(k);

  return new_role_id;
end;
$$;

create or replace function public.update_organization_role(
  target_organization_id uuid,
  target_role_id uuid,
  role_name text,
  role_description text,
  permission_keys text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  distinct_keys text[] := (
    select coalesce(array_agg(distinct k), '{}') from unnest(permission_keys) as t(k)
  );
  target_is_system boolean;
  newly_granted text[];
  was_safe boolean;
begin
  if not private.has_organization_permission(target_organization_id, 'roles.manage') then
    raise exception 'roles.manage is required' using errcode = 'insufficient_privilege';
  end if;
  perform private.lock_organization_for_management(target_organization_id, 'roles.manage');

  select r.is_system into target_is_system
  from public.roles r where r.id = target_role_id and r.organization_id = target_organization_id;
  if target_is_system is null then
    raise exception 'role not found' using errcode = 'no_data_found';
  end if;
  if target_is_system then
    raise exception 'system roles are managed by TalentIQ' using errcode = 'TQ001';
  end if;
  if (select count(*) from public.permissions p where p.key = any (distinct_keys))
     <> cardinality(distinct_keys) then
    raise exception 'unknown permission' using errcode = 'invalid_parameter_value';
  end if;

  -- Delta only: keys the role already carries are retained, not granted, so a caller may narrow a
  -- role that contains permissions they do not hold themselves.
  select coalesce(array_agg(k), '{}') into newly_granted from (
    select k from unnest(distinct_keys) as t(k)
    except
    select rp.permission_key from public.role_permissions rp where rp.role_id = target_role_id
  ) as delta(k);

  if array_length(private.ungrantable_permissions(target_organization_id, newly_granted), 1) is not null then
    raise exception 'cannot grant permissions you do not hold' using errcode = 'TQ005';
  end if;

  was_safe := private.organization_has_recovery_manager(target_organization_id);

  update public.roles r
  set name = btrim(role_name), description = nullif(btrim(role_description), '')
  where r.id = target_role_id;

  delete from public.role_permissions rp where rp.role_id = target_role_id;
  insert into public.role_permissions (role_id, organization_id, permission_key)
  select target_role_id, target_organization_id, k from unnest(distinct_keys) as t(k);

  if was_safe and not private.organization_has_recovery_manager(target_organization_id) then
    raise exception 'organization would lose management recovery' using errcode = 'TQ004';
  end if;
end;
$$;

-- =============================================================================================
-- close the direct-write bypass
--
-- The tenant integrity tables are reachable only through the RPCs above, which own every invariant
-- (tenant scoping, system-role protection, self-deactivation, management recovery). The write
-- policies on these tables stay in place as defence in depth should a future migration grant DML
-- again. Platform control-plane tables (organizations, platform_admins, platform_services,
-- organization_service_entitlements) and self-service profile updates are untouched.
-- =============================================================================================

revoke insert, update, delete on
  public.organization_memberships,
  public.roles,
  public.role_permissions,
  public.membership_roles
from authenticated;

-- =============================================================================================
-- tighten the private helper surface
--
-- PostgreSQL grants EXECUTE to PUBLIC by default, so several trigger functions - including a
-- SECURITY DEFINER one - were still executable by anon and authenticated on paper. Nothing could
-- reach them (anon has no USAGE on the private schema, and a trigger function raises if called
-- directly), but the audit surface should say what is actually intended.
-- =============================================================================================

revoke execute on function
  private.set_updated_at(),
  private.handle_new_auth_user(),
  private.guard_organization_update(),
  private.guard_system_role()
from public, anon, authenticated;

-- organization_has_service is referenced by no policy and no function today, so its grants serve
-- nothing. A future module that genuinely calls it can grant it to the role that needs it then.
revoke execute on function private.organization_has_service(uuid, text)
  from public, anon, authenticated, service_role;

-- =============================================================================================
-- invitation lifecycle recovery
-- =============================================================================================

-- An address whose only trace is an unconfirmed account left behind by a revoked or stale
-- invitation is no longer stranded: a NEW pending invitation is created (history is never
-- rewritten) and the caller is told to send a fresh email. A confirmed account still reports
-- account_exists, and a live pending invitation still reports already_invited.
create or replace function public.prepare_organization_invitation(
  target_organization_id uuid,
  target_email text
)
returns table (status text, invitation_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_email text := lower(btrim(target_email));
  existing_user record;
  new_invitation_id uuid;
  outcome text := 'invite_ready';
begin
  if not private.has_organization_permission(target_organization_id, 'members.manage') then
    raise exception 'members.manage is required' using errcode = 'insufficient_privilege';
  end if;

  if exists (
    select 1 from public.organization_invitations i
    where i.organization_id = target_organization_id
      and i.email = normalized_email
      and i.status = 'pending'
  ) then
    return query select 'already_invited'::text, null::uuid;
    return;
  end if;

  select u.id, u.email_confirmed_at into existing_user
  from auth.users u where lower(u.email) = normalized_email limit 1;
  if existing_user.id is not null then
    if existing_user.email_confirmed_at is not null then
      return query select 'account_exists'::text, null::uuid;
      return;
    end if;
    -- Unconfirmed leftover: invite again rather than stranding the address forever. Supabase Auth
    -- reuses an existing unconfirmed user and sends a fresh invite, while rejecting a confirmed one
    -- as a duplicate, which is exactly the split applied here.
    outcome := 'reinvite_ready';
  end if;

  -- The check above is a fast path; this insert is the authority. Inferring the partial unique
  -- index makes concurrent callers resolve to one winner instead of one of them seeing a 23505,
  -- and it leaves every other constraint violation to surface normally.
  insert into public.organization_invitations (organization_id, email, invited_by)
  values (target_organization_id, normalized_email, auth.uid())
  on conflict (organization_id, email) where organization_invitations.status = 'pending' do nothing
  returning id into new_invitation_id;

  if new_invitation_id is null then
    return query select 'already_invited'::text, null::uuid;
    return;
  end if;
  return query select outcome, new_invitation_id;
end;
$$;

-- What a resend needs, and nothing more. recipient_confirmed lets the trusted server action tell a
-- resendable invitation apart from one whose recipient already confirmed their address and should
-- simply sign in - the caller already knows this address, so it reveals nothing new to them.
create or replace function public.get_organization_invitation_for_resend(
  target_organization_id uuid,
  target_invitation_id uuid
)
returns table (invitation_id uuid, email text, recipient_confirmed boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  invitation public.organization_invitations;
begin
  if not private.has_organization_permission(target_organization_id, 'members.manage') then
    raise exception 'members.manage is required' using errcode = 'insufficient_privilege';
  end if;

  select * into invitation
  from public.organization_invitations i
  where i.id = target_invitation_id and i.organization_id = target_organization_id;

  if invitation.id is null then
    raise exception 'invitation not found' using errcode = 'no_data_found';
  end if;
  if invitation.status <> 'pending' then
    raise exception 'only pending invitations can be resent' using errcode = 'invalid_parameter_value';
  end if;

  return query
    select
      invitation.id,
      invitation.email,
      exists (
        select 1 from auth.users u
        where lower(u.email) = invitation.email and u.email_confirmed_at is not null
      );
end;
$$;

-- Recovery for the recipient who confirmed their address but closed the browser before choosing a
-- password: they can find their own pending invitations without being a member of anything. Only
-- the caller's own confirmed address is matched, and only invitations of active organizations.
create or replace function public.get_my_pending_organization_invitations()
returns table (
  id uuid,
  organization_id uuid,
  organization_name text,
  organization_slug text,
  email text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, o.id, o.name, o.slug, i.email, i.created_at
  from public.organization_invitations i
  join public.organizations o on o.id = i.organization_id
  where i.status = 'pending'
    and o.is_active
    and i.email = (
      select lower(btrim(u.email)) from auth.users u
      where u.id = auth.uid() and u.email_confirmed_at is not null
    )
  order by i.created_at;
$$;

-- =============================================================================================
-- privileges
-- =============================================================================================

revoke execute on function
  public.get_organization_invitation_for_resend(uuid, uuid),
  public.get_my_pending_organization_invitations()
from public, anon;

grant execute on function
  public.get_organization_invitation_for_resend(uuid, uuid),
  public.get_my_pending_organization_invitations()
to authenticated, service_role;
