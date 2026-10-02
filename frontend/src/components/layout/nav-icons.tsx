// Four line glyphs drawn for these four routes, rather than a dependency for four shapes. They
// share one grid, one stroke weight and one visual logic: a workspace plane, people, a key, a
// dial. Each is decorative beside its own text label, so none of them is announced.

type IconProps = { className?: string };

const base = "size-4 shrink-0";

function Frame({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? base}
    >
      {children}
    </svg>
  );
}

/** Overview: the workspace plane, seen slightly from above. */
export function OverviewIcon(props: IconProps) {
  return (
    <Frame {...props}>
      <path d="M8 2.2 14 5.4 8 8.6 2 5.4 8 2.2Z" />
      <path d="M2 8.4 8 11.6l6-3.2" />
      <path d="M2 11.2 8 14.4l6-3.2" opacity="0.55" />
    </Frame>
  );
}

/** Members: two people, one behind the other. */
export function MembersIcon(props: IconProps) {
  return (
    <Frame {...props}>
      <circle cx="6.3" cy="5.6" r="2.3" />
      <path d="M2.2 13.4c0-2.3 1.8-3.9 4.1-3.9s4.1 1.6 4.1 3.9" />
      <path d="M10.8 3.7a2.3 2.3 0 0 1 0 3.9" opacity="0.55" />
      <path d="M12.2 9.9c1.1.5 1.8 1.6 1.8 3.1" opacity="0.55" />
    </Frame>
  );
}

/** Roles: a key — a bundle of permissions that opens things. */
export function RolesIcon(props: IconProps) {
  return (
    <Frame {...props}>
      <circle cx="5.5" cy="5.6" r="2.9" />
      <path d="M7.6 7.7 13.3 13.4" />
      <path d="M11.4 11.5 10 12.9" />
      <path d="M12.9 10 11.6 11.3" />
    </Frame>
  );
}

/** Settings: a single dial, not the usual gear. */
export function SettingsIcon(props: IconProps) {
  return (
    <Frame {...props}>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 4.6v3.4l2.2 1.6" />
    </Frame>
  );
}

/** Jobs: an open requisition — a board with a raised lid. */
export function JobsIcon(props: IconProps) {
  return (
    <Frame {...props}>
      <path d="M2.4 5.8h11.2v7.2a.9.9 0 0 1-.9.9H3.3a.9.9 0 0 1-.9-.9V5.8Z" />
      <path d="M6.2 5.8V3.5a.8.8 0 0 1 .8-.8h2a.8.8 0 0 1 .8.8v2.3" />
      <path d="M2.4 9.1h11.2" opacity="0.55" />
    </Frame>
  );
}

export const NAV_ICONS = {
  overview: OverviewIcon,
  jobs: JobsIcon,
  members: MembersIcon,
  roles: RolesIcon,
  settings: SettingsIcon,
} as const;

export type NavIconName = keyof typeof NAV_ICONS;
