"use server";

import { createMailerClient } from "@/lib/supabase/mailer";
import { EMAIL_PATTERN } from "@/lib/validation";

export type ForgotPasswordState = { error?: string; sent?: boolean };

const GENERIC_FAILURE = "Unable to send the reset email right now. Please try again.";

export async function requestPasswordReset(
  _previous: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  const rawEmail = formData.get("email");
  const email = typeof rawEmail === "string" ? rawEmail.trim() : "";
  if (!EMAIL_PATTERN.test(email)) {
    return { error: "Enter a valid email address." };
  }

  // Trusted deployment configuration is the only source of the destination in an authentication
  // email - never the Origin or Host of the request. /auth/confirm re-validates it against the
  // same APP_URL before honouring it.
  const appUrl = process.env.APP_URL?.replace(/\/$/, "");
  if (!appUrl) {
    return { error: GENERIC_FAILURE };
  }

  // Session-less on purpose. A recovery link has no business depending on state in the browser
  // that asked for it: the email is routinely opened on another device, in another browser, or
  // after that browser's storage is long gone. It verifies server-side through /auth/confirm, and
  // sending it from a client that writes no cookies is what keeps it that way.
  const { error } = await createMailerClient().auth.resetPasswordForEmail(email, {
    redirectTo: `${appUrl}/reset-password`,
  });
  if (error) {
    return { error: GENERIC_FAILURE };
  }

  // Same outcome whether or not the account exists, so the form cannot be used to enumerate users.
  return { sent: true };
}
