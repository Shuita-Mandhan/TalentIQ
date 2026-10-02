"use client";

import { useActionState } from "react";
import { MAX_DESCRIPTION, MIN_DESCRIPTION } from "@/lib/ai/extraction";
import { analyzeJobDescription, type AnalysisState } from "./actions";

// The job description goes in here. Four states and no ambiguity between them: idle, analyzing,
// failed with the text still in the box, or done. The button is disabled while a run is in flight,
// so a second submission cannot start a second run by accident.

export function AnalyzeForm({
  organizationSlug,
  jobId,
  initialDescription,
}: {
  organizationSlug: string;
  jobId: string;
  initialDescription: string;
}) {
  const [state, formAction, isPending] = useActionState<AnalysisState, FormData>(
    analyzeJobDescription,
    {},
  );

  return (
    <form action={formAction} className="mt-6">
      <input type="hidden" name="organizationSlug" value={organizationSlug} />
      <input type="hidden" name="jobId" value={jobId} />

      <label htmlFor="description" className="mb-1.5 block text-sm font-medium">
        Job description
      </label>
      <textarea
        id="description"
        name="description"
        rows={12}
        maxLength={MAX_DESCRIPTION}
        required
        minLength={MIN_DESCRIPTION}
        // Whatever was submitted comes back on a failure, so a long paste is never lost.
        defaultValue={state.description ?? initialDescription}
        placeholder="Paste the job description here. It is sent to the model as text to read, and nothing else about your organization goes with it."
        className="w-full rounded-md border border-border bg-surface px-3.5 py-3 text-sm leading-relaxed transition-colors duration-150 hover:border-border-strong focus:border-accent disabled:opacity-60"
      />

      <div className="mt-3 flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex h-10 items-center gap-2.5 rounded-md bg-accent px-4 text-sm font-medium text-white shadow-sm transition-colors duration-150 hover:bg-accent-strong disabled:cursor-progress disabled:opacity-70"
        >
          {isPending && (
            <span aria-hidden className="relative flex size-2">
              <span className="absolute inset-0 animate-pulse-ring rounded-full bg-white motion-reduce:hidden" />
              <span className="relative size-2 rounded-full bg-white" />
            </span>
          )}
          {isPending ? "Analyzing…" : "Analyze description"}
        </button>

        <p role="status" className="text-sm text-muted-foreground">
          {isPending
            ? "Reading the description and extracting requirements."
            : state.done
              ? state.message
              : `${MIN_DESCRIPTION}–${MAX_DESCRIPTION.toLocaleString()} characters.`}
        </p>
      </div>

      {state.error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}
