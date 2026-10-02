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

-- Supabase Storage stub. Phase 7 keeps resume bytes in a private bucket and authorizes them with
-- ordinary RLS policies on storage.objects, so the parts of Storage those policies actually touch
-- are recreated here: the bucket registry, the object table, its generated path_tokens, and the
-- privileges the authenticated role really holds. The policies under test are the migration's own.
-- What this stub CANNOT do is exercise the Storage HTTP API, signed URLs or the mime/size limits
-- the bucket row declares - those live in a service that is not running here.
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  metadata jsonb,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  created_at timestamptz not null default now()
);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated;
grant select on storage.buckets to authenticated;

\ir ../migrations/20260916120000_saas_foundation.sql
\ir ../migrations/20260916150000_organization_context.sql
\ir ../migrations/20260916180000_platform_control_plane.sql
\ir ../migrations/20260917100000_organization_access_management.sql
\ir ../migrations/20260921120000_organization_invitations.sql
\ir ../migrations/20260921160000_security_integrity_hardening.sql
\ir ../migrations/20260929120000_organization_bootstrap.sql
\ir ../migrations/20261001120000_platform_overview.sql
\ir ../migrations/20261002120000_jobs_foundation.sql
\ir ../migrations/20261003120000_job_requirement_order.sql
\ir ../migrations/20261004120000_jd_intelligence.sql
\ir ../migrations/20261005120000_screening_rubric.sql
\ir ../migrations/20261006120000_resume_intake.sql
\ir ../migrations/20261007120000_resume_processing.sql

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
  assert (select count(*) from public.permissions) = 8, 'permission catalog is readable';
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
  assert (select count(*) from public.get_my_organization_permissions(test.org('acme'))) = (select count(*) from public.permissions), 'alice: the whole tenant catalog';
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
  assert (select count(*) from public.role_permissions where organization_id = test.org('gamma')) = (select count(*) from public.permissions), 'default role carries the whole catalog';
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
  assert (select cardinality(permission_keys) from public.get_organization_roles(test.org('acme')) where name = 'Organization Admin') = (select count(*) from public.permissions), 'system role bundle listed';
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
  assert (select count(*) from public.role_permissions where role_id = test.role_id('acme', 'Organization Admin')) = (select count(*) from public.permissions), 'system role bundle intact';

  -- direct table access is hardened too
  assert test.sqlstate_of(format('insert into public.roles (organization_id, name, is_system) values (%L, %L, true)', test.org('acme'), 'Fake System')) = '42501', 'tenant cannot insert a system role';
  assert test.sqlstate_of(format('update public.roles set name = %L where id = %L', 'Owner', test.role_id('acme', 'Organization Admin'))) = '42501', 'tenant cannot rename the system role';
  assert test.sqlstate_of(format('update public.roles set is_system = true where id = %L', new_role)) = '42501', 'tenant cannot promote a custom role to system';
  assert test.sqlstate_of(format('delete from public.role_permissions where role_id = %L', test.role_id('acme', 'Organization Admin'))) = '42501', 'tenant cannot strip system role permissions';
  assert test.sqlstate_of(format('insert into public.role_permissions (role_id, organization_id, permission_key) values (%L, %L, %L)', test.role_id('acme', 'Organization Admin'), test.org('acme'), 'members.view')) = '42501', 'tenant cannot add system role permissions';
  assert (select count(*) from public.role_permissions where role_id = test.role_id('acme', 'Organization Admin')) = (select count(*) from public.permissions), 'system role bundle still intact';
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
  assert (select count(*) from public.role_permissions where role_id = test.role_id('acme', 'Organization Admin')) = (select count(*) from public.permissions), 'system role bundle intact after UPDATE attempts';
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

  -- Minimal authenticated surface in the private schema: exactly the helpers an RLS policy names
  -- directly, which the querying role must therefore be able to execute. Anything else appearing
  -- here means a grant crept back in. The last two arrived with the Phase 7 storage policies on
  -- storage.objects; private.safe_uuid deliberately is NOT here, because it is only ever called
  -- from inside those two, which are security definer and run it as the owner.
  select string_agg(p.proname, ', ') into offender
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.prokind = 'f'
    and has_function_privilege('authenticated', p.oid, 'execute')
    and p.proname not in ('is_platform_admin', 'is_organization_member',
                          'has_organization_permission', 'shares_organization_with',
                          'can_read_job_resume_object', 'can_write_job_resume_object');
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
    and table_name in ('organization_memberships', 'roles', 'role_permissions', 'membership_roles', 'organization_invitations',
                       -- Phase 8.1: derived processing data is written by the processing functions and
                       -- by nothing else, so the same rule now covers these four.
                       'candidates', 'job_applications', 'resume_processings', 'candidate_evidence')
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

-- ---------------------------------------------------------------------------------------------
-- ---------------------------------------------------------------------------------------------
-- Phase 3: platform bootstrap of an initial tenant administrator (TQ006/TQ007/TQ008)
--
-- The control plane may seat the first administrator of an organization that cannot yet administer
-- itself, and only then. Platform status still grants no tenant permission: what it grants is the
-- ability to create a membership, which is a different thing.
-- ---------------------------------------------------------------------------------------------
insert into public.organizations (name, slug) values ('Bootstrap One', 'boot1');
insert into public.organizations (name, slug) values ('Bootstrap Two', 'boot2');
insert into public.organizations (name, slug) values ('Bootstrap Three', 'boot3');
-- a finished account, and addresses with no account at all
insert into auth.users (id, email) values (test.uid('seated'), 'seated@boot.test');

create function test.system_role_of(slug text) returns uuid
language sql stable security definer as $$
  select r.id from public.roles r join public.organizations o on o.id = r.organization_id
  where o.slug = system_role_of.slug and r.is_system
$$;
create function test.holds_system_role(slug text, uid uuid) returns boolean
language sql stable security definer as $$
  select exists (
    select 1 from public.membership_roles mr
    join public.organization_memberships m on m.id = mr.membership_id
    join public.organizations o on o.id = m.organization_id
    join public.roles r on r.id = mr.role_id
    where o.slug = holds_system_role.slug and m.user_id = holds_system_role.uid and r.is_system
  )
$$;
create function test.pending_admin_invitations(slug text) returns bigint
language sql stable security definer as $$
  select count(*) from public.organization_invitations i
  join public.organizations o on o.id = i.organization_id
  where o.slug = pending_admin_invitations.slug and i.status = 'pending' and i.grants_admin
$$;
grant execute on function
  test.system_role_of(text), test.holds_system_role(text, uuid), test.pending_admin_invitations(text)
  to authenticated, anon;

-- a fresh organization provisions a system role and nothing that can use it -----------------------
do $$
begin
  assert test.system_role_of('boot1') is not null, 'provisioning created the system role';
  assert (select count(*) from public.organization_memberships where organization_id = test.org('boot1')) = 0, 'and no membership at all';
  assert not test.has_recovery_manager(test.org('boot1')), 'so the organization cannot administer itself';
end $$;

-- only the control plane may bootstrap -------------------------------------------------------------
do $$
begin
  perform test.login('alice'); -- a tenant Organization Admin elsewhere, not a platform admin
  assert test.sqlstate_of(format('select * from public.bootstrap_organization_administrator(%L, %L)', test.org('boot1'), 'seated@boot.test')) = '42501', 'a tenant administrator cannot bootstrap';
  perform test.login('bob');
  assert test.sqlstate_of(format('select * from public.bootstrap_organization_administrator(%L, %L)', test.org('boot1'), 'seated@boot.test')) = '42501', 'nor an ordinary member';
  execute 'set local role anon';
  assert test.sqlstate_of(format('select * from public.bootstrap_organization_administrator(%L, %L)', test.org('boot1'), 'seated@boot.test')) = '42501', 'nor anonymous';
end $$;

-- an existing confirmed account is seated immediately ----------------------------------------------
do $$
declare result record;
begin
  perform test.login('pat'); -- platform admin, and a member of nothing
  select * into result from public.bootstrap_organization_administrator(test.org('boot1'), ' Seated@Boot.Test ');
  assert result.status = 'administrator_ready', 'the account is seated at once';
  assert result.membership_id is not null and result.invitation_id is null, 'no invitation was needed';
  assert test.holds_system_role('boot1', test.uid('seated')), 'and holds the system role';
  assert test.has_recovery_manager(test.org('boot1')), 'the organization can now administer itself';
  -- the address was normalized on the way in
  assert (select count(*) from public.organization_memberships where organization_id = test.org('boot1')) = 1, 'exactly one membership';
end $$;

-- and the window closes behind it ------------------------------------------------------------------
do $$
begin
  perform test.login('pat');
  assert test.sqlstate_of(format('select * from public.bootstrap_organization_administrator(%L, %L)', test.org('boot1'), 'seated@boot.test')) = 'TQ006', 'bootstrap is refused once the tenant administers itself';
  assert test.sqlstate_of(format('select * from public.bootstrap_organization_administrator(%L, %L)', test.org('boot1'), 'pat@platform.test')) = 'TQ006', 'including for a different address';
  -- acme has had a recovery manager since the fixture, so it was never bootstrappable
  assert test.sqlstate_of(format('select * from public.bootstrap_organization_administrator(%L, %L)', test.org('acme'), 'seated@boot.test')) = 'TQ006', 'an established tenant is never reachable this way';
  assert test.sqlstate_of(format('select * from public.bootstrap_organization_administrator(%L, %L)', gen_random_uuid(), 'seated@boot.test')) = 'P0002', 'an unknown organization is not found';
end $$;

-- platform status alone still grants nothing -------------------------------------------------------
do $$
begin
  perform test.login('pat');
  assert private.is_platform_admin(), 'pat is a platform admin';
  assert (select count(*) from public.get_organization_members(test.org('boot1'))) = 0, 'which is not tenant access to the organization it just bootstrapped';
  assert test.sqlstate_of(format('select public.set_organization_member_roles(%L, %L, %L)', test.org('boot1'), test.membership_in('boot1', test.uid('seated')), array[]::uuid[])) = '42501', 'and no tenant administration either';
end $$;

-- A + B + C: an organization has one administrator setup in progress, or none -----------------------
do $$
declare first_try record; same_again record;
begin
  perform test.login('pat');
  select * into first_try from public.bootstrap_organization_administrator(test.org('boot2'), 'newadmin@boot.test');
  assert first_try.status = 'invite_ready', 'an invitation is prepared';
  assert first_try.invitation_id is not null and first_try.membership_id is null, 'and nothing is seated yet';

  -- C: the same address is idempotent, and is how a resend is expressed
  select * into same_again from public.bootstrap_organization_administrator(test.org('boot2'), 'newadmin@boot.test');
  assert same_again.status = 'invite_pending', 'retrying reports the outstanding invitation';
  assert same_again.invitation_id = first_try.invitation_id, 'and returns the same one';

  -- B: a different address does not quietly add a second administrator-bearing invitation
  assert test.sqlstate_of(format('select * from public.bootstrap_organization_administrator(%L, %L)', test.org('boot2'), 'someone.else@boot.test')) = 'TQ008', 'a second administrator setup is refused';
  assert test.pending_admin_invitations('boot2') = 1, 'there is still exactly one pending setup';
  assert (select count(*) from test.all_invitations() i where i.organization_id = test.org('boot2')) = 1, 'and no invitation was created for the other address';
end $$;

-- A: the invariant is the database's, not the RPC's -------------------------------------------------
do $$
declare inserted_second boolean := true;
begin
  -- As the owner, bypassing every function: the partial unique index must still refuse it.
  begin
    insert into public.organization_invitations (organization_id, email, grants_admin)
    values (test.org('boot2'), 'forced@boot.test', true);
  exception when unique_violation then
    inserted_second := false;
  end;
  assert not inserted_second, 'a second pending admin invitation cannot exist even from outside the RPC';
  -- an ordinary invitation alongside it is still fine
  insert into public.organization_invitations (organization_id, email) values (test.org('boot2'), 'ordinary@boot.test');
  assert test.pending_admin_invitations('boot2') = 1, 'the index constrains admin-bearing invitations only';
end $$;

-- E + F: cancellation is narrow --------------------------------------------------------------------
do $$
declare admin_invitation uuid; ordinary_invitation uuid;
begin
  select i.id into admin_invitation from test.all_invitations() i
  where i.organization_id = test.org('boot2') and i.grants_admin and i.status = 'pending';
  select i.id into ordinary_invitation from test.all_invitations() i
  where i.organization_id = test.org('boot2') and not i.grants_admin and i.status = 'pending';

  perform test.login('alice');
  assert test.sqlstate_of(format('select public.revoke_bootstrap_organization_invitation(%L, %L)', test.org('boot2'), admin_invitation)) = '42501', 'F: a tenant administrator cannot cancel a setup';
  execute 'set local role anon';
  assert test.sqlstate_of(format('select public.revoke_bootstrap_organization_invitation(%L, %L)', test.org('boot2'), admin_invitation)) = '42501', 'F: nor anonymous';

  perform test.login('pat');
  assert test.sqlstate_of(format('select public.revoke_bootstrap_organization_invitation(%L, %L)', test.org('boot2'), ordinary_invitation)) = '42501', 'E: an ordinary tenant invitation is not cancellable here';
  assert test.sqlstate_of(format('select public.revoke_bootstrap_organization_invitation(%L, %L)', test.org('acme'), admin_invitation)) = 'P0002', 'cross-organization cancellation is not found';
  assert (select i.status from test.all_invitations() i where i.id = ordinary_invitation) = 'pending', 'the ordinary invitation is untouched';
