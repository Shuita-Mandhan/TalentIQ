"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/ui/action-form";
import { requirePermission } from "@/lib/auth/authorization";
import { requireOrganizationActionAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { accessErrorMessage } from "@/lib/organization/access-errors";
import { RESUME_BUCKET } from "@/lib/resumes/types";
import { createClient } from "@/lib/supabase/server";

// Removing a resume that should not have been uploaded.
//
// Uploading is a Route Handler because it carries a file. Removing is an ordinary Server Action
// because it carries two ids, and it authorizes itself exactly as every other mutation in this
// application does: authenticate, resolve the organization from the slug, require jobs.manage, and
// then write through policies that require it again.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Takes a resume out of a job: the record and the file, in that order.
 *
 * The record goes first because the record is where authorization is actually decided. RLS filters
 * the delete to nothing for someone holding only jobs.view, and the archived guard raises for a job
 * that has been frozen — so a refusal is unambiguous and leaves both the record and the file exactly
 * as they were. Deleting the file first would make a refusal ambiguous, because a storage delete that
 * the policy filtered and one that found nothing look alike.
 *
 * Only once the record is gone is the file removed, which is the order that cannot leave a record
 * pointing at a file that no longer exists.
 */
export async function removeResume(
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

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("job_resumes")
    .delete()
    .eq("id", resumeId)
    .eq("organization_id", context.organization.id)
    .eq("job_id", jobId)
    .select("storage_path");
  if (error) return { error: accessErrorMessage(error) };
  if (data.length === 0) return { error: "This resume is no longer available." };

  const removed = await supabase.storage
    .from(RESUME_BUCKET)
    .remove(data.map((row) => row.storage_path as string));

  revalidatePath(`/app/${slug}/jobs/${jobId}`);
  revalidatePath(`/app/${slug}/jobs/${jobId}/resumes`);

  if (removed.error) {
    // The resume is off the job, which is what was asked and what the recruiter will see. The file
    // itself outlived the request, and saying so is the only honest thing to do: there is no record
    // left to retry from, so somebody has to be told rather than left to assume it is gone.
    return {
      done: true,
      message: "Removed from this job. The stored file could not be deleted — tell an administrator.",
    };
  }
  return { done: true, message: "Removed." };
}
