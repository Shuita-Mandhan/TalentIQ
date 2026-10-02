import Link from "next/link";
import type { OrganizationContext, UserContext } from "@/lib/auth/organization-context";
import { MobileWorkspaceNav } from "./mobile-workspace-nav";
import { OrganizationSwitcher } from "./organization-switcher";
import { SignOutButton } from "./sign-out-button";
import { WorkspaceNav, type NavItem } from "./workspace-nav";

// The permanent frame for /app/[organizationSlug]/*. It renders on the server and owns only
// presentation: the layout above it has already proved tenant access, and each page and Server
// Action authorizes itself again regardless of what this shell chose to display.
//
// Two planes. The rail is the navigation plane - deep, substantial, always dark, the same material
// on desktop and inside the mobile panel. The canvas is warm and light, so the surfaces on it read
// as raised rather than drawn.

function ProductMark() {
  return (
    <Link
      href="/app"
      className="group flex items-center gap-2.5 rounded-md text-rail-foreground transition-opacity duration-150 hover:opacity-80"
    >
      <span
        aria-hidden
        className="grid size-6 shrink-0 place-items-center rounded-[5px] bg-accent text-[11px] font-semibold text-white"
      >
        T
      </span>
      <span className="text-sm font-semibold tracking-tight">TalentIQ</span>
    </Link>
  );
}

export function WorkspaceShell({
  user,
  context,
  items,
  children,
}: {
  user: UserContext;
  context: OrganizationContext;
  items: NavItem[];
  children: React.ReactNode;
}) {
  // One workspace is an identity, not a choice; a control would only imply an option that is not
  // there. The same element serves the rail and the mobile panel, so there is one implementation
  // of switching rather than two.
  const switcher =
    user.organizations.length > 1 ? (
      <OrganizationSwitcher organizations={user.organizations} currentSlug={context.organization.slug} />
    ) : null;

  const identity = switcher ?? (
    <div className="flex items-center gap-2.5 rounded-lg border border-rail-border bg-rail-raised px-2.5 py-2">
      <span
        aria-hidden
        className="grid size-7 shrink-0 place-items-center rounded-md bg-accent/15 font-mono text-[11px] font-medium text-accent"
      >
        {context.organization.name.slice(0, 2).toUpperCase()}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium tracking-tight text-rail-foreground">
          {context.organization.name}
        </span>
        <span className="block font-mono text-[11px] text-rail-muted">
          {context.organization.slug}
        </span>
      </span>
    </div>
  );

  const account = (
    <div className="space-y-3">
      <p className="truncate font-mono text-[11px] text-rail-muted" title={user.email ?? undefined}>
        {user.email ?? user.userId}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* The control plane is a separate surface, never a tenant capability. */}
        {user.isPlatformAdmin && (
          <Link
            href="/platform"
            className="text-sm font-medium text-rail-muted transition-colors duration-150 hover:text-rail-foreground"
          >
            Platform
          </Link>
        )}
        <SignOutButton variant="rail" />
      </div>
    </div>
  );

  return (
    <div className="flex flex-1 flex-col lg:flex-row">
      <div className="on-rail sticky top-0 z-40 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-rail-border bg-rail px-4 lg:hidden">
        <div className="flex min-w-0 items-center gap-2.5">
          <ProductMark />
          <span aria-hidden className="text-rail-border">
            /
          </span>
          <span className="truncate text-sm font-medium tracking-tight text-rail-muted">
            {context.organization.name}
          </span>
        </div>
        <MobileWorkspaceNav items={items} switcher={switcher}>
          {account}
        </MobileWorkspaceNav>
      </div>

      <aside className="on-rail hidden bg-rail lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-[268px] lg:shrink-0 lg:flex-col">
        <div className="px-4 pt-5 pb-4">
          <ProductMark />
          <div className="mt-4">{identity}</div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-2">
          <p className="px-3.5 pb-2 font-mono text-[10px] tracking-[0.12em] text-rail-muted/70 uppercase">
            Workspace
          </p>
          <WorkspaceNav items={items} />
        </div>

        <div className="border-t border-rail-border px-4 py-4">{account}</div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="mx-auto w-full max-w-5xl flex-1 px-6 py-10 sm:px-10 lg:px-12 lg:py-14">
          {children}
        </div>
      </main>
    </div>
  );
}
