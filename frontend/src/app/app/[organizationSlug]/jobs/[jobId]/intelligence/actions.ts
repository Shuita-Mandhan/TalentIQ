"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/ui/action-form";
import { requirePermission } from "@/lib/auth/authorization";
import { requireOrganizationActionAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import {
  describeProviderFailure,
  groupDuplicates,
  parseExtraction,
  resolveTimeoutMs,
  staleAfterMs,
  validateDescription,
} from "@/lib/ai/extraction";
import { getExtractionProvider } from "@/lib/ai/provider";
import { IMPORTANCES, REQUIREMENT_CATEGORIES } from "@/lib/jobs/types";
import { accessErrorMessage, GENERIC_FAILURE } from "@/lib/organization/access-errors";
import { createClient } from "@/lib/supabase/server";

// Every action authenticates, resolves the tenant from the slug, requires jobs.manage, and then
// writes through policies that require it again. Extraction gets no privilege of its own: it goes
// through the same two keys a recruiter already needed to edit requirements by hand.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AnalysisState = ActionState & { description?: string };

function text(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Runs one extraction and records it as a review set.
 *
 * Nothing existing is touched. A run owns its own suggestions, so re-analyzing a job that already
 * has approved requirements leaves every one of them exactly where it is — the recruiter simply
 * gets another set to consider. A failure leaves the job description intact and the run marked
 * failed, which is what makes retrying safe.
 */
export async function analyzeJobDescription(
  _previous: AnalysisState,
  formData: FormData,
): Promise<AnalysisState> {
  const slug = text(formData, "organizationSlug");
  const { user, context } = await requireOrganizationActionAccess(slug);
  requirePermission(context, PERMISSIONS.JOBS_MANAGE);

  const jobId = text(formData, "jobId");
  if (!UUID_PATTERN.test(jobId)) return { error: "Invalid request." };

  // The submitted text is echoed back on every failure path, so nothing a recruiter pasted is lost.
  const description = text(formData, "description");
  const { text: validated, error: invalid } = validateDescription(description);
  if (!validated) return { error: invalid, description };

  const supabase = await createClient();
  // The job is re-read in this organization: it proves the job is ours and that it can still be
  // worked on, before a model is contacted at all.
  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .select("id, title, status")
    .eq("id", jobId)
    .eq("organization_id", context.organization.id)
    .maybeSingle();
  if (jobError) return { error: GENERIC_FAILURE, description };
  if (!job) return { error: "This job is no longer available.", description };
  if (job.status === "archived") {
    return { error: "This job is archived, so it can no longer be analyzed.", description };
  }

  let provider;
  try {
    provider = getExtractionProvider();
  } catch (cause) {
    console.error("AI provider unavailable:", cause);
    return { error: describeProviderFailure(cause), description };
  }

  // A run whose process disappeared before it could record an answer would otherwise sit at
  // "running" forever and make the job look permanently busy. Nothing sweeps in the background:
  // starting a new analysis settles any older run that has outlived its own timeout, which is the
  // only moment it matters. The threshold is derived from the timeout, so a genuinely recent run
  // is never cut short.
  const abandonedBefore = new Date(
    Date.now() - staleAfterMs(resolveTimeoutMs(process.env.AI_TIMEOUT_MS)),
  ).toISOString();
  await supabase
    .from("job_description_analyses")
    .update({
      status: "failed",
      error: "The analysis did not finish.",
      completed_at: new Date().toISOString(),
    })
    .eq("organization_id", context.organization.id)
    .eq("job_id", jobId)
    .eq("status", "running")
    .lt("created_at", abandonedBefore);

  // Recorded before the call so a run that never returns is still visible as a failure rather than
  // vanishing. The row also carries the job description, which is what a retry works from.
  const { data: run, error: runError } = await supabase
    .from("job_description_analyses")
    .insert({
      organization_id: context.organization.id,
      job_id: jobId,
      provider: provider.name,
      model: provider.model,
      source_text: validated,
      created_by: user.userId,
    })
    .select("id")
    .single();
  if (runError) return { error: accessErrorMessage(runError), description };

  const fail = async (reason: string, shown: string): Promise<AnalysisState> => {
    await supabase
      .from("job_description_analyses")
      .update({ status: "failed", error: reason, completed_at: new Date().toISOString() })
      .eq("id", run.id)
      .eq("organization_id", context.organization.id);
    revalidatePath(`/app/${slug}/jobs/${jobId}/intelligence`);
    return { error: shown, description };
  };

  let raw: unknown;
  try {
    raw = await provider.extract({ jobTitle: job.title, description: validated });
  } catch (cause) {
    // The provider's own wording goes to the server log and no further.
    console.error("AI extraction failed:", cause);
    return fail("The AI provider could not be reached.", describeProviderFailure(cause));
  }

  const { result, error: invalidOutput } = parseExtraction(raw);
  if (!result) {
    return fail(invalidOutput ?? "Unusable model output.", invalidOutput ?? GENERIC_FAILURE);
  }

  const groups = groupDuplicates(result.requirements);
  const { error: insertError } = await supabase.from("job_requirement_suggestions").insert(
    result.requirements.map((item, index) => ({
      organization_id: context.organization.id,
      analysis_id: run.id,
      job_id: jobId,
      requirement: item.requirement,
      category: item.category,
      importance: item.importance,
      weight: item.weight,
      duplicate_group: groups[index],
      display_order: index,
    })),
  );
  if (insertError) {
    return fail("The extracted requirements could not be saved.", accessErrorMessage(insertError));
  }

  await supabase
    .from("job_description_analyses")
    .update({ status: "succeeded", completed_at: new Date().toISOString() })
    .eq("id", run.id)
    .eq("organization_id", context.organization.id);

  revalidatePath(`/app/${slug}/jobs/${jobId}/intelligence`);
  return { done: true, message: `${result.requirements.length} suggestions ready for review.` };
}

export type SuggestionState = ActionState;

/**
 * Turns one reviewed suggestion into an ordinary requirement, with the recruiter's edits applied.
 * The database does the two writes together and returns the same requirement if it is called
 * twice, so a double click cannot produce a duplicate.
 */
export async function approveSuggestion(
  _previous: SuggestionState,
  formData: FormData,
): Promise<SuggestionState> {
  const slug = text(formData, "organizationSlug");
  const { context } = await requireOrganizationActionAccess(slug);
  requirePermission(context, PERMISSIONS.JOBS_MANAGE);

  const jobId = text(formData, "jobId");
  const suggestionId = text(formData, "suggestionId");
  if (!UUID_PATTERN.test(jobId) || !UUID_PATTERN.test(suggestionId)) {
    return { error: "Invalid request." };
  }

  // Edits are optional; an untouched field leaves the suggestion's own value in place.
  const requirement = text(formData, "requirement");
  if (requirement.length > 500) {
    return { error: "A requirement must be 500 characters or fewer." };
  }
  const weightInput = text(formData, "weight");
  const weight = weightInput.length === 0 ? null : Number(weightInput);
  if (weight !== null && (!Number.isFinite(weight) || weight < 0 || weight > 10)) {
    return { error: "Weight must be between 0 and 10." };
  }
  const category = text(formData, "category");
  const importance = text(formData, "importance");

  const supabase = await createClient();
  const { error } = await supabase.rpc("approve_job_requirement_suggestion", {
    target_organization_id: context.organization.id,
    target_suggestion_id: suggestionId,
    final_requirement: requirement.length > 0 ? requirement : null,
    final_category: (REQUIREMENT_CATEGORIES as readonly string[]).includes(category) ? category : null,
    final_importance: (IMPORTANCES as readonly string[]).includes(importance) ? importance : null,
    final_weight: weight,
  });
  if (error) return { error: accessErrorMessage(error) };

  revalidatePath(`/app/${slug}/jobs/${jobId}`);
  revalidatePath(`/app/${slug}/jobs/${jobId}/intelligence`);
  return { done: true, message: "Added to the job's requirements." };
}

/** Takes a suggestion out of review. It stays on the run as a record and never returns to pending. */
export async function rejectSuggestion(
  _previous: SuggestionState,
  formData: FormData,
): Promise<SuggestionState> {
  const slug = text(formData, "organizationSlug");
  const { context } = await requireOrganizationActionAccess(slug);
  requirePermission(context, PERMISSIONS.JOBS_MANAGE);

  const jobId = text(formData, "jobId");
  const suggestionId = text(formData, "suggestionId");
  if (!UUID_PATTERN.test(jobId) || !UUID_PATTERN.test(suggestionId)) {
    return { error: "Invalid request." };
  }

  const supabase = await createClient();
  // Only a pending suggestion moves, so rejecting an approved one cannot undo the requirement it
  // already created.
  const { data, error } = await supabase
    .from("job_requirement_suggestions")
    .update({ status: "rejected" })
    .eq("id", suggestionId)
    .eq("organization_id", context.organization.id)
    .eq("job_id", jobId)
    .eq("status", "pending")
    .select("id");
  if (error) return { error: accessErrorMessage(error) };
  if (data.length === 0) return { error: "This suggestion is no longer awaiting review." };

  revalidatePath(`/app/${slug}/jobs/${jobId}/intelligence`);
  return {};
}
