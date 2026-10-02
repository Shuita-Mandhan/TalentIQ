// Resume intake: the vocabulary, the limits and the pure decisions.
//
// This module is imported by the uploader in the browser, by the route handler on the server and by
// the tests, so it carries no server imports and reaches for nothing but language built-ins. The
// server-side authority over a file's contents lives in ./inspect, and the reads live in ./resumes.
//
// What is deliberately absent: anything that looks inside a resume. A filename is a label, never a
// candidate. Nothing here parses, extracts, scores, matches or ranks, and nothing here may begin to.

/**
 * The application's file size ceiling, and the number a developer edits.
 *
 * The same value is written twice more, on purpose, so the limit is enforced at every boundary
 * rather than only the friendly one: `file_size_limit` on the storage bucket and the `size_bytes`
 * check constraint on public.job_resumes, both in the Phase 7 migration. Moving this means moving
 * those; the migration says so too.
 */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/** How many resumes one batch may carry. A recruiter's intake, not an import pipeline. */
export const MAX_BATCH_FILES = 100;

/**
 * How many uploads are in flight at once.
 *
 * A hundred simultaneous requests is not progress, it is a queue the browser hides from you: the
 * connection limit serialises them anyway, every one competes for bandwidth, and a failure part way
 * through leaves nothing legible on screen. Four keeps the link busy and keeps the queue honest.
 */
export const UPLOAD_CONCURRENCY = 4;

/** The private Supabase Storage bucket the Phase 7 migration creates. Never public. */
export const RESUME_BUCKET = "resumes";

/**
 * How long a download link lives.
 *
 * Long enough for a browser to follow the redirect, short enough that a link copied out of a history
 * or a log is already dead. No URL is ever stored: one is minted per request, for one object, for
 * someone who has just been authorized.
 */
export const SIGNED_URL_TTL_SECONDS = 60;

export const RESUME_CONTENT_TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

export type ResumeFormat = keyof typeof RESUME_CONTENT_TYPES;
export type ResumeContentType = (typeof RESUME_CONTENT_TYPES)[ResumeFormat];

export const RESUME_FORMATS = Object.keys(RESUME_CONTENT_TYPES) as ResumeFormat[];

export const FORMAT_LABELS: Record<ResumeFormat, string> = { pdf: "PDF", docx: "DOCX" };

/** What a file input should offer. Extensions as well as types, because some systems report neither. */
export const RESUME_ACCEPT = ".pdf,.docx,application/pdf," + RESUME_CONTENT_TYPES.docx;

const CONTENT_TYPE_FORMATS = new Map<string, ResumeFormat>(
  RESUME_FORMATS.map((format) => [RESUME_CONTENT_TYPES[format], format]),
);

export function formatOfContentType(contentType: string): ResumeFormat | null {
  return CONTENT_TYPE_FORMATS.get(contentType) ?? null;
}

/** One received resume. The whole of what the system knows about it in this phase. */
export type JobResume = {
  id: string;
  organization_id: string;
  job_id: string;
  batch_id: string | null;
  storage_path: string;
  original_filename: string;
  content_type: ResumeContentType;
  size_bytes: number;
  checksum: string;
  uploaded_by: string | null;
  created_at: string;
};

/**
 * The state of one file in an intake queue.
 *
 * Only "uploaded" is ever written down: an intake row exists precisely when the bytes are stored,
 * so every other state here lives for as long as the page does and no longer. There is deliberately
 * no "parsing", "extracting", "matching" or "scoring" — those processes do not exist yet, and
 * showing a recruiter a state the system cannot be in would be a lie about what was happening.
 */
export type IntakeState = "waiting" | "uploading" | "uploaded" | "duplicate" | "failed" | "rejected";

export const STATE_LABELS: Record<IntakeState, string> = {
  waiting: "Waiting",
  uploading: "Uploading",
  uploaded: "Uploaded",
  duplicate: "Duplicate",
  failed: "Failed",
  rejected: "Rejected",
};

/** Every message a recruiter may be shown about a file this application refused. */
export const REJECTIONS = {
  unsupported: "Only PDF and DOCX resumes are supported.",
  mismatched: "This file's contents do not match the format its name claims.",
  empty: "This file is empty.",
  tooLarge: `This file is larger than ${MAX_RESUME_BYTES / (1024 * 1024)} MB.`,
} as const;

/** Every message about an attempt that failed rather than a file that was refused. */
export const FAILURES = {
  permission: "Your account does not have permission to upload resumes.",
  archived: "This job is archived and cannot accept new resumes.",
  missing: "This job is no longer available.",
  generic: "The upload failed. Try again.",
} as const;

export const DUPLICATE_MESSAGE = "This resume was already uploaded to this job.";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Accepted, or the one sentence explaining why not. */
export type FileCheck = { format: ResumeFormat } | { rejection: string };

export function isAccepted(check: FileCheck): check is { format: ResumeFormat } {
  return "format" in check;
}

