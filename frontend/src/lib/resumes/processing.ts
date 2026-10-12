import { resolveTimeoutMs, staleAfterMs } from "@/lib/ai/extraction";
import { createClient } from "@/lib/supabase/server";
import type { EvidenceRecord } from "./profile";
import { isStalledAttempt, type CandidateRecord, type ResumeProcessing } from "./processing-types";

// Reads for resume processing. Every one runs as the signed-in user under RLS, which returns nothing
// without jobs.view and nothing belonging to another organization — so the organization filter here
// is a narrowing, not the boundary. The boundary is the policy.

/**
 * The moment before which an in-flight attempt can no longer be alive.
 *
 * Exactly the expression the processing action passes to start_resume_processing as `stale_before`,
 * so an attempt the interface offers to retry is one the database is willing to supersede.
 */
function staleBefore(): number {
  return Date.now() - staleAfterMs(resolveTimeoutMs(process.env.AI_TIMEOUT_MS));
}

/** Decided by the read, not stored: the row is settled the next time an attempt starts. */
function withStalled(row: Omit<ResumeProcessing, "stalled">, cutoff: number): ResumeProcessing {
  return { ...row, stalled: isStalledAttempt(row, cutoff) };
}

const PROCESSING_COLUMNS =
  "id, organization_id, job_id, resume_id, attempt, is_current, status, parser, parser_version, processing_version, provider, model, page_count, structured_profile, error_code, error, application_id, created_at, completed_at";

const CANDIDATE_COLUMNS =
  "id, organization_id, full_name, email, phone, location, headline, summary, linkedin_url, website_url, identity_state, created_at";

const EVIDENCE_COLUMNS =
  "fact_type, fact_key, fact_value, evidence_status, confidence, source_page, source_section, source_quote, quote_verified";

/**
 * The current attempt for every resume on a job, keyed by resume id.
 *
 * One query for the whole list rather than one per row: a job with sixty resumes should not cost
 * sixty round trips to render a status column.
 */
export async function getCurrentProcessings(
  organizationId: string,
  jobId: string,
): Promise<Map<string, ResumeProcessing>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("resume_processings")
    .select(PROCESSING_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("job_id", jobId)
    .eq("is_current", true);
  if (error) throw new Error("Unable to load resume processing status");
  const cutoff = staleBefore();
  return new Map(
    (data as Omit<ResumeProcessing, "stalled">[]).map((row) => [
      row.resume_id,
      withStalled(row, cutoff),
    ]),
  );
}

/** The current attempt for one resume, or null when it has never been processed. */
export async function getCurrentProcessing(
  organizationId: string,
  jobId: string,
  resumeId: string,
): Promise<ResumeProcessing | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("resume_processings")
    .select(PROCESSING_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("job_id", jobId)
    .eq("resume_id", resumeId)
    .eq("is_current", true)
    .maybeSingle();
  if (error) throw new Error("Unable to load resume processing status");
  if (!data) return null;
  return withStalled(data as Omit<ResumeProcessing, "stalled">, staleBefore());
}

/**
 * Every attempt made on one resume, newest first.
 *
 * A failure stays readable after the retry that followed it, which is the point of keeping attempts
 * rather than overwriting one row: "it failed, then it worked" is information, and so is "it has
 * failed the same way three times".
 */
export async function getProcessingHistory(
  organizationId: string,
  resumeId: string,
): Promise<ResumeProcessing[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("resume_processings")
    .select(PROCESSING_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("resume_id", resumeId)
    .order("attempt", { ascending: false });
  if (error) throw new Error("Unable to load the processing history");
  const cutoff = staleBefore();
  return (data as Omit<ResumeProcessing, "stalled">[]).map((row) => withStalled(row, cutoff));
}

export async function getEvidence(
  organizationId: string,
  processingId: string,
): Promise<EvidenceRecord[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("candidate_evidence")
    .select(EVIDENCE_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("processing_id", processingId)
    .order("fact_type")
    .order("fact_key");
  if (error) throw new Error("Unable to load the evidence for this profile");
  return data as EvidenceRecord[];
}

/** The person an attempt resolved to, reached through the application rather than trusted from a URL. */
export async function getCandidateForApplication(
  organizationId: string,
  applicationId: string,
): Promise<CandidateRecord | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("job_applications")
    .select(`candidate_id, candidates!inner(${CANDIDATE_COLUMNS})`)
    .eq("organization_id", organizationId)
    .eq("id", applicationId)
    .maybeSingle();
  if (error) throw new Error("Unable to load the candidate");
  if (!data) return null;
  // candidate_id is a many-to-one FK so PostgREST embeds one object; without generated database
  // types supabase-js cannot know the cardinality and types it as an array.
  const row = data as unknown as { candidates: CandidateRecord };
  return row.candidates ?? null;
}

/**
 * How many other jobs in this organization this candidate has applied to.
 *
 * The number a recruiter wants when a profile says "Identified": one person, several applications, no
 * duplicate records. Counts applications other than the one being looked at.
 */
export async function countOtherApplications(
  organizationId: string,
  candidateId: string,
  excludeApplicationId: string,
): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("job_applications")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("candidate_id", candidateId)
    .neq("id", excludeApplicationId);
  if (error) return 0;
  return count ?? 0;
}
