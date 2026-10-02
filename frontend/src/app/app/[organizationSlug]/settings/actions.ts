"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/authorization";
import { requireOrganizationActionAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { GENERIC_FAILURE } from "@/lib/organization/access-errors";
import { createClient } from "@/lib/supabase/server";

// Like every other tenant action, this authorizes itself: the page having rendered proves nothing.
// The write then passes the RLS update policy (platform admin OR organization.update) and the
// guard_organization_update trigger, which refuses any change to is_active or slug from a tenant
// caller. So the permission is checked three times over, and the identifiers this application
// routes on cannot be moved from here.

export type OrganizationSettingsState = { error?: string; name?: string; saved?: boolean };

export async function updateOrganization(
  _previous: OrganizationSettingsState,
  formData: FormData,
): Promise<OrganizationSettingsState> {
  const slugValue = formData.get("organizationSlug");
  const slug = typeof slugValue === "string" ? slugValue.trim() : "";
  const { context } = await requireOrganizationActionAccess(slug);
  requirePermission(context, PERMISSIONS.ORGANIZATION_UPDATE);

  const nameValue = formData.get("name");
  const name = typeof nameValue === "string" ? nameValue.trim() : "";
  // Mirrors the database constraint so invalid input never costs a round trip.
  if (name.length === 0 || name.length > 120) {
    return { error: "Enter an organization name of up to 120 characters.", name };
  }
  if (name === context.organization.name) return { name, saved: true };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organizations")
    .update({ name })
    .eq("id", context.organization.id)
    .select("id");
  if (error) return { error: GENERIC_FAILURE, name };
  if (data.length === 0) return { error: "Organization not found.", name };

  // The name appears in the shell on every tenant route, so the whole workspace is revalidated.
  revalidatePath(`/app/${slug}`, "layout");
  return { name, saved: true };
}
