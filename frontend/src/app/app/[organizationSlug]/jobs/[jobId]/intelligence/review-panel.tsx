"use client";

import { useActionState, useState } from "react";
import {
  CATEGORY_LABELS,
  IMPORTANCES,
  REQUIREMENT_CATEGORIES,
  type RequirementSuggestion,
} from "@/lib/jobs/types";
import {
  approveSuggestion,
  rejectSuggestion,
  type SuggestionState,
} from "./actions";

// Review. The whole point of this screen is that a suggestion is NOT a requirement: it is dashed,
// tinted and labelled until a person says otherwise, and the only way across that line is the
// Approve button. Editing before approving is the normal path, not an afterthought — what gets
// saved is the recruiter's wording, with the model's as a starting point.

const inputClass =
  "h-10 w-full rounded-md border border-border bg-surface px-3 text-sm transition-colors duration-150 hover:border-border-strong focus:border-accent";

function SuggestionRow({
  suggestion,
  organizationSlug,
  jobId,
  duplicateLabel,
  canManage,
}: {
  suggestion: RequirementSuggestion;
  organizationSlug: string;
  jobId: string;
  duplicateLabel: string | null;
  canManage: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [approveState, approveAction, approvePending] = useActionState<SuggestionState, FormData>(
    approveSuggestion,
    {},
  );
  const [rejectState, rejectAction, rejectPending] = useActionState<SuggestionState, FormData>(
    rejectSuggestion,
    {},
  );

  // Settled rows stay visible as a record of the decision, but stop offering it again.
  if (suggestion.status !== "pending") {
    const approved = suggestion.status === "approved";
    return (
      <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
        <span
          aria-hidden
          className={`size-1.5 shrink-0 rounded-full ${approved ? "bg-accent" : "bg-border-strong"}`}
        />
        <span
          className={`min-w-0 flex-1 text-sm break-words ${approved ? "text-muted-foreground" : "text-muted-foreground/60 line-through"}`}
        >
          {suggestion.requirement}
        </span>
        <span className="shrink-0 text-xs font-medium text-muted-foreground">
          {approved ? "Approved" : "Rejected"}
        </span>
      </li>
    );
  }

  return (
    <li className="px-4 py-3.5 transition-colors duration-150 hover:bg-surface-sunken/50 sm:px-5">
      {editing && canManage ? (
        <form action={approveAction} className="grid gap-3">
          <input type="hidden" name="organizationSlug" value={organizationSlug} />
          <input type="hidden" name="jobId" value={jobId} />
          <input type="hidden" name="suggestionId" value={suggestion.id} />
          <input
            name="requirement"
            defaultValue={suggestion.requirement}
            required
            maxLength={500}
            aria-label="Requirement"
            className={inputClass}
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <select
              name="category"
              defaultValue={suggestion.category}
              aria-label="Category"
              className={inputClass}
            >
              {REQUIREMENT_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {CATEGORY_LABELS[category]}
                </option>
              ))}
            </select>
            <select
              name="importance"
              defaultValue={suggestion.importance}
              aria-label="Importance"
              className={inputClass}
            >
              {IMPORTANCES.map((importance) => (
                <option key={importance} value={importance}>
                  {importance === "required" ? "Required" : "Preferred"}
                </option>
              ))}
            </select>
            <input
              name="weight"
              type="number"
              min={0}
              max={10}
              step={0.5}
              defaultValue={suggestion.weight}
              aria-label="Weight"
              className={inputClass}
            />
          </div>
          {approveState.error && (
            <p role="alert" className="text-sm text-destructive">
              {approveState.error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={approvePending}
              className="h-9 rounded-md bg-accent px-3.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-accent-strong disabled:cursor-progress disabled:opacity-70"
            >
              {approvePending ? "Saving…" : "Save & approve"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="h-9 rounded-md border border-border bg-surface px-3.5 text-sm font-medium transition-colors duration-150 hover:border-border-strong"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm break-words">{suggestion.requirement}</p>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="rounded bg-surface-sunken px-2 py-0.5 text-[11px] text-muted-foreground">
                {CATEGORY_LABELS[suggestion.category]}
              </span>
              <span
                className={`text-[11px] font-medium ${
                  suggestion.importance === "required" ? "text-accent-strong" : "text-muted-foreground"
                }`}
              >
                {suggestion.importance === "required" ? "Required" : "Preferred"}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                weight {suggestion.weight}
              </span>
              {duplicateLabel && (
                // Flagged, never merged: two similar extractions stay two rows and a person decides.
                <span className="rounded border border-border-strong px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {duplicateLabel}
                </span>
              )}
            </p>
          </div>

          {/* A reader may see what was suggested; deciding on it needs jobs.manage. The database
              refuses either way — this only stops offering an action that would be refused. */}
          <div className={`flex shrink-0 flex-wrap items-center gap-1.5 ${canManage ? "" : "hidden"}`}>
            <form action={approveAction}>
              <input type="hidden" name="organizationSlug" value={organizationSlug} />
              <input type="hidden" name="jobId" value={jobId} />
              <input type="hidden" name="suggestionId" value={suggestion.id} />
              <button
                type="submit"
                disabled={approvePending || rejectPending}
                aria-label={`Approve: ${suggestion.requirement}`}
                className="h-8 rounded-md bg-accent px-3 text-xs font-medium text-white transition-colors duration-150 hover:bg-accent-strong disabled:cursor-progress disabled:opacity-70"
              >
                {approvePending ? "Approving…" : "Approve"}
              </button>
            </form>
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={approvePending || rejectPending}
              className="h-8 rounded-md border border-border bg-surface px-3 text-xs font-medium transition-colors duration-150 hover:border-border-strong hover:bg-surface-sunken disabled:opacity-50"
            >
              Edit
            </button>
            <form action={rejectAction}>
              <input type="hidden" name="organizationSlug" value={organizationSlug} />
              <input type="hidden" name="jobId" value={jobId} />
              <input type="hidden" name="suggestionId" value={suggestion.id} />
              <button
                type="submit"
                disabled={approvePending || rejectPending}
                aria-label={`Reject: ${suggestion.requirement}`}
                className="h-8 rounded-md border border-border bg-surface px-3 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:border-destructive/40 hover:text-destructive disabled:opacity-50"
              >
                {rejectPending ? "Rejecting…" : "Reject"}
              </button>
            </form>
          </div>

          {(approveState.error || rejectState.error) && (
            <p role="alert" className="w-full text-xs text-destructive">
              {approveState.error ?? rejectState.error}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function ReviewPanel({
  suggestions,
  organizationSlug,
  jobId,
  canManage,
}: {
  suggestions: RequirementSuggestion[];
  organizationSlug: string;
  jobId: string;
  canManage: boolean;
}) {
  const pending = suggestions.filter((item) => item.status === "pending").length;
  const groupCounts = new Map<number, number>();
  for (const item of suggestions) {
    if (item.duplicate_group !== null) {
      groupCounts.set(item.duplicate_group, (groupCounts.get(item.duplicate_group) ?? 0) + 1);
    }
  }

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className="text-lg font-semibold tracking-tight">Suggested requirements</h2>
        <p className="text-sm text-muted-foreground">
          {pending === 0 ? "All reviewed" : `${pending} awaiting review`}
        </p>
      </div>
      <p className="mt-1.5 max-w-prose text-sm text-pretty text-muted-foreground">
        Nothing here is part of the job yet. Approve what is right, edit what is close, reject the
        rest — only what you approve becomes a requirement.
      </p>

      {/* Dashed and tinted throughout: this block must never read as the approved list. */}
      <ul className="mt-4 divide-y divide-dashed divide-border-strong overflow-hidden rounded-xl border border-dashed border-border-strong bg-surface-sunken/40">
        {suggestions.map((suggestion) => (
          <SuggestionRow
            key={suggestion.id}
            suggestion={suggestion}
            organizationSlug={organizationSlug}
            jobId={jobId}
            canManage={canManage}
            duplicateLabel={
              suggestion.duplicate_group !== null &&
              (groupCounts.get(suggestion.duplicate_group) ?? 0) > 1
                ? "Possible repeat"
                : null
            }
          />
        ))}
      </ul>
    </section>
  );
}
