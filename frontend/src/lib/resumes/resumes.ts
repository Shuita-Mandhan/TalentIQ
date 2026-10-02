import { createClient } from "@/lib/supabase/server";
import type { JobResume } from "./types";

// Reads for resume intake. Every one runs as the signed-in user under RLS, which returns nothing
// without jobs.view and nothing belonging to another organization — so the organization filter here
// is a narrowing, not the boundary. The boundary is the policy.
//
// Nothing here reads a resume's contents. A JobResume is metadata about a file and that is all it
// will be until a later phase gives it more.

const RESUME_COLUMNS =
  "id, organization_id, job_id, batch_id, storage_path, original_filename, content_type, size_bytes, checksum, uploaded_by, created_at";

export async function getJobResumes(organizationId: string, jobId: string): Promise<JobResume[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("job_resumes")
    .select(RESUME_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("job_id", jobId)
    .order("created_at", { ascending: false });
  if (error) throw new Error("Unable to load the resumes for this job");
  return data as JobResume[];
}

export async function getJobResume(
  organizationId: string,
  jobId: string,
  resumeId: string,
): Promise<JobResume | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("job_resumes")
    .select(RESUME_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("job_id", jobId)
    .eq("id", resumeId)
    .maybeSingle();
  if (error) throw new Error("Unable to load the resume");
  return data as JobResume | null;
}

/** How many resumes a job holds, for the job page's summary. A count, not the rows. */
export async function countJobResumes(organizationId: string, jobId: string): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("job_resumes")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("job_id", jobId);
  if (error) throw new Error("Unable to count the resumes for this job");
  return count ?? 0;
}

/**
 * Display names for the people who uploaded these resumes.
 *
 * Read from profiles rather than through the member administration RPC on purpose: that RPC needs
 * members.view, and a recruiter who may bring resumes in has no reason to also administer the
 * organization's membership. The profiles policy already lets colleagues see each other's names.
 *
 * A profile with no name is left out, and the caller decides what to show instead — never the raw
 * user id, which identifies an account without naming a person.
 */
export async function getUploaderNames(userIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name")
    .in("id", unique);
  // A missing name is cosmetic; it must not take the page down with it.
  if (error) return new Map();

  return new Map(
    (data as { id: string; full_name: string | null }[])
      .filter((row): row is { id: string; full_name: string } => row.full_name !== null)
      .map((row) => [row.id, row.full_name]),
  );
}
