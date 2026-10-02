import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasPermission } from "@/lib/auth/authorization";
import { requireOrganizationAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { PageHeading } from "@/components/layout/page-heading";
import { createRole } from "../actions";
import { RoleForm } from "../role-form";

export const metadata: Metadata = { title: "Create role" };

export default async function NewRolePage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const { context } = await requireOrganizationAccess(organizationSlug);
  if (!hasPermission(context, PERMISSIONS.ROLES_MANAGE)) notFound();

  return (
    <div className="max-w-xl">
      <PageHeading
        back={{ href: `/app/${organizationSlug}/roles`, label: "Roles" }}
        title="Create role"
        description="Name the role the way your organization talks about it, then choose what it can do."
      />
      <div className="mt-8">
        <RoleForm
          action={createRole}
          organizationSlug={organizationSlug}
          initial={{ name: "", description: "", permissions: [] }}
          submitLabel="Create role"
        />
      </div>
    </div>
  );
}