end $$;

-- D + G: cancel, then name someone else ------------------------------------------------------------
do $$
declare admin_invitation uuid; replacement record;
begin
  select i.id into admin_invitation from test.all_invitations() i
  where i.organization_id = test.org('boot2') and i.grants_admin and i.status = 'pending';

  perform test.login('pat');
  perform public.revoke_bootstrap_organization_invitation(test.org('boot2'), admin_invitation);
  assert (select i.status from test.all_invitations() i where i.id = admin_invitation) = 'revoked', 'D: the setup is cancelled';
  assert test.pending_admin_invitations('boot2') = 0, 'D: no administrator setup is pending';
  -- cancelling twice is not a way to reach anything else
  assert test.sqlstate_of(format('select public.revoke_bootstrap_organization_invitation(%L, %L)', test.org('boot2'), admin_invitation)) = 'P0002', 'a cancelled setup cannot be cancelled again';

  select * into replacement from public.bootstrap_organization_administrator(test.org('boot2'), 'replacement@boot.test');
  assert replacement.status = 'invite_ready', 'G: a different administrator can now be named';
  assert test.pending_admin_invitations('boot2') = 1, 'G: and there is again exactly one';
end $$;

-- promoting an ordinary pending invitation into the administrator setup ----------------------------
-- A stranded organization can already have an ordinary invitation outstanding: someone was invited
-- while it still had an administrator, and it lost them afterwards. Naming that same person as the
-- administrator must carry the existing invitation up rather than fail on the pending-address
-- uniqueness, and rather than issue a second link to the same person. Set up as the owner because
-- no tenant caller can issue an invitation in an organization nobody administers.
insert into public.organizations (name, slug) values ('Bootstrap Four', 'boot4');
insert into public.organization_invitations (organization_id, email)
  values (test.org('boot4'), 'promote@boot.test');
-- the unconfirmed account the invitation email would have created
insert into auth.users (id, email, email_confirmed_at)
  values (test.uid('promote'), 'promote@boot.test', null);

do $$
declare original uuid; promoted record;
begin
  select i.id into original from test.all_invitations() i
  where i.organization_id = test.org('boot4') and i.email = 'promote@boot.test';
  assert not (select i.grants_admin from test.all_invitations() i where i.id = original), 'it starts as an ordinary invitation';
  assert not test.has_recovery_manager(test.org('boot4')), 'and boot4 cannot administer itself';

  -- the promotion is the control plane's alone
  perform test.login('alice');
  assert test.sqlstate_of(format('select * from public.bootstrap_organization_administrator(%L, %L)', test.org('boot4'), 'promote@boot.test')) = '42501', 'a tenant caller cannot promote an invitation';
  assert test.sqlstate_of(format('update public.organization_invitations set grants_admin = true where id = %L', original)) = '42501', 'nor write the marker directly';
  assert not (select i.grants_admin from test.all_invitations() i where i.id = original), 'so it is still ordinary';

  perform test.login('pat');
  select * into promoted from public.bootstrap_organization_administrator(test.org('boot4'), 'promote@boot.test');
  assert promoted.status = 'invite_pending', 'the existing invitation is reused';
  assert promoted.invitation_id = original, 'and it is the very same invitation';
  assert promoted.membership_id is null, 'nothing is seated yet';
  assert (select i.grants_admin from test.all_invitations() i where i.id = original), 'it now carries the administrator role';
  assert (select count(*) from test.all_invitations() i where i.organization_id = test.org('boot4') and i.email = 'promote@boot.test' and i.status = 'pending') = 1, 'no second invitation was issued to the same address';
  assert test.pending_admin_invitations('boot4') = 1, 'and the organization has exactly one pending setup';
end $$;

-- it behaves as the organization's administrator setup from here on --------------------------------
do $$
declare resent record;
begin
  perform test.login('pat');
  -- resending is the same idempotent call the control plane makes
  select * into resent from public.bootstrap_organization_administrator(test.org('boot4'), 'promote@boot.test');
  assert resent.status = 'invite_pending', 'resend still resolves to the same setup';
  assert test.pending_admin_invitations('boot4') = 1, 'without duplicating it';
  -- and naming somebody else is refused while it stands
  assert test.sqlstate_of(format('select * from public.bootstrap_organization_administrator(%L, %L)', test.org('boot4'), 'other.admin@boot.test')) = 'TQ008', 'a second administrator setup is still refused';
end $$;

update auth.users set email_confirmed_at = now() where id = test.uid('promote');
do $$
declare joined record;
begin
  perform test.login_as(test.uid('promote'));
  select * into joined from public.accept_organization_invitation((select i.id from test.all_invitations() i where i.email = 'promote@boot.test' and i.status = 'pending'));
  assert joined.organization_slug = 'boot4', 'the promoted invitation is accepted';
  assert test.holds_system_role('boot4', test.uid('promote')), 'and assigns the system role';
  assert test.has_recovery_manager(test.org('boot4')), 'so boot4 administers itself';
end $$;

-- superseding an ordinary invitation by seating its recipient directly -----------------------------
-- The same stranded-organization state, except the address already has a finished account. Seating
-- is immediate, and the invitation they were never going to need is closed rather than left in the
-- tenant's pending list addressed to somebody who is already the administrator.
insert into public.organizations (name, slug) values ('Bootstrap Five', 'boot5');
insert into auth.users (id, email, email_confirmed_at)
  values (test.uid('supersede'), 'supersede@boot.test', now());
insert into public.organization_invitations (organization_id, email)
  values (test.org('boot5'), 'supersede@boot.test');
-- two invitations that must not be touched: a different address here, and the same address in
-- another organization
insert into public.organization_invitations (organization_id, email)
  values (test.org('boot5'), 'bystander@boot.test');
insert into public.organization_invitations (organization_id, email)
  values (test.org('boot4'), 'supersede@boot.test');

do $$
declare superseded uuid; bystander uuid; elsewhere uuid; seated record;
begin
  select i.id into superseded from test.all_invitations() i
  where i.organization_id = test.org('boot5') and i.email = 'supersede@boot.test';
  select i.id into bystander from test.all_invitations() i
  where i.organization_id = test.org('boot5') and i.email = 'bystander@boot.test';
  select i.id into elsewhere from test.all_invitations() i
  where i.organization_id = test.org('boot4') and i.email = 'supersede@boot.test';

  assert not (select i.grants_admin from test.all_invitations() i where i.id = superseded), 'it starts as an ordinary invitation';
  assert (select i.status from test.all_invitations() i where i.id = superseded) = 'pending', 'and pending';
  assert not test.has_recovery_manager(test.org('boot5')), 'boot5 cannot administer itself';

  perform test.login('pat');
  select * into seated from public.bootstrap_organization_administrator(test.org('boot5'), 'supersede@boot.test');
  assert seated.status = 'administrator_ready', 'the confirmed account is seated immediately';
  assert seated.membership_id is not null and seated.invitation_id is null, 'with no invitation involved';

  -- the membership and the role
  assert (select m.is_active from public.organization_memberships m
          where m.organization_id = test.org('boot5') and m.user_id = test.uid('supersede')), 'they are an active member';
  assert test.holds_system_role('boot5', test.uid('supersede')), 'holding the system role';
  assert test.has_recovery_manager(test.org('boot5')), 'so boot5 administers itself';

  -- the superseded invitation is closed, and closed honestly
  assert (select i.status from test.all_invitations() i where i.id = superseded) = 'revoked', 'the ordinary invitation is revoked';
  assert (select i.revoked_at from test.all_invitations() i where i.id = superseded) is not null, 'with revoked_at recorded';
  assert (select i.accepted_at from test.all_invitations() i where i.id = superseded) is null
     and (select i.accepted_user_id from test.all_invitations() i where i.id = superseded) is null,
    'and never marked accepted - they did not accept it';
  assert not (select i.grants_admin from test.all_invitations() i where i.id = superseded), 'it was not promoted on the way out';
  assert (select count(*) from test.all_invitations() i
          where i.organization_id = test.org('boot5') and i.email = 'supersede@boot.test' and i.status = 'pending') = 0,
    'nothing pending remains for that address here';

  -- nothing else moved
  assert (select i.status from test.all_invitations() i where i.id = bystander) = 'pending', 'another address in the same organization is untouched';
  assert (select i.status from test.all_invitations() i where i.id = elsewhere) = 'pending', 'the same address in another organization is untouched';
  assert test.pending_admin_invitations('boot5') = 0, 'and no bootstrap invitation was created';
end $$;

-- the ordinary invitation path is untouched by any of this -----------------------------------------
insert into auth.users (id, email, email_confirmed_at) values (test.uid('plainjoin'), 'plainjoin@boot.test', null);
do $$
declare prepared record;
begin
  perform test.login('alice'); -- members.manage in acme
  select * into prepared from public.prepare_organization_invitation(test.org('acme'), 'plainjoin@boot.test');
  assert prepared.status in ('invite_ready', 'reinvite_ready'), 'the ordinary path still issues invitations';
  assert not (select i.grants_admin from test.all_invitations() i where i.id = prepared.invitation_id), 'and never marks them as bootstrap';
end $$;
update auth.users set email_confirmed_at = now() where id = test.uid('plainjoin');

-- K: ordinary acceptance still produces zero roles, even though acme has a recovery manager ---------
do $$
declare joined record;
begin
  perform test.login_as(test.uid('plainjoin'));
  select * into joined from public.accept_organization_invitation((select i.id from test.all_invitations() i where i.email = 'plainjoin@boot.test' and i.status = 'pending'));
  assert joined.organization_slug = 'acme', 'K: the ordinary invitation is accepted';
  assert not test.holds_system_role('acme', test.uid('plainjoin')), 'K: with no system role';
  assert (select count(*) from public.membership_roles mr join public.organization_memberships m on m.id = mr.membership_id where m.user_id = test.uid('plainjoin')) = 0, 'K: and no roles whatsoever';
end $$;

-- H + L: bootstrap acceptance while the window is open ---------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values (test.uid('replacement'), 'replacement@boot.test', now());
do $$
declare joined record; again record;
begin
  perform test.login_as(test.uid('replacement'));
  select * into joined from public.accept_organization_invitation((select i.id from test.all_invitations() i where i.email = 'replacement@boot.test' and i.status = 'pending'));
  assert joined.organization_slug = 'boot2', 'H: the bootstrap invitation is accepted';
  assert test.holds_system_role('boot2', test.uid('replacement')), 'H: and carries the system role with it';
  assert test.has_recovery_manager(test.org('boot2')), 'H: so boot2 now administers itself';

  -- L: re-opening the same link is still idempotent, and is settled before any window check
  select * into again from public.accept_organization_invitation((select i.id from test.all_invitations() i where i.email = 'replacement@boot.test' and i.status = 'accepted'));
  assert again.organization_slug = 'boot2', 'L: an already accepted bootstrap invitation remains idempotent';
  assert test.holds_system_role('boot2', test.uid('replacement')), 'L: and nothing is taken away';
end $$;

-- which closes that organization to further bootstrapping too ---------------------------------------
do $$
begin
  perform test.login('pat');
  assert test.sqlstate_of(format('select * from public.bootstrap_organization_administrator(%L, %L)', test.org('boot2'), 'someone@boot.test')) = 'TQ006', 'boot2 is no longer bootstrappable';
end $$;

-- I + J: a setup issued before recovery must not confer administration after it ---------------------
-- boot3 is bootstrapped for an address that never accepts, and the organization then recovers by
-- another route - exactly the stale-link case.
insert into auth.users (id, email, email_confirmed_at) values (test.uid('stale'), 'stale@boot.test', now());
insert into auth.users (id, email, email_confirmed_at) values (test.uid('other'), 'other@boot.test', now());

-- a setup is issued to an address with no account, while boot3 is stranded
do $$
declare issued record; cancelled uuid;
begin
  assert not test.has_recovery_manager(test.org('boot3')), 'boot3 starts stranded';
  perform test.login('pat');
  select * into issued from public.bootstrap_organization_administrator(test.org('boot3'), 'pending@boot.test');
  assert issued.status = 'invite_ready', 'a setup is pending for an address with no account';
  assert test.pending_admin_invitations('boot3') = 1, 'exactly one, outstanding';

  -- the organization then recovers by another route. Naming a second administrator is blocked
  -- while one is pending, so the control plane cancels first - which is what Cancel setup does.
  select i.id into cancelled from test.all_invitations() i
  where i.organization_id = test.org('boot3') and i.grants_admin and i.status = 'pending';
  perform public.revoke_bootstrap_organization_invitation(test.org('boot3'), cancelled);
  perform public.bootstrap_organization_administrator(test.org('boot3'), 'stale@boot.test');
  assert test.has_recovery_manager(test.org('boot3')), 'boot3 now administers itself';
end $$;

