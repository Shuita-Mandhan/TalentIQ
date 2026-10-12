"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/ui/action-form";
import { isTimeoutFailure } from "@/lib/ai/chat";
import { resolveTimeoutMs, staleAfterMs } from "@/lib/ai/extraction";
import { getAiProvider } from "@/lib/ai/provider";
import { requirePermission } from "@/lib/auth/authorization";
import { requireOrganizationActionAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { extractDocument, isExtracted, parserFor } from "@/lib/documents/extract";
import { PARSER_VERSION, hasUsefulText } from "@/lib/documents/text";
import { accessErrorMessage } from "@/lib/organization/access-errors";
import { PROCESSING_ERRORS, type ProcessingErrorCode } from "@/lib/resumes/processing-types";
import {
  PROFILE_SCHEMA_VERSION,
  PROFILE_SYSTEM_PROMPT,
  buildProfileRequest,
  parseCandidateProfile,
} from "@/lib/resumes/profile";
import { getJobResume } from "@/lib/resumes/resumes";
import { RESUME_BUCKET } from "@/lib/resumes/types";
import { createClient } from "@/lib/supabase/server";

// Reading a resume into a candidate profile.
//
// Deliberately a separate module from ./actions, which handles intake. Intake must reach no AI
// provider at all - a file arriving is not a file being read, and the Phase 7 suite asserts that
// separation by inspecting that file's imports. Keeping the two apart means the assertion stays true
// rather than being relaxed to accommodate this.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The version key for "this document, read this way, by this schema".
 *
 * Deterministic, so two runs of the same code produce the same key and a change to either the
 * extractor or the profile shape produces a different one. That is how a result written months ago is
 * later recognised as stale rather than silently trusted.
 *
 * NOT exported. This is a "use server" module, and Next.js requires every export of one to be an
 * async function because each export becomes a callable server endpoint. Exporting this string made
 * the whole module fail to load at runtime with `A "use server" file can only export async
 * functions, found string` - which took the processResume action down with it. It is used only here,
 * so it is module-local. If another module ever needs it, it belongs in a plain module, not this one.
 */
const PROCESSING_VERSION = `${PARSER_VERSION}|${PROFILE_SCHEMA_VERSION}`;

/**
 * Reads one resume into a candidate profile.
 *
 *   stored bytes -> document extractor -> normalized text -> AI provider -> strict parser -> database
 *
 * Every stage can fail on its own terms, and every failure is recorded against the attempt with a
 * code from a fixed list, so a recruiter sees a sentence and the attempt stays inspectable. Nothing a
 * provider said reaches the browser, and nothing out of the resume reaches a log.
 *
 * Triggered explicitly. Nothing here runs while a page renders, and an attempt that is genuinely in
 * flight makes a second one raise TQ013 rather than start a duplicate, so a refresh is harmless.
 */
export async function processResume(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = text(formData, "organizationSlug");
  const { context } = await requireOrganizationActionAccess(slug);
  requirePermission(context, PERMISSIONS.JOBS_MANAGE);

  const jobId = text(formData, "jobId");
  const resumeId = text(formData, "resumeId");
  if (!UUID_PATTERN.test(jobId) || !UUID_PATTERN.test(resumeId)) {
    return { error: "Invalid request." };
  }

  const organizationId = context.organization.id;
  const supabase = await createClient();

  // Re-read in the resolved organization, which is also what proves this job holds this resume. An
  // id from another tenant matches nothing, so "not ours" and "not a resume" are one answer.
  const resume = await getJobResume(organizationId, jobId, resumeId);
  if (!resume) return { error: "This resume is no longer available." };

  const parser = parserFor(resume.content_type);
  if (parser === null) return { error: PROCESSING_ERRORS.unsupported };

  // An attempt still marked processing can only be alive for as long as a provider request could be.
  // Derived from the server's own timeout; a browser has no say in it.
  const staleBefore = new Date(
    Date.now() - staleAfterMs(resolveTimeoutMs(process.env.AI_TIMEOUT_MS)),
  ).toISOString();

  const started = await supabase.rpc("start_resume_processing", {
    target_organization_id: organizationId,
    target_job_id: jobId,
    target_resume_id: resumeId,
    parser_name: parser,
    parser_version: PARSER_VERSION,
    processing_version: PROCESSING_VERSION,
    stale_before: staleBefore,
  });
  if (started.error) {
    return {
      error: accessErrorMessage(started.error, { notFound: "This resume is no longer available." }),
    };
  }
  const processingId = started.data as string;

  /** Records why an attempt stopped, and returns what to show. Never a provider's wording. */
  const settle = async (
    code: ProcessingErrorCode,
    resumeText: string | null = null,
    pages: number | null = null,
    providerName: string | null = null,
    modelName: string | null = null,
  ): Promise<ActionState> => {
    const failed = await supabase.rpc("fail_resume_processing", {
      target_organization_id: organizationId,
      target_processing_id: processingId,
      failure_code: code,
      failure_message: PROCESSING_ERRORS[code],
      resume_text: resumeText,
      pages,
      provider_name: providerName,
      model_name: modelName,
    });
    revalidatePath(`/app/${slug}/jobs/${jobId}/resumes`);
    if (failed.error) return { error: PROCESSING_ERRORS.database };
    // A document with no readable text has not failed - it needs a person, possibly with a scanner -
    // so it is reported as an outcome rather than as an error.
    return code === "no_text"
      ? { done: true, message: PROCESSING_ERRORS.no_text }
      : { error: PROCESSING_ERRORS[code] };
  };

  // The bytes, through the same authorized path the download route uses. They are read on the server
  // and never sent to the browser.
  const download = await supabase.storage.from(RESUME_BUCKET).download(resume.storage_path);
  if (download.error || !download.data) return settle("extract_failed");
  const bytes = new Uint8Array(await download.data.arrayBuffer());

  const extraction = await extractDocument(bytes, resume.content_type);
  if (!isExtracted(extraction)) return settle(extraction.failure);
  const document = extraction.document;

  // A scan extracts to a handful of stray characters. Pretending that succeeded, and asking a model
  // to invent a profile out of nothing, is exactly what must not happen.
  if (!hasUsefulText(document)) {
    return settle("no_text", document.text, document.pageCount);
  }

  let provider;
  try {
    provider = getAiProvider();
  } catch {
    return settle("ai_unavailable", document.text, document.pageCount);
  }

  let raw: unknown;
  try {
    raw = await provider.completeJson({
      system: PROFILE_SYSTEM_PROMPT,
      user: buildProfileRequest(document.text),
    });
  } catch (cause) {
    const code: ProcessingErrorCode = isTimeoutFailure(cause) ? "ai_timeout" : "ai_unavailable";
    return settle(code, document.text, document.pageCount, provider.name, provider.model);
  }

  // The trust boundary. Everything the model produced is checked against the document before any of
  // it is stored, and anything it could not ground there is dropped.
  const parsed = parseCandidateProfile(
    raw,
    document.text,
    document.pages,
    document.headings,
  );
  if ("error" in parsed) {
    return settle("ai_malformed", document.text, document.pageCount, provider.name, provider.model);
  }

  // One call, because resolving the person, attaching the application, recording the evidence and
  // settling the attempt have to happen together or not at all.
  const completed = await supabase.rpc("complete_resume_processing", {
    target_organization_id: organizationId,
    target_processing_id: processingId,
    resume_text: document.text,
    pages: document.pageCount,
    provider_name: provider.name,
    model_name: provider.model,
    profile: parsed.profile,
    evidence: parsed.evidence,
    identity_name: parsed.identity.name,
    identity_email: parsed.identity.email,
    identity_phone: parsed.identity.phone,
  });
  if (completed.error) {
    return settle("database", document.text, document.pageCount, provider.name, provider.model);
  }

  revalidatePath(`/app/${slug}/jobs/${jobId}`);
  revalidatePath(`/app/${slug}/jobs/${jobId}/resumes`);
  revalidatePath(`/app/${slug}/jobs/${jobId}/resumes/${resumeId}`);
  return { done: true, message: "Profile ready." };
}
