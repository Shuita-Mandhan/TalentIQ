-- Phase 3 — organization bootstrap.
--
-- The control plane could create an organization but nothing could enter it. Provisioning leaves
-- zero memberships by design, so nobody holds members.manage there and no tenant RPC will seat the
-- first administrator; Phase 2G then closed direct DML. The only remaining route was the SQL
-- editor, which is not a product.
--
-- This closes that gap without softening the boundary that platform administration is not tenant
-- administration. Platform owns tenant LIFECYCLE and BOOTSTRAP; tenant administrators own MEMBERS
-- and ROLES. A platform admin gains tenant access here only by naming their own address, which
-- creates an explicit membership - their platform status still grants nothing on its own.
--
-- SQLSTATEs, continuing the project convention:
--   42501 insufficient_privilege   P0002 not found   22023 invalid identifiers
--   TQ004 organization would lose management recovery
--   TQ006 organization already administers itself
--   TQ007 administrator setup is no longer active
--   TQ008 an administrator setup is already pending
--
-- Bootstrap is deliberately narrow: it is refused the moment the organization has an active
-- recovery manager (someone holding both members.manage and roles.manage). That covers exactly two
-- situations - a newly created organization, and one accidentally stranded - and turns itself off
-- as soon as ordinary tenant administration can take over. It is not a general power to edit any
-- tenant's members.

-- =============================================================================================
-- bootstrap invitations
-- =============================================================================================

-- Ordinary invitations are unchanged and still join with zero roles: the column defaults to false
-- and only the SECURITY DEFINER functions below ever set it true. Authenticated callers hold no
-- DML on this table (Phase 2G), so it cannot be forged from a client, and no RPC accepts it as an
-- argument.
alter table public.organization_invitations
  add column if not exists grants_admin boolean not null default false;

comment on column public.organization_invitations.grants_admin is
  'Platform-issued bootstrap invitation: acceptance also assigns the system Organization Admin role. Never settable by a tenant caller.';

-- An organization has one administrator setup in progress, or none. The product represents a
-- single pending administrator and the control plane offers one Cancel, so two outstanding
-- admin-bearing invitations must be impossible rather than merely unlikely - this is the
-- invariant, and the RPC below is its user interface, not its enforcement.
create unique index if not exists organization_invitations_one_pending_admin
  on public.organization_invitations (organization_id)
  where status = 'pending' and grants_admin;

-- =============================================================================================
-- helpers
-- =============================================================================================