function extensionOf(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * A first pass over what the browser says about a file, before a byte is sent.
 *
 * This is a courtesy, not a boundary: it exists so a recruiter who picked the wrong file learns
 * instantly instead of after a round trip. The decision that counts is inspectResumeBytes() on the
 * server, which reads the actual contents and can therefore disagree with everything here.
 *
 * The declared type is used only to catch a file that admits to being something else — a PNG named
 * .pdf. An absent or generic type is not suspicious: plenty of systems report nothing for a DOCX.
 */
export function checkResumeFile(file: { name: string; size: number; type: string }): FileCheck {
  const extension = extensionOf(file.name);
  const format = (RESUME_FORMATS as string[]).includes(extension)
    ? (extension as ResumeFormat)
    : null;
  if (format === null) return { rejection: REJECTIONS.unsupported };

  const declared = file.type.trim().toLowerCase();
  const generic = declared.length === 0 || declared === "application/octet-stream";
  if (!generic && formatOfContentType(declared) === null) {
    return { rejection: REJECTIONS.unsupported };
  }

  if (file.size <= 0) return { rejection: REJECTIONS.empty };
  if (file.size > MAX_RESUME_BYTES) return { rejection: REJECTIONS.tooLarge };
  return { format };
}

/**
 * Whether a selection can be taken as one batch, or the sentence explaining why not.
 *
 * An over-sized selection is refused whole rather than silently truncated to the first hundred: a
 * recruiter who dropped 137 files and saw "100 uploaded" would have no way to know 37 applicants
 * were never considered.
 */
export function checkBatchSize(count: number): string | null {
  if (count === 0) return "Select at least one resume.";
  if (count > MAX_BATCH_FILES) {
    return `Select up to ${MAX_BATCH_FILES} resumes at a time. You selected ${count}.`;
  }
  return null;
}

export type BatchProgress = {
  total: number;
  /** Files that have reached a final state, whatever that state is. */
  settled: number;
  uploaded: number;
  duplicates: number;
  failed: number;
  rejected: number;
  /** Whole percent of the batch settled, for the bar's width. */
  percent: number;
  done: boolean;
};

/** Counts, derived from the states themselves so the bar can never claim progress nothing made. */
export function summariseBatch(states: IntakeState[]): BatchProgress {
  const count = (state: IntakeState) => states.filter((value) => value === state).length;
  const uploaded = count("uploaded");
  const duplicates = count("duplicate");
  const failed = count("failed");
  const rejected = count("rejected");
  const settled = uploaded + duplicates + failed + rejected;
  return {
    total: states.length,
    settled,
    uploaded,
    duplicates,
    failed,
    rejected,
    percent: states.length === 0 ? 0 : Math.round((settled / states.length) * 100),
    done: settled === states.length,
  };
}

/**
 * Runs `work` over every item with at most `limit` in flight, and settles every one.
 *
 * A hundred files are a hundred independent requests, so this never rejects: `work` is expected to
 * resolve with an outcome rather than throw, and a batch therefore cannot be cancelled by one file
 * going wrong. That is the whole point - ninety-eight successful uploads must survive two failures.
 *
 * Results come back in the order the items were given, not the order they finished.
 */
export async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await work(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * The files a retry should send again: the ones that failed, and nothing else.
 *
 * An uploaded file must never be sent twice — the batch's successes are not undone because other
 * files in it did not make it. A duplicate is an answer, not a failure, and a rejected file would
 * be rejected identically. Resending either would at best waste a round trip and at worst invite a
 * second record for a resume that already has one.
 */
export function retryable<T extends { state: IntakeState }>(items: readonly T[]): T[] {
  return items.filter((item) => item.state === "failed");
}

/**
 * A filename safe to put in a storage key.
 *
 * Path separators, traversal and anything non-portable are gone, and the extension comes from the
 * format the server verified rather than from whatever the name claimed. The result is never empty
 * and never contains a slash, so it cannot widen the path it is placed in.
 */
export function safeStorageFilename(original: string, format: ResumeFormat): string {
  const base = original.replace(/\\/g, "/").split("/").pop() ?? "";
  const stem = base
    .replace(/\.[^.]*$/, "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+/, "")
    .replace(/[-._]+$/, "")
    .slice(0, 100);
  return `${stem.length > 0 ? stem : "resume"}.${format}`;
}

/**
 * The name to show, and to keep as provenance.
 *
 * The basename only, so a path a browser happened to include cannot travel into the record; control
 * characters dropped, so a filename cannot disturb the list it is rendered in; capped by code point
 * rather than by UTF-16 unit, so a long name is never cut through the middle of a character. Falls
 * back to the storage-safe name when nothing usable is left.
 */
export function displayFilename(original: string, format: ResumeFormat): string {
  const base = [...(original.replace(/\\/g, "/").split("/").pop() ?? "")]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
    .join("")
    .trim();
  if (base.length === 0) return safeStorageFilename(original, format);
  return [...base].slice(0, 255).join("");
}

/**
 * Where a resume's bytes go.
 *
 * Organization, then job, so the storage policies can read the owning job out of the path and
 * verify it; then a fresh id per intake, which is what lets two applicants both send "resume.pdf"
 * without either one standing on the other. Every segment is chosen by the server.
 */
export function resumeStoragePath(input: {
  organizationId: string;
  jobId: string;
  intakeId: string;
  filename: string;
}): string {
  return `${input.organizationId}/${input.jobId}/resumes/${input.intakeId}/${input.filename}`;
}

/** The server's answer about one file. The shape the uploader reads back. */
export type IntakeOutcome =
  | { status: "uploaded"; resume: JobResume }
  | { status: "duplicate"; message: string }
  | { status: "rejected"; message: string }
  | { status: "failed"; message: string };
