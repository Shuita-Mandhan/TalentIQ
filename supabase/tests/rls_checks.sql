-- Phase 2A tenant-isolation checks.
--
-- Runs against a THROWAWAY local PostgreSQL only (never the hosted project): it stubs the parts of
-- Supabase the migration depends on (auth.users, auth.uid(), the anon/authenticated/service_role
-- roles), applies the migration, seeds two organizations and asserts the isolation rules.
--
--   createdb talentiq_rls_test
--   psql -v ON_ERROR_STOP=1 -d talentiq_rls_test -f supabase/tests/rls_checks.sql
--
-- Any failed assertion aborts the script with a non-zero exit code.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------------------------
-- Supabase stub
-- ---------------------------------------------------------------------------------------------
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text unique,
  -- Supabase leaves this null until the person completes an email flow; rows created by
  -- inviteUserByEmail are unconfirmed. The default keeps ordinary fixture accounts confirmed.
  email_confirmed_at timestamptz default now(),
  raw_user_meta_data jsonb not null default '{}'::jsonb
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to authenticated, service_role;

\ir ../migrations/20260916120000_saas_foundation.sql
\ir ../migrations/20260916150000_organization_context.sql
\ir ../migrations/20260916180000_platform_control_plane.sql
\ir ../migrations/20260917100000_organization_access_management.sql
\ir ../migrations/20260921120000_organization_invitations.sql
\ir ../migrations/20260921160000_security_integrity_hardening.sql

