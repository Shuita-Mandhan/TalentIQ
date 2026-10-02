"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/ui/action-form";
import { requirePermission } from "@/lib/auth/authorization";
import { requireOrganizationActionAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import {
  EMPLOYMENT_TYPES,
  MAX_REQUIREMENT_WEIGHT,
  IMPORTANCES,
  JOB_STATUSES,
  REQUIREMENT_CATEGORIES,
  SOURCES,
  WORK_MODES,
  type EmploymentType,
  type Importance,
  type JobStatus,
  type RequirementCategory,
  type RequirementSource,
  type WorkMode,
} from "@/lib/jobs/types";
import { accessErrorMessage, GENERIC_FAILURE } from "@/lib/organization/access-errors";
import { createClient } from "@/lib/supabase/server";

// Every action authenticates, resolves the tenant, requires the permission, and then writes
// through RLS policies that require it again. The organization comes from the slug and is
// re-resolved server-side on every call: an organization id is never accepted from the form, so a
// job id belonging to another tenant simply matches nothing.
//
// Validation here mirrors the database constraints so bad input costs no round trip. It is not the
// authority - every rule it applies is also a constraint or a trigger.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type JobFormState = ActionState & { values?: Record<string, string> };

function text(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === "string" ? value.trim() : "";
}

/** Empty strings become null so an untouched optional field is absent rather than blank. */
function optional(formData: FormData, field: string): string | null {
  const value = text(formData, field);
  return value.length === 0 ? null : value;
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

type JobInput = {
  title: string;
  description: string | null;
  department: string | null;
  location: string | null;
  work_mode: WorkMode | null;
  employment_type: EmploymentType | null;
  openings: number;
  application_deadline: string | null;
};

/** Returns the validated row, or the first message a recruiter needs to act on. */
function readJob(formData: FormData): { input?: JobInput; error?: string } {
  const title = text(formData, "title");
  if (title.length === 0) return { error: "Enter a job title." };
  if (title.length > 160) return { error: "Job title must be 160 characters or fewer." };

  const description = optional(formData, "description");
  if (description && description.length > 20000) {
    return { error: "Job description is too long (20,000 characters maximum)." };
  }

  const location = optional(formData, "location");
  if (location && location.length > 160) return { error: "Location must be 160 characters or fewer." };
  const department = optional(formData, "department");
  if (department && department.length > 120) {
    return { error: "Department must be 120 characters or fewer." };
  }

  const openingsRaw = text(formData, "openings") || "1";
  const openings = Number(openingsRaw);
  if (!Number.isInteger(openings) || openings < 1 || openings > 10000) {
    return { error: "Number of openings must be a whole number of at least 1." };
  }

  const deadline = optional(formData, "application_deadline");
  if (deadline && Number.isNaN(Date.parse(deadline))) {
    return { error: "Enter a valid application deadline." };
  }

  return {
    input: {
      title,
      description,
      department,
      location,
      work_mode: oneOf(optional(formData, "work_mode"), WORK_MODES),
      employment_type: oneOf(optional(formData, "employment_type"), EMPLOYMENT_TYPES),
      openings,
      application_deadline: deadline,
    },
  };
}

/** Everything the form submitted, so a rejected attempt is not retyped from scratch. */
function submitted(formData: FormData): Record<string, string> {
  const fields = [
    "title",
    "description",
    "department",
    "location",
    "work_mode",
    "employment_type",
    "openings",
    "application_deadline",
  ];
  return Object.fromEntries(fields.map((field) => [field, text(formData, field)]));
}

export async function createJob(_previous: JobFormState, formData: FormData): Promise<JobFormState> {
  const slug = text(formData, "organizationSlug");
  const { user, context } = await requireOrganizationActionAccess(slug);
  requirePermission(context, PERMISSIONS.JOBS_MANAGE);

  const values = submitted(formData);
  const { input, error } = readJob(formData);
  if (!input) return { error, values };

  const supabase = await createClient();
  // Both the organization and the author come from the verified session, never from the form.
  const { data, error: insertError } = await supabase
    .from("jobs")
    .insert({ ...input, organization_id: context.organization.id, created_by: user.userId })
    .select("id")
    .single();
  if (insertError) return { error: accessErrorMessage(insertError), values };

  revalidatePath(`/app/${slug}`);
  revalidatePath(`/app/${slug}/jobs`);
  redirect(`/app/${slug}/jobs/${data.id}`);
}

export async function updateJob(_previous: JobFormState, formData: FormData): Promise<JobFormState> {
  const slug = text(formData, "organizationSlug");
  const { context } = await requireOrganizationActionAccess(slug);
  requirePermission(context, PERMISSIONS.JOBS_MANAGE);

  const jobId = text(formData, "jobId");
  if (!UUID_PATTERN.test(jobId)) return { error: "Invalid request." };

  const values = submitted(formData);
  const { input, error } = readJob(formData);
  if (!input) return { error, values };

  const supabase = await createClient();
  // Scoped by organization as well as id, so an id from another tenant matches nothing rather
  // than relying on the policy alone.
  const { data, error: updateError } = await supabase
    .from("jobs")
    .update(input)
    .eq("id", jobId)
    .eq("organization_id", context.organization.id)
    .select("id");
  if (updateError) return { error: accessErrorMessage(updateError), values };
  if (data.length === 0) return { error: "This job is no longer available.", values };

  revalidatePath(`/app/${slug}`);
  revalidatePath(`/app/${slug}/jobs`);
  revalidatePath(`/app/${slug}/jobs/${jobId}`);
  redirect(`/app/${slug}/jobs/${jobId}`);
}

export async function setJobStatus(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const slug = text(formData, "organizationSlug");
  const { context } = await requireOrganizationActionAccess(slug);
  requirePermission(context, PERMISSIONS.JOBS_MANAGE);

  const jobId = text(formData, "jobId");
  const status = text(formData, "status");
  if (!UUID_PATTERN.test(jobId) || !(JOB_STATUSES as readonly string[]).includes(status)) {
    return { error: "Invalid request." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("jobs")
    .update({ status: status as JobStatus })
    .eq("id", jobId)
    .eq("organization_id", context.organization.id)
    .select("id");
  // The trigger owns which moves are legal; this only reports its answer.
  if (error) return { error: accessErrorMessage(error) };
  if (data.length === 0) return { error: "This job is no longer available." };

  revalidatePath(`/app/${slug}`);
  revalidatePath(`/app/${slug}/jobs`);
  revalidatePath(`/app/${slug}/jobs/${jobId}`);
  return {};
}

export type RequirementFormState = ActionState & { values?: Record<string, string> };

export async function addRequirement(
  _previous: RequirementFormState,
  formData: FormData,
): Promise<RequirementFormState> {
  const slug = text(formData, "organizationSlug");
  const { context } = await requireOrganizationActionAccess(slug);
  requirePermission(context, PERMISSIONS.JOBS_MANAGE);

  const jobId = text(formData, "jobId");
  if (!UUID_PATTERN.test(jobId)) return { error: "Invalid request." };

  const requirement = text(formData, "requirement");
  const values = {
    requirement,
    category: text(formData, "category"),
    importance: text(formData, "importance"),
    weight: text(formData, "weight"),
  };
  if (requirement.length === 0) return { error: "Enter the requirement.", values };
  if (requirement.length > 500) return { error: "A requirement must be 500 characters or fewer.", values };

  const weight = Number(text(formData, "weight") || "1");
  if (!Number.isFinite(weight) || weight < 0 || weight > 10) {
    return { error: "Weight must be between 0 and 10.", values };
  }

  const supabase = await createClient();
  // The job is re-read in this organization first: it both proves the job is ours and gives the
  // next position without trusting anything the form said about ordering.
  const existing = await supabase
    .from("job_requirements")
    .select("display_order")
    .eq("organization_id", context.organization.id)
    .eq("job_id", jobId)
    .order("display_order", { ascending: false })
    .limit(1);
  if (existing.error) return { error: GENERIC_FAILURE, values };

  const { error } = await supabase.from("job_requirements").insert({
    organization_id: context.organization.id,
    job_id: jobId,
    requirement,
    category: oneOf(text(formData, "category"), REQUIREMENT_CATEGORIES) ?? ("other" as RequirementCategory),
    importance: oneOf(text(formData, "importance"), IMPORTANCES) ?? ("required" as Importance),
    source: oneOf(text(formData, "source"), SOURCES) ?? ("manual" as RequirementSource),
    weight,
    display_order: (existing.data[0]?.display_order ?? -1) + 1,
  });
  if (error) return { error: accessErrorMessage(error), values };

  revalidatePath(`/app/${slug}/jobs/${jobId}`);
  return { done: true };
}

export async function updateRequirement(
  _previous: RequirementFormState,
  formData: FormData,
): Promise<RequirementFormState> {
  const slug = text(formData, "organizationSlug");
  const { context } = await requireOrganizationActionAccess(slug);
  requirePermission(context, PERMISSIONS.JOBS_MANAGE);

  const jobId = text(formData, "jobId");
  const requirementId = text(formData, "requirementId");
  if (!UUID_PATTERN.test(jobId) || !UUID_PATTERN.test(requirementId)) {
    return { error: "Invalid request." };
  }

  const requirement = text(formData, "requirement");
  if (requirement.length === 0) return { error: "Enter the requirement." };
  if (requirement.length > 500) return { error: "A requirement must be 500 characters or fewer." };

  const weight = Number(text(formData, "weight") || "1");
  if (!Number.isFinite(weight) || weight < 0 || weight > 10) {
    return { error: "Weight must be between 0 and 10." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("job_requirements")
    .update({
      requirement,
      category: oneOf(text(formData, "category"), REQUIREMENT_CATEGORIES) ?? ("other" as RequirementCategory),
      importance: oneOf(text(formData, "importance"), IMPORTANCES) ?? ("required" as Importance),
      source: oneOf(text(formData, "source"), SOURCES) ?? ("manual" as RequirementSource),
      weight,
    })
    .eq("id", requirementId)
    .eq("organization_id", context.organization.id)
    .eq("job_id", jobId)
    .select("id");
  if (error) return { error: accessErrorMessage(error) };
  if (data.length === 0) return { error: "This requirement is no longer available." };

  revalidatePath(`/app/${slug}/jobs/${jobId}`);
  return { done: true };
}

/**
 * Persists a new order for a job's requirements. The ids arrive as one repeated field, every one
 * is checked for shape, and the database renumbers them in a single statement scoped to this job
 * and this organization — so an id from elsewhere renumbers nothing.
 */
export async function reorderRequirements(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = text(formData, "organizationSlug");
  const { context } = await requireOrganizationActionAccess(slug);
  requirePermission(context, PERMISSIONS.JOBS_MANAGE);

  const jobId = text(formData, "jobId");
  const orderedIds = formData
    .getAll("requirementIds")
    .filter((value): value is string => typeof value === "string");
  if (!UUID_PATTERN.test(jobId) || orderedIds.length === 0) return { error: "Invalid request." };
  if (!orderedIds.every((id) => UUID_PATTERN.test(id))) return { error: "Invalid request." };
  if (new Set(orderedIds).size !== orderedIds.length) return { error: "Invalid request." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("reorder_job_requirements", {
    target_organization_id: context.organization.id,
    target_job_id: jobId,
    ordered_ids: orderedIds,
  });
  if (error) return { error: accessErrorMessage(error) };

  revalidatePath(`/app/${slug}/jobs/${jobId}`);
  return { done: true, message: "Order saved." };
}

export async function removeRequirement(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = text(formData, "organizationSlug");
  const { context } = await requireOrganizationActionAccess(slug);
  requirePermission(context, PERMISSIONS.JOBS_MANAGE);

  const jobId = text(formData, "jobId");
  const requirementId = text(formData, "requirementId");
  if (!UUID_PATTERN.test(jobId) || !UUID_PATTERN.test(requirementId)) {
    return { error: "Invalid request." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("job_requirements")
    .delete()
    .eq("id", requirementId)
    .eq("organization_id", context.organization.id)
    .eq("job_id", jobId);
  if (error) return { error: accessErrorMessage(error) };

  revalidatePath(`/app/${slug}/jobs/${jobId}`);
  return {};
}

/**
 * Sets several requirement weights in one statement.
 *
 * Used by the rubric, where adjusting one weight usually means adjusting others: spreading that
 * across a dozen round trips would leave the rubric half-adjusted if any of them failed, and a
 * half-adjusted rubric is exactly what must never be shown as ready. Weights are taken as paired
 * fields and validated here before the database validates them again.
 */
export async function setRequirementWeights(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = text(formData, "organizationSlug");
  const { context } = await requireOrganizationActionAccess(slug);
  requirePermission(context, PERMISSIONS.JOBS_MANAGE);

  const jobId = text(formData, "jobId");
  if (!UUID_PATTERN.test(jobId)) return { error: "Invalid request." };

  const ids = formData
    .getAll("requirementIds")
    .filter((value): value is string => typeof value === "string");
  const rawWeights = formData
    .getAll("weights")
    .filter((value): value is string => typeof value === "string");

  if (ids.length === 0 || ids.length !== rawWeights.length) return { error: "Invalid request." };
  if (!ids.every((id) => UUID_PATTERN.test(id))) return { error: "Invalid request." };
  if (new Set(ids).size !== ids.length) return { error: "Invalid request." };

  const weights: number[] = [];
  for (const raw of rawWeights) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > MAX_REQUIREMENT_WEIGHT) {
      return { error: `Each weight must be between 0 and ${MAX_REQUIREMENT_WEIGHT}.` };
    }
    // Two decimals is what the column stores; rounding here rather than letting the database
    // truncate means the recruiter sees back exactly what was saved.
    weights.push(Math.round(value * 100) / 100);
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_job_requirement_weights", {
    target_organization_id: context.organization.id,
    target_job_id: jobId,
    requirement_ids: ids,
    requirement_weights: weights,
  });
  if (error) return { error: accessErrorMessage(error) };

  revalidatePath(`/app/${slug}/jobs/${jobId}`);
  revalidatePath(`/app/${slug}/jobs/${jobId}/rubric`);
  return { done: true, message: "Weights saved." };
}