-- A setup that was issued before that recovery and never opened. Constructed as the owner because
-- the RPC will no longer issue one for a recovered organization - which is the point: the link
-- already exists in the wild, and acceptance is the only place left to refuse it.
insert into public.organization_invitations (organization_id, email, grants_admin)
  values (test.org('boot3'), 'other@boot.test', true);
do $$
declare stale_invitation uuid;
begin
  select i.id into stale_invitation from test.all_invitations() i
  where i.organization_id = test.org('boot3') and i.grants_admin and i.status = 'pending';

  perform test.login_as(test.uid('other'));
  assert test.sqlstate_of(format('select * from public.accept_organization_invitation(%L)', stale_invitation)) = 'TQ007', 'I: a setup issued before recovery is refused afterwards';
  assert not exists (select 1 from public.organization_memberships m where m.organization_id = test.org('boot3') and m.user_id = test.uid('other')), 'I: and creates no membership at all';
  assert (select i.status from test.all_invitations() i where i.id = stale_invitation) = 'pending', 'I: the invitation is left for the control plane to cancel';
end $$;

-- J: the re-check happens under the organization row lock, so it cannot race a management change
do $$
declare source text;
begin
  select p.prosrc into source from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'accept_organization_invitation';
  -- the organization row is taken FOR UPDATE - the same row and mode that
  -- private.lock_organization_for_management uses - before the window is evaluated
  assert position('for update' in source) > 0, 'J: acceptance locks rows explicitly';
  assert position('from public.organizations o' in source) > 0
     and position('for update' in substr(source, position('from public.organizations o' in source))) > 0,
    'J: the organization row itself is locked';
  assert position('from public.organizations o' in source)
       < position('organization_has_recovery_manager' in source),
    'J: and the lock is taken before the recovery-manager check';
end $$;

-- the platform administration read ------------------------------------------------------------------
do $$
declare state record;
begin
  perform test.login('pat');
  select * into state from public.get_platform_organization_administration(test.org('boot1'));
  assert state.has_recovery_manager, 'boot1 reports an administrator';
  assert state.administrator_emails = array['seated@boot.test'], 'and names them';
  assert state.pending_admin_invitation_id is null, 'with nothing outstanding';
  assert not state.caller_is_member, 'pat bootstrapped it but did not join it';

  -- boot3 administers itself AND still carries a live admin-bearing invitation: both are reported,
  -- because hiding the second would hide a live grant
  select * into state from public.get_platform_organization_administration(test.org('boot3'));
  assert state.has_recovery_manager, 'boot3 has an administrator';
  assert state.pending_admin_invitation_id is not null, 'and its stale setup is still surfaced';
  assert state.pending_admin_email = 'other@boot.test', 'by address';

  perform test.login('alice');
  assert test.sqlstate_of(format('select * from public.get_platform_organization_administration(%L)', test.org('boot1'))) = '42501', 'a tenant administrator cannot read the control plane';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Phase 3.3: the platform operations overview
--
-- One row per organization so the control plane can see which tenants are stranded without
-- opening each one. It is a read, gated the same way, and adds no authority.
-- ---------------------------------------------------------------------------------------------
do $$
begin
  perform test.login('alice');
  assert test.sqlstate_of('select * from public.get_platform_organizations_overview()') = '42501', 'a tenant administrator cannot read the overview';
  perform test.login('bob');
  assert test.sqlstate_of('select * from public.get_platform_organizations_overview()') = '42501', 'nor an ordinary member';
  execute 'set local role anon';
  assert test.sqlstate_of('select * from public.get_platform_organizations_overview()') = '42501', 'nor anonymous';
end $$;

do $$
declare row_for record; total bigint;
begin
  perform test.login('pat');
  select count(*) into total from public.get_platform_organizations_overview();
  assert total = (select count(*) from public.organizations), 'every organization is reported exactly once';

  -- boot1: seated directly, nothing outstanding
  select * into row_for from public.get_platform_organizations_overview() o where o.slug = 'boot1';
  assert row_for.has_recovery_manager, 'boot1 administers itself';
  assert row_for.administrator_count = 1, 'by exactly one administrator';
  assert row_for.pending_admin_invitation_id is null, 'with no setup outstanding';
  assert row_for.pending_member_invitations = 0, 'and no member invitations';
  assert not row_for.caller_is_member, 'pat bootstrapped it without joining it';

  -- boot3: administers itself AND still carries the obsolete setup, which must not be hidden
  select * into row_for from public.get_platform_organizations_overview() o where o.slug = 'boot3';
  assert row_for.has_recovery_manager, 'boot3 administers itself';
  assert row_for.pending_admin_email = 'other@boot.test', 'and its obsolete setup is still surfaced';

  -- boot5: an ordinary pending invitation is counted, never named
  select * into row_for from public.get_platform_organizations_overview() o where o.slug = 'boot5';
  assert row_for.has_recovery_manager, 'boot5 administers itself';
  assert row_for.pending_admin_invitation_id is null, 'the superseded invitation was not an admin setup';
  assert row_for.pending_member_invitations = 1, 'the ordinary invitation is counted';

  -- a suspended organization is still reported, with its state intact
  select * into row_for from public.get_platform_organizations_overview() o where o.slug = 'beta';
  assert row_for.is_active = (select o.is_active from public.organizations o where o.slug = 'beta'), 'activity is reported as it stands';
end $$;

-- the counts are of ordinary invitations only, and never disclose who they are addressed to -------
create table test.overview_probe (member_count integer);
grant select, insert on test.overview_probe to authenticated, anon;
do $$
declare admin_row record;
begin
  perform test.login('pat');
  select * into admin_row from public.get_platform_organizations_overview() o where o.slug = 'boot3';
  -- boot3's outstanding admin-bearing invitation is reported in its own field, not as a member count
  assert admin_row.pending_admin_invitation_id is not null, 'the administrator setup is its own field';
  insert into test.overview_probe (member_count) values (admin_row.pending_member_invitations);
end $$;

-- as the owner: an ordinary invitation arrives in boot3
insert into public.organization_invitations (organization_id, email)
  values (test.org('boot3'), 'counted@boot.test');

do $$
declare admin_row record; before_count integer;
begin
  select p.member_count into before_count from test.overview_probe p;
  perform test.login('pat');
  select * into admin_row from public.get_platform_organizations_overview() o where o.slug = 'boot3';
  assert admin_row.pending_member_invitations = before_count + 1, 'an ordinary invitation increments the member count';
  assert admin_row.pending_admin_email = 'other@boot.test', 'and leaves the administrator setup alone';

  -- the overview exposes no ordinary invitation address anywhere in its result
  assert not exists (
    select 1 from public.get_platform_organizations_overview() o
    where o.pending_admin_email = 'counted@boot.test'
  ), 'an ordinary recipient is never named by the control plane';
end $$;

-- membership is reported from the caller's own perspective ------------------------------------------
do $$
declare row_for record;
begin
  perform test.login('alice'); -- a member of acme, but not a platform admin, so she cannot read it
  assert test.sqlstate_of('select * from public.get_platform_organizations_overview()') = '42501', 'still refused';

  perform test.login('pat');
  select * into row_for from public.get_platform_organizations_overview() o where o.slug = 'acme';
  assert not row_for.caller_is_member, 'pat is not a member of acme';
  assert row_for.has_recovery_manager, 'which administers itself regardless';
end $$;

-- the new administrators are ordinary tenant administrators, still bound by TQ003 and TQ004 ---------
do $$
begin
  perform test.login_as(test.uid('replacement'));
  assert test.sqlstate_of(format('select public.set_organization_member_status(%L, %L, false)', test.org('boot2'), test.membership_in('boot2', test.uid('replacement')))) = 'TQ003', 'the sole administrator cannot deactivate themselves';
  assert test.sqlstate_of(format('select public.set_organization_member_roles(%L, %L, %L)', test.org('boot2'), test.membership_in('boot2', test.uid('replacement')), array[]::uuid[])) = 'TQ004', 'and cannot strip the last recovery manager';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Phase 4: jobs and job requirements
--
-- The first recruitment domain, and the first tenant data that platform administration cannot
-- see. Two organizations with their own jobs, and three identities: a manager, a viewer, and
-- somebody with neither key.
-- ---------------------------------------------------------------------------------------------
insert into public.organizations (name, slug) values ('Jobs Alpha', 'jobsa');
insert into public.organizations (name, slug) values ('Jobs Beta', 'jobsb');
insert into auth.users (id, email) values
  (test.uid('jman'), 'jman@jobs.test'),
  (test.uid('jview'), 'jview@jobs.test'),
  (test.uid('jnone'), 'jnone@jobs.test'),
  (test.uid('bman'), 'bman@jobs.test');

create function test.job_id(slug text, job_title text) returns uuid
language sql stable security definer as $$
  select j.id from public.jobs j join public.organizations o on o.id = j.organization_id
  where o.slug = job_id.slug and j.title = job_title
$$;
create function test.job_status(job uuid) returns text
language sql stable security definer as $$ select status from public.jobs where id = job $$;
grant execute on function test.job_id(text, text), test.job_status(uuid) to authenticated, anon;

-- memberships and roles, established as the owner exactly as provisioning would
do $$
declare alpha uuid := test.org('jobsa'); beta uuid := test.org('jobsb');
  manage_role uuid; view_role uuid; none_role uuid; beta_role uuid; membership uuid;
begin
  insert into public.roles (organization_id, name) values (alpha, 'Hiring Manager') returning id into manage_role;
  insert into public.role_permissions (role_id, organization_id, permission_key)
    values (manage_role, alpha, 'jobs.view'), (manage_role, alpha, 'jobs.manage');

  insert into public.roles (organization_id, name) values (alpha, 'Job Viewer') returning id into view_role;
  insert into public.role_permissions (role_id, organization_id, permission_key)
    values (view_role, alpha, 'jobs.view');

  insert into public.roles (organization_id, name) values (alpha, 'Bystander') returning id into none_role;
  insert into public.role_permissions (role_id, organization_id, permission_key)
    values (none_role, alpha, 'members.view');

  insert into public.roles (organization_id, name) values (beta, 'Beta Hiring') returning id into beta_role;
  insert into public.role_permissions (role_id, organization_id, permission_key)
    values (beta_role, beta, 'jobs.view'), (beta_role, beta, 'jobs.manage');

  insert into public.organization_memberships (organization_id, user_id) values (alpha, test.uid('jman')) returning id into membership;
  insert into public.membership_roles (membership_id, role_id, organization_id) values (membership, manage_role, alpha);
  insert into public.organization_memberships (organization_id, user_id) values (alpha, test.uid('jview')) returning id into membership;
  insert into public.membership_roles (membership_id, role_id, organization_id) values (membership, view_role, alpha);
  insert into public.organization_memberships (organization_id, user_id) values (alpha, test.uid('jnone')) returning id into membership;
  insert into public.membership_roles (membership_id, role_id, organization_id) values (membership, none_role, alpha);
  insert into public.organization_memberships (organization_id, user_id) values (beta, test.uid('bman')) returning id into membership;
  insert into public.membership_roles (membership_id, role_id, organization_id) values (membership, beta_role, beta);
end $$;

-- 5 + 6: the catalog reaches the system role and nobody else's role --------------------------------
do $$
begin
  assert (select count(*) from public.role_permissions rp
          join public.roles r on r.id = rp.role_id
          where r.is_system and r.organization_id = test.org('jobsa')
            and rp.permission_key in ('jobs.view', 'jobs.manage')) = 2,
    '5: the provisioned Organization Admin holds both job permissions';
  assert (select count(*) from public.role_permissions rp
          join public.roles r on r.id = rp.role_id
          where r.is_system and rp.permission_key in ('jobs.view', 'jobs.manage')) =
         (select count(*) from public.roles where is_system) * 2,
    '5: in every organization, including those that existed before the migration';
  assert not exists (
    select 1 from public.role_permissions rp
    join public.roles r on r.id = rp.role_id
    where not r.is_system and r.name in ('Recruiter', 'Interview Panel', 'Job Viewer', 'Bystander')
      and rp.permission_key = 'jobs.manage'
  ), '6: a custom role never silently gains a new capability';
end $$;

-- 1 + 2: the two keys do what they say -------------------------------------------------------------
do $$
declare created uuid;
begin
  perform test.login('jman');
  insert into public.jobs (organization_id, title, description, created_by)
  values (test.org('jobsa'), 'Senior Engineer', 'Build things.', test.uid('jman'))
  returning id into created;
  assert created is not null, '2: jobs.manage can create';
  assert (select j.status from public.jobs j where j.id = created) = 'draft', 'new jobs start as drafts';

  update public.jobs set title = 'Senior Engineer', openings = 3 where id = created;
  assert (select j.openings from public.jobs j where j.id = created) = 3, '2: jobs.manage can update';

  perform test.login('jview');
  assert (select count(*) from public.jobs where organization_id = test.org('jobsa')) = 1, '1: jobs.view can read';
end $$;

