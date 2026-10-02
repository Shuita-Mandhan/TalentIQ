import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { hasPermission } from "@/lib/auth/authorization";
import { requireOrganizationAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { getJob, getJobRequirements } from "@/lib/jobs/jobs";
import { summariseRubric } from "@/lib/jobs/types";
import { PageHeading } from "@/components/layout/page-heading";
import { RubricReadinessBar } from "@/components/jobs/rubric-readiness";
import { RequirementsEditor } from "../requirements-editor";
import { WeightsForm } from "./weights-form";

export const metadata: Metadata = { title: "Screening rubric" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function RubricPage({
  params,
}: {
  params: Promise<{ organizationSlug: string; jobId: string }>;
}) {
  const { organizationSlug, jobId } = await params;
  const { context } = await requireOrganizationAccess(organizationSlug);
  if (!hasPermission(context, PERMISSIONS.JOBS_VIEW)) notFound();
  if (!UUID_PATTERN.test(jobId)) notFound();
  const canManage = hasPermission(context, PERMISSIONS.JOBS_MANAGE);

  const job = await getJob(context.organization.id, jobId);
  if (!job) notFound();

  // The rubric IS the approved requirements. Reading them creates nothing and copies nothing.
  const requirements = await getJobRequirements(context.organization.id, job.id);
  const summary = summariseRubric(requirements);
  const editable = canManage && job.status !== "archived";

  return (
    <>
      <PageHeading
        back={{ href: `/app/${organizationSlug}/jobs/${job.id}`, label: job.title }}
        eyebrow={
          <p className="font-mono text-[11px] tracking-[0.12em] text-accent uppercase">
            Screening rubric
          </p>
        }
        title="What this role is screened on"
        description="Each requirement carries a share of 100 points. Screening will later weigh candidates against exactly this, so the weights are yours to set."
      />

      <section className="mt-8 rounded-xl border border-border bg-surface p-5 shadow-sm sm:p-6">
        <RubricReadinessBar summary={summary} />
        {/* Two different things, kept visually apart: what holds the rubric back, and what merely
            deserves a look. A ready rubric shows no issues but may still show a warning. */}
        {(summary.issues.length > 0 || summary.warnings.length > 0) && (
          <div className="mt-4 space-y-4 border-t border-border pt-4">
            {summary.issues.length > 0 && (
              <ul className="space-y-1">
                {summary.issues.map((issue) => (
                  <li key={issue} className="flex items-start gap-2 text-sm">
                    <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
                    {issue}
                  </li>
                ))}
              </ul>
            )}
            {summary.warnings.length > 0 && (
              <div>
                <h3 className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                  Worth checking
                </h3>
                <ul className="mt-2 space-y-1">
                  {summary.warnings.map((warning) => (
                    <li
                      key={warning}
                      className="flex items-start gap-2 text-sm text-muted-foreground"
                    >
                      <span
                        aria-hidden
                        className="mt-1.5 size-1.5 shrink-0 rounded-full border border-border-strong"
                      />
                      {warning}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      {job.status === "archived" && (
        <p className="mt-6 border-l-2 border-border-strong pl-3 text-sm text-pretty text-muted-foreground">
          This job is archived. Its rubric is kept as a record of what the role was screened on and
          can no longer be changed.
        </p>
      )}

      {!canManage && job.status !== "archived" && (
        <p className="mt-6 text-sm text-muted-foreground">
          You can see this rubric but not change it. Editing needs the “Manage jobs” permission.
        </p>
      )}

      {requirements.length > 0 && editable && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold tracking-tight">Weights</h2>
          <p className="mt-1.5 max-w-prose text-sm text-pretty text-muted-foreground">
            Distribute the 100 points across the requirements. Nothing is adjusted for you — if the
            total is not {100}, the rubric stays incomplete until you decide where the rest goes.
          </p>
          <WeightsForm
            requirements={requirements}
            organizationSlug={organizationSlug}
            jobId={job.id}
          />
        </section>
      )}

      <section className="mt-12">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 className="text-lg font-semibold tracking-tight">Requirements</h2>
          {canManage && job.status !== "archived" && (
            <Link
              href={`/app/${organizationSlug}/jobs/${job.id}/intelligence`}
              className="text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
            >
              Extract from a description
            </Link>
          )}
        </div>
        <p className="mt-1.5 max-w-prose text-sm text-pretty text-muted-foreground">
          Add your own, edit anything here — including requirements a model suggested and you
          approved — and set the order they are presented in.
        </p>

        {/* The same editor the job detail used. One implementation of requirement management, now
            living where the rubric is configured. */}
        <RequirementsEditor
          requirements={requirements}
          organizationSlug={organizationSlug}
          jobId={job.id}
          canManage={editable}
        />
      </section>
    </>
  );
}
