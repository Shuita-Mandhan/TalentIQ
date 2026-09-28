import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { hasPermission } from "@/lib/auth/authorization";
import { requireOrganizationAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { getOrganizationInvitations, getOrganizationMembers } from "@/lib/organization/access-data";
import { WorkspaceHeader } from "@/components/layout/workspace-header";
import { ActionForm } from "@/components/ui/action-form";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatDate } from "@/lib/format";
import { resendInvitation, revokeInvitation } from "./actions";
import { AddMemberForm } from "./add-member-form";

export const metadata: Metadata = { title: "Members" };

export default async function MembersPage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const { user, context } = await requireOrganizationAccess(organizationSlug);
  if (!hasPermission(context, PERMISSIONS.MEMBERS_VIEW)) notFound();
  const canManage = hasPermission(context, PERMISSIONS.MEMBERS_MANAGE);

  const [members, invitations] = await Promise.all([
    getOrganizationMembers(context.organization.id),
    getOrganizationInvitations(context.organization.id),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 sm:px-10">
      <WorkspaceHeader user={user} />

      <main className="flex-1 py-6">
        <Link
          href={`/app/${organizationSlug}`}
          className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          ← {context.organization.name}
        </Link>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">Members</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {members.length} member{members.length === 1 ? "" : "s"}
        </p>

        <div className="mt-8 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs tracking-wide text-muted-foreground uppercase">
              <tr>
                <th scope="col" className="py-2.5 pr-6 font-medium">
                  Name
                </th>
                <th scope="col" className="py-2.5 pr-6 font-medium">
                  Email
                </th>
                <th scope="col" className="py-2.5 pr-6 font-medium">
                  Status
                </th>
                <th scope="col" className="py-2.5 font-medium">
                  Roles
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {members.map((member) => (
                <tr key={member.membership_id} className="group">
                  <td className="py-3.5 pr-6 font-medium">
                    <Link
                      href={`/app/${organizationSlug}/members/${member.membership_id}`}
                      className="transition-colors group-hover:text-accent"
                    >
                      {member.full_name ?? member.email}
                    </Link>
                    {member.user_id === user.userId && (
                      <span className="ml-2 font-mono text-xs text-muted-foreground">you</span>
                    )}
                  </td>
                  <td className="py-3.5 pr-6 font-mono text-xs text-muted-foreground">{member.email}</td>
                  <td className="py-3.5 pr-6">
                    <StatusBadge active={member.is_active} labels={["Active", "Inactive"]} />
                  </td>
                  <td className="py-3.5 text-muted-foreground">
                    {member.role_names.length === 0 ? "No roles" : member.role_names.join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {invitations.length > 0 && (
          <section className="mt-12">
            <h2 className="text-lg font-semibold tracking-tight">Pending invitations</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {invitations.length} invitation{invitations.length === 1 ? "" : "s"} waiting to be
              accepted. They become members once they create their account.
            </p>
            <ul className="mt-4 divide-y divide-border border-y border-border">
              {invitations.map((invitation) => (
                <li
                  key={invitation.id}
                  className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-4"
                >
                  <div className="min-w-0">
                    <p className="font-mono text-sm break-all">{invitation.email}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Invited {formatDate(invitation.created_at)}
                      {invitation.invited_by_email && ` by ${invitation.invited_by_name ?? invitation.invited_by_email}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-5">
                    <span className="text-sm text-muted-foreground">Pending</span>
                    {canManage && (
                      <div className="flex items-start gap-2">
                        <ActionForm
                          action={resendInvitation}
                          fields={{ organizationSlug, invitationId: invitation.id }}
                          label="Resend"
                          ariaLabel={`Resend the invitation to ${invitation.email}`}
                          successLabel="Invitation sent."
                        />
                        <ActionForm
                          action={revokeInvitation}
                          fields={{ organizationSlug, invitationId: invitation.id }}
                          label="Revoke"
                          ariaLabel={`Revoke the invitation for ${invitation.email}`}
                        />
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {canManage && (
          <section className="mt-12 border-t border-border pt-8">
            <h2 className="text-lg font-semibold tracking-tight">Add or invite member</h2>
            <div className="mt-4">
              <AddMemberForm organizationSlug={organizationSlug} />
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
