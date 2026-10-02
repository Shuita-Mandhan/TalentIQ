import { hasPermission } from "@/lib/auth/authorization";
import { requireOrganizationAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import type { NavItem } from "@/components/layout/workspace-nav";

// Tenant shell. It resolves access through the same helper every tenant page uses - membership in
// an active organization, never platform-admin status - so a visitor without access meets the same
// not-found as before and never sees the frame. This is presentation, not a guard: layouts are not
// re-rendered on every navigation, so each page and Server Action still checks for itself.

export default async function OrganizationLayout({
  params,
  children,
}: {
  params: Promise<{ organizationSlug: string }>;
  children: React.ReactNode;
}) {
  const { organizationSlug } = await params;
  const { user, context } = await requireOrganizationAccess(organizationSlug);
  const base = `/app/${organizationSlug}`;

  // Only routes that exist today, and only the ones this member may actually open. Visibility is
  // permission-keyed; role names carry no meaning here or anywhere else.
  const items: NavItem[] = [
    { href: base, label: "Overview", icon: "overview", exact: true },
    ...(hasPermission(context, PERMISSIONS.JOBS_VIEW)
      ? [{ href: `${base}/jobs`, label: "Jobs", icon: "jobs" as const }]
      : []),
    ...(hasPermission(context, PERMISSIONS.MEMBERS_VIEW)
      ? [{ href: `${base}/members`, label: "Members", icon: "members" as const }]
      : []),
    ...(hasPermission(context, PERMISSIONS.ROLES_VIEW)
      ? [{ href: `${base}/roles`, label: "Roles", icon: "roles" as const }]
      : []),
    ...(hasPermission(context, PERMISSIONS.ORGANIZATION_UPDATE)
      ? [{ href: `${base}/settings`, label: "Settings", icon: "settings" as const }]
      : []),
  ];

  return (
    <WorkspaceShell user={user} context={context} items={items}>
      {children}
    </WorkspaceShell>
  );
}
