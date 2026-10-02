import type { Metadata } from "next";
import Link from "next/link";
import { requirePlatformPageAccess } from "@/lib/platform/auth";
import {
  getPlatformOrganizations,
  getPlatformOverview,
  getPlatformServices,
  type PlatformOrganizationOverview,
} from "@/lib/platform/data";
import { PlatformTopology, type TopologyNode } from "@/components/platform/platform-topology";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = { title: "Platform" };

function administrationState(
  organization: PlatformOrganizationOverview,
): { label: string; tone: "pending" | "ready" | "none" } {
  if (organization.has_recovery_manager) return { label: "Ready", tone: "ready" };
  if (organization.pending_admin_invitation_id) return { label: "Setup pending", tone: "pending" };
  return { label: "No administrator", tone: "none" };
}

export default async function PlatformOverviewPage() {
  await requirePlatformPageAccess();
  const [overview, services] = await Promise.all([getPlatformOverview(), getPlatformServices()]);

  // The overview function is the one thing this page cannot do without. When it is unreachable the
  // page says so and still shows what it can, rather than becoming an error.
  if (!overview) {
    const fallback = await getPlatformOrganizations(8);
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">Platform</h1>
        <div className="mt-8 rounded-xl border border-destructive/30 bg-destructive/5 p-5">
          <p className="font-medium tracking-tight">Administration state unavailable</p>
          <p className="mt-1.5 max-w-prose text-sm text-pretty text-muted-foreground">
            The platform overview function could not be reached, so onboarding state cannot be shown
            for any organization. If the organization bootstrap migrations have not been applied to
            this project yet, that is the likely cause.
          </p>
        </div>
        <section className="mt-10">
          <h2 className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            Organizations
          </h2>
          <ul className="mt-4 overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
            {fallback.map((organization, index) => (
              <li
                key={organization.id}
                className={index > 0 ? "border-t border-border" : undefined}
              >
                <Link
                  href={`/platform/organizations/${organization.id}`}
                  className="flex items-center justify-between gap-6 px-5 py-3.5 transition-colors duration-150 hover:bg-surface-sunken"
                >
                  <span className="font-medium tracking-tight">{organization.name}</span>
                  <StatusBadge active={organization.is_active} labels={["Active", "Suspended"]} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </>
    );
  }

  const active = overview.filter((organization) => organization.is_active);
  const suspended = overview.filter((organization) => !organization.is_active);
  const ready = overview.filter((organization) => organization.has_recovery_manager);
  // Anything active that cannot administer itself is work for the operator, whether an
  // administrator was ever named or the setup is still outstanding.
  const needsAttention = active.filter((organization) => !organization.has_recovery_manager);
  const pendingMemberInvitations = overview.reduce(
    (total, organization) => total + organization.pending_member_invitations,
    0,
  );
  const organizationsWithPendingMembers = overview.filter(
    (organization) => organization.pending_member_invitations > 0,
  ).length;

  const nodes: TopologyNode[] = overview.map((organization) => ({
    id: organization.organization_id,
    name: organization.name,
    href: `/platform/organizations/${organization.organization_id}`,
    state: !organization.is_active
      ? "suspended"
      : organization.has_recovery_manager
        ? "ready"
        : "pending",
  }));
  // Whatever wants attention goes into the scene first.
  nodes.sort((a, b) => Number(b.state === "pending") - Number(a.state === "pending"));

  const health = [
    { label: "Organizations", value: overview.length },
    { label: "Active", value: active.length },
    { label: "Administration ready", value: ready.length },
    { label: "Awaiting setup", value: needsAttention.length },
    ...(suspended.length > 0 ? [{ label: "Suspended", value: suspended.length }] : []),
  ];

  return (
    <div className="animate-rise motion-reduce:animate-none">
      <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,480px)] lg:gap-12">
        <div>
          <p className="font-mono text-[11px] tracking-[0.12em] text-accent uppercase">
            Control plane
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Platform
          </h1>
          <p className="mt-3 max-w-md text-pretty text-muted-foreground">
            {needsAttention.length === 0
              ? `All ${overview.length} organization${overview.length === 1 ? "" : "s"} administer themselves. Nothing is waiting on you.`
              : `${needsAttention.length} of ${overview.length} organization${overview.length === 1 ? "" : "s"} cannot yet administer ${needsAttention.length === 1 ? "itself" : "themselves"}.`}
          </p>

          <dl className="mt-8 grid grid-cols-2 gap-x-8 gap-y-5 border-t border-border pt-6 sm:grid-cols-3">
            {health.map(({ label, value }) => (
              <div key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="-mx-2 order-first sm:mx-0 lg:order-none">
          <PlatformTopology nodes={nodes} totalOrganizations={overview.length} />
        </div>
      </div>

      {/* The operational heart of the page: what the operator has to do next. */}
      <section className="mt-14">
        <h2 className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
          Needs attention
        </h2>
        {needsAttention.length === 0 ? (
          <div className="mt-4 flex items-center gap-3.5 rounded-xl border border-border bg-surface p-5 shadow-sm">
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-accent" />
            <div>
              <p className="font-medium tracking-tight">All clear</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                No organizations currently require platform attention.
              </p>
            </div>
          </div>
        ) : (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              {needsAttention.length} organization{needsAttention.length === 1 ? " is" : "s are"}{" "}
              waiting for administrator setup.
            </p>
            <ul className="mt-4 grid gap-3">
              {needsAttention.map((organization) => (
                <li key={organization.organization_id}>
                  <Link
                    href={`/platform/organizations/${organization.organization_id}`}
                    className="group flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-xl border border-accent/30 bg-surface p-5 shadow-sm transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-accent hover:shadow-md motion-reduce:hover:translate-y-0"
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-2.5">
                        <span className="relative flex size-2 shrink-0">
                          <span className="absolute inset-0 animate-pulse-ring rounded-full bg-accent motion-reduce:hidden" />
                          <span className="relative size-2 rounded-full bg-accent" />
                        </span>
                        <span className="font-medium tracking-tight transition-colors duration-150 group-hover:text-accent">
                          {organization.name}
                        </span>
                      </span>
                      <span className="mt-1.5 block text-sm text-muted-foreground">
                        {organization.pending_admin_email ? (
                          <>
                            Administrator setup pending ·{" "}
                            <span className="font-mono text-[13px]">
                              {organization.pending_admin_email}
                            </span>
                          </>
                        ) : (
                          "No administrator configured"
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Created {formatDate(organization.created_at)}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 text-sm font-medium text-accent">
                      View organization
                      <span
                        aria-hidden
                        className="transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:group-hover:translate-x-0"
                      >
                        &rarr;
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* Onboarding progress as a ratio, not a second copy of the list above it. */}
      <section className="mt-12 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-border bg-surface p-5 shadow-sm">
          <h2 className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            Administrator onboarding
          </h2>
          <div className="mt-4 flex items-end gap-8">
            <div>
              <p className="text-2xl font-semibold tracking-tight tabular-nums">{ready.length}</p>
              <p className="text-xs text-muted-foreground">Administration ready</p>
            </div>
            <div>
              <p className="text-2xl font-semibold tracking-tight tabular-nums">
                {needsAttention.length}
              </p>
              <p className="text-xs text-muted-foreground">Pending setup</p>
            </div>
          </div>
          <div
            aria-hidden
            className="mt-4 flex h-1.5 overflow-hidden rounded-full bg-surface-sunken"
          >
            <div
              className="bg-accent transition-[width] duration-500"
              style={{
                width: `${overview.length === 0 ? 0 : (ready.length / overview.length) * 100}%`,
              }}
            />
          </div>
        </div>

        <div className="rounded-xl border border-border bg-surface p-5 shadow-sm">
          <h2 className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            Services
          </h2>
          <p className="mt-4 text-2xl font-semibold tracking-tight tabular-nums">
            {services.length}
          </p>
          <p className="text-xs text-muted-foreground">
            {services.length === 0 ? "No services registered yet" : "Registered services"}
          </p>
          <Link
            href="/platform/services"
            className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            Manage services
            <span aria-hidden>&rarr;</span>
          </Link>
          {pendingMemberInvitations > 0 && (
            // An aggregate only. Who each tenant invited, and anything that could change it, stays
            // inside that organization's own Members page.
            <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
              {pendingMemberInvitations} pending member invitation
              {pendingMemberInvitations === 1 ? "" : "s"} across {organizationsWithPendingMembers}{" "}
              organization{organizationsWithPendingMembers === 1 ? "" : "s"}
            </p>
          )}
        </div>
      </section>

      <section className="mt-12">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            Recent organizations
          </h2>
          <Link
            href="/platform/organizations"
            className="text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            View all
          </Link>
        </div>

        {overview.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-border-strong bg-surface-sunken/60 p-8 text-center">
            <p className="font-medium tracking-tight">No organizations yet</p>
            <p className="mx-auto mt-1.5 max-w-sm text-sm text-pretty text-muted-foreground">
              Create the first customer organization and name the person who will administer it.
            </p>
            <Link
              href="/platform/organizations/new"
              className="mt-5 inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-medium text-white shadow-sm transition-colors duration-150 hover:bg-accent-strong"
            >
              Create organization
            </Link>
          </div>
        ) : (
          <ul className="mt-4 overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
            {overview.slice(0, 6).map((organization, index) => {
              const state = administrationState(organization);
              return (
                <li
                  key={organization.organization_id}
                  className={index > 0 ? "border-t border-border" : undefined}
                >
                  <Link
                    href={`/platform/organizations/${organization.organization_id}`}
                    className="group flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3.5 transition-colors duration-150 hover:bg-surface-sunken sm:px-5"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium tracking-tight transition-colors duration-150 group-hover:text-accent">
                        {organization.name}
                      </span>
                      <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                        {organization.slug}
                      </span>
                    </span>
                    <StatusBadge
                      active={organization.is_active}
                      labels={["Active", "Suspended"]}
                    />
                    <span
                      className={`inline-flex items-center gap-1.5 text-sm ${
                        state.tone === "ready" ? "text-muted-foreground" : "text-accent"
                      }`}
                    >
                      <span
                        aria-hidden
                        className={`size-1.5 rounded-full ${
                          state.tone === "ready" ? "bg-border-strong" : "bg-accent"
                        }`}
                      />
                      {state.label}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {formatDate(organization.created_at)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
