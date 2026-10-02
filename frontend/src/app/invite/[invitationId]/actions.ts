"use server";

import { redirect } from "next/navigation";
import { BOOTSTRAP_SETUP_INACTIVE } from "@/lib/organization/access-errors";
import { getMyInvitation } from "@/lib/organization/invitation";
import { createClient } from "@/lib/supabase/server";

// Onboarding entrypoint for the invited person. It is an independent entrypoint like every other
// Server Action: the invitation is re-read here (which proves it is still pending and addressed to
// the caller's own Auth email) rather than trusting anything the form submitted.

export type FinishAccountState = { error?: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function finishAccount(
  _previous: FinishAccountState,
  formData: FormData,
): Promise<FinishAccountState> {
  const invitationId = formData.get("invitationId");
  const password = formData.get("password");
  const confirmPassword = formData.get("confirmPassword");

  if (typeof invitationId !== "string" || !UUID_PATTERN.test(invitationId)) {
    return { error: "Invalid request." };
  }
  if (typeof password !== "string" || password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (confirmPassword !== password) return { error: "Passwords do not match." };

  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims) redirect("/login?error=invalid-link");

  const invitation = await getMyInvitation(invitationId);
  if (!invitation) return { error: "This invitation is no longer available." };

  const updated = await supabase.auth.updateUser({ password });
  if (updated.error) {
    return { error: "Unable to set that password. Choose a different one and try again." };
  }

  // The account now works even if this step fails, so the error stays retryable: acceptance is
  // idempotent and the person can simply submit again.
  const accepted = await supabase
    .rpc("accept_organization_invitation", { target_invitation_id: invitationId })
    .single();
  if (accepted.error) {
    // A platform-issued administrator setup whose organization has since gained an administrator
    // of its own is not retryable, so it does not pretend to be.
    const code = (accepted.error as { code?: string }).code;
    if (code === "TQ007") return { error: BOOTSTRAP_SETUP_INACTIVE };
    return { error: "Your password was saved, but joining the workspace failed. Please try again." };
  }

  const { organization_slug: slug } = accepted.data as { organization_slug: string };
  redirect(`/app/${slug}`);
}