-- 3 + 4: and refuse what they do not -----------------------------------------------------------------
-- An UPDATE or DELETE the policy does not admit matches no rows rather than raising: RLS filters,
-- it does not reject. The proof that a write was refused is therefore the row, not a SQLSTATE.
-- An INSERT is different - a failing WITH CHECK does raise - so both shapes are exercised.
do $$
declare job uuid := test.job_id('jobsa', 'Senior Engineer'); touched integer;
begin
  perform test.login('jview');
  update public.jobs set title = 'Hijacked' where id = job;
  get diagnostics touched = row_count;
  assert touched = 0, '3: view-only updates nothing';
  assert test.sqlstate_of(format('insert into public.jobs (organization_id, title) values (%L, %L)', test.org('jobsa'), 'Sneaky')) = '42501', '3: view-only cannot create';

  perform test.login('jman');
  assert (select j.title from public.jobs j where j.id = job) = 'Senior Engineer', '3: and the job is as it was';

  perform test.login('jnone');
  assert (select count(*) from public.jobs) = 0, '4: without jobs.view there is nothing to see';
  update public.jobs set title = 'Hijacked' where id = job;
  get diagnostics touched = row_count;
  assert touched = 0, '4: and nothing to change';
  assert test.sqlstate_of(format('insert into public.jobs (organization_id, title) values (%L, %L)', test.org('jobsa'), 'Sneaky')) = '42501', '4: nor anything to add';

  execute 'set local role anon';
  assert test.sqlstate_of('select count(*) from public.jobs') = '42501', '4: anonymous has no access at all';
end $$;

-- 7 to 10: the organization boundary ------------------------------------------------------------------
do $$
declare alpha_job uuid := test.job_id('jobsa', 'Senior Engineer'); beta_job uuid;
begin
  perform test.login('bman');
  insert into public.jobs (organization_id, title) values (test.org('jobsb'), 'Beta Role') returning id into beta_job;

  assert (select count(*) from public.jobs) = 1, '7: beta sees only its own job';
  assert not exists (select 1 from public.jobs j where j.id = alpha_job), '7: alpha''s job is invisible';
  -- an update that matches nothing is not an error, so the proof is that the row is untouched
  update public.jobs set title = 'Stolen' where id = alpha_job;
  perform test.login('jview');
  assert (select j.title from public.jobs j where j.id = alpha_job) = 'Senior Engineer', '8: and unchanged';

  -- 9: a requirement against another organization's job is unrepresentable, not merely refused
  perform test.login('bman');
  assert test.sqlstate_of(format(
    'insert into public.job_requirements (organization_id, job_id, requirement) values (%L, %L, %L)',
    test.org('jobsb'), alpha_job, 'Cross-tenant')) = '23503',
    '9: the composite foreign key rejects a cross-organization requirement';
  assert test.sqlstate_of(format(
    'insert into public.job_requirements (organization_id, job_id, requirement) values (%L, %L, %L)',
    test.org('jobsa'), alpha_job, 'Cross-tenant')) = '42501',
    '9: and claiming the other organization is refused by policy';
end $$;

-- requirements, and 10: their boundary ------------------------------------------------------------
do $$
declare job uuid := test.job_id('jobsa', 'Senior Engineer'); made uuid; removed integer;
begin
  perform test.login('jman');
  insert into public.job_requirements (organization_id, job_id, category, requirement, importance, weight)
  values (test.org('jobsa'), job, 'skill', 'PostgreSQL', 'required', 2.5)
  returning id into made;
  assert (select r.source from public.job_requirements r where r.id = made) = 'manual', 'requirements are the recruiter''s by default';
  assert (select r.display_order from public.job_requirements r where r.id = made) = 0, 'and ordered';

  -- a machine-written one is editable and removable exactly like any other
  insert into public.job_requirements (organization_id, job_id, requirement, source, display_order)
  values (test.org('jobsa'), job, 'Kubernetes', 'ai', 1);
  update public.job_requirements set requirement = 'Kubernetes (edited)' where source = 'ai';
  assert (select count(*) from public.job_requirements where requirement = 'Kubernetes (edited)') = 1, 'AI is not the authority over requirements';

  perform test.login('jview');
  assert (select count(*) from public.job_requirements) = 2, 'jobs.view reads requirements';
  delete from public.job_requirements where id = made;
  get diagnostics removed = row_count;
  assert removed = 0, 'view-only removes nothing';

  perform test.login('jman');
  assert exists (select 1 from public.job_requirements r where r.id = made), 'and the requirement survives';

  perform test.login('bman');
  assert (select count(*) from public.job_requirements) = 0, '10: and another organization reads none of them';
end $$;

-- 11: the lifecycle is the database's, not the form's ----------------------------------------------
do $$
declare job uuid := test.job_id('jobsa', 'Senior Engineer');
begin
  perform test.login('jman');
  assert test.sqlstate_of(format('update public.jobs set status = %L where id = %L', 'closed', job)) = 'TQ009', '11: draft cannot jump to closed';
  assert test.sqlstate_of(format('update public.jobs set status = %L where id = %L', 'paused', job)) = 'TQ009', '11: nor to paused';
  assert test.job_status(job) = 'draft', '11: and stays a draft';

  update public.jobs set status = 'open' where id = job;
  assert test.job_status(job) = 'open', 'draft opens';
  assert test.sqlstate_of(format('update public.jobs set status = %L where id = %L', 'draft', job)) = 'TQ009', 'an open job cannot go back to draft';
  assert test.sqlstate_of(format('update public.jobs set status = %L where id = %L', 'archived', job)) = 'TQ009', 'nor straight to archived';

  update public.jobs set status = 'paused' where id = job;
  update public.jobs set status = 'open' where id = job;
  update public.jobs set status = 'closed' where id = job;
  assert test.sqlstate_of(format('update public.jobs set status = %L where id = %L', 'open', job)) = 'TQ009', 'a closed job cannot reopen';
  update public.jobs set status = 'archived' where id = job;
  assert test.job_status(job) = 'archived', 'and is archived from closed';
end $$;

-- 15: archived is terminal, for the job and everything hanging off it -------------------------------
do $$
declare job uuid := test.job_id('jobsa', 'Senior Engineer'); requirement uuid;
begin
  select r.id into requirement from public.job_requirements r where r.job_id = job limit 1;
  perform test.login('jman');
  assert test.sqlstate_of(format('update public.jobs set title = %L where id = %L', 'Renamed', job)) = 'TQ010', '15: an archived job cannot be edited';
  assert test.sqlstate_of(format('update public.jobs set status = %L where id = %L', 'open', job)) = 'TQ010', '15: nor revived';
  assert test.sqlstate_of(format('update public.job_requirements set requirement = %L where id = %L', 'Changed', requirement)) = 'TQ010', '15: nor its requirements edited';
  assert test.sqlstate_of(format('delete from public.job_requirements where id = %L', requirement)) = 'TQ010', '15: nor removed';
  assert (select j.title from public.jobs j where j.id = job) = 'Senior Engineer', '15: the record stands';
end $$;

-- 12 + 16: the constraints, not the form, decide what a job may contain -----------------------------
do $$
declare job uuid; org uuid := test.org('jobsa');
begin
  perform test.login('jman');
  insert into public.jobs (organization_id, title) values (org, 'Validation Target') returning id into job;

  assert test.sqlstate_of(format('update public.jobs set openings = 0 where id = %L', job)) = '23514', '12: openings below one is refused';
  assert test.sqlstate_of(format('update public.jobs set openings = -5 where id = %L', job)) = '23514', '12: and a negative one';
  assert test.sqlstate_of(format('update public.jobs set title = %L where id = %L', '   ', job)) = '23514', 'a blank title is refused';
  -- The lifecycle guard is a BEFORE trigger, so it reaches an unknown status before the check
  -- constraint does. Either way it never lands.
  assert test.sqlstate_of(format('update public.jobs set status = %L where id = %L', 'retired', job)) = 'TQ009', 'an unknown status is refused';
  assert test.sqlstate_of(format('insert into public.jobs (organization_id, title, status) values (%L, %L, %L)', org, 'Bad Status', 'retired')) = '23514', 'and refused outright on insert, where no transition exists yet';
  assert test.sqlstate_of(format('update public.jobs set work_mode = %L where id = %L', 'telepathic', job)) = '23514', 'an unknown work mode is refused';
  -- The ceiling moved to 100 in Phase 6 so a rubric can be expressed in points; 99 is now a
  -- legitimate weight, so the out-of-range case is tested above it rather than at the old limit.
  assert test.sqlstate_of(format(
    'insert into public.job_requirements (organization_id, job_id, requirement, weight) values (%L, %L, %L, 101)',
    org, job, 'Too heavy')) = '23514', 'an out-of-range weight is refused';
  assert test.sqlstate_of(format(
    'insert into public.job_requirements (organization_id, job_id, requirement, category) values (%L, %L, %L, %L)',
    org, job, 'Odd', 'vibes')) = '23514', 'an unknown category is refused';
  assert test.sqlstate_of(format(
    'insert into public.job_requirements (organization_id, job_id, requirement) values (%L, %L, %L)',
    org, job, '  ')) = '23514', 'blank requirement text is refused';

  -- 16: and a requirement cannot be moved to another organization's job afterwards
  assert test.sqlstate_of(format(
    'update public.job_requirements set job_id = %L where job_id = %L',
    test.job_id('jobsb', 'Beta Role'), test.job_id('jobsa', 'Senior Engineer'))) in ('23503', 'TQ010'),
    '16: a requirement cannot be re-pointed across the boundary';
end $$;

-- Phase 4 completion, new test 1: reordering persists, and freezes with the job ---------------------
do $$
declare org uuid := test.org('jobsa'); job uuid; first_id uuid; second_id uuid; third_id uuid; moved integer;
begin
  perform test.login('jman');
  insert into public.jobs (organization_id, title) values (org, 'Ordering Target') returning id into job;
  insert into public.job_requirements (organization_id, job_id, requirement, display_order)
    values (org, job, 'First', 0) returning id into first_id;
  insert into public.job_requirements (organization_id, job_id, requirement, display_order)
    values (org, job, 'Second', 1) returning id into second_id;
  insert into public.job_requirements (organization_id, job_id, requirement, source, display_order)
    values (org, job, 'Third', 'ai', 2) returning id into third_id;

  -- the order the editor submits becomes the stored order, in one statement
  moved := public.reorder_job_requirements(org, job, array[third_id, first_id, second_id]);
  assert moved = 3, 'every requirement was renumbered';
  assert (select array_agg(r.requirement order by r.display_order)
          from public.job_requirements r where r.job_id = job) = array['Third', 'First', 'Second'],
    'and the new order persists';
  -- a machine-written requirement reorders exactly like any other
  assert (select r.display_order from public.job_requirements r where r.id = third_id) = 0,
    'a suggested requirement holds no special position';

  -- an id from another job renumbers nothing
  moved := public.reorder_job_requirements(org, job, array[test.job_id('jobsa', 'Validation Target')]);
  assert moved = 0, 'a foreign id moves nothing';
  assert (select array_agg(r.requirement order by r.display_order)
          from public.job_requirements r where r.job_id = job) = array['Third', 'First', 'Second'],
    'and leaves the order as it was';

  -- archiving freezes ordering with everything else
  update public.jobs set status = 'open' where id = job;
  update public.jobs set status = 'closed' where id = job;
  update public.jobs set status = 'archived' where id = job;
  assert test.sqlstate_of(format('select public.reorder_job_requirements(%L, %L, %L)', org, job, array[first_id, second_id, third_id])) = 'TQ010',
    'an archived job cannot be reordered';
  assert (select array_agg(r.requirement order by r.display_order)
          from public.job_requirements r where r.job_id = job) = array['Third', 'First', 'Second'],
    'and its order is left exactly as it stands';
end $$;

-- Phase 4 completion, new test 2: reordering carries no authority of its own ------------------------
do $$
declare org uuid := test.org('jobsa'); job uuid;
  beta_job uuid := test.job_id('jobsb', 'Beta Role'); ids uuid[]; moved integer;
begin
  -- Its own live job: the lifecycle tests above leave earlier jobs archived, and an archived job
  -- would refuse every caller for the wrong reason.
  perform test.login('jman');
  insert into public.jobs (organization_id, title) values (org, 'Authorization Target') returning id into job;
  insert into public.job_requirements (organization_id, job_id, requirement, display_order)
    values (org, job, 'Alpha', 0), (org, job, 'Beta', 1);
  select array_agg(r.id order by r.display_order) into ids
  from public.job_requirements r where r.job_id = job;

  -- the function runs as its caller, so jobs.view alone changes nothing
  perform test.login('jview');
  moved := public.reorder_job_requirements(org, job, ids);
  assert moved = 0, 'a viewer reorders nothing';

  perform test.login('jnone');
  moved := public.reorder_job_requirements(org, job, ids);
  assert moved = 0, 'and neither does somebody with no job permission';

  -- nor does another organization, in either direction
  perform test.login('bman');
  moved := public.reorder_job_requirements(test.org('jobsb'), job, ids);
  assert moved = 0, 'beta cannot reorder an alpha job';
  moved := public.reorder_job_requirements(org, job, ids);
  assert moved = 0, 'not even by naming alpha as the organization';

  perform test.login('jman');
  moved := public.reorder_job_requirements(org, beta_job, ids);
  assert moved = 0, 'and alpha cannot reach into beta';

  -- the manager still can, which proves the zeros above were authorization and not a broken call
  moved := public.reorder_job_requirements(org, job, ids);
  assert moved = cardinality(ids), 'jobs.manage reorders its own job';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Phase 5: JD intelligence. Suggestions are not requirements until a person says so.
