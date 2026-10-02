import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasPermission } from "@/lib/auth/authorization";
import { requireOrganizationAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { getJob } from "@/lib/jobs/jobs";
import { PageHeading } from "@/components/layout/page-heading";
import { updateJob } from "../../actions";
import { JobForm } from "../../job-form";

export const metadata: Metadata = { title: "Edit job" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditJobPage({
  params,
}: {
  params: Promise<{ organizationSlug: string; jobId: string }>;
}) {
  const { organizationSlug, jobId } = await params;
  const { context } = await requireOrganizationAccess(organizationSlug);
  if (!hasPermission(context, PERMISSIONS.JOBS_MANAGE)) notFound();
  if (!UUID_PATTERN.test(jobId)) notFound();

  const job = await getJob(context.organization.id, jobId);
  if (!job) notFound();
  // Archived jobs are history: the database refuses to change them, so no editor is offered.
  if (job.status === "archived") notFound();

  return (
    <div className="max-w-2xl">
      <PageHeading
        back={{ href: `/app/${organizationSlug}/jobs/${job.id}`, label: job.title }}
        title="Edit job"
        description="Requirements are edited on the job itself."
      />
      <div className="mt-8">
        <JobForm
          action={updateJob}
          organizationSlug={organizationSlug}
          jobId={job.id}
          initial={{
            title: job.title,
            description: job.description ?? "",
            department: job.department ?? "",
            location: job.location ?? "",
            work_mode: job.work_mode ?? "",
            employment_type: job.employment_type ?? "",
            openings: String(job.openings),
            application_deadline: job.application_deadline ?? "",
          }}
          submitLabel="Save changes"
        />
      </div>
    </div>
  );
}
