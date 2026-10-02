import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasPermission } from "@/lib/auth/authorization";
import { requireOrganizationAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { getOrganizationMember, getOrganizationRoles } from "@/lib/organization/access-data";
import { PageHeading } from "@/components/layout/page-heading";
import { ActionForm } from "@/components/ui/action-form";
import { StatusBadge } from "@/components/ui/status-badge";
import { setMemberStatus } from "../actions";
import { MemberRolesForm } from "./member-roles-form";

export const metadata: Metadata = { title: "Member" };

export default async function MemberPage({
  params,
}: {
  params: Promise<{ organizationSlug: string; membershipId: string }>;
}) {
  const { organizationSlug, membershipId } = await params;
  const { user, context } = await requireOrganizationAccess(organizationSlug);
  if (!hasPermission(context, PERMISSIONS.MEMBERS_VIEW)) notFound();
  const canManage = hasPermission(context, PERMISSIONS.MEMBERS_MANAGE);

  const member = await getOrganizationMember(context.organization.id, membershipId);
  if (!member) notFound();
  // Roles are listed only when the caller may see them; without roles.view the assignment editor
  // still shows the member's current role names but cannot change them.
  const roles = hasPermission(context, PERMISSIONS.ROLES_VIEW)
    ? await getOrganizationRoles(context.organization.id)
    : [];
  const isSelf = member.user_id === user.userId;

  return (
    <>
      <PageHeading
        back={{ href: `/app/${organizationSlug}/members`, label: "Members" }}
        title={member.full_name ?? member.email}
        actions={
          canManage &&
          (isSelf ? (
            <p className="max-w-xs text-sm text-muted-foreground">
              This is your own membership; another member with manage access can change its status.
            </p>
          ) : (
            <ActionForm
              action={setMemberStatus}
              fields={{
                organizationSlug,
                membershipId: member.membership_id,
                active: member.is_active ? "false" : "true",
              }}
              label={member.is_active ? "Deactivate membership" : "Reactivate membership"}
            />
          ))
        }
      />

      <dl className="mt-6 flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Email</dt>
          <dd className="font-mono break-all">{member.email}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Status</dt>
          <dd>
            <StatusBadge active={member.is_active} labels={["Active", "Inactive"]} />
          </dd>
        </div>
      </dl>

      {!member.is_active && (
        <p className="mt-6 max-w-xl border-l-2 border-border pl-3 text-sm text-muted-foreground">
          Inactive: this person cannot open the workspace. Their role assignments are kept and apply
          again on reactivation.
        </p>
      )}

      <section className="mt-12">
        <h2 className="text-lg font-semibold tracking-tight">Roles</h2>
        {canManage && roles.length > 0 ? (
          <div className="mt-4 max-w-xl">
            <MemberRolesForm
              organizationSlug={organizationSlug}
              membershipId={member.membership_id}
              roles={roles}
              assignedRoleIds={member.role_ids}
            />
          </div>
        ) : member.role_names.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No roles assigned.</p>
        ) : (
          <ul className="mt-3 flex flex-wrap gap-2">
            {member.role_names.map((name) => (
              <li key={name} className="rounded border border-border bg-surface px-2.5 py-1 text-sm">
                {name}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
