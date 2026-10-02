import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { hasPermission } from "@/lib/auth/authorization";
import { requireOrganizationAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { getOrganizationInvitations, getOrganizationMembers } from "@/lib/organization/access-data";
import { PageHeading } from "@/components/layout/page-heading";
import { ActionForm } from "@/components/ui/action-form";
import { Avatar } from "@/components/ui/avatar";
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
  const activeCount = members.filter((member) => member.is_active).length;

  return (
    <>
      <PageHeading
        title="Members"
        description={`${activeCount} active of ${members.length} in ${context.organization.name}.`}
      />

      <ul className="mt-8 overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
        {members.map((member, index) => (
          <li key={member.membership_id} className={index > 0 ? "border-t border-border" : undefined}>
            <Link
              href={`/app/${organizationSlug}/members/${member.membership_id}`}
              className="group flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3.5 transition-colors duration-150 hover:bg-surface-sunken sm:px-5"
            >
              <Avatar name={member.full_name} email={member.email} muted={!member.is_active} />

              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium tracking-tight transition-colors duration-150 group-hover:text-accent">
                    {member.full_name ?? member.email}
                  </span>
                  {member.user_id === user.userId && (
                    <span className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      you
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                  {member.email}
                </span>
              </span>

              <span className="order-last w-full text-sm sm:order-none sm:w-auto sm:max-w-[42%]">
                {member.role_names.length === 0 ? (
                  <span className="text-muted-foreground/70">No roles</span>
                ) : (
                  <span className="flex flex-wrap gap-1.5 sm:justify-end">
                    {member.role_names.map((name) => (
                      <span
                        key={name}
                        className="rounded bg-surface-sunken px-2 py-0.5 text-xs text-foreground/80"
                      >
                        {name}
                      </span>
                    ))}
                  </span>
                )}
              </span>

              <span className="flex items-center gap-3">
                <StatusBadge active={member.is_active} labels={["Active", "Inactive"]} />
                <span
                  aria-hidden
                  className="text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-accent motion-reduce:group-hover:translate-x-0"
                >
                  &rarr;
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {invitations.length > 0 && (
        <section className="mt-12">
          <h2 className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            Pending invitations
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {invitations.length} invitation{invitations.length === 1 ? "" : "s"} waiting to be
            accepted. They become members once they finish setting up their account.
          </p>
          <ul className="mt-4 overflow-hidden rounded-xl border border-dashed border-border-strong bg-surface-sunken/60">
            {invitations.map((invitation, index) => (
              <li
                key={invitation.id}
                className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3.5 sm:px-5 ${
                  index > 0 ? "border-t border-dashed border-border-strong" : ""
                }`}
              >
                <div className="flex min-w-0 items-center gap-4">
                  <span
                    aria-hidden
                    className="grid size-8 shrink-0 place-items-center rounded-full border border-dashed border-border-strong text-muted-foreground"
                  >
                    &#43;
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm">{invitation.email}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Invited {formatDate(invitation.created_at)}
                      {invitation.invited_by_email &&
                        ` by ${invitation.invited_by_name ?? invitation.invited_by_email}`}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-xs font-medium text-muted-foreground">Pending</span>
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
        <section className="mt-12 rounded-xl border border-border bg-surface p-5 shadow-sm sm:p-6">
          <h2 className="font-medium tracking-tight">Add or invite a member</h2>
          <p className="mt-1.5 max-w-prose text-sm text-pretty text-muted-foreground">
            One email address is enough. An existing TalentIQ account joins immediately; a new
            address receives an invitation and joins with no roles until you assign them.
          </p>
          <div className="mt-5">
            <AddMemberForm organizationSlug={organizationSlug} />
          </div>
        </section>
      )}
    </>
  );
}
