import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasPermission } from "@/lib/auth/authorization";
import { requireOrganizationAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { PageHeading } from "@/components/layout/page-heading";
import { OrganizationForm } from "./organization-form";

export const metadata: Metadata = { title: "Settings" };

export default async function OrganizationSettingsPage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const { context } = await requireOrganizationAccess(organizationSlug);
  // The page guards itself; the navigation not offering it is convenience, not security.
  if (!hasPermission(context, PERMISSIONS.ORGANIZATION_UPDATE)) notFound();

  return (
    <div className="max-w-xl">
      <PageHeading
        title="Settings"
        description="The organization's identity inside TalentIQ."
      />

      <section className="mt-8">
        <OrganizationForm
          organizationSlug={organizationSlug}
          initialName={context.organization.name}
        />
      </section>

      <section className="mt-12 border-t border-border pt-8">
        <h2 className="font-medium tracking-tight">Managed by TalentIQ</h2>
        <p className="mt-1.5 max-w-prose text-sm text-pretty text-muted-foreground">
          These identify your organization across the platform and everything that links to it, so
          they are not changed from inside the workspace. Contact TalentIQ if either needs to move.
        </p>
        <dl className="mt-5 divide-y divide-border border-y border-border text-sm">
          <div className="flex items-center justify-between gap-6 py-3.5">
            <dt className="text-muted-foreground">Workspace address</dt>
            <dd className="font-mono text-[13px]">/app/{context.organization.slug}</dd>
          </div>
          <div className="flex items-center justify-between gap-6 py-3.5">
            <dt className="text-muted-foreground">Status</dt>
            <dd className="font-medium">Active</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