-- ---------------------------------------------------------------------------------------------

-- new test 1: approval creates exactly one requirement, honours edits, and cannot double-fire ------
do $$
declare org uuid := test.org('jobsa'); job uuid; run uuid; plain uuid; edited uuid; spurned uuid;
  made uuid; again uuid; before_count integer;
begin
  perform test.login('jman');
  insert into public.jobs (organization_id, title) values (org, 'Intelligence Target') returning id into job;
  insert into public.job_description_analyses (organization_id, job_id, provider, model, source_text)
  values (org, job, 'test', 'double', repeat('A job description long enough to analyze. ', 3))
  returning id into run;

  insert into public.job_requirement_suggestions (organization_id, analysis_id, job_id, requirement, display_order)
    values (org, run, job, 'Five years of PostgreSQL', 0) returning id into plain;
  insert into public.job_requirement_suggestions (organization_id, analysis_id, job_id, requirement, category, weight, display_order)
    values (org, run, job, 'Knows Kubernetes', 'skill', 3, 1) returning id into edited;
  insert into public.job_requirement_suggestions (organization_id, analysis_id, job_id, requirement, display_order)
    values (org, run, job, 'Invented certification', 2) returning id into spurned;

  select count(*) into before_count from public.job_requirements r where r.job_id = job;
  assert before_count = 0, 'a suggestion is not a requirement';

  -- plain approval copies the suggestion across, marked as AI in provenance only
  made := public.approve_job_requirement_suggestion(org, plain);
  assert (select r.requirement from public.job_requirements r where r.id = made) = 'Five years of PostgreSQL', 'approval creates the requirement';
  assert (select r.source from public.job_requirements r where r.id = made) = 'ai', 'recorded as AI-originated';
  assert (select s.status from public.job_requirement_suggestions s where s.id = plain) = 'approved', 'and the suggestion is settled';

  -- approving again returns the same requirement rather than creating a second
  again := public.approve_job_requirement_suggestion(org, plain);
  assert again = made, 'approving twice is idempotent';
  assert (select count(*) from public.job_requirements r where r.job_id = job) = 1, 'and creates nothing further';

  -- the recruiter's edits win over what was extracted
  made := public.approve_job_requirement_suggestion(org, edited, 'Kubernetes in production', 'experience', 'preferred', 7.5);
  assert (select r.requirement from public.job_requirements r where r.id = made) = 'Kubernetes in production', 'the edited wording is saved';
  assert (select r.category from public.job_requirements r where r.id = made) = 'experience', 'with the edited category';
  assert (select r.importance from public.job_requirements r where r.id = made) = 'preferred', 'and importance';
  assert (select r.weight from public.job_requirements r where r.id = made) = 7.5, 'and weight';

  -- rejection creates nothing and cannot be walked back into an approval
  update public.job_requirement_suggestions set status = 'rejected' where id = spurned;
  assert test.sqlstate_of(format('select public.approve_job_requirement_suggestion(%L, %L)', org, spurned)) = 'TQ011',
    'a rejected suggestion cannot be approved';
  assert (select count(*) from public.job_requirements r where r.job_id = job) = 2, 'only the approved two exist';
end $$;

-- new test 2: suggestions carry no authority of their own -------------------------------------------
do $$
declare org uuid := test.org('jobsa'); job uuid := test.job_id('jobsa', 'Intelligence Target');
  run uuid; pending_id uuid; touched integer;
begin
  perform test.login('jman');
  select a.id into run from public.job_description_analyses a where a.job_id = job limit 1;
  select s.id into pending_id from public.job_requirement_suggestions s
  where s.job_id = job and s.status = 'pending' limit 1;
  if pending_id is null then
    insert into public.job_requirement_suggestions (organization_id, analysis_id, job_id, requirement, display_order)
      values (org, run, job, 'Still pending', 9) returning id into pending_id;
  end if;

  -- jobs.view reads the review set but cannot act on it
  perform test.login('jview');
  assert (select count(*) from public.job_requirement_suggestions s where s.job_id = job) >= 1, 'a viewer can read suggestions';
  -- Refused, and refused before anything is created. The code is 'not found' rather than 'denied'
  -- because the function locks the row first and SELECT ... FOR UPDATE applies the UPDATE policy:
  -- a viewer may read the suggestion but may not take it for writing, so it is simply not there.
  assert test.sqlstate_of(format('select public.approve_job_requirement_suggestion(%L, %L)', org, pending_id)) in ('42501', 'P0002'),
    'but cannot approve one';
  perform test.login('jman');
  assert not exists (select 1 from public.job_requirements r where r.job_id = job and r.requirement = 'Still pending'),
    'and the attempt created no requirement';
  perform test.login('jview');
  update public.job_requirement_suggestions set status = 'rejected' where id = pending_id;
  get diagnostics touched = row_count;
  assert touched = 0, 'nor reject one';
  assert test.sqlstate_of(format('insert into public.job_description_analyses (organization_id, job_id, provider, model, source_text) values (%L, %L, %L, %L, %L)',
    org, job, 'test', 'x', repeat('Long enough to be a job description. ', 3))) = '42501', 'nor start an analysis';

  -- somebody with neither key sees nothing at all
  perform test.login('jnone');
  assert (select count(*) from public.job_requirement_suggestions) = 0, 'without jobs.view there is nothing to see';
  assert (select count(*) from public.job_description_analyses) = 0, 'not even that a run happened';

  -- and another organization is refused in both directions
  perform test.login('bman');
  assert (select count(*) from public.job_requirement_suggestions) = 0, 'beta sees none of alpha''s suggestions';
  assert test.sqlstate_of(format('select public.approve_job_requirement_suggestion(%L, %L)', test.org('jobsb'), pending_id)) = 'P0002',
    'and cannot approve one by naming its own organization';
  -- The alpha run's real id, captured above while it was readable, so this is a genuine attempt
  -- rather than an empty subquery that trivially succeeds.
  assert test.sqlstate_of(format('insert into public.job_requirement_suggestions (organization_id, analysis_id, job_id, requirement) values (%L, %L, %L, %L)',
    test.org('jobsb'), run, job, 'Cross tenant')) = '23503',
    'the composite key refuses a suggestion spanning two organizations';
  assert test.sqlstate_of(format('insert into public.job_requirement_suggestions (organization_id, analysis_id, job_id, requirement) values (%L, %L, %L, %L)',
    org, run, job, 'Cross tenant')) = '42501',
    'and claiming alpha outright is refused by policy';
end $$;

-- new test 3: re-running analysis is additive, and archiving freezes the whole flow -----------------
do $$
declare org uuid := test.org('jobsa'); job uuid := test.job_id('jobsa', 'Intelligence Target');
  first_run uuid; second_run uuid; approved_before integer; approved_after integer;
  first_set_before integer; new_suggestion uuid;
begin
  perform test.login('jman');
  select count(*) into approved_before from public.job_requirements r where r.job_id = job;
  select a.id into first_run from public.job_description_analyses a where a.job_id = job limit 1;
  select count(*) into first_set_before
  from public.job_requirement_suggestions s where s.analysis_id = first_run;

  -- a second run is a second set; it owns its own suggestions and touches nothing already decided
  insert into public.job_description_analyses (organization_id, job_id, provider, model, source_text)
  values (org, job, 'test', 'second', repeat('A different job description entirely. ', 3))
  returning id into second_run;
  insert into public.job_requirement_suggestions (organization_id, analysis_id, job_id, requirement, display_order)
    values (org, second_run, job, 'Something new', 0) returning id into new_suggestion;

  select count(*) into approved_after from public.job_requirements r where r.job_id = job;
  assert approved_after = approved_before, 'a new run changes no existing requirement';
  assert (select count(*) from public.job_requirement_suggestions s where s.analysis_id = first_run) = first_set_before,
    'and leaves the earlier review set intact';
  assert (select count(*) from public.job_requirement_suggestions s where s.analysis_id = second_run) = 1,
    'the new suggestions belong to the new run';

  -- archiving the job stops analysis, review and approval together
  update public.jobs set status = 'open' where id = job;
  update public.jobs set status = 'closed' where id = job;
  update public.jobs set status = 'archived' where id = job;
  assert test.sqlstate_of(format('select public.approve_job_requirement_suggestion(%L, %L)', org, new_suggestion)) = 'TQ010',
    'an archived job gains no further requirements';
  assert test.sqlstate_of(format('insert into public.job_description_analyses (organization_id, job_id, provider, model, source_text) values (%L, %L, %L, %L, %L)',
    org, job, 'test', 'third', repeat('Yet another job description here. ', 3))) = 'TQ010',
    'and cannot be analyzed again';
  assert (select count(*) from public.job_requirements r where r.job_id = job) = approved_before,
    'its requirements stand exactly as they were';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Phase 6: the screening rubric. No new tables - the rubric IS the approved requirements, read as
-- a weighted configuration. What is new is the weight range and setting several weights at once.
-- ---------------------------------------------------------------------------------------------

-- new test 1: rubric weights, their range, and manual requirements -----------------------------
do $$
declare org uuid := test.org('jobsa'); job uuid; a uuid; b uuid; c uuid; changed integer;
begin
  perform test.login('jman');
  insert into public.jobs (organization_id, title) values (org, 'Rubric Target') returning id into job;

  -- a manual requirement uses the same vocabulary and the widened weight range
  insert into public.job_requirements (organization_id, job_id, requirement, importance, weight, display_order)
    values (org, job, 'Five years of Go', 'required', 45, 0) returning id into a;
  insert into public.job_requirements (organization_id, job_id, requirement, importance, weight, display_order)
    values (org, job, 'PostgreSQL in production', 'required', 35, 1) returning id into b;
  insert into public.job_requirements (organization_id, job_id, requirement, importance, weight, display_order)
    values (org, job, 'Kubernetes', 'preferred', 20, 2) returning id into c;
  assert (select r.source from public.job_requirements r where r.id = a) = 'manual', 'a hand-written requirement is manual';

  -- the old ceiling of 10 is gone; 100 is now representable, and above it is not
  assert (select sum(r.weight) from public.job_requirements r where r.job_id = job) = 100, 'the three weights total 100';
  update public.job_requirements set weight = 100 where id = a;
  assert (select r.weight from public.job_requirements r where r.id = a) = 100, 'a single requirement may carry the whole rubric';
  assert test.sqlstate_of(format('update public.job_requirements set weight = 100.01 where id = %L', a)) = '23514', 'but no more';
  assert test.sqlstate_of(format('update public.job_requirements set weight = -1 where id = %L', a)) = '23514', 'and never less than nothing';

  -- several weights, one statement, paired by position
  changed := public.set_job_requirement_weights(org, job, array[a, b, c], array[50, 30, 20]::numeric[]);
  assert changed = 3, 'every weight was set';
  assert (select r.weight from public.job_requirements r where r.id = a) = 50, 'first';
  assert (select r.weight from public.job_requirements r where r.id = b) = 30, 'second';
  assert (select r.weight from public.job_requirements r where r.id = c) = 20, 'third';
  assert (select sum(r.weight) from public.job_requirements r where r.job_id = job) = 100, 'and the rubric totals 100';

  -- mismatched arrays are refused rather than silently paired off
  assert test.sqlstate_of(format('select public.set_job_requirement_weights(%L, %L, %L, %L)', org, job, array[a, b], array[50]::numeric[])) = '22023',
    'a weight is required for every requirement';
  -- importance is editable and is only ever metadata: nothing gates on it
  update public.job_requirements set importance = 'preferred' where id = a;
  assert (select r.importance from public.job_requirements r where r.id = a) = 'preferred', 'required becomes preferred';
  assert (select r.weight from public.job_requirements r where r.id = a) = 50, 'and carries the same weight either way';
end $$;

-- new test 2: setting weights carries no authority of its own ----------------------------------
do $$
declare org uuid := test.org('jobsa'); job uuid := test.job_id('jobsa', 'Rubric Target');
  beta_job uuid := test.job_id('jobsb', 'Beta Role'); ids uuid[]; changed integer;
begin
  select array_agg(r.id order by r.display_order) into ids
  from public.job_requirements r where r.job_id = job;

  -- jobs.view reads the rubric but cannot reweight it
  perform test.login('jview');
  assert (select count(*) from public.job_requirements r where r.job_id = job) = 3, 'a viewer reads the rubric';
  changed := public.set_job_requirement_weights(org, job, ids, array[10, 10, 10]::numeric[]);
  assert changed = 0, 'and changes nothing';

  perform test.login('jnone');
  changed := public.set_job_requirement_weights(org, job, ids, array[10, 10, 10]::numeric[]);
  assert changed = 0, 'nor does somebody with no job permission';

  -- nor another organization, in either direction
  perform test.login('bman');
  changed := public.set_job_requirement_weights(test.org('jobsb'), job, ids, array[1, 1, 1]::numeric[]);
  assert changed = 0, 'beta cannot reweight an alpha rubric';
  changed := public.set_job_requirement_weights(org, job, ids, array[1, 1, 1]::numeric[]);
  assert changed = 0, 'not even by naming alpha';

  perform test.login('jman');
  changed := public.set_job_requirement_weights(org, beta_job, ids, array[1, 1, 1]::numeric[]);
  assert changed = 0, 'and alpha cannot reach into beta';
  assert (select sum(r.weight) from public.job_requirements r where r.job_id = job) = 100,
    'through all of which the rubric is untouched';

  -- the manager still can, which proves the zeros were authorization and not a broken call
  changed := public.set_job_requirement_weights(org, job, ids, array[60, 25, 15]::numeric[]);
  assert changed = 3, 'jobs.manage reweights its own rubric';
