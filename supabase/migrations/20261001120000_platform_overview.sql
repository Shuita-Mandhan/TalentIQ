-- Phase 3.3 — platform operations overview.
--
-- The control plane could describe one organization's administration (Phase 3) but had no way to
-- see across them. public.organization_invitations has RLS enabled with no policies and no table
-- grants, so it is unreachable through the Data API for every role including platform admins:
-- without a read of its own, an operator could only discover a stranded organization by opening
-- each one in turn. That is the gap this closes, and nothing more.
--
-- One read-only function, gated on platform administration exactly like its per-organization
-- sibling. It adds no authority: a platform admin can already read every organization and
-- membership, and already sees the pending administrator address on the detail page. The one new
-- thing it exposes is a COUNT of ordinary pending invitations per organization - never their
-- addresses, which remain the tenant's own business, and never a control over them.
--
-- Requires 20260929120000_organization_bootstrap.sql, whose grants_admin column it reads.

create or replace function public.get_platform_organizations_overview()
returns table (
  organization_id uuid,
  name text,
  slug text,
  is_active boolean,
  created_at timestamptz,
  has_recovery_manager boolean,
  administrator_count integer,
  pending_admin_email text,
  pending_admin_invitation_id uuid,
  pending_admin_since timestamptz,
  pending_member_invitations integer,
  caller_is_member boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin() then
    raise exception 'platform administration is required' using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    o.id,
    o.name,
    o.slug,
    o.is_active,
    o.created_at,
    coalesce(managers.total, 0) > 0,
    coalesce(managers.total, 0)::integer,
    pending_admin.email,
    pending_admin.id,
    pending_admin.created_at,
    coalesce(pending_members.total, 0)::integer,
    exists (
      select 1 from public.organization_memberships own
      where own.organization_id = o.id
        and own.user_id = auth.uid()
        and own.is_active
    )
  from public.organizations o

  -- Recovery managers: active memberships whose roles, taken together, carry both keys. The same
  -- definition private.organization_has_recovery_manager uses, expressed once per organization so
  -- the whole page is one query rather than one per row.
  left join lateral (
    select count(*) as total
    from (
      select m.id
      from public.organization_memberships m
      left join public.membership_roles mr on mr.membership_id = m.id
      left join public.role_permissions rp on rp.role_id = mr.role_id
      where m.organization_id = o.id and m.is_active
      group by m.id
      having bool_or(rp.permission_key = 'members.manage')
         and bool_or(rp.permission_key = 'roles.manage')
    ) qualified
  ) managers on true

  -- At most one exists, by the partial unique index in the bootstrap migration.
  left join lateral (
    select i.id, i.email, i.created_at
    from public.organization_invitations i
    where i.organization_id = o.id and i.status = 'pending' and i.grants_admin
    limit 1
  ) pending_admin on true

  -- A count only. Who a tenant has invited is the tenant's business; how many are outstanding is
  -- operational information the control plane may legitimately total up.
  left join lateral (
    select count(*) as total
    from public.organization_invitations i
    where i.organization_id = o.id and i.status = 'pending' and not i.grants_admin
  ) pending_members on true

  order by o.created_at desc;
end;
$$;

revoke execute on function public.get_platform_organizations_overview() from public, anon;
grant execute on function public.get_platform_organizations_overview() to authenticated, service_role;
