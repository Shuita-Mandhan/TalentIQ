import { RUBRIC_TOTAL, type RubricSummary } from "@/lib/jobs/types";

// The one reading of rubric readiness, used on the rubric itself and in the job's summary.
//
// The bar is the whole point: a rubric is a hundred points, and what matters at a glance is how
// far from a hundred this one is and how it splits between required and preferred. Over 100 is
// shown as over, never clipped to look full.

export function RubricReadinessBar({ summary }: { summary: RubricSummary }) {
  const { totalWeight, requiredWeight, preferredWeight, readiness } = summary;
  // Scaled against whichever is larger, so an over-weighted rubric visibly overflows its target
  // instead of pretending to be complete.
  const scale = Math.max(totalWeight, RUBRIC_TOTAL) || 1;
  const requiredPercent = (requiredWeight / scale) * 100;
  const preferredPercent = (preferredWeight / scale) * 100;
  const targetPercent = (RUBRIC_TOTAL / scale) * 100;

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <p className="flex items-baseline gap-2">
          <span
            className={`text-3xl font-semibold tracking-tight tabular-nums ${
              readiness === "ready" ? "text-accent-strong" : ""
            }`}
          >
            {totalWeight}
          </span>
          <span className="text-sm text-muted-foreground">/ {RUBRIC_TOTAL} points</span>
        </p>
        <RubricReadinessPill readiness={readiness} />
      </div>

      <div
        className="relative mt-3 h-2 overflow-hidden rounded-full bg-surface-sunken"
        role="img"
        aria-label={`Weights total ${totalWeight} of ${RUBRIC_TOTAL}: ${requiredWeight} required, ${preferredWeight} preferred`}
      >
        <div className="flex h-full">
          <div
            className="bg-accent transition-[width] duration-300"
            style={{ width: `${requiredPercent}%` }}
          />
          <div
            className="bg-accent/40 transition-[width] duration-300"
            style={{ width: `${preferredPercent}%` }}
          />
        </div>
        {/* Where 100 sits, so an over-weighted rubric shows the line it has crossed. */}
        {totalWeight > RUBRIC_TOTAL && (
          <span
            aria-hidden
            className="absolute inset-y-0 w-px bg-destructive"
            style={{ left: `${targetPercent}%` }}
          />
        )}
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-[2px] bg-accent" />
          <dt>Required</dt>
          <dd className="font-medium text-foreground tabular-nums">
            {summary.required} · {requiredWeight}
          </dd>
        </div>
        <div className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-[2px] bg-accent/40" />
          <dt>Preferred</dt>
          <dd className="font-medium text-foreground tabular-nums">
            {summary.preferred} · {preferredWeight}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export function RubricReadinessPill({ readiness }: { readiness: RubricSummary["readiness"] }) {
  const ready = readiness === "ready";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        ready
          ? "border-accent/30 bg-accent-soft text-accent-strong"
          : "border-border-strong bg-surface-sunken text-muted-foreground"
      }`}
    >
      <span aria-hidden className={`size-1.5 rounded-full ${ready ? "bg-accent" : "bg-border-strong"}`} />
      {ready ? "Ready" : readiness === "empty" ? "Empty" : "Incomplete"}
    </span>
  );
}
