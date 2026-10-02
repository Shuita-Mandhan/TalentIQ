// The vocabulary of a processing attempt: its states, its reasons, and the row shape.
//
// Pure, and imported by both the server reads and the client controls. `CandidateProfile` arrives as
// a type-only import on purpose, so none of the prompt text in ./profile is pulled into a browser
// bundle by a component that only wanted a label.

import { MAX_PDF_PAGES } from "../documents/text.ts";
import type { CandidateProfile } from "./profile.ts";
import type { ResumeFormat } from "./types.ts";

export const PROCESSING_STATUSES = [
  "waiting",
  "processing",
  "succeeded",
  "needs_review",
  "failed",
] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

/**
 * What a recruiter is shown, and nothing a recruiter would have to decode.
 *
 * "succeeded" is deliberately not called "Succeeded": what matters to the person reading the list is
 * not that a parser exited cleanly but that there is now a profile worth their attention.
 */
export const PROCESSING_LABELS: Record<ProcessingStatus, string> = {
  waiting: "Waiting",
  processing: "Processing",
  succeeded: "Ready for review",
  needs_review: "Needs review",
  failed: "Failed",
};

export const PROCESSING_ERROR_CODES = [
  "no_text",
  "extract_failed",
  "unsupported",
  "too_large",
  "extract_timeout",
  "ai_unavailable",
  "ai_timeout",
  "ai_malformed",
  "identity_conflict",
  "identity_unresolved",
  "database",
] as const;
export type ProcessingErrorCode = (typeof PROCESSING_ERROR_CODES)[number];

/**
 * One sentence per reason, in the recruiter's terms.
 *
 * The database also stores a sentence alongside the code, so a row read directly makes sense on its
 * own; where both exist the interface prefers this map, because it is the copy that gets revised when
 * the wording turns out to be unclear. No provider wording, exception text or stack trace reaches
 * either of them.
 */
export const PROCESSING_ERRORS: Record<ProcessingErrorCode, string> = {
  no_text:
    "No text could be read from this document. It is most likely a scan or a photograph, which this version cannot read.",
  extract_failed: "This document could not be read. It may be damaged or password protected.",
  unsupported: "Only PDF and DOCX resumes can be processed.",
  // A page count or a decompressed size beyond what a resume plausibly is. Distinct from "damaged"
  // on purpose: telling someone their file is corrupt when it is merely enormous sends them looking
  // for the wrong problem.
  too_large: `This document is too large to process. Resumes of up to ${MAX_PDF_PAGES} pages can be read, and this one is beyond that.`,
  extract_timeout: "This document took too long to read and was stopped. Try a simpler PDF export.",
  ai_unavailable: "AI processing is currently unavailable. Try again.",
  ai_timeout: "Processing took too long and was stopped. Try again.",
  ai_malformed: "A profile could not be read from this resume. Try again.",
  identity_conflict:
    "The contact details in this resume disagree with an existing candidate. Confirm who this is.",
  identity_unresolved:
    "This resume gave no email or phone number, so it could not be matched to a candidate.",
  database: "The result could not be saved. Try again.",
};

export function isProcessingErrorCode(value: unknown): value is ProcessingErrorCode {
  return typeof value === "string" && (PROCESSING_ERROR_CODES as readonly string[]).includes(value);
}

/** The sentence to show for an attempt, or null when there is nothing to explain. */
export function processingReason(attempt: {
  error_code: string | null;
  error: string | null;
}): string | null {
  if (isProcessingErrorCode(attempt.error_code)) return PROCESSING_ERRORS[attempt.error_code];
  return attempt.error;
}

export type ResumeProcessing = {
  id: string;
  organization_id: string;
  job_id: string;
  resume_id: string;
  attempt: number;
  is_current: boolean;
  status: ProcessingStatus;
  parser: ResumeFormat;
  parser_version: string;
  processing_version: string;
  provider: string | null;
  model: string | null;
  page_count: number | null;
  structured_profile: CandidateProfile | null;
  error_code: string | null;
  error: string | null;
  application_id: string | null;
  created_at: string;
  completed_at: string | null;
};

export type CandidateRecord = {
  id: string;
  organization_id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  headline: string | null;
  summary: string | null;
  linkedin_url: string | null;
  website_url: string | null;
  identity_state: "resolved" | "unresolved" | "conflicted";
  created_at: string;
};

export const IDENTITY_LABELS: Record<CandidateRecord["identity_state"], string> = {
  resolved: "Identified",
  unresolved: "Unidentified",
  conflicted: "Conflicting details",
};

/**
 * How many resumes are processed at once when a batch is started.
 *
 * Two, not the four Phase 7 uses for uploads. An upload is bounded by the network; this is bounded by
 * a model, and on a local provider a third concurrent request makes all three slower rather than
 * finishing any of them sooner.
 */
export const PROCESSING_CONCURRENCY = 2;

/** Whether an attempt in this state may be started again. A success may not. */
export function canRetry(status: ProcessingStatus | null): boolean {
  return status === "failed" || status === "needs_review";
}

/** Whether a resume has never been through processing. */
export function isUnprocessed(attempt: ResumeProcessing | null | undefined): boolean {
  return attempt === null || attempt === undefined;
}

/** Whether an attempt produced something worth opening. */
export function hasProfile(attempt: ResumeProcessing | null | undefined): boolean {
  return (
    attempt !== null &&
    attempt !== undefined &&
    attempt.structured_profile !== null &&
    (attempt.status === "succeeded" || attempt.status === "needs_review")
  );
}
