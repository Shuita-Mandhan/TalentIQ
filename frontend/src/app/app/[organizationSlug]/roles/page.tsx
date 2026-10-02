import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { hasPermission } from "@/lib/auth/authorization";
import { requireOrganizationAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { getOrganizationRoles } from "@/lib/organization/access-data";
import { PageHeading } from "@/components/layout/page-heading";

export const metadata: Metadata = { title: "Roles" };

export default async function RolesPage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const { context } = await requireOrganizationAccess(organizationSlug);
  if (!hasPermission(context, PERMISSIONS.ROLES_VIEW)) notFound();
  const canManage = hasPermission(context, PERMISSIONS.ROLES_MANAGE);
  const roles = await getOrganizationRoles(context.organization.id);

  return (
    <>
      <PageHeading
        title="Roles"
        description="A role is a bundle of permissions. Members may hold several, and their access is the union."
        actions={
          canManage && (
            <Link
              href={`/app/${organizationSlug}/roles/new`}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-white shadow-sm transition-colors duration-150 hover:bg-accent-strong"
            >
              <span aria-hidden className="text-base leading-none">
                &#43;
              </span>
              Create role
            </Link>
          )
        }
      />

      <ul className="mt-8 grid gap-3">
        {roles.map((role) => (
          <li key={role.id}>
            <Link
              href={`/app/${organizationSlug}/roles/${role.id}`}
              className={`group flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-xl border bg-surface px-5 py-4 shadow-sm transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:shadow-md motion-reduce:hover:translate-y-0 ${
                role.is_system
                  ? "border-accent/25 hover:border-accent/50"
                  : "border-border hover:border-border-strong"
              }`}
            >
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2.5">
                  <span className="font-medium tracking-tight transition-colors duration-150 group-hover:text-accent">
                    {role.name}
                  </span>
                  {role.is_system ? (
                    // Protected, not disabled: it can be assigned freely, it just cannot be edited.
                    <span className="inline-flex items-center gap-1.5 rounded bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-strong">
                      <svg viewBox="0 0 12 12" aria-hidden className="size-3">
                        <path
                          d="M6 1.4 9.8 3v3c0 2.2-1.6 4.1-3.8 4.7C3.8 10.1 2.2 8.2 2.2 6V3L6 1.4Z"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1"
                          strokeLinejoin="round"
                        />
                      </svg>
                      System
                    </span>
                  ) : (
                    <span className="rounded bg-surface-sunken px-2 py-0.5 text-[11px] text-muted-foreground">
                      Custom
                    </span>
                  )}
                </span>
                <span className="mt-1 block max-w-prose text-sm text-pretty text-muted-foreground">
                  {role.description ??
                    (role.is_system
                      ? "Managed by TalentIQ so this organization always keeps an administrator."
                      : "No description.")}
                </span>
              </span>

              <span className="flex shrink-0 items-center gap-6 text-sm">
                <span className="text-right">
                  <span className="block font-medium tabular-nums">
                    {role.permission_keys.length}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    permission{role.permission_keys.length === 1 ? "" : "s"}
                  </span>
                </span>
                <span className="text-right">
                  <span className="block font-medium tabular-nums">{role.member_count}</span>
                  <span className="block text-xs text-muted-foreground">
                    member{role.member_count === 1 ? "" : "s"}
                  </span>
                </span>
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

      {roles.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-border-strong bg-surface-sunken/60 p-8 text-center">
          <p className="font-medium tracking-tight">No roles yet</p>
          <p className="mx-auto mt-1.5 max-w-sm text-sm text-pretty text-muted-foreground">
            Roles decide what members can do here. Create one to start granting access.
          </p>
        </div>
      )}
    </>
  );
}
