import { NextResponse } from "next/server";
import { PermissionDeniedError, requirePermission } from "@/lib/auth/authorization";
import { requireOrganizationActionAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { getJob } from "@/lib/jobs/jobs";
import { checksumHex, inspectResumeBytes } from "@/lib/resumes/inspect";
import {
  DUPLICATE_MESSAGE,
  FAILURES,
  MAX_RESUME_BYTES,
  REJECTIONS,
  RESUME_BUCKET,
  RESUME_CONTENT_TYPES,
  checkResumeFile,
  displayFilename,
  isAccepted,
  resumeStoragePath,
  safeStorageFilename,
  type IntakeOutcome,
  type JobResume,
} from "@/lib/resumes/types";
import { createClient } from "@/lib/supabase/server";

// One resume per request. A batch is a hundred of these, four at a time, from the browser — which is
// what gives honest per-file progress and lets a batch of a hundred tolerate two failures without
// the other ninety-eight being undone.
//
// A Route Handler rather than a Server Action because this carries a file body: the bytes arrive
// here, are inspected here, and reach storage only once they have passed. Nothing invalid is ever
// stored, so there is no quarantine to clean up and no window in which a rejected file exists.
//
// This is an independent entrypoint and trusts nothing about the page that called it. It
// authenticates, resolves the organization from the slug, requires jobs.manage, re-reads the job in
// that organization and refuses an archived one — and then writes through storage policies and RLS
// policies that require all of it again.
//
// No AI provider is reachable from this file, directly or transitively. A resume's contents are
// read for exactly two purposes: the format signature and the SHA-256. Nothing is logged.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Headroom for the multipart boundaries and field names wrapped around one file. */
const MULTIPART_ALLOWANCE = 64 * 1024;

const RESUME_COLUMNS =
  "id, organization_id, job_id, batch_id, storage_path, original_filename, content_type, size_bytes, checksum, uploaded_by, created_at";

/** The body is always one of the four outcomes; the status code is for well-behaved clients. */
function answer(outcome: IntakeOutcome, status: number) {
  return NextResponse.json(outcome, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ organizationSlug: string; jobId: string }> },
) {
  const { organizationSlug, jobId } = await params;

  let organizationId: string;
  let userId: string;
  try {
    const { user, context } = await requireOrganizationActionAccess(organizationSlug);
    requirePermission(context, PERMISSIONS.JOBS_MANAGE);
    organizationId = context.organization.id;
    userId = user.userId;
  } catch (error) {
    // A denial is a denial whether the caller is signed out, not a member, or merely a viewer: all
    // three get the same sentence, so none of them learns anything about the others.
    if (error instanceof PermissionDeniedError) {
      return answer({ status: "failed", message: FAILURES.permission }, 403);
    }
    return answer({ status: "failed", message: FAILURES.generic }, 500);
  }

  if (!UUID_PATTERN.test(jobId)) {
    return answer({ status: "failed", message: FAILURES.missing }, 404);
  }
  // Re-read in the resolved organization. A job id from another tenant matches nothing here, so
  // "not ours" and "not a job" are the same answer.
  const job = await getJob(organizationId, jobId);
  if (!job) return answer({ status: "failed", message: FAILURES.missing }, 404);
  if (job.status === "archived") {
    return answer({ status: "failed", message: FAILURES.archived }, 409);
  }

  // Checked before the body is parsed, because parsing buffers it. Without this a request claiming
  // to be a resume could hand the server a gigabyte before anything had a chance to object. The
  // allowance is for the multipart envelope around the file, not for a larger file.
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESUME_BYTES + MULTIPART_ALLOWANCE) {
    return answer({ status: "rejected", message: REJECTIONS.tooLarge }, 413);
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return answer({ status: "failed", message: FAILURES.generic }, 400);
  }
  const batchField = form?.get("batchId");
  const batchId =
    typeof batchField === "string" && UUID_PATTERN.test(batchField) ? batchField : null;

  // Refused on the declared size before a byte is read, so an oversized file costs no memory.
  if (file.size > MAX_RESUME_BYTES) {
    return answer({ status: "rejected", message: REJECTIONS.tooLarge }, 422);
  }
  const claim = checkResumeFile({ name: file.name, size: file.size, type: file.type });
  if (!isAccepted(claim)) return answer({ status: "rejected", message: claim.rejection }, 422);

  const bytes = new Uint8Array(await file.arrayBuffer());
  // The declared size was a claim too. This is the real one, and it is what gets stored.
  if (bytes.length === 0) return answer({ status: "rejected", message: REJECTIONS.empty }, 422);
  if (bytes.length > MAX_RESUME_BYTES) {
    return answer({ status: "rejected", message: REJECTIONS.tooLarge }, 422);
  }

  const inspection = inspectResumeBytes(bytes, claim.format);
  if (!isAccepted(inspection)) {
    return answer({ status: "rejected", message: inspection.rejection }, 422);
  }
  const contentType = RESUME_CONTENT_TYPES[inspection.format];
  const checksum = await checksumHex(bytes);

  const supabase = await createClient();

  // Asked before storing, so the common duplicate costs no upload. It is not the rule, though — the
  // unique constraint is, and it settles the race two recruiters dropping the same file can create.
  const existing = await supabase
    .from("job_resumes")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("job_id", job.id)
    .eq("checksum", checksum)
    .maybeSingle();
  if (existing.data) return answer({ status: "duplicate", message: DUPLICATE_MESSAGE }, 409);

  const intakeId = crypto.randomUUID();
  const storagePath = resumeStoragePath({
    organizationId,
    jobId: job.id,
    intakeId,
    filename: safeStorageFilename(file.name, inspection.format),
  });

  const upload = await supabase.storage.from(RESUME_BUCKET).upload(storagePath, bytes, {
    contentType,
    // Never overwrite. The path carries a fresh id so a collision should be impossible; if one ever
    // happened, failing is correct and silently replacing an applicant's resume would not be.
    upsert: false,
  });
  if (upload.error) return answer({ status: "failed", message: FAILURES.generic }, 502);

  const insert = await supabase
    .from("job_resumes")
    .insert({
      organization_id: organizationId,
      job_id: job.id,
      batch_id: batchId,
      storage_path: storagePath,
      // Shown to recruiters and stored as provenance. It names a file, never a candidate.
      original_filename: displayFilename(file.name, inspection.format),
      content_type: contentType,
      size_bytes: bytes.length,
      checksum,
      uploaded_by: userId,
    })
    .select(RESUME_COLUMNS)
    .single();

  if (insert.error) {
    // The bytes are already stored but nothing refers to them, so they come back out. An orphaned
    // file is worse than no file: it is an applicant's resume that no screen can show and no
    // deletion can reach.
    await supabase.storage.from(RESUME_BUCKET).remove([storagePath]);
    if (insert.error.code === "23505") {
      return answer({ status: "duplicate", message: DUPLICATE_MESSAGE }, 409);
    }
    if (insert.error.code === "TQ010") {
      return answer({ status: "failed", message: FAILURES.archived }, 409);
    }
    if (insert.error.code === "42501") {
      return answer({ status: "failed", message: FAILURES.permission }, 403);
    }
    return answer({ status: "failed", message: FAILURES.generic }, 500);
  }

  return answer({ status: "uploaded", resume: insert.data as JobResume }, 201);
}
