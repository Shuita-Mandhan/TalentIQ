import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasPermission } from "@/lib/auth/authorization";
import { requireOrganizationAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { PageHeading } from "@/components/layout/page-heading";
import { createJob } from "../actions";
import { JobForm } from "../job-form";

export const metadata: Metadata = { title: "New job" };

const EMPTY = {
  title: "",
  description: "",
  department: "",
  location: "",
  work_mode: "",
  employment_type: "",
  openings: "1",
  application_deadline: "",
};

export default async function NewJobPage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const { context } = await requireOrganizationAccess(organizationSlug);
  if (!hasPermission(context, PERMISSIONS.JOBS_MANAGE)) notFound();

  return (
    <div className="max-w-2xl">
      <PageHeading
        back={{ href: `/app/${organizationSlug}/jobs`, label: "Jobs" }}
        title="New job"
        description="Only a title is required to start. The job is saved as a draft, so you can add requirements before anyone sees it."
      />
      <div className="mt-8">
        <JobForm
          action={createJob}
          organizationSlug={organizationSlug}
          initial={EMPTY}
          submitLabel="Save draft"
        />
      </div>
    </div>
  );
}
