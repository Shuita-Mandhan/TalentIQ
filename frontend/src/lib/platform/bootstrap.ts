import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Seating the first administrator of an organization, shared by the create flow and the retry on
// the organization detail page so both behave identically.
//
// The database decides everything that matters: whether the organization may still be bootstrapped
// at all, whether the address already has a usable account, and which role is assigned. This
// module only carries out the side effect the database cannot - sending the email - and reports
// what happened. The email is a side effect, not part of the transaction, so a failure here leaves
// a real pending invitation behind that can simply be retried.

export type AdministrationState = {
  has_recovery_manager: boolean;
  administrator_emails: string[];
  pending_admin_email: string | null;
  pending_admin_invitation_id: string | null;
  caller_is_member: boolean;
};

/**
 * How an organization currently administers itself, for the control plane to describe honestly.
 *
 * Returns null rather than throwing when the function is unreachable. Administration is one
 * section of the organization detail page, and losing it should not take suspension and service
 * entitlements down with it - the page says that state is unavailable and stays usable. The
 * diagnostic is kept on the server log, where it belongs, rather than rendered as an error page.
 */
export async function getAdministrationState(
  organizationId: string,
): Promise<AdministrationState | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .rpc("get_platform_organization_administration", { target_organization_id: organizationId })
    .single();
  if (error) {
    console.error("get_platform_organization_administration failed:", error);
    return null;
  }
  return data as AdministrationState;
}

export type BootstrapOutcome =
  /** An existing account is now an active member holding the system role. */
  | { state: "seated" }
  /** An invitation exists and the email went out. */
  | { state: "invited" }
  /** An invitation exists but the email did not go out; retrying is safe. */
  | { state: "invite-not-sent"; error: string }
  /** Nothing happened; the organization or the request was refused. */
  | { state: "failed"; error: string };

const GENERIC_FAILURE = "Unable to set up the administrator right now. Please try again.";

function messageFor(code: string | undefined): string {
  if (code === "TQ006") {
    return "This organization already has an administrator, so it manages its own members from here.";
  }
  if (code === "TQ008") {
    return "An administrator setup is already pending. Cancel it before naming someone else.";
  }
  if (code === "P0002") return "Organization not found.";
  if (code === "42501") return "You do not have permission to perform this action.";
  if (code === "22023") return "Enter a valid email address.";
  return GENERIC_FAILURE;
}

/**
 * Cancels a pending administrator setup so a different person can be named. The database refuses
 * anything that is not a pending, admin-bearing invitation of this organization, so this is not a
 * route into ordinary tenant invitations.
 */
export async function cancelAdministratorSetup(
  organizationId: string,
  invitationId: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("revoke_bootstrap_organization_invitation", {
    target_organization_id: organizationId,
    target_invitation_id: invitationId,
  });
  if (error) return { error: messageFor((error as { code?: string }).code) };
  return {};
}

export async function bootstrapAdministrator(
  organizationId: string,
  organizationName: string,
  email: string,
): Promise<BootstrapOutcome> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .rpc("bootstrap_organization_administrator", {
      target_organization_id: organizationId,
      target_email: email,
    })
    .single();
  if (error) return { state: "failed", error: messageFor((error as { code?: string }).code) };

  const result = data as { status: string; invitation_id: string | null };
  if (result.status === "administrator_ready") return { state: "seated" };
  if (!result.invitation_id) return { state: "failed", error: GENERIC_FAILURE };

  const appUrl = process.env.APP_URL?.replace(/\/$/, "");
  if (!appUrl) {
    return {
      state: "invite-not-sent",
      error: "The invitation was recorded but APP_URL is not configured, so no email was sent.",
    };
  }

  // The same invitation email the tenant flow sends, verified server-side through /auth/confirm.
  // The invitation row already records that accepting it confers the administrator role; nothing
  // about that travels in the link.
  const { error: inviteError } = await createAdminClient().auth.admin.inviteUserByEmail(email, {
    redirectTo: `${appUrl}/invite/${result.invitation_id}`,
    data: { invitation_id: result.invitation_id, organization_name: organizationName },
  });
  if (inviteError) {
    return {
      state: "invite-not-sent",
      error: "The invitation was recorded but the email could not be sent. Try sending it again.",
    };
  }

  return { state: "invited" };
}
