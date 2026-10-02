import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { hasPermission } from "@/lib/auth/authorization";
import { requireOrganizationAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import {
  EMPLOYMENT_TYPE_LABELS,
  STATUS_LABELS,
  STATUS_TRANSITIONS,
  WORK_MODE_LABELS,
  summariseRubric,
} from "@/lib/jobs/types";
import { getJob, getJobRequirements } from "@/lib/jobs/jobs";
import { countJobResumes } from "@/lib/resumes/resumes";
import { PageHeading } from "@/components/layout/page-heading";
import { ActionForm } from "@/components/ui/action-form";
import { JobStatusPill } from "@/components/jobs/job-status-pill";
import { RubricReadinessBar } from "@/components/jobs/rubric-readiness";
import { formatDate } from "@/lib/format";
import { setJobStatus } from "../actions";

export const metadata: Metadata = { title: "Job" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What each move means to a recruiter, and which ones deserve a moment's thought. */
const TRANSITION_LABELS: Record<string, { label: string; tone: "primary" | "quiet" }> = {
  open: { label: "Open job", tone: "primary" },
  paused: { label: "Pause", tone: "quiet" },
  closed: { label: "Close", tone: "quiet" },
  archived: { label: "Archive", tone: "quiet" },
};

export default async function JobPage({
  params,
}: {
  params: Promise<{ organizationSlug: string; jobId: string }>;
}) {
  const { organizationSlug, jobId } = await params;
  const { context } = await requireOrganizationAccess(organizationSlug);
  if (!hasPermission(context, PERMISSIONS.JOBS_VIEW)) notFound();
  // A malformed id is simply not a job here.
  if (!UUID_PATTERN.test(jobId)) notFound();
  const canManage = hasPermission(context, PERMISSIONS.JOBS_MANAGE);

  const job = await getJob(context.organization.id, jobId);
  if (!job) notFound();
  const requirements = await getJobRequirements(context.organization.id, job.id);
  const rubric = summariseRubric(requirements);
  // A count, not the rows: the job page says how much intake has happened and sends you to the page
  // that does it, the same arrangement the rubric has.
  const resumeCount = await countJobResumes(context.organization.id, job.id);

  const transitions = STATUS_TRANSITIONS[job.status];
  const facts = [
    { label: "Department", value: job.department },
    { label: "Location", value: job.location },
    { label: "Work mode", value: job.work_mode ? WORK_MODE_LABELS[job.work_mode] : null },
    {
      label: "Employment",
      value: job.employment_type ? EMPLOYMENT_TYPE_LABELS[job.employment_type] : null,
    },
    { label: "Openings", value: String(job.openings) },
    {
      label: "Deadline",
      value: job.application_deadline ? formatDate(job.application_deadline) : null,
    },
  ];

  return (
    <>
      <PageHeading
        back={{ href: `/app/${organizationSlug}/jobs`, label: "Jobs" }}
        eyebrow={<JobStatusPill status={job.status} />}
        title={job.title}
        actions={
          canManage &&
          job.status !== "archived" && (
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/app/${organizationSlug}/jobs/${job.id}/intelligence`}
                className="inline-flex h-10 items-center rounded-md border border-accent/30 bg-accent-soft px-4 text-sm font-medium text-accent-strong shadow-sm transition-colors duration-150 hover:border-accent/60"
              >
                Extract requirements
              </Link>
              <Link
                href={`/app/${organizationSlug}/jobs/${job.id}/edit`}
                className="inline-flex h-10 items-center rounded-md border border-border bg-surface px-4 text-sm font-medium shadow-sm transition-colors duration-150 hover:border-border-strong hover:bg-surface-sunken"
              >
                Edit job
              </Link>
            </div>
          )
        }
      />

      {job.status === "archived" && (
        <p className="mt-6 border-l-2 border-border-strong pl-3 text-sm text-pretty text-muted-foreground">
          Archived. This job is kept as a record and can no longer be changed, so the screening
          history that will hang off it stays intact.
        </p>
      )}

      <dl className="mt-8 grid grid-cols-2 gap-x-8 gap-y-5 border-y border-border py-6 sm:grid-cols-3">
        {facts.map(({ label, value }) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className={`mt-1 text-sm ${value ? "" : "text-muted-foreground/60"}`}>
              {value ?? "Not set"}
            </dd>
          </div>
        ))}
      </dl>

      {/* Why nothing is on offer, rather than an empty space where controls would be. */}
      {!canManage && job.status !== "archived" && (
        <p className="mt-6 text-sm text-muted-foreground">
          You can see this job but not change it. Managing jobs needs the “Manage jobs” permission,
          which someone who manages roles can grant.
        </p>
      )}

      {canManage && transitions.length > 0 && (
        <section className="mt-8">
          <h2 className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            Status
          </h2>
          <div className="mt-3 flex flex-wrap items-start gap-2.5">
            {transitions.map((next) => {
              const meta = TRANSITION_LABELS[next];
              return (
                <div key={next} className="flex flex-col items-start gap-1">
                  <ActionForm
                    action={setJobStatus}
                    fields={{ organizationSlug, jobId: job.id, status: next }}
                    label={meta.label}
                    ariaLabel={`${meta.label}: move this job from ${STATUS_LABELS[job.status]} to ${STATUS_LABELS[next]}`}
                  />
                </div>
              );
            })}
          </div>
          {transitions.includes("archived") && (
            // Archiving is the one move that cannot be undone, so it is named rather than guarded
            // by a dialog that people click through.
            <p className="mt-3 text-sm text-muted-foreground">
              Archiving is permanent — an archived job can no longer be edited or reopened.
            </p>
          )}
        </section>
      )}

      {/* The rubric is summarised here and configured on its own page: one editor, not two. */}
      <section className="mt-12">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 className="text-lg font-semibold tracking-tight">Screening rubric</h2>
          <Link
            href={`/app/${organizationSlug}/jobs/${job.id}/rubric`}
            className="group inline-flex items-center gap-1.5 text-sm font-medium text-accent transition-colors duration-150 hover:text-accent-strong"
          >
            {canManage && job.status !== "archived" ? "Configure rubric" : "View rubric"}
            <span
              aria-hidden
              className="transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:group-hover:translate-x-0"
            >
              &rarr;
            </span>
          </Link>
        </div>
        <p className="mt-1.5 max-w-prose text-sm text-pretty text-muted-foreground">
          What candidates will be evaluated against, and how much each requirement counts.
        </p>

        {requirements.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-border-strong bg-surface-sunken/60 p-8">
            <p className="font-medium tracking-tight">No requirements yet</p>
            <p className="mt-1.5 max-w-prose text-sm text-pretty text-muted-foreground">
              The rubric is empty. Add requirements yourself, or extract them from the job
              description and approve the ones that fit.
            </p>
          </div>
        ) : (
          <>
            <div className="mt-4 rounded-xl border border-border bg-surface p-5 shadow-sm">
              <RubricReadinessBar summary={rubric} />
            </div>
            <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
              {requirements.map((requirement) => (
                <li
                  key={requirement.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 sm:px-5"
                >
                  <span
                    aria-hidden
                    className={`size-1.5 shrink-0 rounded-full ${
                      requirement.importance === "required" ? "bg-accent" : "bg-border-strong"
                    }`}
                  />
                  <span className="min-w-0 flex-1 text-sm break-words">
                    {requirement.requirement}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    {requirement.weight}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* Job details, requirements and the rubric describe the role. This is where the applicants
          come in. It has its own page because uploading a hundred files is its own task. */}
      <section className="mt-12">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 className="text-lg font-semibold tracking-tight">Resume intake</h2>
          <Link
            href={`/app/${organizationSlug}/jobs/${job.id}/resumes`}
            className="group inline-flex items-center gap-1.5 text-sm font-medium text-accent transition-colors duration-150 hover:text-accent-strong"
          >
            {canManage && job.status !== "archived" ? "Upload resumes" : "View resumes"}
            <span
              aria-hidden
              className="transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:group-hover:translate-x-0"
            >
              &rarr;
            </span>
          </Link>
        </div>
        <p className="mt-1.5 max-w-prose text-sm text-pretty text-muted-foreground">
          {resumeCount === 0
            ? "No resumes yet. PDF and DOCX, up to 100 in one batch, stored privately against this job."
            : `${resumeCount} resume${resumeCount === 1 ? "" : "s"} received. Nothing has been read from them yet — that is a later step.`}
        </p>
      </section>

      <section className="mt-12">
        <h2 className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
          Description
        </h2>
        {job.description ? (
          // break-words so an unbroken string (a URL, a pasted token) wraps instead of widening
          // the page on a narrow screen.
          <p className="mt-4 max-w-prose text-sm leading-relaxed break-words whitespace-pre-wrap">
            {job.description}
          </p>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            No description yet.
            {canManage && job.status !== "archived" && (
              <>
                {" "}
                <Link
                  href={`/app/${organizationSlug}/jobs/${job.id}/edit`}
                  className="font-medium text-accent transition-colors duration-150 hover:text-accent-strong"
                >
                  Add one
                </Link>
                .
              </>
            )}
          </p>
        )}
      </section>

      <p className="mt-12 border-t border-border pt-5 font-mono text-xs text-muted-foreground">
        Created {formatDate(job.created_at)} · Updated {formatDate(job.updated_at)}
      </p>
    </>
  );
}