end $$;

-- new test 3: ordering persists, and archiving freezes the whole rubric -------------------------
do $$
declare org uuid := test.org('jobsa'); job uuid := test.job_id('jobsa', 'Rubric Target');
  ids uuid[]; reordered uuid[]; before_weights numeric[]; moved integer;
begin
  perform test.login('jman');
  select array_agg(r.id order by r.display_order) into ids
  from public.job_requirements r where r.job_id = job;

  -- reordering is the Phase 4 mechanism, unchanged, and it persists
  reordered := array[ids[3], ids[1], ids[2]];
  moved := public.reorder_job_requirements(org, job, reordered);
  assert moved = 3, 'the rubric is reordered';
  select array_agg(r.id order by r.display_order) into ids
  from public.job_requirements r where r.job_id = job;
  assert ids = reordered, 'and reads back in the order it was given';

  select array_agg(r.weight order by r.display_order) into before_weights
  from public.job_requirements r where r.job_id = job;

  -- archiving the job closes every route into the rubric
  update public.jobs set status = 'open' where id = job;
  update public.jobs set status = 'closed' where id = job;
  update public.jobs set status = 'archived' where id = job;

  assert test.sqlstate_of(format('select public.set_job_requirement_weights(%L, %L, %L, %L)', org, job, ids, array[1, 1, 1]::numeric[])) = 'TQ010',
    'an archived rubric cannot be reweighted';
  assert test.sqlstate_of(format('select public.reorder_job_requirements(%L, %L, %L)', org, job, array[ids[2], ids[1], ids[3]])) = 'TQ010',
    'nor reordered';
  assert test.sqlstate_of(format('update public.job_requirements set importance = %L where id = %L', 'preferred', ids[1])) = 'TQ010',
    'nor its importance changed';
  assert test.sqlstate_of(format('delete from public.job_requirements where id = %L', ids[1])) = 'TQ010',
    'nor a requirement removed';
  assert test.sqlstate_of(format('insert into public.job_requirements (organization_id, job_id, requirement) values (%L, %L, %L)', org, job, 'Late addition')) = 'TQ010',
    'nor one added';

  -- and after every refused mutation the rubric stands exactly as it was
  assert (select array_agg(r.weight order by r.display_order) from public.job_requirements r where r.job_id = job) = before_weights,
    'the weights are unchanged';
  assert (select array_agg(r.id order by r.display_order) from public.job_requirements r where r.job_id = job) = ids,
    'and so is the order';
end $$;

-- jobs are archived, never deleted, and the control plane cannot read them --------------------------
do $$
begin
  perform test.login('jman');
  assert test.sqlstate_of(format('delete from public.jobs where id = %L', test.job_id('jobsa', 'Validation Target'))) = '42501',
    'the application has no DELETE on jobs at all';

  perform test.login('pat'); -- platform admin, member of nothing
  assert private.is_platform_admin(), 'pat administers the platform';
  assert (select count(*) from public.jobs) = 0, 'which is not sight of a tenant''s jobs';
  assert (select count(*) from public.job_requirements) = 0, 'nor of their requirements';
end $$;

-- =================================================================================================
-- Phase 7 — resume intake
--
-- Three blocks, three questions. Who may put a resume into a job and who may only look at it; what
-- happens when the same file arrives twice; and what an archived job will still allow.
--
-- The bytes live in storage.objects, which is stubbed at the top of this file, so what is exercised
-- here is the migration's own policies over that table - the authorization - and not the Storage
-- HTTP service, which is not running. Signed URLs, the bucket's declared mime and size limits and
-- the upload API itself are verified by the frontend suite and by inspection, and are called out as
-- such in the Phase 7 report.
-- =================================================================================================

-- phase 7 new test 3: storage and tenant authorization -------------------------------------------
do $$
declare
  org uuid := test.org('jobsa');
  beta uuid := test.org('jobsb');
  job uuid;
  elsewhere uuid;
  beta_job uuid := test.job_id('jobsb', 'Beta Role');
  path text;
  touched integer;
begin
  -- the bucket itself is not optional reading: a public bucket would make every policy below moot
  assert (select not public from storage.buckets where id = 'resumes'), 'the resume bucket is private';
  assert (select allowed_mime_types from storage.buckets where id = 'resumes') = array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ], 'and accepts only the two resume formats';

  perform test.login('jman');
  insert into public.jobs (organization_id, title) values (org, 'Intake Role') returning id into job;
  insert into public.jobs (organization_id, title) values (org, 'Other Intake Role') returning id into elsewhere;
  path := org || '/' || job || '/resumes/' || gen_random_uuid() || '/resume.pdf';

  -- 3a: jobs.manage may store the bytes and record the intake
  insert into storage.objects (bucket_id, name) values ('resumes', path);
  insert into public.job_resumes
    (organization_id, job_id, storage_path, original_filename, content_type, size_bytes, checksum, uploaded_by)
  values (org, job, path, 'resume.pdf', 'application/pdf', 240000, repeat('a', 64), test.uid('jman'));
  assert (select count(*) from public.job_resumes where job_id = job) = 1, '3: a manager can take a resume in';

  -- 3b: the path must name this row's own organization and job. Two ways of getting it wrong, both
  -- refused by the table itself rather than by whatever wrote it.
  assert test.sqlstate_of(format(
    'insert into public.job_resumes (organization_id, job_id, storage_path, original_filename, content_type, size_bytes, checksum) values (%L, %L, %L, %L, %L, 1000, %L)',
    org, job, beta || '/' || beta_job || '/resumes/x/cv.pdf', 'cv.pdf', 'application/pdf', repeat('b', 64)
  )) = '23514', '3: metadata cannot point into another tenant''s storage prefix';
  assert test.sqlstate_of(format(
    'insert into public.job_resumes (organization_id, job_id, storage_path, original_filename, content_type, size_bytes, checksum) values (%L, %L, %L, %L, %L, 1000, %L)',
    org, job, org || '/' || elsewhere || '/resumes/x/cv.pdf', 'cv.pdf', 'application/pdf', repeat('b', 64)
  )) = '23514', '3: nor at another job of its own organization';

  -- 3c: a job in another organization is unreachable even for a manager here
  assert test.sqlstate_of(format(
    'insert into public.job_resumes (organization_id, job_id, storage_path, original_filename, content_type, size_bytes, checksum) values (%L, %L, %L, %L, %L, 1000, %L)',
    org, beta_job, org || '/' || beta_job || '/resumes/x/cv.pdf', 'cv.pdf', 'application/pdf', repeat('b', 64)
  )) = '23503', '3: a job from another organization is not a job here';

  -- 3d: jobs.view reads, and only reads
  perform test.login('jview');
  assert (select count(*) from public.job_resumes where job_id = job) = 1, '3: a viewer can see the intake';
  assert (select count(*) from storage.objects where bucket_id = 'resumes' and name = path) = 1,
    '3: and the object behind it';
  assert test.sqlstate_of(format(
    'insert into public.job_resumes (organization_id, job_id, storage_path, original_filename, content_type, size_bytes, checksum) values (%L, %L, %L, %L, %L, 1000, %L)',
    org, job, org || '/' || job || '/resumes/y/sneaky.pdf', 'sneaky.pdf', 'application/pdf', repeat('c', 64)
  )) = '42501', '3: a viewer cannot upload';
  assert test.sqlstate_of(format(
    'insert into storage.objects (bucket_id, name) values (%L, %L)',
    'resumes', org || '/' || job || '/resumes/y/sneaky.pdf'
  )) = '42501', '3: nor store bytes directly';
  -- RLS filters a delete rather than refusing it, so the proof is that nothing moved
  delete from public.job_resumes where job_id = job;
  get diagnostics touched = row_count;
  assert touched = 0, '3: nor delete the metadata';
  delete from storage.objects where bucket_id = 'resumes' and name = path;
  get diagnostics touched = row_count;
  assert touched = 0, '3: nor the object';

  -- 3e: a member of the same organization holding neither key sees nothing at all
  perform test.login('jnone');
  assert (select count(*) from public.job_resumes) = 0, '3: without jobs.view there are no resumes';
  assert (select count(*) from storage.objects where bucket_id = 'resumes') = 0, '3: and no objects';

  -- 3f: another organization's manager is not a manager here
  perform test.login('bman');
  assert (select count(*) from public.job_resumes) = 0, '3: another tenant sees none of these';
  assert (select count(*) from storage.objects where bucket_id = 'resumes') = 0, '3: nor their objects';
  assert test.sqlstate_of(format(
    'insert into public.job_resumes (organization_id, job_id, storage_path, original_filename, content_type, size_bytes, checksum) values (%L, %L, %L, %L, %L, 1000, %L)',
    org, job, org || '/' || job || '/resumes/z/cross.pdf', 'cross.pdf', 'application/pdf', repeat('d', 64)
  )) = '42501', '3: and cannot file a resume against another tenant''s job';
  assert test.sqlstate_of(format(
    'insert into storage.objects (bucket_id, name) values (%L, %L)',
    'resumes', org || '/' || job || '/resumes/z/cross.pdf'
  )) = '42501', '3: the storage policy reads the path and refuses it too';

  -- 3g: the platform control plane is not a way in, exactly as it is not for the job itself
  perform test.login('pat');
  assert private.is_platform_admin(), '3: pat administers the platform';
  assert (select count(*) from public.job_resumes) = 0, '3: which is not sight of an applicant''s resume';
  assert (select count(*) from storage.objects where bucket_id = 'resumes') = 0, '3: nor of the file';

  -- 3h: a malformed path denies instead of erroring, which is what safe_uuid is for
  perform test.login('jman');
  assert test.sqlstate_of(format(
    'insert into storage.objects (bucket_id, name) values (%L, %L)', 'resumes', 'not-a-uuid/also-not/resumes/x/cv.pdf'
  )) = '42501', '3: a path that is not a tenant path is simply refused';
end $$;

-- phase 7 new test 4: duplicates and persistence -------------------------------------------------
do $$
declare
  org uuid := test.org('jobsa');
  job uuid := test.job_id('jobsa', 'Intake Role');
  elsewhere uuid := test.job_id('jobsa', 'Other Intake Role');
  original record;
  touched integer;
begin
  perform test.login('jman');
  select id, storage_path, original_filename, size_bytes, checksum into original
  from public.job_resumes where job_id = job;

  -- 4a: the same bytes are the same resume for this job, whatever the file was called this time
  assert test.sqlstate_of(format(
    'insert into public.job_resumes (organization_id, job_id, storage_path, original_filename, content_type, size_bytes, checksum) values (%L, %L, %L, %L, %L, 240000, %L)',
    org, job, org || '/' || job || '/resumes/' || gen_random_uuid() || '/again.pdf',
    'Resume (1).pdf', 'application/pdf', original.checksum
  )) = '23505', '4: the same file cannot be taken in twice for one job';

  -- 4b: and the refusal left the first one exactly as it was - no overwrite, no replacement
  assert (select count(*) from public.job_resumes where job_id = job) = 1, '4: still one intake';
  assert (select storage_path from public.job_resumes where id = original.id) = original.storage_path,
    '4: pointing at the file it always pointed at';
  assert (select original_filename from public.job_resumes where id = original.id) = original.original_filename,
    '4: under the name it arrived with';

  -- 4c: the same person may apply to a second role. Same bytes, different job, allowed.
  insert into public.job_resumes
    (organization_id, job_id, storage_path, original_filename, content_type, size_bytes, checksum, uploaded_by)
  values (org, elsewhere, org || '/' || elsewhere || '/resumes/' || gen_random_uuid() || '/resume.pdf',
          'resume.pdf', 'application/pdf', 240000, original.checksum, test.uid('jman'));
  assert (select count(*) from public.job_resumes where checksum = original.checksum) = 2,
    '4: one candidate, two applications';
  assert (select count(distinct storage_path) from public.job_resumes where checksum = original.checksum) = 2,
    '4: stored separately, so removing one leaves the other';

  -- 4d: an intake record is a statement about a file that was received, so nothing may edit it.
  -- Withheld as a privilege rather than guarded, the way jobs withhold DELETE.
  assert test.sqlstate_of(format(
    'update public.job_resumes set original_filename = %L where id = %L', 'renamed.pdf', original.id
  )) = '42501', '4: there is no UPDATE on an intake record at all';

  -- 4e: persistence - what a later session reads back is what was written, field for field
  perform test.login('jview');
  assert (select original_filename from public.job_resumes where id = original.id) = original.original_filename,
    '4: the filename persists';
  assert (select size_bytes from public.job_resumes where id = original.id) = original.size_bytes,
    '4: so does the size';
  assert (select content_type from public.job_resumes where id = original.id) = 'application/pdf',
    '4: and the type';
  assert (select uploaded_by from public.job_resumes where id = original.id) = test.uid('jman'),
    '4: and who brought it in';

  -- 4f: removing one is the manager's to do, and takes only that one
  perform test.login('jman');
  delete from public.job_resumes where job_id = elsewhere;
  get diagnostics touched = row_count;
  assert touched = 1, '4: a manager can remove a resume';
  assert (select count(*) from public.job_resumes where id = original.id) = 1, '4: without touching the other';
