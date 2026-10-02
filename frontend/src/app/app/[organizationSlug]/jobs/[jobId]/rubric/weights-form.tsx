"use client";

import { useActionState, useState } from "react";
import {
  MAX_REQUIREMENT_WEIGHT,
  RUBRIC_TOTAL,
  balanceWeights,
  summariseRubric,
  type JobRequirement,
} from "@/lib/jobs/types";
import { setRequirementWeights } from "../../actions";
import type { ActionState } from "@/components/ui/action-form";

// Weight editing for the whole rubric at once, because adjusting one weight almost always means
// adjusting another. The running total updates as you type, so the hundred points are visible
// while they are being distributed rather than after a save.
//
// Nothing is normalized behind the recruiter. "Balance to 100" exists, but it is a button with a
// name, pressed deliberately, and the numbers it produces appear in the fields for review before
// anything is saved.

export function WeightsForm({
  requirements,
  organizationSlug,
  jobId,
}: {
  requirements: JobRequirement[];
  organizationSlug: string;
  jobId: string;
}) {
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    setRequirementWeights,
    {},
  );

  // Draft weights, as strings, so a half-typed "1." is not fought with while it is being typed.
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(requirements.map((item) => [item.id, String(item.weight)])),
  );
  const [fromServer, setFromServer] = useState(requirements);
  if (fromServer !== requirements) {
    setFromServer(requirements);
    setDraft(Object.fromEntries(requirements.map((item) => [item.id, String(item.weight)])));
  }

  const parsed = requirements.map((item) => {
    const raw = draft[item.id] ?? String(item.weight);
    const value = Number(raw);
    return {
      ...item,
      weight: Number.isFinite(value) && raw.trim() !== "" ? value : Number.NaN,
    };
  });
  const invalid = parsed.filter(
    (item) => !Number.isFinite(item.weight) || item.weight < 0 || item.weight > MAX_REQUIREMENT_WEIGHT,
  );
  const live = summariseRubric(
    parsed.map((item) => ({ ...item, weight: Number.isFinite(item.weight) ? item.weight : 0 })),
  );
  const dirty = requirements.some(
    (item) => String(item.weight) !== (draft[item.id] ?? String(item.weight)),
  );

  return (
    <form action={formAction} className="mt-6">
      <input type="hidden" name="organizationSlug" value={organizationSlug} />
      <input type="hidden" name="jobId" value={jobId} />

      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
        {requirements.map((item) => {
          const raw = draft[item.id] ?? String(item.weight);
          const value = Number(raw);
          const bad = !Number.isFinite(value) || raw.trim() === "" || value < 0 || value > MAX_REQUIREMENT_WEIGHT;
          return (
            <li
              key={item.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5"
            >
              <input type="hidden" name="requirementIds" value={item.id} />
              <span
                aria-hidden
                className={`size-1.5 shrink-0 rounded-full ${
                  item.importance === "required" ? "bg-accent" : "bg-border-strong"
                }`}
              />
              <label htmlFor={`weight-${item.id}`} className="min-w-0 flex-1 text-sm break-words">
                {item.requirement}
              </label>
              <input
                id={`weight-${item.id}`}
                name="weights"
                type="number"
                min={0}
                max={MAX_REQUIREMENT_WEIGHT}
                step={0.5}
                inputMode="decimal"
                value={raw}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, [item.id]: event.target.value }))
                }
                aria-invalid={bad}
                aria-label={`Weight for ${item.requirement}`}
                className={`h-9 w-24 shrink-0 rounded-md border bg-surface px-3 text-right text-sm tabular-nums transition-colors duration-150 focus:border-accent ${
                  bad ? "border-destructive" : "border-border hover:border-border-strong"
                }`}
              />
            </li>
          );
        })}
      </ul>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3">
        <button
          type="submit"
          disabled={isPending || invalid.length > 0 || !dirty}
          className="inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-medium text-white shadow-sm transition-colors duration-150 hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? "Saving…" : "Save weights"}
        </button>

        {/* Explicit, named, and visible in the fields before it is saved. */}
        <button
          type="button"
          onClick={() =>
            setDraft(
              Object.fromEntries(
                balanceWeights(requirements).map(({ id, weight }) => [id, String(weight)]),
              ),
            )
          }
          disabled={requirements.length === 0 || isPending}
          className="inline-flex h-10 items-center rounded-md border border-border bg-surface px-4 text-sm font-medium transition-colors duration-150 hover:border-border-strong hover:bg-surface-sunken disabled:opacity-50"
        >
          Balance to {RUBRIC_TOTAL}
        </button>

        <p
          role="status"
          className={`text-sm tabular-nums ${
            invalid.length > 0
              ? "text-destructive"
              : live.readiness === "ready"
                ? "text-accent-strong"
                : "text-muted-foreground"
          }`}
        >
          {invalid.length > 0
            ? `Each weight must be between 0 and ${MAX_REQUIREMENT_WEIGHT}.`
            : `${live.totalWeight} / ${RUBRIC_TOTAL}${dirty ? " (unsaved)" : ""}`}
        </p>
      </div>

      {state.error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {state.error}
        </p>
      )}
      {state.done && !state.error && !dirty && (
        <p role="status" className="mt-3 text-sm text-accent">
          {state.message}
        </p>
      )}
    </form>
  );
}
