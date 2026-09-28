// The Phase 2F database functions signal expected failures with dedicated SQLSTATEs; map those to
// user-facing text here so no database wording ever reaches the UI.
const MESSAGES: Record<string, string> = {
  "42501": "You do not have permission to perform this action.",
  "22023": "One or more selections are not valid for this organization.",
  TQ001: "This role is managed by TalentIQ and cannot be changed.",
  TQ002: "Remove this role from its members before deleting it.",
  TQ003: "You cannot deactivate your own membership.",
  TQ004:
    "This change would leave the organization without anyone who can manage both members and roles.",
  TQ005: "You cannot grant organization permissions that you do not have yourself.",
};

export const GENERIC_FAILURE = "Unable to save the change. Please try again.";

export function accessErrorMessage(
  error: { code?: string },
  specific: { notFound?: string; duplicate?: string } = {},
): string {
  if (error.code === "P0002" && specific.notFound) return specific.notFound;
  if (error.code === "23505" && specific.duplicate) return specific.duplicate;
  return (error.code && MESSAGES[error.code]) || GENERIC_FAILURE;
}
