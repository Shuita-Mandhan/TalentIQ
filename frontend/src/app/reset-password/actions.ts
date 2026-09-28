"use server";

import { redirect } from "next/navigation";
import { invitationContinuation } from "@/lib/auth/invite-redirect";
import { completeInvitedAccountSetup } from "@/lib/organization/account-setup";
import { getMyInvitation } from "@/lib/organization/invitation";
import { createClient } from "@/lib/supabase/server";

export type ResetPasswordState = { error?: string };

const PASSWORD_REJECTED =
  "Unable to update the password. Choose a different password and try again.";

export async function updatePassword(
  _previous: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const password = formData.get("password");
  const confirmPassword = formData.get("confirmPassword");

  // Re-validated here rather than trusted from the form, and never used as anything but an
  // invitation id. It decides nothing on its own: the database returns the invitation only to the
  // account it was addressed to, so naming someone else's simply finds nothing.
  const invitationId = invitationContinuation(formData.get("invitationId"));

  if (typeof password !== "string" || password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (confirmPassword !== password) {
    return { error: "Passwords do not match." };
  }

  // Server Actions are independent entrypoints, so the recovery session is verified here too.
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) redirect("/forgot-password?error=invalid-link");

  // Setting up an invited account: one password, then straight into the workspace. Acceptance is
  // still the database's to grant - this only submits it, and only because the person asked.
  if (invitationId) {
    const outcome = await completeInvitedAccountSetup(
      {
        loadInvitation: (id) => getMyInvitation(id),
        setPassword: async (value) => !(await supabase.auth.updateUser({ password: value })).error,
        revokeOtherSessions: async () => {
          // Not a global sign-out: this session carries them into the workspace they just joined.
          await supabase.auth.signOut({ scope: "others" });
        },
        acceptInvitation: async (id) => {
          const accepted = await supabase
            .rpc("accept_organization_invitation", { target_invitation_id: id })
            .single();
          if (accepted.error) return null;
          return (accepted.data as { organization_slug: string }).organization_slug;
        },
      },
      invitationId,
      password,
    );

    if (outcome.status === "unavailable") {
      return {
        error: "This invitation is no longer available. Ask your administrator to send a new one.",
      };
    }
    if (outcome.status === "password-rejected") return { error: PASSWORD_REJECTED };
    // The account already works, and acceptance is idempotent, so submitting again is the retry.
    if (outcome.status === "not-joined") {
      return { error: "Your password was saved, but joining the workspace failed. Please try again." };
    }
    redirect(`/app/${outcome.organizationSlug}`);
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: PASSWORD_REJECTED };

  // A recovery may follow a compromise: revoke every session, not just this browser's.
  await supabase.auth.signOut({ scope: "global" });
  redirect("/login?reset=success");
}
