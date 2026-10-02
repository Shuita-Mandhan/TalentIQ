// The Phase 2F database functions signal expected failures with dedicated SQLSTATEs; map those to
// user-facing text here so no database wording ever reaches the UI.

/**
 * Shown to the recipient of a platform-issued administrator setup whose organization has since
 * gained an administrator of its own. Deliberately says nothing about that organization's current
 * administration, and does not offer to downgrade them to an ordinary membership: they were
 * invited as the administrator, and quietly changing what they accepted would be misleading.
 */
export const BOOTSTRAP_SETUP_INACTIVE =
  "This administrator setup is no longer active. Contact the organization or TalentIQ administrator if you still need access.";

const MESSAGES: Record<string, string> = {
  "42501": "You do not have permission to perform this action.",
  "22023": "One or more selections are not valid for this organization.",
  TQ001: "This role is managed by TalentIQ and cannot be changed.",
  TQ002: "Remove this role from its members before deleting it.",
  TQ003: "You cannot deactivate your own membership.",
  TQ004:
    "This change would leave the organization without anyone who can manage both members and roles.",
  TQ005: "You cannot grant organization permissions that you do not have yourself.",
  TQ006:
    "This organization already has an administrator, so it manages its own members from inside the workspace.",
  TQ007: BOOTSTRAP_SETUP_INACTIVE,
  TQ008:
    "An administrator setup is already pending for this organization. Cancel it before naming someone else.",
  TQ009: "That status change is not available for this job.",
  TQ010: "This job is archived, so it can no longer be changed.",
  TQ012: "This resume has already been processed.",
  TQ013: "This resume is already being processed.",
  "23514": "One or more values are outside what this field allows.",
  "23503": "That reference does not belong to this organization.",
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
