import { STATUS_LABELS, type JobStatus } from "@/lib/jobs/types";

// One reading of job status everywhere it appears. Colour carries meaning rather than decoration:
// accent for the one state that is actively hiring, muted for the ones that are not, and a drained
// treatment for archived so it reads as history.
const STYLES: Record<JobStatus, string> = {
  draft: "border-border-strong bg-surface text-muted-foreground",
  open: "border-accent/30 bg-accent-soft text-accent-strong",
  paused: "border-border-strong bg-surface-sunken text-foreground/70",
  closed: "border-border bg-surface-sunken text-muted-foreground",
  archived: "border-dashed border-border-strong bg-transparent text-muted-foreground",
};

export function JobStatusPill({ status }: { status: JobStatus }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${STYLES[status]}`}
    >
      {status === "open" && (
        <span aria-hidden className="relative flex size-1.5">
          <span className="absolute inset-0 animate-pulse-ring rounded-full bg-accent motion-reduce:hidden" />
          <span className="relative size-1.5 rounded-full bg-accent" />
        </span>
      )}
      {STATUS_LABELS[status]}
    </span>
  );
}
