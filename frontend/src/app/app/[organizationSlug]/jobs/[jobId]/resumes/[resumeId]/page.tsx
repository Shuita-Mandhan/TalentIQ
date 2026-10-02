import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { hasPermission } from "@/lib/auth/authorization";
import { requireOrganizationAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { formatDate } from "@/lib/format";
import { getJob } from "@/lib/jobs/jobs";
import { getJobResume } from "@/lib/resumes/resumes";
import {
  getCandidateForApplication,
  getCurrentProcessing,
  getEvidence,
  getProcessingHistory,
  countOtherApplications,
} from "@/lib/resumes/processing";
import { evidenceFor, evidenceSummary } from "@/lib/resumes/profile";
import {
  IDENTITY_LABELS,
  PROCESSING_LABELS,
  canRetry,
  processingReason,
} from "@/lib/resumes/processing-types";
import { FORMAT_LABELS, formatBytes, formatOfContentType } from "@/lib/resumes/types";
import { PageHeading } from "@/components/layout/page-heading";
import { EvidenceCoverage, FactWithEvidence, GeneratedText } from "@/components/resumes/evidence";
import { ProcessingStatusPill } from "@/components/resumes/processing-status";
import { ProcessButton } from "../processing-controls";

export const metadata: Metadata = { title: "Candidate profile" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A heading that only appears when its section has something in it. */
function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section className="mt-10">
      <h2 className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default async function CandidateProfilePage({
  params,
}: {
  params: Promise<{ organizationSlug: string; jobId: string; resumeId: string }>;
}) {
  const { organizationSlug, jobId, resumeId } = await params;
  const { context } = await requireOrganizationAccess(organizationSlug);
  if (!hasPermission(context, PERMISSIONS.JOBS_VIEW)) notFound();
  if (!UUID_PATTERN.test(jobId) || !UUID_PATTERN.test(resumeId)) notFound();
  const canManage = hasPermission(context, PERMISSIONS.JOBS_MANAGE);
  const organizationId = context.organization.id;

  const job = await getJob(organizationId, jobId);
  if (!job) notFound();
  const resume = await getJobResume(organizationId, jobId, resumeId);
  if (!resume) notFound();

  // Nothing is processed here. This page only reads what an explicit action produced earlier.
  const attempt = await getCurrentProcessing(organizationId, jobId, resumeId);
  const [evidence, history] = await Promise.all([
    attempt !== null ? getEvidence(organizationId, attempt.id) : Promise.resolve([]),
    getProcessingHistory(organizationId, resumeId),
  ]);
  const candidate =
    attempt?.application_id != null
      ? await getCandidateForApplication(organizationId, attempt.application_id)
      : null;
  const otherApplications =
    candidate !== null && attempt?.application_id != null
      ? await countOtherApplications(organizationId, candidate.id, attempt.application_id)
      : 0;

  const profile = attempt?.structured_profile ?? null;
  const coverage = evidenceSummary(evidence);
  const format = formatOfContentType(resume.content_type);
  const downloadHref = `/api/workspace/${organizationSlug}/jobs/${job.id}/resumes/${resume.id}`;
  const reason = attempt !== null ? processingReason(attempt) : null;
  const editable = canManage && job.status !== "archived";

  // The filename is the fallback, and it is labelled as a filename — never dressed up as a person.
  const displayName = profile?.candidate.full_name ?? null;

  return (
    <>
      <PageHeading
        back={{
          href: `/app/${organizationSlug}/jobs/${job.id}/resumes`,
          label: "Resume intake",
        }}
        eyebrow={<ProcessingStatusPill attempt={attempt} />}
        title={displayName ?? resume.original_filename}
        description={
          displayName === null
            ? "No name has been read from this document, so it is listed by its filename. Nothing here is guessed from that filename."
            : (profile?.candidate.headline ?? undefined)
        }
      />

      {/* What the recruiter needs before reading anything below: where this came from, and how far
          to trust it. Deliberately one quiet strip rather than a row of dashboard cards. */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-x-8 gap-y-4 border-y border-border py-4">
        <dl className="flex flex-wrap items-baseline gap-x-8 gap-y-3 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Source</dt>
            <dd className="mt-0.5">
              <a
                href={downloadHref}
                className="font-medium break-all text-accent transition-colors duration-150 hover:text-accent-strong"
              >
                {resume.original_filename}
              </a>
              <span className="ml-2 font-mono text-xs text-muted-foreground tabular-nums">
                {format === null ? "Document" : FORMAT_LABELS[format]} ·{" "}
                {formatBytes(resume.size_bytes)}
                {attempt?.page_count != null && attempt.page_count > 0 && (
                  <> · {attempt.page_count} page{attempt.page_count === 1 ? "" : "s"}</>
                )}
              </span>
            </dd>
          </div>
          {candidate !== null && (
            <div>
              <dt className="text-xs text-muted-foreground">Identity</dt>
              <dd className="mt-0.5">
                {IDENTITY_LABELS[candidate.identity_state]}
                {otherApplications > 0 && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    · also applied to {otherApplications} other role
                    {otherApplications === 1 ? "" : "s"}
                  </span>
                )}
              </dd>
            </div>
          )}
          {attempt?.provider != null && (
            <div>
              <dt className="text-xs text-muted-foreground">Read by</dt>
              {/* Provider and model, so a result can be understood later. Never a credential. */}
              <dd className="mt-0.5 font-mono text-xs tabular-nums">
                {attempt.provider} · {attempt.model}
              </dd>
            </div>
          )}
        </dl>
        {editable && attempt !== null && canRetry(attempt.status) && (
          <ProcessButton
            organizationSlug={organizationSlug}
            jobId={job.id}
            resumeId={resume.id}
            label="Retry"
          />
        )}
      </div>

      {reason !== null && (
        <p className="mt-6 border-l-2 border-border-strong pl-3 text-sm text-pretty text-muted-foreground">
          {reason}
        </p>
      )}

      {attempt === null ? (
        <div className="mt-8 rounded-xl border border-dashed border-border-strong bg-surface-sunken/60 p-8">
          <p className="font-medium tracking-tight">This resume has not been read yet</p>
          <p className="mt-1.5 max-w-prose text-sm text-pretty text-muted-foreground">
            {editable
              ? "Reading it extracts the text and builds a profile with a quote from the document behind every detail."
              : "Someone with the “Manage jobs” permission can read it and build a profile."}
          </p>
          {editable && (
            <div className="mt-4">
              <ProcessButton
                organizationSlug={organizationSlug}
                jobId={job.id}
                resumeId={resume.id}
                label="Process"
              />
            </div>
          )}
        </div>
      ) : profile === null ? (
        <div className="mt-8 rounded-xl border border-dashed border-border-strong bg-surface-sunken/60 p-8">
          <p className="font-medium tracking-tight">No profile was produced</p>
          <p className="mt-1.5 max-w-prose text-sm text-pretty text-muted-foreground">
            The attempt is kept so it can be looked at, and the original document is untouched — you
            can open it above.
          </p>
        </div>
      ) : (
        <>
          {evidence.length > 0 && (
            <div className="mt-8">
              <EvidenceCoverage total={coverage.total} verified={coverage.verified} />
            </div>
          )}

          <Section
            title="Contact"
            count={
              [
                profile.candidate.email,
                profile.candidate.phone,
                profile.candidate.location,
                profile.candidate.linkedin_url,
                profile.candidate.website_url,
              ].filter((value) => value !== null).length
            }
          >
            <div className="rounded-xl border border-border bg-surface px-4 shadow-sm sm:px-5">
              {/* The third element is the fact_key the prompt asks the model to use for this
                  field, so the evidence lands against the right line rather than being matched on
                  a label somebody later rewords. */}
              {(
                [
                  ["Email", profile.candidate.email, "email"],
                  ["Phone", profile.candidate.phone, "phone"],
                  ["Location", profile.candidate.location, "location"],
                  ["LinkedIn", profile.candidate.linkedin_url, "linkedin_url"],
                  ["Website", profile.candidate.website_url, "website_url"],
                ] as const
              )
                .filter(([, value]) => value !== null)
                .map(([label, value, factKey]) => (
                  <FactWithEvidence
                    key={factKey}
                    label={<span className="text-muted-foreground">{label}</span>}
                    detail={<span className="break-all text-foreground">{value}</span>}
                    evidence={evidenceFor(evidence, "identity", factKey)}
                  />
                ))}
            </div>
          </Section>

          {profile.candidate.summary !== null && (
            <section className="mt-10">
              <h2 className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                Summary
              </h2>
              <div className="mt-3">
                <GeneratedText>{profile.candidate.summary}</GeneratedText>
              </div>
            </section>
          )}

          <Section title="Skills" count={profile.skills.length}>
            <div className="rounded-xl border border-border bg-surface px-4 shadow-sm sm:px-5">
              {profile.skills.map((entry) => (
                <FactWithEvidence
                  key={entry.skill}
                  label={entry.original ?? entry.skill}
                  evidence={evidenceFor(evidence, "skill", entry.original ?? entry.skill)}
                />
              ))}
            </div>
          </Section>

          <Section title="Experience" count={profile.experience.length}>
            {/* A timeline, because dates are the thing a recruiter reads here first. The rule on the
                left is one continuous line rather than a card per role. */}
            <ol className="relative border-l border-border pl-6">
              {profile.experience.map((role, index) => (
                <li key={`${role.employer ?? "role"}-${index}`} className="relative pb-7 last:pb-0">
                  <span
                    aria-hidden
                    className="absolute top-1.5 -left-[1.6rem] size-2 rounded-full border-2 border-background bg-border-strong"
                  />
                  <p className="font-medium tracking-tight text-pretty">
                    {role.title ?? "Role not stated"}
                    {role.employer !== null && (
                      <span className="font-normal text-muted-foreground"> · {role.employer}</span>
                    )}
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground tabular-nums">
                    {/* Exactly as the resume wrote them. Never reformatted, never inferred. */}
                    {role.start_date ?? "Start not stated"}
                    {" — "}
                    {role.is_current ? "Present" : (role.end_date ?? "End not stated")}
                  </p>
                  {role.description !== null && <GeneratedText>{role.description}</GeneratedText>}
                  {role.skills.length > 0 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Mentioned: {role.skills.join(", ")}
                    </p>
                  )}
                  <div className="mt-1">
                    <FactWithEvidence
                      label={<span className="text-muted-foreground">Evidence for this role</span>}
                      evidence={evidenceFor(
                        evidence,
                        "experience",
                        role.employer ?? role.title ?? "",
                      )}
                    />
                  </div>
                </li>
              ))}
            </ol>
          </Section>

          <Section title="Education" count={profile.education.length}>
            <div className="rounded-xl border border-border bg-surface px-4 shadow-sm sm:px-5">
              {profile.education.map((entry, index) => (
                <FactWithEvidence
                  key={`${entry.institution ?? "education"}-${index}`}
                  label={
                    <>
                      {entry.degree ?? "Qualification not stated"}
                      {entry.field !== null && (
                        <span className="text-muted-foreground"> · {entry.field}</span>
                      )}
                      {entry.institution !== null && (
                        <span className="block text-xs text-muted-foreground">
                          {entry.institution}
                        </span>
                      )}
                    </>
                  }
                  detail={
                    <span className="font-mono text-xs tabular-nums">
                      {entry.completion ?? entry.end_date ?? ""}
                    </span>
                  }
                  evidence={evidenceFor(
                    evidence,
                    "education",
                    entry.institution ?? entry.degree ?? "",
                  )}
                />
              ))}
            </div>
          </Section>

          {(
            [
              ["Certifications", profile.certifications, "certification"],
              ["Projects", profile.projects, "project"],
              ["Languages", profile.languages, "language"],
              ["Achievements", profile.achievements, "achievement"],
            ] as const
          ).map(([title, entries, factType]) => (
            <Section key={title} title={title} count={entries.length}>
              <div className="rounded-xl border border-border bg-surface px-4 shadow-sm sm:px-5">
                {entries.map((entry) => (
                  <FactWithEvidence
                    key={entry.name}
                    label={entry.name}
                    evidence={evidenceFor(evidence, factType, entry.name)}
                    generated={entry.detail}
                  />
                ))}
              </div>
            </Section>
          ))}

          <p className="mt-10 max-w-prose border-t border-border pt-5 text-xs text-pretty text-muted-foreground">
            Anything the resume did not state is absent here rather than guessed. An absent field is
            not a statement that the candidate lacks it — check the original document before
            concluding anything from a gap.
          </p>
        </>
      )}

      {history.length > 1 && (
        <section className="mt-10">
          <h2 className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            Attempts
          </h2>
          {/* Kept rather than overwritten: "it failed twice and then worked" is information. */}
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface text-sm shadow-sm">
            {history.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2.5 sm:px-5"
              >
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  #{item.attempt}
                </span>
                <span className="min-w-0 flex-1">{PROCESSING_LABELS[item.status]}</span>
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {formatDate(item.created_at)}
                </span>
                {item.is_current && (
                  <span className="font-mono text-[10px] tracking-[0.08em] text-accent uppercase">
                    current
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