end $$;

-- phase 7 new test 5: an archived job ------------------------------------------------------------
do $$
declare
  org uuid := test.org('jobsa');
  job uuid := test.job_id('jobsa', 'Intake Role');
  existing uuid;
  stored_path text;
  touched integer;
begin
  perform test.login('jman');
  select id, storage_path into existing, stored_path from public.job_resumes where job_id = job;
  update public.jobs set status = 'archived' where id = job;
  assert test.job_status(job) = 'archived', '5: the job is archived';

  -- 5a: nothing new comes in, and nothing already in comes out
  assert test.sqlstate_of(format(
    'insert into public.job_resumes (organization_id, job_id, storage_path, original_filename, content_type, size_bytes, checksum) values (%L, %L, %L, %L, %L, 1000, %L)',
    org, job, org || '/' || job || '/resumes/' || gen_random_uuid() || '/late.pdf',
    'late.pdf', 'application/pdf', repeat('e', 64)
  )) = 'TQ010', '5: an archived job accepts no new resume';
  assert test.sqlstate_of(format('delete from public.job_resumes where id = %L', existing)) = 'TQ010',
    '5: and gives none of its own up';

  -- 5b: the storage boundary agrees, without being asked twice. Insert is refused outright; a
  -- delete is filtered to nothing, which is how RLS says no to a DELETE.
  assert test.sqlstate_of(format(
    'insert into storage.objects (bucket_id, name) values (%L, %L)',
    'resumes', org || '/' || job || '/resumes/' || gen_random_uuid() || '/late.pdf'
  )) = '42501', '5: nor may the bytes be stored';
  delete from storage.objects where bucket_id = 'resumes' and name = stored_path;
  get diagnostics touched = row_count;
  assert touched = 0, '5: nor the stored file removed';

  -- 5c: reading is untouched - the record of who applied is the point of keeping the job
  perform test.login('jview');
  assert (select count(*) from public.job_resumes where job_id = job) = 1, '5: an authorized reader still sees it';
  assert (select count(*) from storage.objects where bucket_id = 'resumes' and name = stored_path) = 1,
    '5: and can still reach the file';

  -- 5d: and after every refused mutation the intake stands exactly as it was
  assert (select storage_path from public.job_resumes where id = existing) = stored_path,
    '5: the metadata is unchanged';
  assert (select count(*) from public.job_resumes where job_id = job) = 1, '5: and nothing was added';
end $$;

-- =================================================================================================
-- Phase 8 — resume processing and candidate identity
--
-- Two blocks. The first is the lifecycle of an attempt: who may start one, what happens when one is
-- already in flight, what a retry does to the one before it, and what an archived job allows. The
-- second is identity, which is the part of this phase most able to do quiet damage - merging two
-- people, or inventing a match - so every rule is asserted including the ones that must NOT happen.
--
-- The AI provider is absent from both. Nothing here calls a model: these functions take a profile and
-- an evidence array as arguments, which is exactly how the application calls them, and whether a model
-- produced something sensible is the frontend suite's question.
-- =================================================================================================

-- shared fixture helpers for the two blocks below
create function test.profile_of(location text) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'candidate', jsonb_build_object('location', location),
    'skills', jsonb_build_array(jsonb_build_object('skill', 'python')),
    'experience', '[]'::jsonb,
    'education', '[]'::jsonb
  )
$$;
create function test.evidence_of(quote text, verified boolean) returns jsonb
language sql immutable as $$
  select jsonb_build_array(jsonb_build_object(
    'fact_type', 'skill', 'fact_key', 'Python', 'fact_value', null,
    'evidence_status', case when verified then 'verified' else 'unable_to_determine' end,
    'confidence', 0.91, 'source_page', 2, 'source_section', 'Technical Skills',
    'source_quote', quote, 'quote_verified', verified
  ))
$$;
create function test.new_resume(org uuid, job uuid, tag text) returns uuid
language plpgsql as $$
declare made uuid;
begin
  insert into public.job_resumes
    (organization_id, job_id, storage_path, original_filename, content_type, size_bytes, checksum, uploaded_by)
  values (
    org, job,
    org || '/' || job || '/resumes/' || gen_random_uuid() || '/' || tag || '.pdf',
    tag || '.pdf', 'application/pdf', 120000,
    encode(digest_stub(tag), 'hex'), auth.uid()
  )
  returning id into made;
  return made;
end $$;
-- pgcrypto is not stubbed here, and a checksum only has to be 64 hex characters and distinct.
create function digest_stub(tag text) returns bytea
language sql immutable as $$ select decode(lpad(encode(convert_to(tag, 'UTF8'), 'hex'), 64, '0'), 'hex') $$;
grant execute on all functions in schema test to authenticated, anon;
grant execute on function digest_stub(text) to authenticated, anon;

-- phase 8 new test 3: the processing lifecycle, isolation and idempotency ------------------------
do $$
declare
  org uuid := test.org('jobsa');
  job uuid;
  second_job uuid;
  beta_job uuid := test.job_id('jobsb', 'Beta Role');
  resume uuid;
  beta_resume uuid;
  attempt_one uuid;
  attempt_two uuid;
  attempt_three uuid;
  application uuid;
  touched integer;
  not_stale timestamptz := now() - interval '1 hour';
  all_stale timestamptz := now() + interval '1 hour';
begin
  perform test.login('jman');
  insert into public.jobs (organization_id, title) values (org, 'Processing Role') returning id into job;
  insert into public.jobs (organization_id, title) values (org, 'Second Processing Role') returning id into second_job;
  resume := test.new_resume(org, job, 'alpha-one');

  -- 3a: a manager starts an attempt, and it is the current one
  attempt_one := public.start_resume_processing(org, job, resume, 'pdf', 'extract@1', 'extract@1|profile@1', not_stale);
  assert (select status from public.resume_processings where id = attempt_one) = 'processing', '3: an attempt starts in flight';
  assert (select attempt from public.resume_processings where id = attempt_one) = 1, '3: numbered from one';
  assert (select is_current from public.resume_processings where id = attempt_one), '3: and is the current one';

  -- 3b: a second attempt while the first can still be alive is refused. This is what makes a page
  -- refresh or a double press harmless rather than a second model request.
  assert test.sqlstate_of(format(
    'select public.start_resume_processing(%L, %L, %L, %L, %L, %L, %L)',
    org, job, resume, 'pdf', 'extract@1', 'extract@1|profile@1', not_stale)) = 'TQ013',
    '3: a resume already being read is not read twice';

  -- 3c: one that can no longer be alive is superseded, and exactly one attempt stays current
  attempt_two := public.start_resume_processing(org, job, resume, 'pdf', 'extract@1', 'extract@1|profile@1', all_stale);
  assert (select attempt from public.resume_processings where id = attempt_two) = 2, '3: the next attempt is numbered after it';
  assert not (select is_current from public.resume_processings where id = attempt_one), '3: the abandoned attempt steps down';
  assert (select count(*) from public.resume_processings where resume_id = resume and is_current) = 1,
    '3: and there is never more than one current attempt';
  assert (select count(*) from public.resume_processings where resume_id = resume) = 2,
    '3: while the earlier one is still there to look at';

  -- 3d: a failure is recorded, stays current, and stays inspectable
  perform public.fail_resume_processing(org, attempt_two, 'ai_unavailable', 'AI processing is currently unavailable. Try again.', 'some text', 2, 'ollama', 'test-model');
  assert (select status from public.resume_processings where id = attempt_two) = 'failed', '3: a failure is recorded as one';
  assert (select error_code from public.resume_processings where id = attempt_two) = 'ai_unavailable', '3: with a code from the fixed list';
  assert (select completed_at from public.resume_processings where id = attempt_two) is not null, '3: and a settled time';
  assert (select extracted_text from public.resume_processings where id = attempt_two) = 'some text',
    '3: whatever text there was is kept, because that is itself the finding';

  -- 3e: a document with no readable text is a review, not a failure
  perform public.fail_resume_processing(org, attempt_two, 'no_text', 'No text could be read.', '', 1, null, null);
  assert (select status from public.resume_processings where id = attempt_two) = 'needs_review',
    '3: an unreadable scan needs a person, it has not failed';

  -- 3f: a retry after failure is a new attempt, and completing it writes the person, the application
  -- and the evidence together
  attempt_three := public.start_resume_processing(org, job, resume, 'pdf', 'extract@1', 'extract@1|profile@1', not_stale);
  assert (select attempt from public.resume_processings where id = attempt_three) = 3, '3: a retry is the next attempt';
  application := public.complete_resume_processing(
    org, attempt_three, 'Ada Byron. Python, FastAPI. ada@example.test', 2, 'ollama', 'test-model',
    test.profile_of('London'), test.evidence_of('Python, FastAPI', true),
    'Ada Byron', 'ada@example.test', null);
  assert (select status from public.resume_processings where id = attempt_three) = 'succeeded', '3: a deterministic identity succeeds';
  assert application is not null, '3: and an application exists';
  assert (select application_id from public.resume_processings where id = attempt_three) = application, '3: attached to the attempt';
  assert (select count(*) from public.candidate_evidence where processing_id = attempt_three) = 1, '3: the evidence is stored';
  assert (select quote_verified from public.candidate_evidence where processing_id = attempt_three),
    '3: with the application''s own verdict on the quote';
  assert (select source_page from public.candidate_evidence where processing_id = attempt_three) = 2, '3: and where it was found';

  -- 3g: a success is never retried. Nothing may overwrite a profile that was read correctly.
  assert test.sqlstate_of(format(
    'select public.start_resume_processing(%L, %L, %L, %L, %L, %L, %L)',
    org, job, resume, 'pdf', 'extract@1', 'extract@1|profile@1', all_stale)) = 'TQ012',
    '3: a resume read correctly is not read again';

  -- 3h: completing the same attempt twice adds no second person and no second application
  perform public.complete_resume_processing(
    org, attempt_three, 'Ada Byron. Python, FastAPI. ada@example.test', 2, 'ollama', 'test-model',
    test.profile_of('London'), test.evidence_of('Python, FastAPI', true),
    'Ada Byron', 'ada@example.test', null);
  assert (select count(*) from public.candidates where organization_id = org and email = 'ada@example.test') = 1,
    '3: completing twice is idempotent for the person';
  assert (select count(*) from public.job_applications where job_id = job) = 1, '3: and for the application';
  assert (select count(*) from public.candidate_evidence where processing_id = attempt_three) = 1,
    '3: and the evidence is replaced rather than doubled';

  -- 3i: the wrong job for this resume is not a route in, and neither is another tenant's
  assert test.sqlstate_of(format(
    'select public.start_resume_processing(%L, %L, %L, %L, %L, %L, %L)',
    org, second_job, resume, 'pdf', 'extract@1', 'extract@1|profile@1', not_stale)) = 'P0002',
    '3: a resume cannot be processed against a job that does not hold it';

  perform test.login('bman');
  beta_resume := test.new_resume(test.org('jobsb'), beta_job, 'beta-one');
  -- 42501 rather than P0002 since the hardening pass: the function asks for jobs.manage in the
  -- organization it was handed before it looks at anything, so another tenant is refused for the
  -- reason that is actually true of them. Nothing about the resume is confirmed either way.
  assert test.sqlstate_of(format(
    'select public.start_resume_processing(%L, %L, %L, %L, %L, %L, %L)',
    org, job, resume, 'pdf', 'extract@1', 'extract@1|profile@1', not_stale)) = '42501',
    '3: another tenant cannot start processing on our resume';
  assert (select count(*) from public.resume_processings) = 0, '3: nor read any attempt of theirs';
  assert (select count(*) from public.candidates) = 0, '3: nor any candidate';
  assert (select count(*) from public.job_applications) = 0, '3: nor any application';
  assert (select count(*) from public.candidate_evidence) = 0, '3: nor any evidence';

  -- 3j: a viewer reads everything and writes nothing
  perform test.login('jview');
  assert (select count(*) from public.resume_processings where resume_id = resume) = 3, '3: a viewer sees every attempt';
  assert (select count(*) from public.candidates where organization_id = org) >= 1, '3: and the candidate';
  assert (select count(*) from public.candidate_evidence where processing_id = attempt_three) = 1, '3: and the evidence';
  assert test.sqlstate_of(format(
    'select public.start_resume_processing(%L, %L, %L, %L, %L, %L, %L)',
    org, job, resume, 'pdf', 'extract@1', 'extract@1|profile@1', all_stale)) = '42501',
    '3: but cannot start an attempt';
  -- Since the hardening pass this is refused for want of the privilege rather than filtered to
  -- nothing by a policy: UPDATE is granted to nobody on this table.
  assert test.sqlstate_of(format(
    'update public.resume_processings set status = %L where id = %L', 'succeeded', attempt_two)) = '42501',
    '3: and a viewer cannot update an attempt at all';
  assert (select status from public.resume_processings where id = attempt_two) = 'needs_review',
    '3: so the attempt is unchanged';

  -- 3k: nobody deletes an attempt. A failure that can be deleted is a failure that can be hidden.
  perform test.login('jman');
  assert test.sqlstate_of(format('delete from public.resume_processings where id = %L', attempt_one)) = '42501',
    '3: the application has no DELETE on attempts at all';

  -- 3l: the platform control plane is not a way in
  perform test.login('pat');
  assert private.is_platform_admin(), '3: pat administers the platform';
  assert (select count(*) from public.candidates) = 0, '3: which is not sight of an applicant''s profile';
  assert (select count(*) from public.resume_processings) = 0, '3: nor of what was read from their resume';

  -- 3n: derived data has no direct write path, for anybody
  --
  -- The invariant this protects: AI resume processing is the authoritative writer of everything in
  -- these four tables. A recruiter holding jobs.manage is the MOST privileged tenant identity there
  -- is for this data, so they are the one asked here. Before the hardening pass every one of these
  -- succeeded, which meant a profile could be fabricated with no document, no provider and no
  -- pipeline, and an evidence row could claim quote_verified for a sentence in no document at all.
  perform test.login('jman');
  assert test.sqlstate_of(format(
    'insert into public.candidates (organization_id, full_name, email, identity_state) values (%L, %L, %L, %L)',
    org, 'Invented Person', 'invented@nowhere.test', 'resolved')) = '42501',
    '3: a candidate cannot be invented directly';
  assert test.sqlstate_of(format(
    'update public.candidates set email = %L where organization_id = %L', 'hijacked@nowhere.test', org)) = '42501',
    '3: nor an existing candidate''s identity rewritten';
  assert test.sqlstate_of(format(
    'insert into public.job_applications (organization_id, job_id, candidate_id) values (%L, %L, %L)',
    org, job, (select c.id from public.candidates c where c.organization_id = org limit 1))) = '42501',
    '3: nor an application linked by hand';
  assert test.sqlstate_of(format(
    'insert into public.resume_processings (organization_id, job_id, resume_id, status, parser, parser_version, processing_version, provider, model, structured_profile) '
    || 'values (%L, %L, %L, %L, %L, %L, %L, %L, %L, %L)',
    org, job, resume, 'succeeded', 'pdf', 'extract@1', 'extract@1|profile@1',
    'never-ran', 'hand-written', '{"candidate":{"full_name":"Invented"}}')) = '42501',
    '3: nor a finished attempt written without one having happened';
  assert test.sqlstate_of(format(
    'update public.resume_processings set status = %L, structured_profile = %L where id = %L',
    'succeeded', '{"candidate":{"full_name":"Overwritten"}}', attempt_three)) = '42501',
    '3: nor a profile overwritten after the fact';
  assert test.sqlstate_of(format(
    'insert into public.candidate_evidence (organization_id, processing_id, fact_type, fact_key, evidence_status, confidence, source_quote, quote_verified) '
    || 'values (%L, %L, %L, %L, %L, 1.0, %L, true)',
    org, attempt_three, 'skill', 'everything', 'verified', 'a sentence in no document anywhere')) = '42501',
    '3: nor evidence asserted for a quote that does not exist';
  assert test.sqlstate_of(format(
    'delete from public.candidate_evidence where processing_id = %L', attempt_three)) = '42501',
    '3: nor inconvenient evidence removed';

  -- And the legitimate path is untouched by all of that: the attempt and its evidence stand.
  assert (select status from public.resume_processings where id = attempt_three) = 'succeeded',
    '3: the real attempt is unharmed';
  assert (select provider from public.resume_processings where id = attempt_three) = 'ollama',
    '3: with the provider that actually answered';
  assert (select count(*) from public.candidate_evidence where processing_id = attempt_three) = 1,
    '3: and its evidence intact';
  assert (select count(*) from public.candidates where organization_id = org and email = 'invented@nowhere.test') = 0,
    '3: and no invented person was left behind';

  -- The privileges themselves, stated once: read, and nothing else.
  assert not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and grantee = 'authenticated'
      and table_name in ('candidates', 'job_applications', 'resume_processings', 'candidate_evidence')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  ), '3: no write privilege exists on derived processing data';
  assert not exists (
    select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relname in ('candidates', 'job_applications', 'resume_processings', 'candidate_evidence')
      and p.polcmd <> 'r'
  ), '3: and no policy offers one';

  -- 3m: archiving the job closes every route into processing, and leaves reading open
  perform test.login('jman');
  update public.jobs set status = 'archived' where id = job;
  assert test.sqlstate_of(format(
    'select public.start_resume_processing(%L, %L, %L, %L, %L, %L, %L)',
    org, job, resume, 'pdf', 'extract@1', 'extract@1|profile@1', all_stale)) = 'TQ010',
    '3: an archived job reads no more resumes';
  assert test.sqlstate_of(format(
    'select public.fail_resume_processing(%L, %L, %L, %L, null, null, null, null)',
    org, attempt_three, 'database', 'nope')) = 'TQ010',
    '3: nor may an existing attempt be altered';
  -- Nobody deletes evidence directly, archived or not, so this is 42501 rather than TQ010. The
  -- archived rule is still proven: the attempt mutation above raised TQ010, and completing an attempt
  -- is the only thing that ever replaces its evidence.
  assert test.sqlstate_of(format(
    'delete from public.candidate_evidence where processing_id = %L', attempt_three)) = '42501',
    '3: nor its evidence removed';
  assert (select status from public.resume_processings where id = attempt_three) = 'succeeded',
    '3: and after every refusal the attempt stands as it was';
  assert (select count(*) from public.candidate_evidence where processing_id = attempt_three) = 1,
    '3: with its evidence intact';
  perform test.login('jview');
  assert (select count(*) from public.resume_processings where resume_id = resume) = 3,
    '3: an archived job''s profiles stay readable';
