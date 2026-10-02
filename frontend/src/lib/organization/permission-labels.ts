import { PERMISSIONS, type PermissionKey } from "@/lib/auth/permissions";

// Display metadata only; the keys themselves come from the canonical catalog.
export const PERMISSION_LABELS: Record<PermissionKey, { label: string; description: string }> = {
  [PERMISSIONS.ORGANIZATION_VIEW]: {
    label: "View organization",
    description: "See organization details and settings.",
  },
  [PERMISSIONS.ORGANIZATION_UPDATE]: {
    label: "Update organization",
    description: "Edit organization details.",
  },
  [PERMISSIONS.MEMBERS_VIEW]: {
    label: "View members",
    description: "See who belongs to the organization and their roles.",
  },
  [PERMISSIONS.MEMBERS_MANAGE]: {
    label: "Manage members",
    description: "Add, deactivate and reactivate members; assign roles.",
  },
  [PERMISSIONS.ROLES_VIEW]: {
    label: "View roles",
    description: "See roles and the permissions they grant.",
  },
  [PERMISSIONS.ROLES_MANAGE]: {
    label: "Manage roles",
    description: "Create, edit and delete custom roles and their permissions.",
  },
  [PERMISSIONS.JOBS_VIEW]: {
    label: "View jobs",
    description: "See jobs and the requirements defined for them.",
  },
  [PERMISSIONS.JOBS_MANAGE]: {
    label: "Manage jobs",
    description: "Create and edit jobs, change their status, and edit their requirements.",
  },
};
