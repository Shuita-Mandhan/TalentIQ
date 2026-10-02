import type { Metadata } from "next";
import Link from "next/link";
import { hasPermission } from "@/lib/auth/authorization";
import { requireOrganizationAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { getOrganizationMembers, getOrganizationRoles } from "@/lib/organization/access-data";
import { PERMISSION_LABELS } from "@/lib/organization/permission-labels";
import { getJobs } from "@/lib/jobs/jobs";
import { summariseJobs } from "@/lib/jobs/types";
import { AccessCore, type CoreNode } from "@/components/workspace/access-core";
import { JobStatusPill } from "@/components/jobs/job-status-pill";
import { JobsIcon, MembersIcon, RolesIcon, SettingsIcon } from "@/components/layout/nav-icons";

export const metadata: Metadata = { title: "Workspace" };

export default async function OrganizationWorkspacePage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const { user, context } = await requireOrganizationAccess(organizationSlug);

  const canViewMembers = hasPermission(context, PERMISSIONS.MEMBERS_VIEW);
  const canViewRoles = hasPermission(context, PERMISSIONS.ROLES_VIEW);
  const canUpdateOrganization = hasPermission(context, PERMISSIONS.ORGANIZATION_UPDATE);
  const canViewJobs = hasPermission(context, PERMISSIONS.JOBS_VIEW);
  const canManageJobs = hasPermission(context, PERMISSIONS.JOBS_MANAGE);

  // Only what this caller is allowed to know. Where they are not, the topology shows a dash rather
  // than a number it has no right to, and never a guess.
  const [members, roles, jobs] = await Promise.all([
    canViewMembers ? getOrganizationMembers(context.organization.id) : null,
    canViewRoles ? getOrganizationRoles(context.organization.id) : null,
    canViewJobs ? getJobs(context.organization.id) : null,
  ]);
  const jobSummary = jobs ? summariseJobs(jobs) : null;
  const recentJobs = (jobs ?? []).filter((job) => job.status !== "archived").slice(0, 4);

  const nodes: CoreNode[] = [
    {
      label: "Members",
      value: members ? String(members.filter((member) => member.is_active).length) : "—",
      hint: members ? "active in this workspace" : "not visible to you",
    },
    {
      label: "Roles",
      value: roles ? String(roles.length) : "—",
      hint: roles ? "permission bundles defined" : "not visible to you",
    },
    {
      label: "Your access",
      value: String(context.permissions.length),
      hint: context.permissions.length === 0 ? "no roles assigned yet" : "permissions granted to you",
    },
  ];

  const shortcuts = [
    canViewJobs && {
      href: `/app/${organizationSlug}/jobs`,
      Icon: JobsIcon,
      title: "Jobs",
      detail: "Open roles and the requirements screening will work from.",
    },
    canViewMembers && {
      href: `/app/${organizationSlug}/members`,
      Icon: MembersIcon,
      title: "Members",
      detail: "Who can reach this workspace, and the roles they hold.",
    },
    canViewRoles && {
      href: `/app/${organizationSlug}/roles`,
      Icon: RolesIcon,
      title: "Roles",
      detail: "Permission bundles this organization defines for itself.",
    },
    canUpdateOrganization && {
      href: `/app/${organizationSlug}/settings`,
      Icon: SettingsIcon,
      title: "Settings",
      detail: "The organization's name and identity within TalentIQ.",
    },
  ].filter((shortcut) => shortcut !== false);

  const access = context.permissions
    .map((permission) => PERMISSION_LABELS[permission].label)
    .sort((a, b) => a.localeCompare(b));

  return (
    <div className="animate-rise motion-reduce:animate-none">
      <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)] lg:gap-14">
        <div>
          <p className="font-mono text-[11px] tracking-[0.12em] text-accent uppercase">Workspace</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            {context.organization.name}
          </h1>
          <p className="mt-3 max-w-md text-pretty text-muted-foreground">
            Manage workspace access, roles, and permissions for your organization.
          </p>

          <dl className="mt-8 flex flex-wrap gap-x-10 gap-y-4 border-t border-border pt-6 text-sm">
            <div>
              <dt className="text-muted-foreground">Signed in as</dt>
              <dd className="mt-1 font-mono text-[13px] break-all">{user.email ?? user.userId}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Workspace</dt>
              <dd className="mt-1 font-mono text-[13px]">{context.organization.slug}</dd>
            </div>
          </dl>
        </div>

        <div className="-mx-2 sm:mx-0">
          <AccessCore organizationName={context.organization.name} nodes={nodes} />
        </div>
      </div>

      {/* A starting point, not a dashboard: real counts from the jobs this person may see, and the
          one action that moves recruitment forward. Nothing about candidates, because there are
          none yet. */}
      {jobSummary && (
        <section className="mt-14">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <h2 className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
              Recruitment
            </h2>
            {canManageJobs && (
              <Link
                href={`/app/${organizationSlug}/jobs/new`}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3.5 text-sm font-medium text-white shadow-sm transition-colors duration-150 hover:bg-accent-strong"
              >
                <span aria-hidden className="text-base leading-none">
                  &#43;
                </span>
                Create a job
              </Link>
            )}
          </div>

          {jobSummary.total === 0 ? (
            <div className="mt-4 rounded-xl border border-dashed border-border-strong bg-surface-sunken/60 p-8">
              <p className="font-medium tracking-tight">No jobs yet</p>
              <p className="mt-1.5 max-w-prose text-sm text-pretty text-muted-foreground">
                A job holds the description and the requirements that screening will later work
                from. Start one as a draft whenever you are ready.
              </p>
            </div>
          ) : (
            <>
              <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-5 rounded-xl border border-border bg-surface p-5 shadow-sm sm:grid-cols-4">
                {[
                  ["Open", jobSummary.open],
                  ["Drafts", jobSummary.draft],
                  ["Paused", jobSummary.paused],
                  ["Openings", jobSummary.openings],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>

              {recentJobs.length > 0 && (
                <ul className="mt-3 overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
                  {recentJobs.map((job, index) => (
                    <li key={job.id} className={index > 0 ? "border-t border-border" : undefined}>
                      <Link
                        href={`/app/${organizationSlug}/jobs/${job.id}`}
                        className="group flex items-center justify-between gap-4 px-5 py-3.5 transition-colors duration-150 hover:bg-surface-sunken"
                      >
                        <span className="min-w-0 truncate text-sm font-medium tracking-tight transition-colors duration-150 group-hover:text-accent">
                          {job.title}
                        </span>
                        <JobStatusPill status={job.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      )}

      {shortcuts.length > 0 && (
        <section className="mt-14">
          <h2 className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            Manage
          </h2>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {shortcuts.map(({ href, Icon, title, detail }) => (
              <li key={href}>
                <Link
                  href={href}
                  className="group flex h-full flex-col rounded-xl border border-border bg-surface p-5 shadow-sm transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md motion-reduce:hover:translate-y-0"
                >
                  <span className="flex items-center gap-2.5">
                    <Icon className="size-4 shrink-0 text-accent" />
                    <span className="font-medium tracking-tight">{title}</span>
                    <span
                      aria-hidden
                      className="ml-auto text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-accent motion-reduce:group-hover:translate-x-0"
                    >
                      &rarr;
                    </span>
                  </span>
                  <span className="mt-2 text-sm text-pretty text-muted-foreground">{detail}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-12">
        {access.length === 0 ? (
          <div className="rounded-xl border border-border bg-surface-sunken p-5">
            <h2 className="font-medium tracking-tight">No roles assigned yet</h2>
            <p className="mt-1.5 max-w-prose text-sm text-pretty text-muted-foreground">
              You are an active member of {context.organization.name}, but your membership carries
              no roles, so there is nothing here for you to manage yet. Someone who manages members
              can assign them.
            </p>
          </div>
        ) : (
          // Secondary by design: useful to confirm, never the centrepiece.
          <details className="group rounded-xl border border-border bg-surface px-5 py-4">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium tracking-tight">
              <span
                aria-hidden
                className="text-muted-foreground transition-transform duration-200 group-open:rotate-90"
              >
                &rsaquo;
              </span>
              Your effective access
              <span className="ml-auto font-mono text-xs font-normal text-muted-foreground">
                {access.length}
              </span>
            </summary>
            <ul className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
              {access.map((label) => (
                <li
                  key={label}
                  className="rounded-md bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent-strong"
                >
                  {label}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}
