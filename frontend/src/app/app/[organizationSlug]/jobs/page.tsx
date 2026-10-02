import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { hasPermission } from "@/lib/auth/authorization";
import { requireOrganizationAccess } from "@/lib/auth/organization-context";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { getJobs } from "@/lib/jobs/jobs";
import {
  JOB_SORTS as SORTS,
  JOB_STATUSES,
  STATUS_LABELS,
  filterAndSortJobs,
  type JobSort as Sort,
  type JobStatus,
} from "@/lib/jobs/types";
import { PageHeading } from "@/components/layout/page-heading";
import { JobStatusPill } from "@/components/jobs/job-status-pill";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = { title: "Jobs" };

function one(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function JobsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationSlug: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { organizationSlug } = await params;
  const { context } = await requireOrganizationAccess(organizationSlug);
  if (!hasPermission(context, PERMISSIONS.JOBS_VIEW)) notFound();
  const canManage = hasPermission(context, PERMISSIONS.JOBS_MANAGE);

  const jobs = await getJobs(context.organization.id);
  const query = await searchParams;

  // The query is read here and applied by a pure function, so what the list shows is testable
  // without a browser. The set is the organization's own jobs, already fetched, and the controls
  // stay plain links that work without JavaScript.
  const search = one(query.q).trim();
  const statusFilter = (JOB_STATUSES as readonly string[]).includes(one(query.status))
    ? (one(query.status) as JobStatus)
    : null;
  const sort: Sort = one(query.sort) in SORTS ? (one(query.sort) as Sort) : "updated";

  const visible = filterAndSortJobs(jobs, { search, status: statusFilter, sort });

  const base = `/app/${organizationSlug}/jobs`;
  const linkFor = (next: Record<string, string>) => {
    const params = new URLSearchParams();
    const merged = { q: search, status: statusFilter ?? "", sort, ...next };
    for (const [key, value] of Object.entries(merged)) {
      if (value && !(key === "sort" && value === "updated")) params.set(key, value);
    }
    const queryString = params.toString();
    return queryString ? `${base}?${queryString}` : base;
  };

  const counts = JOB_STATUSES.map((status) => ({
    status,
    total: jobs.filter((job) => job.status === status).length,
  }));

  return (
    <>
      <PageHeading
        title="Jobs"
        description="Jobs are the foundation of screening: the requirements you define here are what candidates will later be evaluated against."
        actions={
          canManage && (
            <Link
              href={`${base}/new`}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-white shadow-sm transition-colors duration-150 hover:bg-accent-strong"
            >
              <span aria-hidden className="text-base leading-none">
                &#43;
              </span>
              New job
            </Link>
          )
        }
      />

      <form method="get" action={base} className="mt-6 flex flex-wrap items-center gap-3">
        <input
          type="search"
          name="q"
          defaultValue={search}
          placeholder="Search title, department or location"
          aria-label="Search jobs"
          className="h-10 min-w-0 flex-1 rounded-md border border-border bg-surface px-3.5 text-sm transition-colors duration-150 hover:border-border-strong focus:border-accent sm:max-w-xs"
        />
        {statusFilter && <input type="hidden" name="status" value={statusFilter} />}
        {sort !== "updated" && <input type="hidden" name="sort" value={sort} />}
        <button
          type="submit"
          className="h-10 rounded-md border border-border bg-surface px-3.5 text-sm font-medium transition-colors duration-150 hover:border-border-strong hover:bg-surface-sunken"
        >
          Search
        </button>

        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Sort</span>
          {(Object.keys(SORTS) as Sort[]).map((option) => (
            <Link
              key={option}
              href={linkFor({ sort: option })}
              aria-current={sort === option ? "true" : undefined}
              className={`rounded-md px-2.5 py-1.5 text-xs transition-colors duration-150 ${
                sort === option
                  ? "bg-surface-sunken font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {SORTS[option]}
            </Link>
          ))}
        </div>
      </form>

      <div className="mt-4 flex flex-wrap items-center gap-1.5 border-b border-border pb-4">
        <Link
          href={linkFor({ status: "" })}
          aria-current={statusFilter === null ? "true" : undefined}
          className={`rounded-md px-2.5 py-1.5 text-xs transition-colors duration-150 ${
            statusFilter === null
              ? "bg-accent-soft font-medium text-accent-strong"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Active
        </Link>
        {counts.map(({ status, total }) => (
          <Link
            key={status}
            href={linkFor({ status })}
            aria-current={statusFilter === status ? "true" : undefined}
            className={`rounded-md px-2.5 py-1.5 text-xs transition-colors duration-150 ${
              statusFilter === status
                ? "bg-accent-soft font-medium text-accent-strong"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {STATUS_LABELS[status]}
            <span className="ml-1.5 font-mono tabular-nums opacity-60">{total}</span>
          </Link>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-border-strong bg-surface-sunken/60 p-10 text-center">
          <p className="font-medium tracking-tight">
            {jobs.length === 0 ? "No jobs yet" : "Nothing matches that"}
          </p>
          <p className="mx-auto mt-1.5 max-w-sm text-sm text-pretty text-muted-foreground">
            {jobs.length === 0
              ? "A job holds the description and the requirements screening will work from. Start with a draft — nothing is published until you open it."
              : "Try a different search, or clear the status filter."}
          </p>
          {jobs.length === 0 && canManage && (
            <Link
              href={`${base}/new`}
              className="mt-5 inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-medium text-white shadow-sm transition-colors duration-150 hover:bg-accent-strong"
            >
              Create the first job
            </Link>
          )}
        </div>
      ) : (
        <ul className="mt-6 grid gap-2.5">
          {visible.map((job) => (
            <li key={job.id}>
              <Link
                href={`${base}/${job.id}`}
                className="group flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-border bg-surface px-5 py-4 shadow-sm transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md motion-reduce:hover:translate-y-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium tracking-tight transition-colors duration-150 group-hover:text-accent">
                    {job.title}
                  </span>
                  <span className="mt-1 block truncate text-sm text-muted-foreground">
                    {[job.department, job.location].filter(Boolean).join(" · ") || "No department or location set"}
                  </span>
                </span>

                {/* Wraps rather than overflowing: at 320px the openings, status and date sit on
                    their own line instead of forcing a horizontal scroll. */}
                <span className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:gap-x-6">
                  <span className="text-right">
                    <span className="block text-sm font-medium tabular-nums">{job.openings}</span>
                    <span className="block text-xs text-muted-foreground">
                      opening{job.openings === 1 ? "" : "s"}
                    </span>
                  </span>
                  <JobStatusPill status={job.status} />
                  <span className="hidden font-mono text-xs text-muted-foreground sm:block">
                    {formatDate(job.updated_at)}
                  </span>
                  <span
                    aria-hidden
                    className="text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-accent motion-reduce:group-hover:translate-x-0"
                  >
                    &rarr;
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