-- ---------------------------------------------------------------------------------------------
-- test helpers
-- ---------------------------------------------------------------------------------------------
create schema test;
create function test.uid(name text) returns uuid language sql immutable as $$ select md5(name)::uuid $$;
create function test.login(name text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', test.uid(name), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $$;
create function test.org(slug text) returns uuid language sql stable security definer as $$
  select id from public.organizations where organizations.slug = org.slug
$$;
create function test.role_id(slug text, role_name text) returns uuid language sql stable security definer as $$
  select r.id from public.roles r join public.organizations o on o.id = r.organization_id
  where o.slug = role_id.slug and r.name = role_name
$$;
create function test.membership(slug text, name text) returns uuid language sql stable security definer as $$
  select m.id from public.organization_memberships m join public.organizations o on o.id = m.organization_id
  where o.slug = membership.slug and m.user_id = test.uid(membership.name)
$$;

grant usage on schema test to authenticated, anon;
-- private helpers that application roles deliberately cannot execute are inspected through
-- owner-context wrappers, so the tests never force a production privilege
create function test.has_service(org_id uuid, svc_key text) returns boolean
language sql stable security definer as $$ select private.organization_has_service(org_id, svc_key) $$;
grant execute on all functions in schema test to authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- fixture (as the migration owner, bypassing RLS)
-- ---------------------------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  (test.uid('alice'),   'alice@acme.test',  '{"full_name": "Alice Admin"}'),
  (test.uid('bob'),     'bob@acme.test',    '{}'),
  (test.uid('carol'),   'carol@beta.test',  '{}'),
  (test.uid('dave'),    'dave@both.test',   '{}'),
  (test.uid('pat'),     'pat@talentiq.test','{}'),
  (test.uid('mallory'), 'mallory@else.test','{}');

insert into public.platform_admins (user_id) values (test.uid('pat'));

insert into public.organizations (name, slug) values ('Acme Recruiting', 'acme'), ('Beta Talent', 'beta');

-- "Organization Admin" is provisioned by trigger on organization insert; add the other roles.
insert into public.roles (organization_id, name, is_system) values
  (test.org('acme'), 'Recruiter', false),
  (test.org('beta'), 'HR Admin', true),
  (test.org('beta'), 'Recruiter', false);

insert into public.role_permissions (role_id, organization_id, permission_key)
select r.id, r.organization_id, p.key from public.roles r cross join public.permissions p
where r.name = 'HR Admin';
insert into public.role_permissions (role_id, organization_id, permission_key) values
  (test.role_id('acme', 'Recruiter'), test.org('acme'), 'members.view'),
  (test.role_id('beta', 'Recruiter'), test.org('beta'), 'roles.view');

insert into public.organization_memberships (organization_id, user_id) values
  (test.org('acme'), test.uid('alice')),
  (test.org('acme'), test.uid('bob')),
  (test.org('acme'), test.uid('dave')),
  (test.org('beta'), test.uid('carol')),
  (test.org('beta'), test.uid('dave'));

insert into public.membership_roles (membership_id, role_id, organization_id) values
  (test.membership('acme', 'alice'), test.role_id('acme', 'Organization Admin'), test.org('acme')),
  (test.membership('acme', 'bob'),   test.role_id('acme', 'Recruiter'),          test.org('acme')),
  (test.membership('beta', 'carol'), test.role_id('beta', 'HR Admin'),           test.org('beta'));

insert into public.platform_services (key, name) values ('resume_screening', 'Resume screening');
insert into public.organization_service_entitlements (organization_id, service_key, enabled) values
  (test.org('acme'), 'resume_screening', true),
  (test.org('beta'), 'resume_screening', false);

-- ---------------------------------------------------------------------------------------------
-- assertions
-- ---------------------------------------------------------------------------------------------

-- profile trigger + backfill
do $$
begin
  assert (select count(*) from public.profiles) = 6, 'every auth user gets a profile';
  assert (select full_name from public.profiles where id = test.uid('alice')) = 'Alice Admin', 'full_name copied from metadata';
  insert into auth.users (id, email) values (test.uid('newcomer'), 'new@x.test');
  assert exists (select 1 from public.profiles where id = test.uid('newcomer')), 'trigger creates profile for new user';
end $$;

-- schema: role names are per organization, case-insensitive
do $$
begin
  begin
    insert into public.roles (organization_id, name) values (test.org('acme'), '  recruiter ');
    raise exception 'duplicate role name accepted';
  exception when unique_violation then null; end;
end $$;

-- schema: a role from org A can never be attached to a membership in org B, even bypassing RLS
do $$
begin
  begin
    insert into public.membership_roles (membership_id, role_id, organization_id)
    values (test.membership('beta', 'dave'), test.role_id('acme', 'Recruiter'), test.org('beta'));
    raise exception 'cross-organization role assignment accepted';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.membership_roles (membership_id, role_id, organization_id)
    values (test.membership('beta', 'dave'), test.role_id('acme', 'Recruiter'), test.org('acme'));
    raise exception 'cross-organization role assignment accepted via organization_id mismatch';
  exception when foreign_key_violation then null; end;
end $$;

-- anon has no access at all
do $$
begin
  execute 'set local role anon';
  begin
    perform count(*) from public.organizations;
    raise exception 'anon could read organizations';
  exception when insufficient_privilege then null; end;
end $$;

-- tenant read isolation: a user in org A cannot read org B data
do $$
begin
  perform test.login('alice');
  assert (select count(*) from public.organizations) = 1, 'alice sees only her organization';
  assert (select slug from public.organizations) = 'acme', 'alice sees acme';
  assert (select count(*) from public.organization_memberships where organization_id = test.org('beta')) = 0, 'alice cannot read beta memberships';
  assert (select count(*) from public.roles where organization_id = test.org('beta')) = 0, 'alice cannot read beta roles';
  assert (select count(*) from public.organization_service_entitlements where organization_id = test.org('beta')) = 0, 'alice cannot read beta entitlements';
  assert (select count(*) from public.profiles) = 3, 'alice reads profiles of shared-organization members only (alice, bob, dave)';
  assert not exists (select 1 from public.profiles where id = test.uid('carol')), 'alice cannot read carol''s profile';
  assert (select count(*) from public.platform_admins) = 0, 'alice cannot list platform admins';
end $$;

-- a user may belong to multiple organizations
do $$
begin
  perform test.login('dave');
  assert (select count(*) from public.organizations) = 2, 'dave belongs to both organizations';
  assert (select count(*) from public.organization_memberships) = 2, 'dave sees his own memberships only';
end $$;

-- no membership: nothing visible except own profile
do $$
begin
  perform test.login('mallory');
  assert (select count(*) from public.organizations) = 0, 'mallory sees no organizations';
  assert (select count(*) from public.profiles) = 1, 'mallory sees only her own profile';
  assert (select count(*) from public.permissions) = 6, 'permission catalog is readable';
end $$;

-- authorization is permission-based, never role-name-based
do $$
begin
  perform test.login('bob'); -- role "Recruiter" with members.view only
  assert (select count(*) from public.organization_memberships) = 3, 'members.view lets bob read all acme memberships';
  assert (select count(*) from public.roles) = 1, 'without roles.view bob sees only his own assigned role';
  begin
    insert into public.roles (organization_id, name) values (test.org('acme'), 'Sneaky');
    raise exception 'bob created a role without roles.manage';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.membership_roles (membership_id, role_id, organization_id)
    values (test.membership('acme', 'dave'), test.role_id('acme', 'Recruiter'), test.org('acme'));
    raise exception 'bob assigned a role without members.manage';
  exception when insufficient_privilege then null; end;
end $$;

do $$
begin
  -- rename bob's role to "admin": the name must change nothing
  update public.roles set name = 'admin' where id = test.role_id('acme', 'Recruiter');
  perform test.login('bob');
  begin
    insert into public.roles (organization_id, name) values (test.org('acme'), 'Sneaky');
    raise exception 'a role named "admin" granted management rights';
  exception when insufficient_privilege then null; end;
end $$;
update public.roles set name = 'Recruiter' where name = 'admin';

-- tenant admin (all tenant permissions) can manage tenant things, but not platform things
do $$
declare new_role uuid;
begin
  perform test.login('alice');
  -- direct DML on the tenant integrity tables is revoked; the RPCs are the only mutation path
  new_role := public.create_organization_role(test.org('acme'), 'Interview Panel', null, array['roles.view']);
  perform public.set_organization_member_roles(test.org('acme'), test.membership('acme', 'bob'),
    array[test.role_id('acme', 'Recruiter'), new_role]);
  assert (select count(*) from public.membership_roles mr where mr.membership_id = test.membership('acme', 'bob')) = 2, 'bob now has two roles';
  update public.organizations set name = 'Acme Recruiting Ltd' where id = test.org('acme');
  assert (select name from public.organizations where id = test.org('acme')) = 'Acme Recruiting Ltd', 'organization.update lets alice rename';

  begin
    insert into public.roles (organization_id, name) values (test.org('beta'), 'Intruder');
    raise exception 'alice created a role in another organization';
  exception when insufficient_privilege then null; end;

  begin
    update public.organizations set is_active = false where id = test.org('acme');
    raise exception 'tenant changed organization status';
  exception when insufficient_privilege then null; end;
  begin
    update public.organizations set slug = 'acme-corp' where id = test.org('acme');
    raise exception 'tenant changed organization slug';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.roles where id = test.role_id('acme', 'Organization Admin');
    raise exception 'tenant deleted a system role';
  exception when insufficient_privilege then null; end;

  begin
    insert into public.organizations (name, slug) values ('Self Made', 'self-made');
    raise exception 'tenant created an organization';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.permissions (key, name, category) values ('jobs.create', 'x', 'x');
    raise exception 'tenant inserted a permission';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.platform_services (key, name) values ('free_stuff', 'x');
    raise exception 'tenant created a platform service';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.platform_admins (user_id) values (test.uid('alice'));
    raise exception 'tenant made herself platform admin';
  exception when insufficient_privilege then null; end;

  -- entitlements: readable, never writable by the tenant
  assert (select enabled from public.organization_service_entitlements where organization_id = test.org('acme')) = true, 'alice reads her entitlement';
  update public.organization_service_entitlements set enabled = false, limits = '{"seats": 999}' where organization_id = test.org('acme');
  assert (select limits from public.organization_service_entitlements where organization_id = test.org('acme')) = '{}'::jsonb, 'tenant update of entitlements silently affects zero rows';
  begin
    insert into public.organization_service_entitlements (organization_id, service_key) values (test.org('acme'), 'resume_screening');
    raise exception 'tenant inserted an entitlement';
  exception when insufficient_privilege then null; when unique_violation then raise exception 'tenant insert reached the table'; end;
end $$;

-- effective permissions RPC: own active membership in an active organization, union of all roles
do $$
begin
  perform test.login('bob'); -- Recruiter (members.view) + Interview Panel (roles.view)
  assert (select array_agg(p order by p) from public.get_my_organization_permissions(test.org('acme')) p) = array['members.view', 'roles.view'], 'bob: union of two roles with different permissions';
  assert (select count(*) from public.get_my_organization_permissions(test.org('beta'))) = 0, 'bob: nothing in an organization he does not belong to';
  perform test.login('alice');
  assert (select count(*) from public.get_my_organization_permissions(test.org('acme'))) = 6, 'alice: all six tenant permissions';
  perform test.login('pat'); -- platform admin, not a member
  assert (select count(*) from public.get_my_organization_permissions(test.org('acme'))) = 0, 'platform admin gets no tenant permissions from status alone';
  execute 'set local role anon';
  begin
    perform public.get_my_organization_permissions(test.org('acme'));
    raise exception 'anon could call the permissions RPC';
  exception when insufficient_privilege then null; end;
end $$;
update public.organization_memberships set is_active = false where user_id = test.uid('bob');
do $$
begin
  perform test.login('bob');
  assert (select count(*) from public.get_my_organization_permissions(test.org('acme'))) = 0, 'inactive membership yields no permissions';
end $$;
update public.organization_memberships set is_active = true where user_id = test.uid('bob');

-- platform admin: control plane without being a tenant member
do $$
begin
  perform test.login('pat');
  assert (select count(*) from public.organizations) = 2, 'platform admin sees every organization';
  assert not private.is_organization_member(test.org('acme')), 'platform admin is not silently a member';
  assert (select count(*) from public.organization_memberships) = 5, 'platform admin sees all memberships';
  update public.organization_service_entitlements set enabled = true, limits = '{"seats": 25}' where organization_id = test.org('beta');
  assert (select enabled from public.organization_service_entitlements where organization_id = test.org('beta')) = true, 'platform admin enables a service';
  insert into public.organizations (name, slug) values ('Gamma Hiring', 'gamma');
  assert (select count(*) from public.roles where organization_id = test.org('gamma')) = 1, 'new organization gets exactly one default role';
  assert (select count(*) from public.roles where organization_id = test.org('gamma') and name = 'Organization Admin' and is_system) = 1, 'default role is the Organization Admin system role';
  assert (select count(*) from public.role_permissions where organization_id = test.org('gamma')) = 6, 'default role carries the six management permissions';
  assert (select count(*) from public.organization_memberships where organization_id = test.org('gamma')) = 0, 'creating an organization does not make the platform admin a member';
  insert into public.platform_services (key, name) values ('job_posting', 'Job posting');
  update public.organizations set is_active = false where id = test.org('beta');
  assert (select is_active from public.organizations where id = test.org('beta')) = false, 'platform admin suspends an organization';
end $$;

-- provisioning invariant: an incomplete permission catalog makes the organization insert fail as a
-- whole (run as the owner, since only migrations may touch the catalog)
do $$
begin
  begin
    delete from public.permissions where key = 'roles.manage';
    insert into public.organizations (name, slug) values ('Broken Provisioning', 'broken');
    raise exception 'organization was created without its full default role';
  exception when raise_exception then
    assert sqlerrm like '%incomplete%', format('unexpected error: %s', sqlerrm);
  end;
  assert not exists (select 1 from public.organizations where slug = 'broken'), 'failed provisioning rolled back the organization';
  assert exists (select 1 from public.permissions where key = 'roles.manage'), 'catalog restored by sub-transaction rollback';
end $$;

-- entitlement helper and suspension semantics
do $$
begin
  perform test.login('carol'); -- HR Admin of the now-suspended beta
  assert test.has_service(test.org('acme'), 'resume_screening'), 'acme entitled';
  assert not test.has_service(test.org('beta'), 'resume_screening'), 'suspended organization has no services';
  assert (select count(*) from public.organizations) = 1, 'member of a suspended organization can still read it';
  assert (select count(*) from public.get_my_organization_permissions(test.org('beta'))) = 0, 'suspended organization yields no permissions';
  update public.organizations set name = 'Beta Talent Ltd' where id = test.org('beta');
  assert (select name from public.organizations where id = test.org('beta')) = 'Beta Talent', 'no tenant actions while suspended';
  begin
    insert into public.roles (organization_id, name) values (test.org('beta'), 'Blocked');
    raise exception 'tenant acted inside a suspended organization';
  exception when insufficient_privilege then null; end;
end $$;
update public.organizations set is_active = true where slug = 'beta';
update public.platform_services set is_active = false where key = 'resume_screening';
do $$
begin
  assert not test.has_service(test.org('acme'), 'resume_screening'), 'inactive platform service is not available';
end $$;
update public.platform_services set is_active = true where key = 'resume_screening';

-- ---------------------------------------------------------------------------------------------
-- Phase 2F: organization users & roles management
-- (state here: acme = alice [Organization Admin], bob [Recruiter: members.view, Interview Panel:
--  roles.view], dave [no roles]; beta = carol [HR Admin], dave; mallory/newcomer: no memberships)
-- ---------------------------------------------------------------------------------------------

-- expected-failure helper: runs a statement and returns the SQLSTATE it raised ('' when it succeeded)
create function test.sqlstate_of(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return '';
exception when others then
  return sqlstate;
end $$;
grant execute on function test.sqlstate_of(text) to authenticated, anon;

-- member directory ----------------------------------------------------------------------------
do $$
begin
  perform test.login('bob'); -- members.view
  assert (select count(*) from public.get_organization_members(test.org('acme'))) = 3, 'members.view lists all acme members';
  assert (select email from public.get_organization_members(test.org('acme')) where user_id = test.uid('alice')) = 'alice@acme.test', 'directory exposes member emails';
  assert (select role_names from public.get_organization_members(test.org('acme')) where user_id = test.uid('bob')) = array['Interview Panel', 'Recruiter'], 'directory lists every assigned role';
  assert (select count(*) from public.get_organization_members(test.org('beta'))) = 0, 'no directory for an organization bob does not belong to';
  perform test.login('dave'); -- member, no roles
  assert (select count(*) from public.get_organization_members(test.org('acme'))) = 0, 'without members.view the directory is empty';
  perform test.login('carol');
  assert (select count(*) from public.get_organization_members(test.org('beta'))) = 2, 'beta directory has its own members only';
  assert not exists (select 1 from public.get_organization_members(test.org('beta')) where user_id = test.uid('alice')), 'never another organization''s members';
  perform test.login('pat'); -- platform admin, no membership
  assert (select count(*) from public.get_organization_members(test.org('acme'))) = 0, 'platform admin status grants no directory access';
end $$;

-- add existing account by email -----------------------------------------------------------------
do $$
declare result record;
begin
  perform test.login('alice'); -- members.manage
  select * into result from public.add_organization_member_by_email(test.org('acme'), 'nobody@nowhere.test');
  assert result.status = 'not_found', 'unknown email is not found';
  select * into result from public.add_organization_member_by_email(test.org('acme'), '  Mallory@Else.TEST ');
  assert result.status = 'added' and result.membership_id = test.membership('acme', 'mallory'), 'existing account added by exact email (trimmed, case-insensitive)';
  assert (select count(*) from public.membership_roles where membership_id = test.membership('acme', 'mallory')) = 0, 'adding a member assigns no roles';
  select * into result from public.add_organization_member_by_email(test.org('acme'), 'mallory@else.test');
  assert result.status = 'already_member', 'active member is reported, not duplicated';
  assert (select count(*) from public.organization_memberships where user_id = test.uid('mallory')) = 1, 'still exactly one membership';

  perform test.login('bob'); -- members.view only
  assert test.sqlstate_of(format('select * from public.add_organization_member_by_email(%L, %L)', test.org('acme'), 'newcomer@x.test')) = '42501', 'members.manage required to add';
  perform test.login('pat');
  assert test.sqlstate_of(format('select * from public.add_organization_member_by_email(%L, %L)', test.org('acme'), 'newcomer@x.test')) = '42501', 'platform admin cannot add tenant members';
end $$;

-- role assignment (atomic, multi-role) ----------------------------------------------------------
do $$
begin
  perform test.login('alice');
  perform public.set_organization_member_roles(test.org('acme'), test.membership('acme', 'mallory'),
    array[test.role_id('acme', 'Recruiter'), test.role_id('acme', 'Interview Panel'), test.role_id('acme', 'Recruiter')]);
  assert (select count(*) from public.membership_roles where membership_id = test.membership('acme', 'mallory')) = 2, 'multiple roles assigned, duplicates collapsed';
  assert test.sqlstate_of(format('select public.set_organization_member_roles(%L, %L, %L)', test.org('acme'), test.membership('acme', 'mallory'), array[test.role_id('beta', 'HR Admin')])) = '22023', 'cross-organization role rejected';
  assert (select count(*) from public.membership_roles where membership_id = test.membership('acme', 'mallory')) = 2, 'rejected call changed nothing';
  assert test.sqlstate_of(format('select public.set_organization_member_roles(%L, %L, %L)', test.org('acme'), test.membership('beta', 'carol'), '{}'::uuid[])) = 'P0002', 'membership of another organization is not found';
  perform public.set_organization_member_roles(test.org('acme'), test.membership('acme', 'mallory'), '{}'::uuid[]);
  assert (select count(*) from public.membership_roles where membership_id = test.membership('acme', 'mallory')) = 0, 'empty role set allowed';
  perform test.login('bob');
  assert test.sqlstate_of(format('select public.set_organization_member_roles(%L, %L, %L)', test.org('acme'), test.membership('acme', 'mallory'), array[test.role_id('acme', 'Recruiter')])) = '42501', 'members.manage required to assign';
end $$;

-- membership status -----------------------------------------------------------------------------
do $$
declare result record;
begin
  perform test.login('alice');
  perform public.set_organization_member_roles(test.org('acme'), test.membership('acme', 'mallory'), array[test.role_id('acme', 'Recruiter')]);
  perform public.set_organization_member_status(test.org('acme'), test.membership('acme', 'mallory'), false);
  assert (select is_active from public.organization_memberships where id = test.membership('acme', 'mallory')) = false, 'membership deactivated';
  assert (select count(*) from public.membership_roles where membership_id = test.membership('acme', 'mallory')) = 1, 'deactivation keeps role assignments';
  assert test.sqlstate_of(format('select public.set_organization_member_status(%L, %L, false)', test.org('acme'), test.membership('acme', 'alice'))) = 'TQ003', 'callers cannot deactivate themselves';
  assert (select is_active from public.organization_memberships where id = test.membership('acme', 'alice')), 'alice still active';
  assert test.sqlstate_of(format('select public.set_organization_member_status(%L, %L, false)', test.org('acme'), test.membership('beta', 'carol'))) = 'P0002', 'membership of another organization is not found';
  select * into result from public.add_organization_member_by_email(test.org('acme'), 'mallory@else.test');
  assert result.status = 'reactivated', 'adding an inactive member reactivates the membership';
  assert (select is_active from public.organization_memberships where id = test.membership('acme', 'mallory')), 'reactivated';
  assert (select count(*) from public.membership_roles where membership_id = test.membership('acme', 'mallory')) = 1, 'reactivation restores the previous roles';
  perform test.login('bob');
  assert test.sqlstate_of(format('select public.set_organization_member_status(%L, %L, false)', test.org('acme'), test.membership('acme', 'mallory'))) = '42501', 'members.manage required to change status';
end $$;

-- deactivated member loses tenant access; suspended organization blocks administration ----------
do $$
begin
  perform test.login('alice');
  perform public.set_organization_member_status(test.org('acme'), test.membership('acme', 'mallory'), false);
  perform test.login('mallory');
  assert (select count(*) from public.organizations) = 0, 'deactivated member no longer sees the organization';
  assert (select count(*) from public.get_my_organization_permissions(test.org('acme'))) = 0, 'deactivated member has no permissions';
  perform test.login('alice');
  perform public.set_organization_member_status(test.org('acme'), test.membership('acme', 'mallory'), true);
end $$;
update public.organizations set is_active = false where slug = 'acme';
do $$
begin
  perform test.login('alice');
  assert (select count(*) from public.get_organization_members(test.org('acme'))) = 0, 'suspended organization: no directory';
  assert test.sqlstate_of(format('select * from public.add_organization_member_by_email(%L, %L)', test.org('acme'), 'newcomer@x.test')) = '42501', 'suspended organization: no member changes';
  assert test.sqlstate_of(format('select public.create_organization_role(%L, %L, null, %L)', test.org('acme'), 'Blocked', '{}'::text[])) = '42501', 'suspended organization: no role changes';
end $$;
update public.organizations set is_active = true where slug = 'acme';

-- role catalog ----------------------------------------------------------------------------------
do $$
begin
  perform test.login('bob'); -- roles.view via Interview Panel
  assert (select count(*) from public.get_organization_roles(test.org('acme'))) = 3, 'roles.view lists the organization roles';
  assert (select is_system from public.get_organization_roles(test.org('acme')) where name = 'Organization Admin'), 'system role flagged';
  assert (select cardinality(permission_keys) from public.get_organization_roles(test.org('acme')) where name = 'Organization Admin') = 6, 'system role bundle listed';
  assert (select member_count from public.get_organization_roles(test.org('acme')) where name = 'Recruiter') = 2, 'assignment counts (bob, mallory)';
  assert (select count(*) from public.get_organization_roles(test.org('beta'))) = 0, 'no roles from another organization';
  perform test.login('dave');
  assert (select count(*) from public.get_organization_roles(test.org('acme'))) = 0, 'without roles.view the catalog is empty';
  perform test.login('pat');
  assert (select count(*) from public.get_organization_roles(test.org('acme'))) = 0, 'platform admin status grants no catalog access';
end $$;

-- custom role create / update / delete ----------------------------------------------------------
do $$
declare
  new_role uuid;
  admin_role_before public.roles;
begin
  perform test.login('alice');
  new_role := public.create_organization_role(test.org('acme'), '  Screening Lead ', ' Reviews screenings ', array['members.view', 'members.view', 'roles.view']);
  assert (select name from public.roles where id = new_role) = 'Screening Lead', 'name trimmed';
  assert (select description from public.roles where id = new_role) = 'Reviews screenings', 'description trimmed';
  assert (select is_system from public.roles where id = new_role) = false, 'created role is always custom';
  assert (select count(*) from public.role_permissions where role_id = new_role) = 2, 'permission bundle created atomically, duplicates collapsed';
  assert test.sqlstate_of(format('select public.create_organization_role(%L, %L, null, %L)', test.org('acme'), 'Broken', array['members.view', 'jobs.create'])) = '22023', 'unknown permission key rejected';
  assert not exists (select 1 from public.roles where name = 'Broken'), 'rejected creation left nothing behind';
  assert test.sqlstate_of(format('select public.create_organization_role(%L, %L, null, %L)', test.org('acme'), 'screening lead', '{}'::text[])) = '23505', 'duplicate role name (case-insensitive) rejected';
  assert test.sqlstate_of(format('select public.create_organization_role(%L, %L, null, %L)', test.org('beta'), 'Intruder', '{}'::text[])) = '42501', 'no role creation in another organization';

  perform public.update_organization_role(test.org('acme'), new_role, 'Screening Manager', '', array['organization.view']);
  assert (select name from public.roles where id = new_role) = 'Screening Manager', 'renamed';
  assert (select description from public.roles where id = new_role) is null, 'blank description stored as null';
  assert (select array_agg(permission_key) from public.role_permissions where role_id = new_role) = array['organization.view'], 'permission bundle replaced atomically';
  assert test.sqlstate_of(format('select public.update_organization_role(%L, %L, %L, null, %L)', test.org('acme'), test.role_id('beta', 'HR Admin'), 'Hijack', '{}'::text[])) = 'P0002', 'cross-organization role update not found';
  assert test.role_id('beta', 'HR Admin') is not null, 'other organization untouched';
  assert test.sqlstate_of(format('select public.update_organization_role(%L, %L, %L, null, %L)', test.org('acme'), test.role_id('acme', 'Organization Admin'), 'Owner', array['members.view'])) = 'TQ001', 'system role cannot be updated through the RPC';
  assert (select count(*) from public.role_permissions where role_id = test.role_id('acme', 'Organization Admin')) = 6, 'system role bundle intact';

  -- direct table access is hardened too
  assert test.sqlstate_of(format('insert into public.roles (organization_id, name, is_system) values (%L, %L, true)', test.org('acme'), 'Fake System')) = '42501', 'tenant cannot insert a system role';
  assert test.sqlstate_of(format('update public.roles set name = %L where id = %L', 'Owner', test.role_id('acme', 'Organization Admin'))) = '42501', 'tenant cannot rename the system role';
  assert test.sqlstate_of(format('update public.roles set is_system = true where id = %L', new_role)) = '42501', 'tenant cannot promote a custom role to system';
  assert test.sqlstate_of(format('delete from public.role_permissions where role_id = %L', test.role_id('acme', 'Organization Admin'))) = '42501', 'tenant cannot strip system role permissions';
  assert test.sqlstate_of(format('insert into public.role_permissions (role_id, organization_id, permission_key) values (%L, %L, %L)', test.role_id('acme', 'Organization Admin'), test.org('acme'), 'members.view')) = '42501', 'tenant cannot add system role permissions';
  assert (select count(*) from public.role_permissions where role_id = test.role_id('acme', 'Organization Admin')) = 6, 'system role bundle still intact';
  -- a tenant has no legitimate UPDATE on a system role: even a nominal no-op would persist a new
  -- updated_at through the set_updated_at trigger, so every UPDATE is rejected outright
  admin_role_before := (select r from public.roles r where r.id = test.role_id('acme', 'Organization Admin'));
  assert test.sqlstate_of(format('update public.roles set name = name where id = %L', test.role_id('acme', 'Organization Admin'))) = '42501', 'no-op name update rejected';
  assert test.sqlstate_of(format('update public.roles set updated_at = updated_at where id = %L', test.role_id('acme', 'Organization Admin'))) = '42501', 'no-op updated_at update rejected';
  assert test.sqlstate_of(format('update public.roles set description = description where id = %L', test.role_id('acme', 'Organization Admin'))) = '42501', 'no-op description update rejected';
  assert test.sqlstate_of(format('update public.roles set created_at = now() - interval ''1 day'' where id = %L', test.role_id('acme', 'Organization Admin'))) = '42501', 'created_at change rejected';
  assert test.sqlstate_of(format('update public.roles set is_system = false where id = %L', test.role_id('acme', 'Organization Admin'))) = '42501', 'is_system transition rejected';
  assert test.sqlstate_of(format('update public.roles set description = null where id = %L', test.role_id('acme', 'Organization Admin'))) = '42501', 'tenant cannot clear the system role description';
  assert (select r from public.roles r where r.id = test.role_id('acme', 'Organization Admin')) is not distinct from admin_role_before, 'system role row is unchanged after every rejected update';

  -- delete safety
  perform public.set_organization_member_roles(test.org('acme'), test.membership('acme', 'mallory'), array[new_role]);
  assert test.sqlstate_of(format('select public.delete_organization_role(%L, %L)', test.org('acme'), new_role)) = 'TQ002', 'assigned custom role cannot be deleted';
  assert exists (select 1 from public.roles where id = new_role), 'role kept';
  assert test.sqlstate_of(format('select public.delete_organization_role(%L, %L)', test.org('acme'), test.role_id('acme', 'Organization Admin'))) = 'TQ001', 'system role cannot be deleted through the RPC';
  perform public.set_organization_member_roles(test.org('acme'), test.membership('acme', 'mallory'), '{}'::uuid[]);
  perform public.delete_organization_role(test.org('acme'), new_role);
  assert not exists (select 1 from public.roles where id = new_role), 'unassigned custom role deleted';
  assert not exists (select 1 from public.role_permissions where role_id = new_role), 'its permissions are gone';

  perform test.login('bob'); -- roles.view only
  assert test.sqlstate_of(format('select public.create_organization_role(%L, %L, null, %L)', test.org('acme'), 'Sneaky', '{}'::text[])) = '42501', 'roles.manage required to create';
  assert test.sqlstate_of(format('select public.delete_organization_role(%L, %L)', test.org('acme'), test.role_id('acme', 'Recruiter'))) = '42501', 'roles.manage required to delete';
  perform test.login('pat');
  assert test.sqlstate_of(format('select public.create_organization_role(%L, %L, null, %L)', test.org('acme'), 'Platform Sneak', '{}'::text[])) = '42501', 'platform admin cannot manage tenant roles';
end $$;

-- system-role permission rows cannot be moved in or out by a tenant identity, even on UPDATE.
-- RLS grants authenticated no UPDATE on role_permissions, so the trigger invariant is exercised as
-- the owner (bypassing RLS) while carrying a tenant JWT subject: only the trigger stands in the way.
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', test.uid('alice'), 'role', 'authenticated')::text, true);
  assert test.sqlstate_of(format('update public.role_permissions set role_id = %L where role_id = %L and permission_key = %L',
    test.role_id('acme', 'Organization Admin'), test.role_id('acme', 'Recruiter'), 'members.view')) = '42501', 'a row cannot be moved INTO a system role (NEW side)';
  assert test.sqlstate_of(format('update public.role_permissions set role_id = %L where role_id = %L and permission_key = %L',
    test.role_id('acme', 'Recruiter'), test.role_id('acme', 'Organization Admin'), 'roles.view')) = '42501', 'a row cannot be moved OUT of a system role (OLD side)';
  assert test.sqlstate_of(format('update public.role_permissions set organization_id = organization_id where role_id = %L',
    test.role_id('acme', 'Recruiter'))) = '', 'custom role permission rows are not affected by the guard';
  assert (select count(*) from public.role_permissions where role_id = test.role_id('acme', 'Organization Admin')) = 6, 'system role bundle intact after UPDATE attempts';
end $$;

-- role names never authorize: a role called "Organization Admin" elsewhere grants nothing extra ----
do $$
declare lookalike uuid;
begin
  perform test.login('carol'); -- HR Admin in beta
  lookalike := public.create_organization_role(test.org('beta'), 'Organisation Admin', null, '{}'::text[]);
  perform public.set_organization_member_roles(test.org('beta'), test.membership('beta', 'dave'), array[lookalike]);
  perform test.login('dave');
  assert (select count(*) from public.get_organization_roles(test.org('beta'))) = 0, 'a grand role name without permissions grants nothing';
  perform test.login('carol');
  perform public.set_organization_member_roles(test.org('beta'), test.membership('beta', 'dave'), '{}'::uuid[]);
  perform public.delete_organization_role(test.org('beta'), lookalike);
end $$;

-- anonymous ---------------------------------------------------------------------------------------
do $$
begin
  execute 'set local role anon';
  assert test.sqlstate_of(format('select * from public.get_organization_members(%L)', test.org('acme'))) = '42501', 'anon cannot call member RPCs';
  assert test.sqlstate_of(format('select public.create_organization_role(%L, %L, null, %L)', test.org('acme'), 'X', '{}'::text[])) = '42501', 'anon cannot call role RPCs';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Phase 2F.1: member invitations & account onboarding
-- (acme: alice [Organization Admin], bob [members.view + roles.view], dave [no roles],
--  mallory [no roles]; beta: carol [HR Admin], dave; pat: platform admin with no membership)
-- ---------------------------------------------------------------------------------------------

create function test.invitation(slug text, addr text) returns uuid
language sql stable security definer as $$
  select i.id from public.organization_invitations i
  join public.organizations o on o.id = i.organization_id
  where o.slug = invitation.slug and i.email = invitation.addr and i.status = 'pending'
$$;
grant execute on function test.invitation(text, text) to authenticated, anon;

-- assertions need to inspect invitation rows while acting as a tenant identity; the table itself is
-- deliberately unreachable through the Data API, so reads go through this owner-context helper
create function test.all_invitations() returns setof public.organization_invitations
language sql stable security definer as $$ select * from public.organization_invitations $$;
grant execute on function test.all_invitations() to authenticated, anon;

-- the Phase 2G management helpers are internal to the RPCs; assertions inspect them through this
-- owner-context wrapper rather than granting application roles EXECUTE just to run the tests
create function test.has_recovery_manager(org_id uuid) returns boolean
language sql stable security definer as $$ select private.organization_has_recovery_manager(org_id) $$;
grant execute on function test.has_recovery_manager(uuid) to authenticated, anon;

-- administrator side ----------------------------------------------------------------------------
do $$
declare result record;
begin
  perform test.login('alice'); -- members.manage
  select * into result from public.prepare_organization_invitation(test.org('acme'), 'fresh@invite.test');
  assert result.status = 'invite_ready' and result.invitation_id is not null, 'invitation prepared for an unknown address';
  select * into result from public.prepare_organization_invitation(test.org('acme'), '  SECOND@Invite.TEST ');
  assert result.status = 'invite_ready', 'second invitation prepared';
  assert exists (select 1 from test.all_invitations() where email = 'second@invite.test'), 'email stored normalized (trimmed, lowercased)';
  assert (select invited_by from test.all_invitations() where email = 'fresh@invite.test') = test.uid('alice'), 'invited_by recorded';
  assert (select status from test.all_invitations() where email = 'fresh@invite.test') = 'pending', 'starts pending';
  assert (select count(*) from public.organization_memberships where organization_id = test.org('acme')) = 4, 'preparing an invitation creates no membership';

  select * into result from public.prepare_organization_invitation(test.org('acme'), 'FRESH@invite.test');
  assert result.status = 'already_invited', 'duplicate pending invitation refused (case-insensitively)';
  select * into result from public.prepare_organization_invitation(test.org('acme'), 'bob@acme.test');
  assert result.status = 'account_exists', 'an existing account is reported instead of invited';
end $$;

do $$
declare result record;
begin
  -- a different organization may invite the same address independently
  perform test.login('carol');
  select * into result from public.prepare_organization_invitation(test.org('beta'), 'fresh@invite.test');
  assert result.status = 'invite_ready', 'another organization can invite the same address';
  assert (select count(*) from test.all_invitations() where email = 'fresh@invite.test' and status = 'pending') = 2, 'two independent pending invitations';
  assert (select count(*) from public.get_organization_invitations(test.org('beta'))) = 1, 'beta sees only its own invitation';
  assert (select count(*) from public.get_organization_invitations(test.org('acme'))) = 0, 'carol cannot see acme invitations';
end $$;

do $$
begin
  perform test.login('bob'); -- members.view, not members.manage
  assert (select count(*) from public.get_organization_invitations(test.org('acme'))) = 2, 'members.view lists pending invitations';
  assert (select invited_by_email from public.get_organization_invitations(test.org('acme')) where email = 'fresh@invite.test') = 'alice@acme.test', 'inviter shown';
  assert test.sqlstate_of(format('select * from public.prepare_organization_invitation(%L, %L)', test.org('acme'), 'nope@invite.test')) = '42501', 'members.manage required to invite';
  assert test.sqlstate_of(format('select public.revoke_organization_invitation(%L, %L)', test.org('acme'), test.invitation('acme', 'second@invite.test'))) = '42501', 'members.manage required to revoke';

  perform test.login('dave'); -- member without members.view
  assert (select count(*) from public.get_organization_invitations(test.org('acme'))) = 0, 'without members.view no invitations are listed';

  perform test.login('pat'); -- platform admin, no membership anywhere
  assert (select count(*) from public.get_organization_invitations(test.org('acme'))) = 0, 'platform admin status does not list tenant invitations';
  assert test.sqlstate_of(format('select * from public.prepare_organization_invitation(%L, %L)', test.org('acme'), 'nope@invite.test')) = '42501', 'platform admin cannot invite into a tenant';
  assert test.sqlstate_of(format('select public.revoke_organization_invitation(%L, %L)', test.org('acme'), test.invitation('acme', 'second@invite.test'))) = '42501', 'platform admin cannot revoke a tenant invitation';
end $$;

-- revoke ----------------------------------------------------------------------------------------
do $$
begin
  perform test.login('alice');
  perform public.revoke_organization_invitation(test.org('acme'), test.invitation('acme', 'second@invite.test'));
  assert (select status from test.all_invitations() where email = 'second@invite.test') = 'revoked', 'invitation revoked';
  assert (select revoked_at from test.all_invitations() where email = 'second@invite.test') is not null, 'revoked_at set';
  assert (select count(*) from public.get_organization_invitations(test.org('acme'))) = 1, 'revoked invitations leave the pending list';
  assert test.sqlstate_of(format('select public.revoke_organization_invitation(%L, %L)', test.org('acme'), (select id from test.all_invitations() where email = 'second@invite.test'))) = '22023', 'only pending invitations can be revoked';
  assert test.sqlstate_of(format('select public.revoke_organization_invitation(%L, %L)', test.org('acme'), test.invitation('beta', 'fresh@invite.test'))) = 'P0002', 'an invitation of another organization is not found';
end $$;

-- suspended organization --------------------------------------------------------------------------
update public.organizations set is_active = false where slug = 'acme';
do $$
begin
  perform test.login('alice');
  assert test.sqlstate_of(format('select * from public.prepare_organization_invitation(%L, %L)', test.org('acme'), 'blocked@invite.test')) = '42501', 'suspended organization cannot invite';
  assert test.sqlstate_of(format('select public.revoke_organization_invitation(%L, %L)', test.org('acme'), test.invitation('acme', 'fresh@invite.test'))) = '42501', 'suspended organization cannot revoke';
  assert (select count(*) from public.get_organization_invitations(test.org('acme'))) = 0, 'suspended organization lists nothing';
end $$;
update public.organizations set is_active = true where slug = 'acme';

-- existing-account interaction ---------------------------------------------------------------------
-- inviteUserByEmail creates an UNCONFIRMED auth row before acceptance; the pending invitation must
-- still win, and the unconfirmed account must never be addable on its own
insert into auth.users (id, email, email_confirmed_at) values (md5('fresh')::uuid, 'fresh@invite.test', null);
do $$
declare result record;
begin
  perform test.login('alice');
  select * into result from public.add_organization_member_by_email(test.org('acme'), 'fresh@invite.test');
  assert result.status = 'already_invited', 'a pending invitation blocks the direct add even though the account now exists';
  assert not exists (select 1 from public.organization_memberships where user_id = md5('fresh')::uuid), 'no membership created behind the invitation';

  -- every pre-existing outcome is preserved
  select * into result from public.add_organization_member_by_email(test.org('acme'), 'nobody@nowhere.test');
  assert result.status = 'not_found', 'unknown address still not_found';
  select * into result from public.add_organization_member_by_email(test.org('acme'), 'new@x.test');
  assert result.status = 'added', 'an uninvited existing account is still added immediately';
  select * into result from public.add_organization_member_by_email(test.org('acme'), 'new@x.test');
  assert result.status = 'already_member', 'active membership still already_member';
  perform public.set_organization_member_status(test.org('acme'), test.membership('acme', 'newcomer'), false);
  select * into result from public.add_organization_member_by_email(test.org('acme'), 'new@x.test');
  assert result.status = 'reactivated', 'inactive membership still reactivates';
end $$;


-- an unconfirmed invited account is never addable, before or after the invitation is revoked -------
do $$
declare result record;
begin
  perform test.login('alice');
  select * into result from public.prepare_organization_invitation(test.org('acme'), 'ghost@invite.test');
  assert result.status = 'invite_ready', 'ghost invited';
end $$;
insert into auth.users (id, email, email_confirmed_at) values (md5('ghost')::uuid, 'ghost@invite.test', null);

do $$
declare result record;
begin
  perform test.login('alice');
  -- A: pending invitation wins while the unconfirmed account exists
  select * into result from public.add_organization_member_by_email(test.org('acme'), 'ghost@invite.test');
  assert result.status = 'already_invited', 'pending invitation blocks the add';
  assert not exists (select 1 from public.organization_memberships m where m.user_id = md5('ghost')::uuid), 'A: no membership';

  -- B: after revoking, the leftover unconfirmed account still cannot be added
  perform public.revoke_organization_invitation(test.org('acme'), test.invitation('acme', 'ghost@invite.test'));
  select * into result from public.add_organization_member_by_email(test.org('acme'), 'ghost@invite.test');
  assert result.status = 'unconfirmed_account', 'B: a revoked invitation leaves an unusable account, not an addable one';
  assert not exists (select 1 from public.organization_memberships m where m.user_id = md5('ghost')::uuid), 'B: no membership';
  -- Phase 2G: the address is no longer stranded - a NEW pending invitation is issued and the
  -- revoked row is kept as history rather than being reopened
  select * into result from public.prepare_organization_invitation(test.org('acme'), 'ghost@invite.test');
  assert result.status = 'reinvite_ready', 'B: a stranded unconfirmed address can be invited again';
  assert result.invitation_id is not null, 'B: a new invitation id is returned';
  assert (select count(*) from test.all_invitations() where email = 'ghost@invite.test' and status = 'pending') = 1, 'B: exactly one pending invitation';
  assert (select count(*) from test.all_invitations() where email = 'ghost@invite.test' and status = 'revoked') = 1, 'B: the revoked row stays revoked';
  assert (select id from test.all_invitations() where email = 'ghost@invite.test' and status = 'pending') <> (select id from test.all_invitations() where email = 'ghost@invite.test' and status = 'revoked'), 'B: it is a new row, not a reopened one';
  select * into result from public.add_organization_member_by_email(test.org('acme'), 'ghost@invite.test');
  assert result.status = 'already_invited', 'B: the fresh pending invitation blocks the direct add again';
  assert not exists (select 1 from public.organization_memberships m where m.user_id = md5('ghost')::uuid), 'B: still no membership';
end $$;

-- C: an unconfirmed account that was never invited here is equally unusable
insert into auth.users (id, email, email_confirmed_at) values (md5('stray')::uuid, 'stray@invite.test', null);
do $$
declare result record;
begin
  perform test.login('alice');
  select * into result from public.add_organization_member_by_email(test.org('acme'), 'stray@invite.test');
  assert result.status = 'unconfirmed_account', 'C: unconfirmed account refused';
  assert not exists (select 1 from public.organization_memberships m where m.user_id = md5('stray')::uuid), 'C: no membership';
  select * into result from public.prepare_organization_invitation(test.org('acme'), 'stray@invite.test');
  assert result.status = 'reinvite_ready', 'C: an unconfirmed account with no invitation can be invited (Phase 2G)';
  assert (select count(*) from test.all_invitations() where email = 'stray@invite.test' and status = 'pending') = 1, 'C: one pending invitation created';

  -- D/E: confirmed accounts keep every previous outcome
  select * into result from public.add_organization_member_by_email(test.org('acme'), 'mallory@else.test');
  assert result.status = 'already_member', 'D: confirmed active member unchanged';
  perform public.set_organization_member_status(test.org('acme'), test.membership('acme', 'mallory'), false);
  select * into result from public.add_organization_member_by_email(test.org('acme'), 'mallory@else.test');
  assert result.status = 'reactivated', 'E: confirmed inactive membership still reactivates';
end $$;

-- recipient side ------------------------------------------------------------------------------------
do $$
begin
  perform test.login('dave'); -- an unrelated signed-in account
  assert (select count(*) from public.get_my_organization_invitation(test.invitation('acme', 'fresh@invite.test'))) = 0, 'an invitation addressed to someone else is invisible';
  assert test.sqlstate_of(format('select * from public.accept_organization_invitation(%L)', test.invitation('acme', 'fresh@invite.test'))) = 'P0002', 'a stranger cannot accept someone else''s invitation';
  assert (select count(*) from public.organization_memberships m where m.user_id = test.uid('dave')) = 2, 'the failed attempt created no membership (dave still belongs to acme and beta only)';

  execute 'set local role anon';
  assert test.sqlstate_of(format('select * from public.accept_organization_invitation(%L)', test.invitation('acme', 'fresh@invite.test'))) = '42501', 'anonymous cannot accept';
end $$;

-- A/B: an unconfirmed account cannot read or accept its own invitation, even though the address
-- matches - the database enforces confirmation independently of the /auth/confirm UI
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', md5('fresh')::uuid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  assert (select count(*) from public.get_my_organization_invitation(test.invitation('acme', 'fresh@invite.test'))) = 0, 'A: unconfirmed caller reads nothing';
  assert test.sqlstate_of(format('select * from public.accept_organization_invitation(%L)', test.invitation('acme', 'fresh@invite.test'))) = 'P0002', 'B: unconfirmed caller cannot accept, and cannot tell why';
  assert not exists (select 1 from public.organization_memberships m where m.user_id = md5('fresh')::uuid), 'B: no membership';
end $$;
do $$
begin
  assert (select status from test.all_invitations() where email = 'fresh@invite.test' and organization_id = test.org('acme')) = 'pending', 'B: the invitation is still pending';
end $$;

-- C: verifying the emailed token confirms the address, which is what the real invite link does
update auth.users set email_confirmed_at = now() where id = md5('fresh')::uuid;

do $$
declare invitation_row record;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', md5('fresh')::uuid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select * into invitation_row from public.get_my_organization_invitation(test.invitation('acme', 'fresh@invite.test'));
  assert invitation_row.organization_slug = 'acme', 'the recipient can read their own invitation';
  assert invitation_row.email = 'fresh@invite.test', 'it carries the invited address';
  assert (select count(*) from public.get_my_organization_invitation(test.invitation('beta', 'fresh@invite.test'))) = 1, 'the same person sees their other organization''s invitation too';
end $$;

-- acceptance (C continued: a confirmed recipient can accept) -------------------------------------------
do $$
declare result record; new_membership uuid;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', md5('fresh')::uuid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select * into result from public.accept_organization_invitation(test.invitation('acme', 'fresh@invite.test'));
  assert result.organization_slug = 'acme', 'acceptance returns the workspace destination';

  select id into new_membership from public.organization_memberships
  where organization_id = test.org('acme') and user_id = md5('fresh')::uuid;
  assert new_membership is not null, 'membership created';
  assert (select is_active from public.organization_memberships where id = new_membership), 'membership is active';
  assert (select count(*) from public.membership_roles mr where mr.membership_id = new_membership) = 0, 'accepted member starts with zero roles';
end $$;

do $$
declare accepted public.organization_invitations;
begin
  select * into accepted from test.all_invitations() where email = 'fresh@invite.test' and organization_id = test.org('acme');
  assert accepted.status = 'accepted', 'invitation marked accepted';
  assert accepted.accepted_at is not null, 'accepted_at recorded';
  assert accepted.accepted_user_id = md5('fresh')::uuid, 'accepted_user_id recorded';
end $$;

do $$
declare result record;
begin
  -- double acceptance is idempotent and creates no second membership
  perform set_config('request.jwt.claims', json_build_object('sub', md5('fresh')::uuid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select * into result from public.accept_organization_invitation((select id from test.all_invitations() where email = 'fresh@invite.test' and organization_id = test.org('acme')));
  assert result.organization_slug = 'acme', 're-acceptance returns the same destination';
  assert (select count(*) from public.organization_memberships where organization_id = test.org('acme') and user_id = md5('fresh')::uuid) = 1, 'still exactly one membership';
end $$;

-- a revoked invitation can never be accepted; a suspended organization blocks acceptance ------------
do $$
begin
  perform test.login('alice');
  perform public.prepare_organization_invitation(test.org('acme'), 'revoked@invite.test');
end $$;
-- the invite email creates the (unconfirmed) account, then the administrator changes their mind
insert into auth.users (id, email, email_confirmed_at) values (md5('revoked')::uuid, 'revoked@invite.test', null);
do $$
begin
  perform test.login('alice');
  perform public.revoke_organization_invitation(test.org('acme'), (select id from test.all_invitations() where email = 'revoked@invite.test' and status = 'pending'));

  perform set_config('request.jwt.claims', json_build_object('sub', md5('revoked')::uuid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  assert test.sqlstate_of(format('select * from public.accept_organization_invitation(%L)', (select id from test.all_invitations() where email = 'revoked@invite.test'))) = 'P0002', 'a revoked invitation cannot be accepted';
  assert not exists (select 1 from public.organization_memberships where user_id = md5('revoked')::uuid), 'no membership created from a revoked invitation';
end $$;

update public.organizations set is_active = false where slug = 'beta';
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', md5('fresh')::uuid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  assert test.sqlstate_of(format('select * from public.accept_organization_invitation(%L)', test.invitation('beta', 'fresh@invite.test'))) = '42501', 'a suspended organization cannot be joined';
  assert not exists (select 1 from public.organization_memberships where user_id = md5('fresh')::uuid and organization_id = test.org('beta')), 'no membership in the suspended organization';
end $$;
update public.organizations set is_active = true where slug = 'beta';

-- acceptance reactivates a previously deactivated membership and keeps its roles -------------------
-- (a defensive branch: the RPCs refuse to invite an address that already has an account, so the
--  state is set up directly as the owner rather than through the administrator flow)
insert into auth.users (id, email, email_confirmed_at) values (md5('returner')::uuid, 'returner@invite.test', now());
insert into public.organization_memberships (organization_id, user_id, is_active)
values ((select id from public.organizations where slug = 'acme'), md5('returner')::uuid, false);
insert into public.membership_roles (membership_id, role_id, organization_id)
select m.id, r.id, m.organization_id
from public.organization_memberships m
join public.roles r on r.organization_id = m.organization_id and r.name = 'Recruiter'
where m.user_id = md5('returner')::uuid;
insert into public.organization_invitations (organization_id, email)
values ((select id from public.organizations where slug = 'acme'), 'returner@invite.test');

do $$
declare result record; returner_membership uuid;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', md5('returner')::uuid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select * into result from public.accept_organization_invitation(test.invitation('acme', 'returner@invite.test'));
  assert result.organization_slug = 'acme', 'returning member accepted';
  select id into returner_membership from public.organization_memberships
  where organization_id = test.org('acme') and user_id = md5('returner')::uuid;
  assert (select is_active from public.organization_memberships where id = returner_membership), 'existing membership reactivated';
  assert (select count(*) from public.organization_memberships where user_id = md5('returner')::uuid) = 1, 'no duplicate membership';
  assert (select count(*) from public.membership_roles mr where mr.membership_id = returner_membership) = 1, 'previous role assignments preserved';
end $$;

-- the direct table is unreachable through the Data API ---------------------------------------------
do $$
begin
  perform test.login('alice');
  assert test.sqlstate_of('select count(*) from public.organization_invitations') = '42501', 'tenant admins cannot read the table directly';
  assert test.sqlstate_of(format('insert into public.organization_invitations (organization_id, email) values (%L, %L)', test.org('acme'), 'sneaky@invite.test')) = '42501', 'tenant admins cannot insert directly';
  execute 'set local role anon';
  assert test.sqlstate_of('select count(*) from public.organization_invitations') = '42501', 'anonymous cannot read the table';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Phase 2G: security & integrity hardening
-- ---------------------------------------------------------------------------------------------

-- role description bound ------------------------------------------------------------------------
do $$
declare new_role uuid;
begin
  perform test.login('alice');
  new_role := public.create_organization_role(test.org('acme'), 'Desc Null', null, '{}'::text[]);
  assert (select r.description from public.roles r where r.id = new_role) is null, 'null description allowed';
  perform public.update_organization_role(test.org('acme'), new_role, 'Desc Empty', '', '{}'::text[]);
  assert (select r.description from public.roles r where r.id = new_role) is null, 'blank description is stored as null';
  perform public.update_organization_role(test.org('acme'), new_role, 'Desc 500', repeat('d', 500), '{}'::text[]);
  assert (select char_length(r.description) from public.roles r where r.id = new_role) = 500, 'exactly 500 characters accepted';
  assert test.sqlstate_of(format('select public.update_organization_role(%L, %L, %L, %L, %L)', test.org('acme'), new_role, 'Desc 501', repeat('d', 501), '{}'::text[])) = '23514', 'update path: 501 characters refused by the database';
  assert (select char_length(r.description) from public.roles r where r.id = new_role) = 500, 'the rejected update changed nothing';
  assert test.sqlstate_of(format('select public.create_organization_role(%L, %L, %L, %L)', test.org('acme'), 'Too Long', repeat('d', 501), '{}'::text[])) = '23514', 'create path: 501 characters refused by the database';
  assert not exists (select 1 from public.roles r where r.name = 'Too Long'), 'nothing was created';
  perform public.delete_organization_role(test.org('acme'), new_role);
end $$;

-- the tenant integrity tables are RPC-only: no authenticated DML at all ---------------------------
do $$
begin
  perform test.login('alice'); -- holds every tenant permission
  assert test.sqlstate_of(format('update public.organization_memberships set is_active = false where id = %L', test.membership('acme', 'bob'))) = '42501', 'no direct membership write';
  assert test.sqlstate_of(format('insert into public.roles (organization_id, name) values (%L, %L)', test.org('acme'), 'Direct')) = '42501', 'no direct role insert';
  assert test.sqlstate_of(format('update public.roles set name = %L where id = %L', 'Renamed', test.role_id('acme', 'Recruiter'))) = '42501', 'no direct role update';
  assert test.sqlstate_of(format('delete from public.roles where id = %L', test.role_id('acme', 'Recruiter'))) = '42501', 'no direct role delete';
  assert test.sqlstate_of(format('delete from public.role_permissions where role_id = %L', test.role_id('acme', 'Recruiter'))) = '42501', 'no direct permission delete';
  assert test.sqlstate_of(format('delete from public.membership_roles where membership_id = %L', test.membership('acme', 'bob'))) = '42501', 'no direct assignment delete';
  -- reads still work through RLS
  assert (select count(*) from public.roles r where r.organization_id = test.org('acme')) > 0, 'reads are unaffected';
  perform test.login('pat'); -- platform admin
  assert test.sqlstate_of(format('update public.organization_memberships set is_active = false where id = %L', test.membership('acme', 'bob'))) = '42501', 'platform admin has no direct tenant DML either';
end $$;

-- the system-role guards remain functional defence in depth (proved with the grants temporarily
-- restored inside a transaction that is rolled back, so production privileges are unchanged)
begin;
grant insert, update, delete on public.roles, public.role_permissions to authenticated;
do $$
begin
  perform test.login('alice');
  assert test.sqlstate_of(format('insert into public.roles (organization_id, name, is_system) values (%L, %L, true)', test.org('acme'), 'Fake System')) = '42501', 'guard still blocks system-role insert';
  assert test.sqlstate_of(format('update public.roles set name = name where id = %L', test.role_id('acme', 'Organization Admin'))) = '42501', 'guard still blocks any system-role update';
  assert test.sqlstate_of(format('delete from public.roles where id = %L', test.role_id('acme', 'Organization Admin'))) = '42501', 'guard still blocks system-role delete';
  assert test.sqlstate_of(format('delete from public.role_permissions where role_id = %L', test.role_id('acme', 'Organization Admin'))) = '42501', 'guard still blocks system-role permission changes';
end $$;
rollback;
do $$
begin
  perform test.login('alice');
  assert test.sqlstate_of(format('insert into public.roles (organization_id, name) values (%L, %L)', test.org('acme'), 'Direct2')) = '42501', 'grants really were rolled back';
end $$;

-- meta-test: no function in the private schema is executable by anon or authenticated except the
-- helpers the RPCs and policies genuinely need, and every one of them pins search_path
do $$
declare offender text;
begin
  select string_agg(p.proname, ', ') into offender
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.prokind = 'f'
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
  assert offender is null, format('private functions without a pinned search_path: %s', offender);

  select string_agg(p.proname, ', ') into offender
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.prokind = 'f'
    and has_function_privilege('anon', p.oid, 'execute');
  assert offender is null, format('private functions executable by anon: %s', offender);

  select string_agg(p.proname, ', ') into offender
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
    and has_function_privilege('anon', p.oid, 'execute');
  assert offender is null, format('public functions executable by anon: %s', offender);

  -- Minimal authenticated surface in the private schema: exactly the four helpers RLS policies
  -- reference directly, which the querying role must therefore be able to execute. Anything else
  -- appearing here means a grant crept back in.
  select string_agg(p.proname, ', ') into offender
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.prokind = 'f'
    and has_function_privilege('authenticated', p.oid, 'execute')
    and p.proname not in ('is_platform_admin', 'is_organization_member',
                          'has_organization_permission', 'shares_organization_with');
  assert offender is null, format('private functions executable by authenticated outside the allowlist: %s', offender);

  select string_agg(p.proname, ', ') into offender
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f' and p.prosecdef
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
  assert offender is null, format('security definer functions without a pinned search_path: %s', offender);

  -- and no authenticated DML remains on the tenant integrity tables
  select string_agg(table_name || '.' || privilege_type, ', ') into offender
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee = 'authenticated'
    and table_name in ('organization_memberships', 'roles', 'role_permissions', 'membership_roles', 'organization_invitations')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE');
  assert offender is null, format('unexpected authenticated DML: %s', offender);
end $$;

-- management recovery invariant -------------------------------------------------------------------
-- acme currently has exactly one recovery manager: alice (Organization Admin).
do $$
begin
  assert test.has_recovery_manager(test.org('acme')), 'acme has a recovery manager';
  assert test.has_recovery_manager(test.org('beta')), 'beta has a recovery manager (carol)';
end $$;

do $$
declare weak_role uuid;
begin
  perform test.login('alice');

  -- the sole recovery manager cannot be deactivated by another manager...
  assert test.sqlstate_of(format('select public.set_organization_member_status(%L, %L, false)', test.org('acme'), test.membership('acme', 'alice'))) = 'TQ003', 'self-deactivation is still caught first';

  -- ...nor stripped of the capability through a role replacement
  assert test.sqlstate_of(format('select public.set_organization_member_roles(%L, %L, %L)', test.org('acme'), test.membership('acme', 'alice'), array[test.role_id('acme', 'Recruiter')])) = 'TQ004', 'replacing the sole manager''s roles is refused';
  assert (select count(*) from public.membership_roles mr where mr.membership_id = test.membership('acme', 'alice')) = 1, 'the refused change rolled back';
  assert test.has_recovery_manager(test.org('acme')), 'acme still has its manager';
  assert test.sqlstate_of(format('select public.set_organization_member_roles(%L, %L, %L)', test.org('acme'), test.membership('acme', 'alice'), '{}'::uuid[])) = 'TQ004', 'clearing the sole manager''s roles is refused';

  -- ...nor through editing the role that grants it
  assert test.sqlstate_of(format('select public.update_organization_role(%L, %L, %L, null, %L)', test.org('acme'), test.role_id('acme', 'Organization Admin'), 'Owner', array['members.manage', 'roles.manage'])) = 'TQ001', 'the system role is still immutable';
  weak_role := public.create_organization_role(test.org('acme'), 'Manager', null, array['members.manage', 'roles.manage', 'members.view']);
  perform public.set_organization_member_roles(test.org('acme'), test.membership('acme', 'dave'), array[weak_role]);
  assert test.has_recovery_manager(test.org('acme')), 'dave is now a second recovery manager';

  -- an unrelated permission may still be removed from that role
  perform public.update_organization_role(test.org('acme'), weak_role, 'Manager', null, array['members.manage', 'roles.manage']);
  assert (select count(*) from public.role_permissions rp where rp.role_id = weak_role) = 2, 'unrelated permission removed';
end $$;

-- with a second manager present, removing one is allowed ------------------------------------------
do $$
begin
  perform test.login('alice');
  perform public.set_organization_member_status(test.org('acme'), test.membership('acme', 'dave'), false);
  assert (select m.is_active from public.organization_memberships m where m.id = test.membership('acme', 'dave')) = false, 'the second manager can be deactivated while another remains';
  perform public.set_organization_member_status(test.org('acme'), test.membership('acme', 'dave'), true);
  -- and the role that made dave a manager can still be edited, because alice remains one
  perform public.update_organization_role(test.org('acme'), test.role_id('acme', 'Manager'), 'Manager', null, array['members.view']);
  assert (select count(*) from public.role_permissions rp where rp.role_id = test.role_id('acme', 'Manager')) = 1, 'the edit went through while another manager existed';
  perform public.update_organization_role(test.org('acme'), test.role_id('acme', 'Manager'), 'Manager', null, array['members.manage', 'roles.manage']);
end $$;

-- an organization whose ONLY manager holds the capability through a custom role --------------------
do $$
begin
  perform test.login('pat');
  insert into public.organizations (name, slug) values ('Lockout Co', 'lockout');
end $$;
insert into auth.users (id, email) values (md5('solo')::uuid, 'solo@lockout.test');
insert into public.organization_memberships (organization_id, user_id)
values ((select id from public.organizations where slug = 'lockout'), md5('solo')::uuid);
insert into public.roles (organization_id, name)
select id, 'Sole Manager' from public.organizations where slug = 'lockout';
insert into public.role_permissions (role_id, organization_id, permission_key)
select r.id, r.organization_id, k
from public.roles r, unnest(array['members.manage', 'roles.manage', 'members.view']) as t(k)
where r.name = 'Sole Manager';
insert into public.membership_roles (membership_id, role_id, organization_id)
select m.id, r.id, m.organization_id
from public.organization_memberships m
join public.roles r on r.organization_id = m.organization_id and r.name = 'Sole Manager'
where m.user_id = md5('solo')::uuid;

do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', md5('solo')::uuid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  assert test.has_recovery_manager(test.org('lockout')), 'solo is the only recovery manager';

  -- editing that role so members.manage disappears is refused
  assert test.sqlstate_of(format('select public.update_organization_role(%L, %L, %L, null, %L)', test.org('lockout'), test.role_id('lockout', 'Sole Manager'), 'Sole Manager', array['roles.manage'])) = 'TQ004', 'removing members.manage from the last manager''s role is refused';
  -- ...and so is removing roles.manage
  assert test.sqlstate_of(format('select public.update_organization_role(%L, %L, %L, null, %L)', test.org('lockout'), test.role_id('lockout', 'Sole Manager'), 'Sole Manager', array['members.manage'])) = 'TQ004', 'removing roles.manage from the last manager''s role is refused';
  assert (select count(*) from public.role_permissions rp where rp.role_id = test.role_id('lockout', 'Sole Manager')) = 3, 'both refused edits rolled back';

  -- removing an unrelated permission is allowed: the two critical ones survive
  perform public.update_organization_role(test.org('lockout'), test.role_id('lockout', 'Sole Manager'), 'Sole Manager', null, array['members.manage', 'roles.manage']);
  assert (select count(*) from public.role_permissions rp where rp.role_id = test.role_id('lockout', 'Sole Manager')) = 2, 'unrelated permission removed';
  -- and the caller cannot add back a permission they no longer hold (key-based, no hierarchy)
  assert test.sqlstate_of(format('select public.update_organization_role(%L, %L, %L, null, %L)', test.org('lockout'), test.role_id('lockout', 'Sole Manager'), 'Sole Manager', array['members.manage', 'roles.manage', 'members.view'])) = 'TQ005', 'the ceiling applies even to a weaker permission';

  -- once a second manager exists, the role may be narrowed
  perform public.add_organization_member_by_email(test.org('lockout'), 'dave@both.test');
end $$;

-- multiple roles may combine to provide the two critical permissions --------------------------------
do $$
declare members_only uuid; roles_only uuid;
begin
  perform test.login('alice');
  members_only := public.create_organization_role(test.org('acme'), 'Members Only', null, array['members.manage']);
  roles_only := public.create_organization_role(test.org('acme'), 'Roles Only', null, array['roles.manage']);
  perform public.set_organization_member_roles(test.org('acme'), test.membership('acme', 'bob'), array[members_only, roles_only]);
  assert test.has_recovery_manager(test.org('acme')), 'the union of two roles makes a recovery manager';

  -- bob alone would not qualify with only one of them
  perform public.set_organization_member_roles(test.org('acme'), test.membership('acme', 'bob'), array[members_only]);
  perform public.set_organization_member_roles(test.org('acme'), test.membership('acme', 'dave'), '{}'::uuid[]);
  perform public.set_organization_member_roles(test.org('acme'), test.membership('acme', 'mallory'), '{}'::uuid[]);
  assert test.has_recovery_manager(test.org('acme')), 'alice still qualifies';
  assert test.sqlstate_of(format('select public.set_organization_member_roles(%L, %L, %L)', test.org('acme'), test.membership('acme', 'alice'), '{}'::uuid[])) = 'TQ004', 'alice is the last qualifying manager again';

  -- restore the fixture roles the later invitation tests rely on
  perform public.set_organization_member_roles(test.org('acme'), test.membership('acme', 'bob'),
    array[test.role_id('acme', 'Recruiter'), test.role_id('acme', 'Interview Panel')]);
  perform public.delete_organization_role(test.org('acme'), members_only);
  perform public.delete_organization_role(test.org('acme'), roles_only);
end $$;

-- an organization with no manager at all can still be worked on (unsafe -> safe is allowed) ---------
do $$
declare bootstrap_role uuid;
begin
  perform test.login('pat'); -- platform admin creates the organization
  insert into public.organizations (name, slug) values ('Bootstrap Co', 'bootstrap');
  assert not test.has_recovery_manager(test.org('bootstrap')), 'a fresh organization has no manager';
  assert not exists (select 1 from public.organization_memberships m where m.organization_id = test.org('bootstrap')), 'and no members';
end $$;
-- the first member and their roles are established as the owner, exactly as provisioning would
insert into public.organization_memberships (organization_id, user_id)
values ((select id from public.organizations where slug = 'bootstrap'), md5('dave')::uuid);
insert into public.membership_roles (membership_id, role_id, organization_id)
select m.id, r.id, m.organization_id
from public.organization_memberships m
join public.roles r on r.organization_id = m.organization_id and r.name = 'Organization Admin'
where m.organization_id = (select id from public.organizations where slug = 'bootstrap');
do $$
begin
  assert test.has_recovery_manager(test.org('bootstrap')), 'unsafe -> safe transition is allowed';
end $$;

-- the Phase 2G management helpers are not directly executable by application roles -------------------
do $$
begin
  assert has_function_privilege('authenticated', 'private.organization_has_recovery_manager(uuid)', 'execute') = false, 'authenticated cannot execute organization_has_recovery_manager';
  assert has_function_privilege('anon', 'private.organization_has_recovery_manager(uuid)', 'execute') = false, 'anon cannot execute organization_has_recovery_manager';
  assert has_function_privilege('authenticated', 'private.lock_organization_for_management(uuid, text)', 'execute') = false, 'authenticated cannot execute lock_organization_for_management';
  assert has_function_privilege('anon', 'private.lock_organization_for_management(uuid, text)', 'execute') = false, 'anon cannot execute lock_organization_for_management';
  -- and a platform admin gains nothing from platform status here either
  assert not test.has_recovery_manager(test.org('prov-check')), 'a provisioned organization with no members has no recovery manager';
end $$;

-- invitation resend -----------------------------------------------------------------------------------
do $$
declare resend record;
begin
  perform test.login('alice');
  select * into resend from public.get_organization_invitation_for_resend(test.org('acme'), test.invitation('acme', 'ghost@invite.test'));
  assert resend.email = 'ghost@invite.test', 'resend data returned for a pending invitation';
  assert resend.recipient_confirmed = false, 'the recipient has not confirmed yet';

  perform test.login('bob'); -- members.view only
  assert test.sqlstate_of(format('select * from public.get_organization_invitation_for_resend(%L, %L)', test.org('acme'), test.invitation('acme', 'ghost@invite.test'))) = '42501', 'members.manage is required to resend';
  perform test.login('carol'); -- another organization
  assert test.sqlstate_of(format('select * from public.get_organization_invitation_for_resend(%L, %L)', test.org('acme'), test.invitation('acme', 'ghost@invite.test'))) = '42501', 'another organization cannot resend';
  perform test.login('pat'); -- platform admin without membership
  assert test.sqlstate_of(format('select * from public.get_organization_invitation_for_resend(%L, %L)', test.org('acme'), test.invitation('acme', 'ghost@invite.test'))) = '42501', 'platform admin cannot resend a tenant invitation';
  execute 'set local role anon';
  assert test.sqlstate_of(format('select * from public.get_organization_invitation_for_resend(%L, %L)', test.org('acme'), test.invitation('acme', 'ghost@invite.test'))) = '42501', 'anonymous cannot resend';
end $$;

do $$
begin
  perform test.login('alice');
  assert test.sqlstate_of(format('select * from public.get_organization_invitation_for_resend(%L, %L)', test.org('acme'), (select i.id from test.all_invitations() i where i.email = 'second@invite.test'))) = '22023', 'a revoked invitation cannot be resent';
  assert test.sqlstate_of(format('select * from public.get_organization_invitation_for_resend(%L, %L)', test.org('acme'), (select i.id from test.all_invitations() i where i.email = 'fresh@invite.test' and i.organization_id = test.org('acme')))) = '22023', 'an accepted invitation cannot be resent';
  assert test.sqlstate_of(format('select * from public.get_organization_invitation_for_resend(%L, %L)', test.org('acme'), test.invitation('beta', 'fresh@invite.test'))) = 'P0002', 'an invitation of another organization is not found';
end $$;

-- a pending invitation whose recipient already confirmed is distinguishable to the manager ----------
update auth.users set email_confirmed_at = now() where id = md5('ghost')::uuid;
do $$
declare resend record;
begin
  perform test.login('alice');
  select * into resend from public.get_organization_invitation_for_resend(test.org('acme'), test.invitation('acme', 'ghost@invite.test'));
  assert resend.recipient_confirmed = true, 'the manager can tell the recipient already confirmed';
end $$;

-- recipient recovery: finding your own pending invitations -------------------------------------------
do $$
begin
  -- ghost is now confirmed and still has a pending invitation but no membership
  perform set_config('request.jwt.claims', json_build_object('sub', md5('ghost')::uuid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  assert (select count(*) from public.get_my_pending_organization_invitations()) = 1, 'the recipient finds their own pending invitation';
  assert (select organization_slug from public.get_my_pending_organization_invitations()) = 'acme', 'it names the organization';
  assert (select email from public.get_my_pending_organization_invitations()) = 'ghost@invite.test', 'and their own address';
end $$;

do $$
begin
  perform test.login('dave'); -- a different confirmed account
  assert (select count(*) from public.get_my_pending_organization_invitations()) = 0, 'another user sees none of them';
  perform test.login('alice');
  assert (select count(*) from public.get_my_pending_organization_invitations()) = 0, 'a manager does not see invitations addressed to others';
  execute 'set local role anon';
  assert test.sqlstate_of('select * from public.get_my_pending_organization_invitations()') = '42501', 'anonymous cannot call it';
end $$;

do $$
begin
  -- an unconfirmed recipient gets nothing, exactly like the single-invitation lookup
  perform set_config('request.jwt.claims', json_build_object('sub', md5('stray')::uuid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  assert (select count(*) from public.get_my_pending_organization_invitations()) = 0, 'an unconfirmed caller sees nothing';
end $$;

-- a suspended organization's invitation is not offered for recovery -----------------------------------
update public.organizations set is_active = false where slug = 'acme';
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', md5('ghost')::uuid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  assert (select count(*) from public.get_my_pending_organization_invitations()) = 0, 'a suspended organization is not offered';
end $$;
update public.organizations set is_active = true where slug = 'acme';

-- accepted and revoked invitations disappear from recipient recovery ------------------------------------
do $$
declare accepted record;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', md5('ghost')::uuid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select * into accepted from public.accept_organization_invitation(test.invitation('acme', 'ghost@invite.test'));
  assert accepted.organization_slug = 'acme', 'the recovered invitation can be accepted';
  assert (select count(*) from public.get_my_pending_organization_invitations()) = 0, 'it disappears once accepted';
  assert (select count(*) from public.membership_roles mr join public.organization_memberships m on m.id = mr.membership_id where m.user_id = md5('ghost')::uuid) = 0, 'and the new member still has zero roles';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Phase 2G: permission delegation ceiling (TQ005)
-- An isolated organization so these identities cannot disturb the other fixtures.
-- ---------------------------------------------------------------------------------------------
do $$
begin
  perform test.login('pat');
  insert into public.organizations (name, slug) values ('Escalate Co', 'escalate');
end $$;

insert into auth.users (id, email) values
  (md5('boss')::uuid,   'boss@escalate.test'),
  (md5('mm')::uuid,     'mm@escalate.test'),
  (md5('rm')::uuid,     'rm@escalate.test'),
  (md5('victim')::uuid, 'victim@escalate.test')
on conflict do nothing;

-- two narrow roles plus the provisioned Organization Admin system role
insert into public.roles (organization_id, name)
select o.id, n from public.organizations o, unnest(array['Member Manager', 'Role Manager', 'Viewer']) as t(n)
where o.slug = 'escalate';
insert into public.role_permissions (role_id, organization_id, permission_key)
select r.id, r.organization_id,
       case r.name when 'Member Manager' then 'members.manage'
                   when 'Role Manager' then 'roles.manage'
                   else 'members.view' end
from public.roles r join public.organizations o on o.id = r.organization_id
where o.slug = 'escalate' and r.name in ('Member Manager', 'Role Manager', 'Viewer');
-- the narrow managers also need members.view/roles.view to be realistic; still far short of admin
insert into public.role_permissions (role_id, organization_id, permission_key)
select r.id, r.organization_id, 'members.view'
from public.roles r join public.organizations o on o.id = r.organization_id
where o.slug = 'escalate' and r.name = 'Member Manager';
insert into public.role_permissions (role_id, organization_id, permission_key)
select r.id, r.organization_id, 'roles.view'
from public.roles r join public.organizations o on o.id = r.organization_id
where o.slug = 'escalate' and r.name = 'Role Manager';

-- roles carrying permissions the narrow managers do NOT hold, for the delta cases
insert into public.roles (organization_id, name)
select o.id, n from public.organizations o, unnest(array['Org Editor', 'Role Viewer', 'Mixed']) as t(n)
where o.slug = 'escalate';
insert into public.role_permissions (role_id, organization_id, permission_key)
select r.id, r.organization_id,
       case r.name when 'Org Editor' then 'organization.update' else 'roles.view' end
from public.roles r join public.organizations o on o.id = r.organization_id
where o.slug = 'escalate' and r.name in ('Org Editor', 'Role Viewer');
insert into public.role_permissions (role_id, organization_id, permission_key)
select r.id, r.organization_id, k
from public.roles r join public.organizations o on o.id = r.organization_id,
     unnest(array['organization.update', 'members.manage']) as t(k)
where o.slug = 'escalate' and r.name = 'Mixed';

insert into public.organization_memberships (organization_id, user_id)
select o.id, u from public.organizations o,
  unnest(array[md5('boss')::uuid, md5('mm')::uuid, md5('rm')::uuid, md5('victim')::uuid, md5('pat')::uuid]) as t(u)
where o.slug = 'escalate';

insert into public.membership_roles (membership_id, role_id, organization_id)
select m.id, r.id, m.organization_id
from public.organization_memberships m
join public.organizations o on o.id = m.organization_id and o.slug = 'escalate'
join public.roles r on r.organization_id = o.id
where (m.user_id = md5('boss')::uuid   and r.name = 'Organization Admin')
   or (m.user_id = md5('mm')::uuid     and r.name = 'Member Manager')
   or (m.user_id = md5('rm')::uuid     and r.name = 'Role Manager')
   or (m.user_id = md5('pat')::uuid    and r.name = 'Member Manager');

create function test.membership_in(slug text, uid uuid) returns uuid
language sql stable security definer as $$
  select m.id from public.organization_memberships m
  join public.organizations o on o.id = m.organization_id
  where o.slug = membership_in.slug and m.user_id = membership_in.uid
$$;
grant execute on function test.membership_in(text, uuid) to authenticated, anon;

create function test.login_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $$;
grant execute on function test.login_as(uuid) to authenticated, anon;

-- A + B: a members.manage-only caller cannot hand out anything beyond their own permissions ------
do $$
begin
  perform test.login_as(md5('mm')::uuid);
  assert (select count(*) from public.get_organization_members(test.org('escalate'))) = 5, 'mm can administer members';

  -- A: not to themselves
  assert test.sqlstate_of(format('select public.set_organization_member_roles(%L, %L, %L)', test.org('escalate'), test.membership_in('escalate', md5('mm')::uuid), array[test.role_id('escalate', 'Organization Admin')])) = 'TQ005', 'A: members.manage cannot self-assign the admin role';
  assert (select count(*) from public.membership_roles mr where mr.membership_id = test.membership_in('escalate', md5('mm')::uuid)) = 1, 'A: nothing changed';

  -- B: nor to somebody else
  assert test.sqlstate_of(format('select public.set_organization_member_roles(%L, %L, %L)', test.org('escalate'), test.membership_in('escalate', md5('victim')::uuid), array[test.role_id('escalate', 'Organization Admin')])) = 'TQ005', 'B: members.manage cannot grant the admin role to another member';
  assert test.sqlstate_of(format('select public.set_organization_member_roles(%L, %L, %L)', test.org('escalate'), test.membership_in('escalate', md5('victim')::uuid), array[test.role_id('escalate', 'Role Manager')])) = 'TQ005', 'B: nor a role carrying roles.manage, which mm lacks';
  assert not exists (select 1 from public.membership_roles mr where mr.membership_id = test.membership_in('escalate', md5('victim')::uuid)), 'B: victim still has no roles';

  -- C: a role whose permissions are a subset of the caller's own is fine
  perform public.set_organization_member_roles(test.org('escalate'), test.membership_in('escalate', md5('victim')::uuid), array[test.role_id('escalate', 'Viewer')]);
  assert (select count(*) from public.membership_roles mr where mr.membership_id = test.membership_in('escalate', md5('victim')::uuid)) = 1, 'C: a subset role can be assigned';
  perform public.set_organization_member_roles(test.org('escalate'), test.membership_in('escalate', md5('victim')::uuid), array[test.role_id('escalate', 'Member Manager')]);
  assert (select count(*) from public.membership_roles mr where mr.membership_id = test.membership_in('escalate', md5('victim')::uuid)) = 1, 'C: an equal-power role can be assigned';

  -- H: several roles are judged by the union of their permissions
  assert test.sqlstate_of(format('select public.set_organization_member_roles(%L, %L, %L)', test.org('escalate'), test.membership_in('escalate', md5('victim')::uuid), array[test.role_id('escalate', 'Viewer'), test.role_id('escalate', 'Role Manager')])) = 'TQ005', 'H: the union is what counts';

  -- removal remains permitted: an empty set requests nothing
  perform public.set_organization_member_roles(test.org('escalate'), test.membership_in('escalate', md5('victim')::uuid), '{}'::uuid[]);
  assert not exists (select 1 from public.membership_roles mr where mr.membership_id = test.membership_in('escalate', md5('victim')::uuid)), 'removal is unaffected by the ceiling';
end $$;

-- D + E + F: a roles.manage-only caller cannot mint permissions they lack ---------------------------
do $$
declare made uuid;
begin
  perform test.login_as(md5('rm')::uuid);

  -- D: cannot create a role containing members.manage
  assert test.sqlstate_of(format('select public.create_organization_role(%L, %L, null, %L)', test.org('escalate'), 'Sneaky Admin', array['members.manage'])) = 'TQ005', 'D: roles.manage cannot mint members.manage';
  assert not exists (select 1 from public.roles r where r.name = 'Sneaky Admin'), 'D: nothing was created';
  assert test.sqlstate_of(format('select public.create_organization_role(%L, %L, null, %L)', test.org('escalate'), 'Sneaky Mix', array['roles.manage', 'organization.update'])) = 'TQ005', 'D: a mixed bundle is judged key by key';

  -- E: cannot edit their own role to add a permission they lack
  assert test.sqlstate_of(format('select public.update_organization_role(%L, %L, %L, null, %L)', test.org('escalate'), test.role_id('escalate', 'Role Manager'), 'Role Manager', array['roles.manage', 'roles.view', 'members.manage'])) = 'TQ005', 'E: no self-promotion through the role they hold';
  assert (select count(*) from public.role_permissions rp where rp.role_id = test.role_id('escalate', 'Role Manager')) = 2, 'E: the bundle is unchanged';

  -- F: permissions they do hold are fine
  made := public.create_organization_role(test.org('escalate'), 'Role Helper', null, array['roles.view']);
  assert (select count(*) from public.role_permissions rp where rp.role_id = made) = 1, 'F: a role within the ceiling is created';
  perform public.update_organization_role(test.org('escalate'), made, 'Role Helper', null, array['roles.view', 'roles.manage']);
  assert (select count(*) from public.role_permissions rp where rp.role_id = made) = 2, 'F: and can be edited within the ceiling';

  -- I: names carry no authority - a harmless-sounding role is judged only by its keys
  assert test.sqlstate_of(format('select public.update_organization_role(%L, %L, %L, null, %L)', test.org('escalate'), made, 'Totally Harmless', array['members.manage'])) = 'TQ005', 'I: the role name is irrelevant';
  perform public.delete_organization_role(test.org('escalate'), made);
end $$;

-- delta semantics: TQ005 measures only what is NEWLY introduced -------------------------------------
-- victim starts out holding permissions neither narrow manager has
insert into public.membership_roles (membership_id, role_id, organization_id)
select m.id, r.id, m.organization_id
from public.organization_memberships m
join public.organizations o on o.id = m.organization_id and o.slug = 'escalate'
join public.roles r on r.organization_id = o.id and r.name in ('Org Editor', 'Role Viewer')
where m.user_id = md5('victim')::uuid;

do $$
begin
  perform test.login_as(md5('mm')::uuid); -- members.manage + members.view only
  assert (select count(*) from public.membership_roles mr where mr.membership_id = test.membership_in('escalate', md5('victim')::uuid)) = 2, 'victim holds two stronger roles';

  -- pure removal: roles.view goes, organization.update is RETAINED, and mm holds neither
  perform public.set_organization_member_roles(test.org('escalate'), test.membership_in('escalate', md5('victim')::uuid), array[test.role_id('escalate', 'Org Editor')]);
  assert (select count(*) from public.membership_roles mr where mr.membership_id = test.membership_in('escalate', md5('victim')::uuid)) = 1, 'a limited manager may strip a role while a stronger permission is retained';

  -- re-introducing the removed permission is a grant, and mm does not hold it
  assert test.sqlstate_of(format('select public.set_organization_member_roles(%L, %L, %L)', test.org('escalate'), test.membership_in('escalate', md5('victim')::uuid), array[test.role_id('escalate', 'Org Editor'), test.role_id('escalate', 'Role Viewer')])) = 'TQ005', 'adding back a permission the caller lacks is refused';

  -- a no-op re-save of the retained set introduces nothing
  perform public.set_organization_member_roles(test.org('escalate'), test.membership_in('escalate', md5('victim')::uuid), array[test.role_id('escalate', 'Org Editor')]);
  assert (select count(*) from public.membership_roles mr where mr.membership_id = test.membership_in('escalate', md5('victim')::uuid)) = 1, 'retaining is not granting';

  -- a swap whose only newly introduced key is one the caller DOES hold is allowed, even though the
  -- role also carries organization.update, which mm lacks but victim already had
  perform public.set_organization_member_roles(test.org('escalate'), test.membership_in('escalate', md5('victim')::uuid), array[test.role_id('escalate', 'Mixed')]);
  assert (select count(*) from public.membership_roles mr where mr.membership_id = test.membership_in('escalate', md5('victim')::uuid)) = 1, 'a swap introducing only held permissions is allowed';

  -- clearing everything remains allowed
  perform public.set_organization_member_roles(test.org('escalate'), test.membership_in('escalate', md5('victim')::uuid), '{}'::uuid[]);
  assert not exists (select 1 from public.membership_roles mr where mr.membership_id = test.membership_in('escalate', md5('victim')::uuid)), 'an empty resulting set is always allowed under TQ005';
end $$;

do $$
begin
  perform test.login_as(md5('rm')::uuid); -- roles.manage + roles.view only
  assert (select count(*) from public.role_permissions rp where rp.role_id = test.role_id('escalate', 'Mixed')) = 2, 'Mixed carries two permissions rm lacks';

  -- narrowing a role that contains permissions the caller does not hold: members.manage is removed,
  -- organization.update is retained, nothing is introduced
  perform public.update_organization_role(test.org('escalate'), test.role_id('escalate', 'Mixed'), 'Mixed', null, array['organization.update']);
  assert (select array_agg(rp.permission_key) from public.role_permissions rp where rp.role_id = test.role_id('escalate', 'Mixed')) = array['organization.update'], 'a role may be narrowed even around permissions the caller lacks';

  -- introducing a new key the caller lacks is still refused
  assert test.sqlstate_of(format('select public.update_organization_role(%L, %L, %L, null, %L)', test.org('escalate'), test.role_id('escalate', 'Mixed'), 'Mixed', array['organization.update', 'members.view'])) = 'TQ005', 'introducing a permission the caller lacks is refused';
  -- introducing one the caller does hold is fine, alongside the retained one
  perform public.update_organization_role(test.org('escalate'), test.role_id('escalate', 'Mixed'), 'Mixed', null, array['organization.update', 'roles.view']);
  assert (select count(*) from public.role_permissions rp where rp.role_id = test.role_id('escalate', 'Mixed')) = 2, 'a held permission may be added beside a retained one';
end $$;

-- G: a caller holding every permission delegates freely -----------------------------------------------
do $$
declare made uuid;
begin
  perform test.login_as(md5('boss')::uuid);
  made := public.create_organization_role(test.org('escalate'), 'Deputy', null, array['members.manage', 'roles.manage', 'members.view', 'roles.view']);
  assert (select count(*) from public.role_permissions rp where rp.role_id = made) = 4, 'G: an all-permission caller creates a powerful role';
  perform public.set_organization_member_roles(test.org('escalate'), test.membership_in('escalate', md5('victim')::uuid), array[test.role_id('escalate', 'Organization Admin')]);
  assert (select count(*) from public.membership_roles mr where mr.membership_id = test.membership_in('escalate', md5('victim')::uuid)) = 1, 'G: and can assign the admin role';
  perform public.update_organization_role(test.org('escalate'), made, 'Deputy', 'Second in command', array['members.manage', 'members.view']);
  assert (select count(*) from public.role_permissions rp where rp.role_id = made) = 2, 'G: and can edit it';
end $$;

-- J: platform-admin status grants no exemption -----------------------------------------------------
do $$
begin
  -- pat is a platform admin AND a member here, but holds only members.manage in this organization
  perform test.login('pat');
  assert private.is_platform_admin(), 'pat is a platform admin';
  assert test.sqlstate_of(format('select public.set_organization_member_roles(%L, %L, %L)', test.org('escalate'), test.membership_in('escalate', md5('pat')::uuid), array[test.role_id('escalate', 'Organization Admin')])) = 'TQ005', 'J: platform admin status does not lift the ceiling';
  assert test.sqlstate_of(format('select public.create_organization_role(%L, %L, null, %L)', test.org('escalate'), 'Platform Sneak', array['roles.manage'])) = '42501', 'J: and pat lacks roles.manage here anyway';
end $$;

-- the ceiling is evaluated after the lock, so authority lost while waiting cannot be used ------------
do $$
begin
  perform test.login_as(md5('boss')::uuid);
  -- boss loses the admin role; a later attempt to delegate it must now fail
  perform public.set_organization_member_roles(test.org('escalate'), test.membership_in('escalate', md5('boss')::uuid), array[test.role_id('escalate', 'Member Manager')]);
  assert test.sqlstate_of(format('select public.set_organization_member_roles(%L, %L, %L)', test.org('escalate'), test.membership_in('escalate', md5('mm')::uuid), array[test.role_id('escalate', 'Organization Admin')])) = 'TQ005', 'a demoted caller can no longer delegate what they lost';
end $$;

-- cascades
do $$
begin
  delete from public.organizations where slug = 'gamma';
  delete from auth.users where id = test.uid('dave');
  assert not exists (select 1 from public.profiles where id = test.uid('dave')), 'deleting a user removes the profile';
  assert not exists (select 1 from public.organization_memberships where user_id = test.uid('dave')), 'deleting a user removes memberships';
  delete from public.roles where name = 'Interview Panel';
  assert not exists (select 1 from public.membership_roles where role_id not in (select id from public.roles)), 'deleting a role removes assignments';
  delete from public.organizations where slug = 'acme';
  assert not exists (select 1 from public.roles where organization_id = test.org('acme')), 'deleting an organization removes roles';
  assert not exists (select 1 from public.organization_service_entitlements where service_key = 'resume_screening' and organization_id is null), 'sanity';
  assert (select count(*) from public.organization_service_entitlements) = 1, 'deleting an organization removes its entitlements';
end $$;

select 'all Phase 2A RLS checks passed' as result;
