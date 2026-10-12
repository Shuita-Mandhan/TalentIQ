import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { hasPermission } from "@/lib/auth/authorization";
import { requireOrganizationAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { formatDate } from "@/lib/format";
import { getJob } from "@/lib/jobs/jobs";
import { getJobResumes, getUploaderNames } from "@/lib/resumes/resumes";
import { getCurrentProcessings } from "@/lib/resumes/processing";
import { canRetry, processingReason } from "@/lib/resumes/processing-types";
import { FORMAT_LABELS, formatBytes, formatOfContentType } from "@/lib/resumes/types";
import { PageHeading } from "@/components/layout/page-heading";
import { ProcessingStatusPill } from "@/components/resumes/processing-status";
import { ActionForm } from "@/components/ui/action-form";
import { removeResume } from "./actions";
import { IntakeUploader } from "./intake-uploader";
import { ProcessAllButton, ProcessButton } from "./processing-controls";

export const metadata: Metadata = { title: "Resume intake" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ResumeIntakePage({
  params,
}: {
  params: Promise<{ organizationSlug: string; jobId: string }>;
}) {
  const { organizationSlug, jobId } = await params;
  const { user, context } = await requireOrganizationAccess(organizationSlug);
  if (!hasPermission(context, PERMISSIONS.JOBS_VIEW)) notFound();
  if (!UUID_PATTERN.test(jobId)) notFound();
  const canManage = hasPermission(context, PERMISSIONS.JOBS_MANAGE);
  const organizationId = context.organization.id;

  const job = await getJob(organizationId, jobId);
  if (!job) notFound();

  const resumes = await getJobResumes(organizationId, job.id);
  // One query for the whole list. Reading this page never starts processing — it only reports where
  // each document already stands.
  const [uploaders, processings] = await Promise.all([
    getUploaderNames(
      resumes.map((resume) => resume.uploaded_by).filter((id): id is string => id !== null),
    ),
    getCurrentProcessings(organizationId, job.id),
  ]);
  // The same rule the rubric uses: holding the key is not enough if the job has been frozen.
  const editable = canManage && job.status !== "archived";

  // Not read: never attempted, or attempted by a process that disappeared. A failed or needs-review
  // attempt is deliberately NOT included - those produced something a person should look at, and a
  // batch button should not quietly re-run them.
  const unread = resumes
    .filter((resume) => {
      const attempt = processings.get(resume.id);
      return attempt === undefined || attempt.stalled;
    })
    .map((resume) => resume.id);

  return (
    <>
      <PageHeading
        back={{ href: `/app/${organizationSlug}/jobs/${job.id}`, label: job.title }}
        eyebrow={
          <p className="font-mono text-[11px] tracking-[0.12em] text-accent uppercase">
            Resume intake
          </p>
        }
        title="Resumes for this role"
        description="Bring applicants' resumes in, then read them into candidate profiles. Every detail a profile shows carries a quote from the document it came from, so nothing has to be taken on trust."
      />

      {job.status === "archived" && (
        <p className="mt-6 border-l-2 border-border-strong pl-3 text-sm text-pretty text-muted-foreground">
          This job is archived. The resumes it received are kept as a record and stay readable,
          together with the profiles already read from them, but nothing new can be added, read or
          removed.
        </p>
      )}

      {!canManage && job.status !== "archived" && (
        <p className="mt-6 text-sm text-muted-foreground">
          You can see these resumes and the profiles read from them, but not add, read or remove
          them. That needs the “Manage jobs” permission.
        </p>
      )}

      {editable && <IntakeUploader organizationSlug={organizationSlug} jobId={job.id} />}

      <section className="mt-12">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              {resumes.length === 0
                ? "No resumes yet"
                : `${resumes.length} resume${resumes.length === 1 ? "" : "s"} uploaded`}
            </h2>
            {resumes.length > 0 && (
              <p className="mt-1 text-sm text-muted-foreground tabular-nums">
                {resumes.length - unread.length} read · {unread.length} not read yet
              </p>
            )}
          </div>
          {editable && (
            <ProcessAllButton
              organizationSlug={organizationSlug}
              jobId={job.id}
              resumeIds={unread}
            />
          )}
        </div>

        {resumes.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-border-strong bg-surface-sunken/60 p-8">
            <p className="font-medium tracking-tight">No resumes uploaded yet.</p>
            <p className="mt-1.5 max-w-prose text-sm text-pretty text-muted-foreground">
              {editable
                ? "Select or drop PDF and DOCX files above. They are stored privately against this job and stay here after you leave the page."
                : "When someone with the “Manage jobs” permission uploads resumes for this role, they will be listed here."}
            </p>
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
            {resumes.map((resume) => {
              const format = formatOfContentType(resume.content_type);
              const uploader =
                (resume.uploaded_by !== null ? uploaders.get(resume.uploaded_by) : undefined) ??
                (resume.uploaded_by === user.userId ? "You" : "Unknown");
              const attempt = processings.get(resume.id) ?? null;
              const profile = attempt?.structured_profile ?? null;
              // Only ever a name that was read out of the document. The filename is never mined for
              // one, which is why a resume with no readable name is shown by its filename and said
              // to be a filename.
              const name = profile?.candidate.full_name ?? null;
              const email = profile?.candidate.email ?? null;
              const reason = attempt !== null ? processingReason(attempt) : null;
              const profileHref = `/app/${organizationSlug}/jobs/${job.id}/resumes/${resume.id}`;

              return (
                <li key={resume.id} className="px-4 py-3.5 sm:px-5">
                  <div className="flex flex-wrap items-start gap-x-5 gap-y-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <Link
                          href={profileHref}
                          className="min-w-0 truncate text-sm font-medium transition-colors duration-150 hover:text-accent-strong"
                          title={name ?? resume.original_filename}
                        >
                          {name ?? resume.original_filename}
                        </Link>
                        <ProcessingStatusPill attempt={attempt} />
                      </div>
                      <p className="mt-1 font-mono text-xs text-muted-foreground tabular-nums">
                        {/* When a name is shown above, the filename moves here so the document is
                            still identifiable. */}
                        {name !== null && (
                          <span className="break-all">{resume.original_filename} · </span>
                        )}
                        {format === null ? "Document" : FORMAT_LABELS[format]} ·{" "}
                        {formatBytes(resume.size_bytes)} · {formatDate(resume.created_at)} ·{" "}
                        {uploader}
                      </p>
                      {email !== null && (
                        <p className="mt-0.5 text-xs break-all text-muted-foreground">{email}</p>
                      )}
                      {reason !== null && (
                        <p className="mt-1 max-w-prose text-xs text-pretty text-muted-foreground">
                          {reason}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-start justify-end gap-x-3 gap-y-2">
                      {profile !== null && (
                        <Link
                          href={profileHref}
                          className="text-sm font-medium text-accent transition-colors duration-150 hover:text-accent-strong"
                        >
                          Profile
                          <span className="sr-only"> for {resume.original_filename}</span>
                        </Link>
                      )}
                      {/* An ordinary link: the route it points at mints a one-minute signed URL and
                          redirects to it, so nothing durable is ever exposed. */}
                      <a
                        href={`/api/workspace/${organizationSlug}/jobs/${job.id}/resumes/${resume.id}`}
                        className="text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
                      >
                        Download
                        <span className="sr-only"> {resume.original_filename}</span>
                      </a>
                      {editable && (attempt === null || canRetry(attempt)) && (
                        <ProcessButton
                          organizationSlug={organizationSlug}
                          jobId={job.id}
                          resumeId={resume.id}
                          label={attempt === null ? "Process" : "Retry"}
                        />
                      )}
                      {editable && (
                        <ActionForm
                          action={removeResume}
                          fields={{ organizationSlug, jobId: job.id, resumeId: resume.id }}
                          label="Remove"
                          ariaLabel={`Remove ${resume.original_filename} from this job`}
                        />
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
