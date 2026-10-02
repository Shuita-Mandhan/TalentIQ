import { NextResponse } from "next/server";
import { PermissionDeniedError, requirePermission } from "@/lib/auth/authorization";
import { requireOrganizationActionAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { getJobResume } from "@/lib/resumes/resumes";
import { RESUME_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/resumes/types";
import { createClient } from "@/lib/supabase/server";

// Getting a resume back out.
//
// The bucket is private, so there is no URL to put in a page and none is ever stored. This mints one
// link, for one object, valid for a minute, for somebody who has just been authorized — and then
// redirects to it. A plain link in the list is enough to reach it, which means it works without
// JavaScript and is reachable from the keyboard like any other link.
//
// Authorization is asked twice and neither answer is taken on trust from the other: jobs.view here,
// and the storage policy again when the link is minted, which resolves the owning job out of the
// object's own path. A viewer in another organization fails both.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** No body, no detail. A caller who may not have this learns only that they may not have it. */
function refuse(status: number) {
  return new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ organizationSlug: string; jobId: string; resumeId: string }> },
) {
  const { organizationSlug, jobId, resumeId } = await params;

  let organizationId: string;
  try {
    const { context } = await requireOrganizationActionAccess(organizationSlug);
    requirePermission(context, PERMISSIONS.JOBS_VIEW);
    organizationId = context.organization.id;
  } catch (error) {
    // Deliberately not a redirect to /login: this is fetched as a file, and a sign-in page delivered
    // where a PDF was expected is worse than a refusal.
    return refuse(error instanceof PermissionDeniedError ? 403 : 500);
  }

  if (!UUID_PATTERN.test(jobId) || !UUID_PATTERN.test(resumeId)) return refuse(404);

  // Scoped by organization and job as well as id, so a resume id from elsewhere is simply not here.
  const resume = await getJobResume(organizationId, jobId, resumeId);
  if (!resume) return refuse(404);

  const supabase = await createClient();
  const signed = await supabase.storage
    .from(RESUME_BUCKET)
    .createSignedUrl(resume.storage_path, SIGNED_URL_TTL_SECONDS, {
      // Arrives named as the recruiter's own file rather than as a storage key.
      download: resume.original_filename,
    });
  if (signed.error || !signed.data) return refuse(502);

  return NextResponse.redirect(signed.data.signedUrl, {
    status: 302,
    // The redirect carries a credential in its query string. Nothing may keep it.
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