-- The provisioned Organization Admin role, resolved structurally rather than by name: exactly one
-- system role is provisioned per organization, and a name is not an authorization key here or
-- anywhere else in this schema.
create or replace function private.organization_system_role(org_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.id
  from public.roles r
  where r.organization_id = org_id and r.is_system
  order by r.created_at
  limit 1;
$$;

revoke execute on function private.organization_system_role(uuid)
  from public, anon, authenticated, service_role;

-- =============================================================================================
-- acceptance
--
-- Identical to the Phase 2F function in every respect - caller confirmation, address matching,
-- indistinguishable failures, idempotent re-acceptance, suspended-organization refusal - with two
-- additions, both confined to bootstrap invitations:
--
--   * the organization row is locked before the decision, the same row and the same lock that
--     private.lock_organization_for_management takes, so this serialises against every management
--     mutation instead of racing one;
--   * the bootstrap window is re-checked under that lock. Authority to seat an administrator was
--     granted when the organization could not administer itself, and it lapses when that stops
--     being true - a link issued weeks ago must not quietly confer administration on a tenant that
--     has since recovered.
--
-- An ordinary invitation takes neither branch and behaves exactly as before.
-- =============================================================================================

create or replace function public.accept_organization_invitation(target_invitation_id uuid)
returns table (organization_id uuid, organization_slug text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_email text;
  caller_confirmed_at timestamptz;
  invitation public.organization_invitations;
  organization public.organizations;
  existing_id uuid;
  joined_membership_id uuid;
  admin_role_id uuid;
begin
  if caller_id is null then
    raise exception 'authentication is required' using errcode = 'insufficient_privilege';
  end if;
  select lower(btrim(u.email)), u.email_confirmed_at into caller_email, caller_confirmed_at
  from auth.users u where u.id = caller_id;

  select * into invitation
  from public.organization_invitations i
  where i.id = target_invitation_id
  for update;

  -- A missing Auth row, an unconfirmed address and a mismatched address are all reported exactly
  -- like a missing invitation, so nothing here reveals which condition failed or whether the
  -- invitation exists.
  if invitation.id is null
     or caller_email is null
     or caller_confirmed_at is null
     or invitation.email is distinct from caller_email then
    raise exception 'invitation not found' using errcode = 'no_data_found';
  end if;

  -- Taken before anything is decided, so the recovery-manager question below cannot be answered
  -- from a state that another transaction is in the middle of changing.
  select * into organization from public.organizations o
  where o.id = invitation.organization_id for update;
  if not organization.is_active then
    raise exception 'organization is unavailable' using errcode = 'insufficient_privilege';
  end if;

  -- Re-acceptance is settled before any window check: the membership already exists and the role,
  -- if any, was assigned when it was still allowed.
  if invitation.status = 'accepted' and invitation.accepted_user_id = caller_id then
    return query select organization.id, organization.slug;
    return;
  end if;
  if invitation.status <> 'pending' then
    raise exception 'invitation not found' using errcode = 'no_data_found';
  end if;

  if invitation.grants_admin
     and private.organization_has_recovery_manager(invitation.organization_id) then
    -- Distinct from 'not found' on purpose: the recipient was invited as the administrator, and
    -- silently downgrading that to an ordinary zero-role membership would change what they
    -- accepted. Nothing about the organization's current administration is disclosed.
    raise exception 'administrator setup is no longer active' using errcode = 'TQ007';
  end if;

  select m.id into existing_id
  from public.organization_memberships m
  where m.organization_id = invitation.organization_id and m.user_id = caller_id;

  if existing_id is null then
    insert into public.organization_memberships (organization_id, user_id)
    values (invitation.organization_id, caller_id)
    returning id into joined_membership_id;
  else
    update public.organization_memberships m set is_active = true where m.id = existing_id;
    joined_membership_id := existing_id;
  end if;

  -- Only a platform-issued bootstrap reaches this branch; an ordinary invitation still joins with
  -- no roles at all.
  if invitation.grants_admin then
    admin_role_id := private.organization_system_role(invitation.organization_id);
    if admin_role_id is null then
      raise exception 'organization has no system role to assign' using errcode = 'no_data_found';
    end if;
    -- Named by constraint: several functions here have OUT parameters sharing these column names,
    -- and an inference list would be read as the variables rather than the target index.
    insert into public.membership_roles (membership_id, role_id, organization_id)
    values (joined_membership_id, admin_role_id, invitation.organization_id)
    on conflict on constraint membership_roles_pkey do nothing;
  end if;

  update public.organization_invitations i
  set status = 'accepted', accepted_at = now(), accepted_user_id = caller_id
  where i.id = invitation.id;

  return query select organization.id, organization.slug;
end;
$$;

-- =============================================================================================
-- platform bootstrap
-- =============================================================================================

-- Seats the first administrator of an organization that cannot yet administer itself. Returns one
-- of:
--   administrator_ready  an existing confirmed account is now an active member holding the system
--                        role; nothing further is required
--   invite_ready         a bootstrap invitation was created and the caller must send the email
--   invite_pending       one was already outstanding for this address; the caller may resend it
-- Retrying with the same address is safe and idempotent. A different address while a setup is
-- already pending is refused rather than silently issuing a second one - the pending setup is
-- cancelled first, which is what the control plane offers.
create or replace function public.bootstrap_organization_administrator(
  target_organization_id uuid,
  target_email text
)
returns table (status text, membership_id uuid, invitation_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_email text := lower(btrim(target_email));
  organization public.organizations;
  admin_role_id uuid;
  target_user record;
  existing_membership uuid;
  seated_membership_id uuid;
  existing_invitation public.organization_invitations;
  new_invitation_id uuid;
begin
  -- Control-plane authority, and nothing else: tenant permissions are not consulted, and holding
  -- them would not help.
  if not private.is_platform_admin() then
    raise exception 'platform administration is required' using errcode = 'insufficient_privilege';
  end if;

  if normalized_email is null or char_length(normalized_email) < 3 or char_length(normalized_email) > 255 then
    raise exception 'a valid email address is required' using errcode = 'invalid_parameter_value';
  end if;

  select * into organization from public.organizations o
  where o.id = target_organization_id for update;
  if organization.id is null then
    raise exception 'organization not found' using errcode = 'no_data_found';
  end if;

  -- The narrow window. Once the organization has someone who can manage both members and roles,
  -- ordinary tenant administration owns this and the control plane steps back out.
  if private.organization_has_recovery_manager(target_organization_id) then
    raise exception 'organization already administers itself' using errcode = 'TQ006';
  end if;

  admin_role_id := private.organization_system_role(target_organization_id);
  if admin_role_id is null then
    raise exception 'organization has no system role to assign' using errcode = 'no_data_found';
  end if;

  -- At most one of these exists, by index. Found by organization rather than by address, so a
  -- second administrator can never be introduced alongside the first.
  select * into existing_invitation
  from public.organization_invitations i
  where i.organization_id = target_organization_id
    and i.status = 'pending'
    and i.grants_admin
  for update;

  if existing_invitation.id is not null then
    if existing_invitation.email = normalized_email then
      return query select 'invite_pending'::text, null::uuid, existing_invitation.id;
      return;
    end if;
    raise exception 'an administrator setup is already pending' using errcode = 'TQ008';
  end if;

  select u.id, u.email_confirmed_at into target_user
  from auth.users u where lower(u.email) = normalized_email limit 1;

  -- A finished account is seated immediately; an unconfirmed one is treated as no account at all,
  -- exactly as the ordinary member-add path treats it.
  if target_user.id is not null and target_user.email_confirmed_at is not null then
    select m.id into existing_membership
    from public.organization_memberships m
    where m.organization_id = target_organization_id and m.user_id = target_user.id;

    if existing_membership is null then
      insert into public.organization_memberships (organization_id, user_id)
      values (target_organization_id, target_user.id)
      returning id into seated_membership_id;
    else
      update public.organization_memberships m set is_active = true where m.id = existing_membership;
      seated_membership_id := existing_membership;
    end if;

    insert into public.membership_roles (membership_id, role_id, organization_id)
    values (seated_membership_id, admin_role_id, target_organization_id)
    on conflict on constraint membership_roles_pkey do nothing;

    -- Superseded setup. They are in, as the administrator, so an ordinary invitation still
    -- addressed to them here is waiting on nothing and would otherwise sit in the tenant's pending
    -- list forever. Revoked rather than accepted: they never accepted it, and recording otherwise
    -- would put a consent in the database that never happened.
    --
    -- Narrow on purpose - this organization, this address, and ordinary invitations only. The
    -- pending administrator setup is settled in the branch above and can never reach this point,
    -- so nothing here can cancel the live bootstrap path.
    update public.organization_invitations i
    set status = 'revoked', revoked_at = now()
    where i.organization_id = target_organization_id
      and i.email = normalized_email
      and i.status = 'pending'
      and not i.grants_admin;

    return query select 'administrator_ready'::text, seated_membership_id, null::uuid;
    return;
  end if;

  -- No usable account. An ordinary invitation already outstanding for this address is carried up
  -- to a bootstrap rather than duplicated; otherwise a new one is recorded first, so the database
  -- stays the source of truth even if the email never leaves.
  select * into existing_invitation
  from public.organization_invitations i
  where i.organization_id = target_organization_id
    and i.email = normalized_email
    and i.status = 'pending'
  for update;

  if existing_invitation.id is not null then
    update public.organization_invitations i
    set grants_admin = true where i.id = existing_invitation.id;
    return query select 'invite_pending'::text, null::uuid, existing_invitation.id;
    return;
  end if;

  insert into public.organization_invitations (organization_id, email, invited_by, grants_admin)
  values (target_organization_id, normalized_email, auth.uid(), true)
  returning id into new_invitation_id;

  return query select 'invite_ready'::text, null::uuid, new_invitation_id;
end;
$$;

-- Cancels an administrator setup so a different person can be named. Deliberately narrow: it
-- reaches nothing but a pending, admin-bearing invitation of the named organization, so it is not
-- a way for the control plane to manage ordinary tenant invitations.
create or replace function public.revoke_bootstrap_organization_invitation(
  target_organization_id uuid,
  target_invitation_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  invitation public.organization_invitations;
begin
  if not private.is_platform_admin() then
    raise exception 'platform administration is required' using errcode = 'insufficient_privilege';
  end if;

  select * into invitation
  from public.organization_invitations i
  where i.id = target_invitation_id and i.organization_id = target_organization_id
  for update;

  if invitation.id is null then
    raise exception 'invitation not found' using errcode = 'no_data_found';
  end if;
  -- An ordinary tenant invitation belongs to the organization's own administrators.
  if not invitation.grants_admin then
    raise exception 'only an administrator setup can be cancelled here'
      using errcode = 'insufficient_privilege';
  end if;
  if invitation.status <> 'pending' then
    raise exception 'invitation not found' using errcode = 'no_data_found';
  end if;

  update public.organization_invitations i
  set status = 'revoked', revoked_at = now()
  where i.id = invitation.id;
end;
$$;

-- =============================================================================================
-- platform administration read
-- =============================================================================================

-- What the control plane needs to describe an organization's administration honestly, and nothing
-- more. Platform administrators can already read every organization and membership, so this
-- exposes no new information - it just answers the question in one round trip.
--
-- A pending setup is reported even when the organization already administers itself: that
-- invitation still carries the administrator role until someone cancels it, so hiding it would
-- hide a live grant.
create or replace function public.get_platform_organization_administration(target_organization_id uuid)
returns table(
  has_recovery_manager boolean,
  administrator_emails text[],
  pending_admin_email text,
  pending_admin_invitation_id uuid,
  caller_is_member boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not private.is_platform_admin() then
    raise exception 'platform administration is required'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  with member_permissions as (
    select 
      m.id,
      m.user_id,
      array_agg(distinct rp.permission_key) as keys
    from public.organization_memberships m
    left join public.membership_roles mr 
      on mr.membership_id = m.id
    left join public.role_permissions rp 
      on rp.role_id = mr.role_id
    where m.organization_id = target_organization_id
      and m.is_active
    group by m.id, m.user_id
  ),
  managers as (
    select u.email::text as email
    from member_permissions mp
    join auth.users u 
      on u.id = mp.user_id
    where 'members.manage' = any(mp.keys)
      and 'roles.manage' = any(mp.keys)
  ),
  pending as (
    select 
      i.id,
      i.email::text as email
    from public.organization_invitations i
    where i.organization_id = target_organization_id
      and i.status = 'pending'
      and i.grants_admin
    limit 1
  )
  select
    exists (
      select 1 from managers
    ),

    coalesce(
      (
        select array_agg(m.email order by m.email)::text[]
        from managers m
      ),
      '{}'::text[]
    ),

    (select p.email from pending p),

    (select p.id from pending p),

    exists (
      select 1
      from public.organization_memberships m
      where m.organization_id = target_organization_id
        and m.user_id = auth.uid()
        and m.is_active
    );
end;
$function$;

-- =============================================================================================
-- privileges
-- =============================================================================================

revoke execute on function
  public.bootstrap_organization_administrator(uuid, text),
  public.revoke_bootstrap_organization_invitation(uuid, uuid),
  public.get_platform_organization_administration(uuid)
from public, anon;

grant execute on function
  public.bootstrap_organization_administrator(uuid, text),
  public.revoke_bootstrap_organization_invitation(uuid, uuid),
  public.get_platform_organization_administration(uuid)
to authenticated, service_role;
