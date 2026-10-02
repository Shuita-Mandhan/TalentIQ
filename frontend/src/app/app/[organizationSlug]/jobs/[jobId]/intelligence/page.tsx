import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { hasPermission } from "@/lib/auth/authorization";
import { requireOrganizationAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { getJob, getJobRequirements, getLatestAnalysis, getSuggestions } from "@/lib/jobs/jobs";
import { PageHeading } from "@/components/layout/page-heading";
import { formatDate } from "@/lib/format";
import { AnalyzeForm } from "./analyze-form";
import { ReviewPanel } from "./review-panel";

export const metadata: Metadata = { title: "Requirement intelligence" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function IntelligencePage({
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

  const [analysis, approved] = await Promise.all([
    getLatestAnalysis(context.organization.id, job.id),
    getJobRequirements(context.organization.id, job.id),
  ]);
  const suggestions = analysis ? await getSuggestions(context.organization.id, analysis.id) : [];


  return (
    <>
      <PageHeading
        back={{ href: `/app/${organizationSlug}/jobs/${job.id}`, label: job.title }}
        eyebrow={
          <p className="font-mono text-[11px] tracking-[0.12em] text-accent uppercase">
            Requirement intelligence
          </p>
        }
        title="Extract requirements"
        description="Paste a job description and the model proposes structured requirements. Nothing it proposes becomes part of the job until you approve it."
      />

      {/* The whole flow, stated once, so the separation between suggested and approved is the
          first thing read rather than something inferred from styling. */}
      <ol className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {["Description", "Analysis", "Your review", "Job requirements"].map((step, index) => (
          <li key={step} className="flex items-center gap-2">
            {index > 0 && (
              <span aria-hidden className="text-border-strong">
                &rarr;
              </span>
            )}
            <span className={index === 3 ? "font-medium text-foreground" : undefined}>{step}</span>
          </li>
        ))}
      </ol>

      {job.status === "archived" ? (
        <p className="mt-8 border-l-2 border-border-strong pl-3 text-sm text-pretty text-muted-foreground">
          This job is archived, so it can no longer be analyzed or gain requirements.
        </p>
      ) : canManage ? (
        <AnalyzeForm
          organizationSlug={organizationSlug}
          jobId={job.id}
          initialDescription={analysis?.source_text ?? job.description ?? ""}
        />
      ) : (
        <p className="mt-8 text-sm text-muted-foreground">
          You can see this job&apos;s analysis but not run one. Analyzing a description needs the
          “Manage jobs” permission.
        </p>
      )}

      {analysis && (
        <p className="mt-4 text-xs text-muted-foreground">
          Last run {formatDate(analysis.created_at)} · {analysis.provider}/{analysis.model} ·{" "}
          {analysis.status === "failed" || analysis.stalled ? (
            <span className="text-destructive">
              {analysis.stalled
                ? "did not finish — run it again"
                : `failed${analysis.error ? ` — ${analysis.error}` : ""}`}
            </span>
          ) : (
            analysis.status
          )}
        </p>
      )}

      {/* Shown to anyone who may read the job, because they may read these too. An archived job's
          review set is history and offers nothing, which is what canManage carries here. */}
      {analysis && suggestions.length > 0 && (
        <ReviewPanel
          suggestions={suggestions}
          organizationSlug={organizationSlug}
          jobId={job.id}
          canManage={canManage && job.status !== "archived"}
        />
      )}

      {/* Approved requirements are shown here too, deliberately: the contrast between the dashed
          suggestion block above and this solid one is the clearest statement of what counts. */}
      <section className="mt-12">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 className="text-lg font-semibold tracking-tight">Job requirements</h2>
          <Link
            href={`/app/${organizationSlug}/jobs/${job.id}`}
            className="text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            Manage on the job
          </Link>
        </div>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {approved.length === 0
            ? "Nothing approved yet."
            : `${approved.length} requirement${approved.length === 1 ? "" : "s"} on this job.`}
        </p>
        {approved.length > 0 && (
          <ul className="mt-4 divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
            {approved.map((requirement) => (
              <li key={requirement.id} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                <span
                  aria-hidden
                  className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                    requirement.importance === "required" ? "bg-accent" : "bg-border-strong"
                  }`}
                />
                <span className="min-w-0 text-sm break-words">{requirement.requirement}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