end $$;

-- phase 8 new test 4: candidate identity ---------------------------------------------------------
do $$
declare
  org uuid := test.org('jobsa');
  job_a uuid;
  job_b uuid;
  resume_a uuid;
  resume_b uuid;
  resume_c uuid;
  resume_d uuid;
  resume_e uuid;
  resume_f uuid;
  run_id uuid;
  app_a uuid;
  app_b uuid;
  shared uuid;
  not_stale timestamptz := now() - interval '1 hour';
  text_a text := 'Grace Hopper. grace@example.test. +1 415 555 0101. COBOL.';
begin
  perform test.login('jman');
  insert into public.jobs (organization_id, title) values (org, 'Identity Role A') returning id into job_a;
  insert into public.jobs (organization_id, title) values (org, 'Identity Role B') returning id into job_b;

  -- 4a: an exact normalized email reuses the person, and a second job is a second APPLICATION
  resume_a := test.new_resume(org, job_a, 'grace-a');
  run_id := public.start_resume_processing(org, job_a, resume_a, 'pdf', 'extract@1', 'extract@1|profile@1', not_stale);
  app_a := public.complete_resume_processing(org, run_id, text_a, 1, 'ollama', 'test-model',
    test.profile_of('Arlington'), test.evidence_of('COBOL', true), 'Grace Hopper', 'grace@example.test', '+14155550101');
  assert (select identity_state from public.candidates where email = 'grace@example.test') = 'resolved',
    '4: an email identifies a person';

  resume_b := test.new_resume(org, job_b, 'grace-b');
  run_id := public.start_resume_processing(org, job_b, resume_b, 'pdf', 'extract@1', 'extract@1|profile@1', not_stale);
  app_b := public.complete_resume_processing(org, run_id, text_a, 1, 'ollama', 'test-model',
    test.profile_of('Arlington'), test.evidence_of('COBOL', true), 'Grace Hopper', 'grace@example.test', null);
  assert (select count(*) from public.candidates where organization_id = org and email = 'grace@example.test') = 1,
    '4: applying to a second role does not make a second person';
  assert app_a is distinct from app_b, '4: but it does make a second application';
  assert (select count(*) from public.job_applications a
          join public.candidates c on c.id = a.candidate_id
          where c.email = 'grace@example.test') = 2,
    '4: one candidate, two applications';

  -- 4b: a NAME is never enough. Two resumes with the same name and nothing deterministic are two
  -- people, because the alternative is merging strangers who happen to share a name.
  resume_c := test.new_resume(org, job_a, 'smith-one');
  run_id := public.start_resume_processing(org, job_a, resume_c, 'pdf', 'extract@1', 'extract@1|profile@1', not_stale);
  perform public.complete_resume_processing(org, run_id, 'J Smith. Java.', 1, 'ollama', 'test-model',
    test.profile_of(null), '[]'::jsonb, 'J Smith', null, null);
  resume_d := test.new_resume(org, job_b, 'smith-two');
  run_id := public.start_resume_processing(org, job_b, resume_d, 'pdf', 'extract@1', 'extract@1|profile@1', not_stale);
  perform public.complete_resume_processing(org, run_id, 'J Smith. Rust.', 1, 'ollama', 'test-model',
    test.profile_of(null), '[]'::jsonb, 'J Smith', null, null);
  assert (select count(*) from public.candidates where organization_id = org and full_name = 'J Smith') = 2,
    '4: a shared name does not merge two candidates';
  assert (select count(*) from public.candidates
          where organization_id = org and full_name = 'J Smith' and identity_state = 'unresolved') = 2,
    '4: and neither of them claims to be identified';
  assert (select status from public.resume_processings where id = run_id) = 'needs_review',
    '4: insufficient identity is a review, not a success';
  assert (select error_code from public.resume_processings where id = run_id) = 'identity_unresolved',
    '4: and the reason says which';

  -- 4c: a phone reuses a person only when nothing contradicts it
  resume_e := test.new_resume(org, job_a, 'phone-one');
  run_id := public.start_resume_processing(org, job_a, resume_e, 'pdf', 'extract@1', 'extract@1|profile@1', not_stale);
  perform public.complete_resume_processing(org, run_id, 'No email here. +44 20 7946 0958. Haskell.', 1, 'ollama', 'test-model',
    test.profile_of(null), '[]'::jsonb, 'Phone Only', null, '+442079460958');
  select id into shared from public.candidates where organization_id = org and phone = '+442079460958';
  assert shared is not null, '4: a phone alone can still identify somebody';
  assert (select identity_state from public.candidates where id = shared) = 'resolved', '4: deterministically';

  resume_f := test.new_resume(org, job_b, 'phone-two');
  run_id := public.start_resume_processing(org, job_b, resume_f, 'pdf', 'extract@1', 'extract@1|profile@1', not_stale);
  perform public.complete_resume_processing(org, run_id, 'Also no email. +44 20 7946 0958. Haskell.', 1, 'ollama', 'test-model',
    test.profile_of(null), '[]'::jsonb, 'Phone Only', null, '+442079460958');
  assert (select count(*) from public.candidates where organization_id = org and phone = '+442079460958') = 1,
    '4: and the same phone is the same person';

  -- 4d: a phone pointing at somebody who is identified by an EMAIL is a disagreement, not a match.
  -- Grace already has that number against her email, so a bare phone claiming it must not become her.
  resume_c := test.new_resume(org, job_a, 'conflict-one');
  run_id := public.start_resume_processing(org, job_a, resume_c, 'pdf', 'extract@1', 'extract@1|profile@1', not_stale);
  perform public.complete_resume_processing(org, run_id, 'Someone Else. +1 415 555 0101. Ada.', 1, 'ollama', 'test-model',
    test.profile_of(null), '[]'::jsonb, 'Someone Else', null, '+14155550101');
  assert (select count(*) from public.candidates
          where organization_id = org and phone = '+14155550101') = 2,
    '4: a conflicting phone makes a separate record rather than merging';
  assert (select identity_state from public.candidates where full_name = 'Someone Else') = 'conflicted',
    '4: marked as conflicting';
  assert (select email from public.candidates where full_name = 'Someone Else') is null,
    '4: and it never inherits the other person''s email';
  assert (select email from public.candidates where email = 'grace@example.test') = 'grace@example.test',
    '4: while the original is untouched';
  assert (select status from public.resume_processings where id = run_id) = 'needs_review',
    '4: a conflict is a review, not a success';
  assert (select error_code from public.resume_processings where id = run_id) = 'identity_conflict',
    '4: and the reason says which';

  -- 4e: the structural reason none of the above can go wrong later. There is no key on a name, so no
  -- future query could merge by one even if somebody wrote it.
  assert not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'candidates' and indexdef like '%full_name%'
  ), '4: nothing indexes a candidate by name';
  assert exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'candidates'
      and indexdef like '%UNIQUE%' and indexdef like '%email%'
  ), '4: and exactly the email is unique';

  -- 4f: an earlier document is not less true than a later one, so completion fills gaps only
  assert (select full_name from public.candidates where email = 'grace@example.test') = 'Grace Hopper',
    '4: a reused candidate keeps the name it had';
  assert (select phone from public.candidates where email = 'grace@example.test') = '+14155550101',
    '4: and the phone the first resume gave, which the second one omitted';
end $$;

-- cascades
do $$
begin
  delete from public.organizations where slug = 'jobsa';
  delete from public.organizations where slug = 'jobsb';
  delete from public.organizations where slug = 'boot1';
  delete from public.organizations where slug = 'boot2';
  delete from public.organizations where slug = 'boot3';
  delete from public.organizations where slug = 'boot4';
  delete from public.organizations where slug = 'boot5';
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
