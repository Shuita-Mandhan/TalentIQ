"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/ui/action-form";
import { requirePlatformActionAccess } from "@/lib/platform/auth";
import {
  bootstrapAdministrator,
  cancelAdministratorSetup as cancelSetup,
  getAdministrationState,
} from "@/lib/platform/bootstrap";
import { createClient } from "@/lib/supabase/server";
import { EMAIL_PATTERN } from "@/lib/validation";

// Every action authorizes itself: the rendering page having passed the platform check is irrelevant.

export type CreateOrganizationState = {
  error?: string;
  name?: string;
  slug?: string;
  adminEmail?: string;
};

// Mirrors the database constraints so invalid input is rejected before a round-trip.
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = "23505";

function text(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === "string" ? value.trim() : "";
}

export async function createOrganization(
  _previous: CreateOrganizationState,
  formData: FormData,
): Promise<CreateOrganizationState> {
  await requirePlatformActionAccess();

  const name = text(formData, "name");
  const slug = text(formData, "slug").toLowerCase();
  const adminEmail = text(formData, "adminEmail").toLowerCase();
  if (name.length === 0 || name.length > 120) {
    return { error: "Enter an organization name (up to 120 characters).", name, slug, adminEmail };
  }
  if (!SLUG_PATTERN.test(slug)) {
    return {
      error: "Slug must be 1–63 lowercase letters, digits or hyphens, and cannot start or end with a hyphen.",
      name,
      slug,
      adminEmail,
    };
  }
  // Required: an organization nobody can enter is not a finished organization.
  if (!EMAIL_PATTERN.test(adminEmail)) {
    return {
      error: "Enter the email address of the person who will administer this organization.",
      name,
      slug,
      adminEmail,
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organizations")
    .insert({ name, slug })
    .select("id")
    .single();
  if (error) {
    return {
      error:
        error.code === UNIQUE_VIOLATION
          ? "That slug is already in use."
          : "Unable to create the organization. Please try again.",
      name,
      slug,
      adminEmail,
    };
  }

  // Creating the organization and delivering an email are not one transaction and are not pretended
  // to be. The organization is kept whatever happens next, and the detail page derives the setup
  // state from the database rather than from this outcome, so a failed send shows as work still to
  // do with a retry beside it instead of a success that was not one.
  const outcome = await bootstrapAdministrator(data.id, name, adminEmail);

  revalidatePath("/platform");
  revalidatePath("/platform/organizations");
  redirect(
    outcome.state === "seated" || outcome.state === "invited"
      ? `/platform/organizations/${data.id}`
      : `/platform/organizations/${data.id}?setup=incomplete`,
  );
}

/** Names the administrator of an organization that still cannot administer itself. */
export async function setupAdministrator(
  _previous: CreateOrganizationState,
  formData: FormData,
): Promise<CreateOrganizationState> {
  await requirePlatformActionAccess();

  const organizationId = text(formData, "organizationId");
  const adminEmail = text(formData, "adminEmail").toLowerCase();
  if (!UUID_PATTERN.test(organizationId)) return { error: "Invalid request." };
  if (!EMAIL_PATTERN.test(adminEmail)) {
    return { error: "Enter a valid email address.", adminEmail };
  }
  return runBootstrap(organizationId, adminEmail);
}

/**
 * Sends the pending setup again. The address is read from the database rather than the form: this
 * button resends what is outstanding, and is never a way to move the setup to someone else.
 */
export async function resendAdministratorSetup(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requirePlatformActionAccess();

  const organizationId = text(formData, "organizationId");
  if (!UUID_PATTERN.test(organizationId)) return { error: "Invalid request." };

  // Read from the database, not the form, so this button can only ever resend what is outstanding.
  const administration = await getAdministrationState(organizationId);
  if (!administration?.pending_admin_email) {
    return { error: "There is no administrator setup pending for this organization." };
  }

  const result = await runBootstrap(organizationId, administration.pending_admin_email);
  if (result.error) return { error: result.error };
  return { done: true, message: "Setup email sent again." };
}

/** Cancels the pending setup so a different administrator can be named. */
export async function cancelAdministratorSetup(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requirePlatformActionAccess();

  const organizationId = text(formData, "organizationId");
  const invitationId = text(formData, "invitationId");
  if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(invitationId)) {
    return { error: "Invalid request." };
  }

  const { error } = await cancelSetup(organizationId, invitationId);
  if (error) return { error };

  revalidatePath("/platform/organizations");
  revalidatePath(`/platform/organizations/${organizationId}`);
  return {};
}

/** Shared tail of the two paths that seat or invite an administrator. */
async function runBootstrap(
  organizationId: string,
  adminEmail: string,
): Promise<CreateOrganizationState> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) return { error: GENERIC_FAILURE, adminEmail };
  if (!data) return { error: "Organization not found.", adminEmail };

  const outcome = await bootstrapAdministrator(organizationId, data.name, adminEmail);
  if (outcome.state === "failed" || outcome.state === "invite-not-sent") {
    return { error: outcome.error, adminEmail };
  }

  revalidatePath("/platform/organizations");
  revalidatePath(`/platform/organizations/${organizationId}`);
  return {};
}

const GENERIC_FAILURE = "Unable to save the change. Please try again.";

export async function setOrganizationStatus(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requirePlatformActionAccess();

  const organizationId = text(formData, "organizationId");
  const active = text(formData, "active") === "true";
  if (!UUID_PATTERN.test(organizationId)) return { error: "Invalid request." };

  const supabase = await createClient();
  // The update returns the matched rows, which proves whether the organization exists.
  const { data, error } = await supabase
    .from("organizations")
    .update({ is_active: active })
    .eq("id", organizationId)
    .select("id");
  if (error) return { error: GENERIC_FAILURE };
  if (data.length === 0) return { error: "Organization not found." };

  revalidatePath("/platform");
  revalidatePath("/platform/organizations");
  revalidatePath(`/platform/organizations/${organizationId}`);
  return {};
}

export async function setServiceEntitlement(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requirePlatformActionAccess();

  const organizationId = text(formData, "organizationId");
  const serviceKey = text(formData, "serviceKey");
  const enabled = text(formData, "enabled") === "true";
  if (!UUID_PATTERN.test(organizationId) || !/^[a-z][a-z0-9_]*$/.test(serviceKey)) {
    return { error: "Invalid request." };
  }

  const supabase = await createClient();
  const [organization, service] = await Promise.all([
    supabase.from("organizations").select("id").eq("id", organizationId).maybeSingle(),
    supabase.from("platform_services").select("key").eq("key", serviceKey).maybeSingle(),
  ]);
  if (organization.error || service.error) return { error: GENERIC_FAILURE };
  if (!organization.data) return { error: "Organization not found." };
  if (!service.data) return { error: "Service not found." };

  // Update first so an existing row keeps its limits; only insert when no entitlement exists yet.
  const updated = await supabase
    .from("organization_service_entitlements")
    .update({ enabled })
    .eq("organization_id", organizationId)
    .eq("service_key", serviceKey)
    .select("service_key");
  if (updated.error) return { error: GENERIC_FAILURE };
  if (updated.data.length === 0) {
    const inserted = await supabase
      .from("organization_service_entitlements")
      .insert({ organization_id: organizationId, service_key: serviceKey, enabled });
    if (inserted.error) return { error: GENERIC_FAILURE };
  }

  revalidatePath(`/platform/organizations/${organizationId}`);
  return {};
}
