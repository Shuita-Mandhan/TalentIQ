// The invited-account setup path, sequenced in one place.
//
// This module deliberately imports nothing from Next or Supabase: the order it enforces - prove
// the invitation is still pending and still ours BEFORE touching anything, then set the password,
// then accept - is the whole point of it, so it is expressed as something that can be tested
// directly rather than inferred from reading the server action around it.

export type AccountSetupOutcome =
  | { status: "unavailable" }
  | { status: "password-rejected" }
  | { status: "not-joined" }
  | { status: "joined"; organizationSlug: string };

export type AccountSetupSteps = {
  /** The caller's own pending invitation, or null once it is accepted, revoked or not theirs. */
  loadInvitation: (invitationId: string) => Promise<unknown | null>;
  /** True when the new password was accepted. */
  setPassword: (password: string) => Promise<boolean>;
  /** Other sessions only - this one has to survive to carry them into the workspace. */
  revokeOtherSessions: () => Promise<void>;
  /** The organization slug joined, or null when acceptance failed; must stay idempotent. */
  acceptInvitation: (invitationId: string) => Promise<string | null>;
};

export async function completeInvitedAccountSetup(
  steps: AccountSetupSteps,
  invitationId: string,
  password: string,
): Promise<AccountSetupOutcome> {
  // Read before write. An invitation that has been accepted, revoked or was never addressed to
  // this account must cost the recipient nothing, least of all their password.
  if ((await steps.loadInvitation(invitationId)) === null) return { status: "unavailable" };

  if (!(await steps.setPassword(password))) return { status: "password-rejected" };

  // From here the password is usable whatever happens next, so nothing below may undo it and every
  // later failure has to stay retryable.
  await steps.revokeOtherSessions();

  const organizationSlug = await steps.acceptInvitation(invitationId);
  return organizationSlug === null
    ? { status: "not-joined" }
    : { status: "joined", organizationSlug };
}
