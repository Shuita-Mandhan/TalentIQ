import { resolveTimeoutMs, staleAfterMs } from "@/lib/ai/extraction";
import { createClient } from "@/lib/supabase/server";
import type {
  Job,
  JobDescriptionAnalysis,
  JobRequirement,
  RequirementSuggestion,
} from "./types";

// Reads for the job domain. Every one runs as the signed-in user under RLS, which returns nothing
// without jobs.view and nothing belonging to another organization - so the organization filter
// here is a narrowing, not the boundary. The boundary is the policy.
//
// The vocabulary and shapes live in ./types, which carries no server imports so the forms can
// share them.

const JOB_COLUMNS =
  "id, organization_id, title, description, status, employment_type, work_mode, location, department, openings, application_deadline, created_by, created_at, updated_at";

const REQUIREMENT_COLUMNS =
  "id, organization_id, job_id, category, requirement, importance, weight, source, display_order";

export async function getJobs(organizationId: string): Promise<Job[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("jobs")
    .select(JOB_COLUMNS)
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false });
  if (error) throw new Error("Unable to load jobs");
  return data as Job[];
}

export async function getJob(organizationId: string, jobId: string): Promise<Job | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("jobs")
    .select(JOB_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new Error("Unable to load the job");
  return data as Job | null;
}

export async function getJobRequirements(
  organizationId: string,
  jobId: string,
): Promise<JobRequirement[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("job_requirements")
    .select(REQUIREMENT_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("job_id", jobId)
    .order("display_order")
    .order("created_at");
  if (error) throw new Error("Unable to load the job requirements");
  return data as JobRequirement[];
}

const ANALYSIS_COLUMNS =
  "id, status, provider, model, source_text, error, created_at, completed_at";

const SUGGESTION_COLUMNS =
  "id, analysis_id, category, requirement, importance, weight, status, duplicate_group, display_order";

/** The most recent analysis run for a job, or null when none has been started. */
export async function getLatestAnalysis(
  organizationId: string,
  jobId: string,
): Promise<JobDescriptionAnalysis | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("job_description_analyses")
    .select(ANALYSIS_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("job_id", jobId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("Unable to load the analysis");
  if (!data) return null;

  // Whether a run is still plausibly in flight is decided here rather than while rendering: a run
  // cannot outlive its own timeout, so anything older than that plus slack had its process
  // disappear. The row itself is settled the next time an analysis starts.
  const row = data as Omit<JobDescriptionAnalysis, "stalled">;
  const stalled =
    row.status === "running" &&
    Date.now() - new Date(row.created_at).getTime() >
      staleAfterMs(resolveTimeoutMs(process.env.AI_TIMEOUT_MS));
  return { ...row, stalled };
}

/** The suggestions belonging to one run, in the order the model produced them. */
export async function getSuggestions(
  organizationId: string,
  analysisId: string,
): Promise<RequirementSuggestion[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("job_requirement_suggestions")
    .select(SUGGESTION_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("analysis_id", analysisId)
    .order("display_order");
  if (error) throw new Error("Unable to load the suggestions");
  return data as RequirementSuggestion[];
}
