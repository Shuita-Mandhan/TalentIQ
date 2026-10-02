// The system permission catalog. Roles are dynamic per-organization bundles of these keys, so
// application code authorizes against keys, never role names. Keys must match public.permissions:
// when a migration adds one, add it here in the same change.
export const PERMISSIONS = {
  ORGANIZATION_VIEW: "organization.view",
  ORGANIZATION_UPDATE: "organization.update",
  MEMBERS_VIEW: "members.view",
  MEMBERS_MANAGE: "members.manage",
  ROLES_VIEW: "roles.view",
  ROLES_MANAGE: "roles.manage",
  JOBS_VIEW: "jobs.view",
  JOBS_MANAGE: "jobs.manage",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.values(PERMISSIONS));

/** Narrows database text to the catalog; keys this build does not know are ignored, not trusted. */
export function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === "string" && KNOWN_KEYS.has(value);
}
