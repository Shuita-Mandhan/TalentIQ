// Validation for the destinations the authentication emails continue to. Neither form is ever
// taken from the request: an absolute URL is checked against trusted deployment configuration, and
// a recovery continuation is accepted only as a bare invitation id. Both can resolve to nothing
// except one invitation on this deployment.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVITE_PATH = /^\/invite\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESET_PATH = "/reset-password";

/**
 * Returns the local path to continue to, or null. The URL must sit on the `trustedAppUrl` origin
 * exactly (scheme, host and port), carry no credentials, query or fragment, and address exactly
 * one invitation.
 */
export function inviteDestination(raw: string | null, trustedAppUrl: string | undefined): string | null {
  if (!raw || !trustedAppUrl) return null;

  let trusted: URL;
  let target: URL;
  try {
    trusted = new URL(trustedAppUrl);
    target = new URL(raw);
  } catch {
    return null;
  }

  if (target.origin !== trusted.origin) return null;
  if (target.username || target.password) return null;
  if (target.search || target.hash) return null;
  if (!INVITE_PATH.test(target.pathname)) return null;
  return target.pathname;
}

/**
 * Returns the local path a password-recovery link continues to, or null. The same origin,
 * credential and shape rules as an invitation apply, and the recovery screen accepts exactly one
 * optional parameter: the pending invitation to carry on to once the password is set. The result
 * is rebuilt from the validated id rather than echoing the query that arrived, so nothing an
 * attacker appends can survive the round trip.
 */
export function recoveryDestination(raw: string | null, trustedAppUrl: string | undefined): string | null {
  if (!raw || !trustedAppUrl) return null;

  let trusted: URL;
  let target: URL;
  try {
    trusted = new URL(trustedAppUrl);
    target = new URL(raw);
  } catch {
    return null;
  }

  if (target.origin !== trusted.origin) return null;
  if (target.username || target.password) return null;
  if (target.hash) return null;
  if (target.pathname !== RESET_PATH) return null;

  // A repeated `invite` yields two keys and is refused rather than resolved to one of them.
  const keys = [...target.searchParams.keys()];
  if (keys.length === 0) return RESET_PATH;
  if (keys.length !== 1 || keys[0] !== "invite") return null;

  const invitation = invitationContinuation(target.searchParams.get("invite"));
  return invitation === null ? null : `${RESET_PATH}?invite=${invitation}`;
}

/**
 * The invitation a password-recovery link continues to, as a bare id. The value leaves the server
 * in the recovery email and comes back through the browser, so it is never parsed as a location:
 * anything that is not exactly a UUID - a URL, a path, a query, a fragment, a traversal segment,
 * an array of values - is refused outright. Returns the canonical lower-case id, or null.
 */
export function invitationContinuation(raw: unknown): string | null {
  if (typeof raw !== "string" || !UUID.test(raw)) return null;
  return raw.toLowerCase();
}

/**
 * The local destination for a recovery continuation. The path is assembled here rather than at the
 * call sites, so no caller can build a destination of its own, and the only shape it can ever take
 * is one invitation on this deployment. Null when the value does not name exactly one invitation.
 */
export function inviteContinuationPath(raw: unknown): string | null {
  const id = invitationContinuation(raw);
  return id === null ? null : `/invite/${id}`;
}
