"use client";

import { useActionState } from "react";
import {
  EMPLOYMENT_TYPES,
  EMPLOYMENT_TYPE_LABELS,
  WORK_MODES,
  WORK_MODE_LABELS,
} from "@/lib/jobs/types";
import type { JobFormState } from "./actions";

// One form for creating and editing. The action decides which, and re-validates everything either
// way; the hidden job id is a routing detail the server re-checks against this organization, never
// a claim the form gets to make.

const inputClass =
  "h-11 w-full rounded-md border border-border bg-surface px-3.5 text-sm transition-colors duration-150 hover:border-border-strong focus:border-accent";
const labelClass = "mb-1.5 block text-sm font-medium";

export type JobFormValues = {
  title: string;
  description: string;
  department: string;
  location: string;
  work_mode: string;
  employment_type: string;
  openings: string;
  application_deadline: string;
};

export function JobForm({
  action,
  organizationSlug,
  jobId,
  initial,
  submitLabel,
}: {
  action: (previous: JobFormState, formData: FormData) => Promise<JobFormState>;
  organizationSlug: string;
  jobId?: string;
  initial: JobFormValues;
  submitLabel: string;
}) {
  const [state, formAction, isPending] = useActionState<JobFormState, FormData>(action, {});
  const value = (field: keyof JobFormValues) => state.values?.[field] ?? initial[field];

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="organizationSlug" value={organizationSlug} />
      {jobId && <input type="hidden" name="jobId" value={jobId} />}

      <div>
        <label htmlFor="title" className={labelClass}>
          Job title
        </label>
        <input
          id="title"
          name="title"
          type="text"
          required
          maxLength={160}
          defaultValue={value("title")}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="description" className={labelClass}>
          Job description
        </label>
        <textarea
          id="description"
          name="description"
          rows={10}
          maxLength={20000}
          defaultValue={value("description")}
          className="w-full rounded-md border border-border bg-surface px-3.5 py-3 text-sm leading-relaxed transition-colors duration-150 hover:border-border-strong focus:border-accent"
        />
        <p className="mt-1.5 text-sm text-muted-foreground">
          Write it however your team writes it. Requirements are defined separately, so nothing here
          has to be structured.
        </p>
      </div>

      <fieldset className="grid gap-5 border-t border-border pt-6 sm:grid-cols-2">
        <legend className="sr-only">Job details</legend>

        <div>
          <label htmlFor="department" className={labelClass}>
            Department
          </label>
          <input
            id="department"
            name="department"
            type="text"
            maxLength={120}
            defaultValue={value("department")}
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="location" className={labelClass}>
            Location
          </label>
          <input
            id="location"
            name="location"
            type="text"
            maxLength={160}
            defaultValue={value("location")}
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="work_mode" className={labelClass}>
            Work mode
          </label>
          <select
            id="work_mode"
            name="work_mode"
            defaultValue={value("work_mode")}
            className={inputClass}
          >
            <option value="">Not specified</option>
            {WORK_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {WORK_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="employment_type" className={labelClass}>
            Employment type
          </label>
          <select
            id="employment_type"
            name="employment_type"
            defaultValue={value("employment_type")}
            className={inputClass}
          >
            <option value="">Not specified</option>
            {EMPLOYMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {EMPLOYMENT_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="openings" className={labelClass}>
            Openings
          </label>
          <input
            id="openings"
            name="openings"
            type="number"
            min={1}
            max={10000}
            step={1}
            defaultValue={value("openings") || "1"}
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="application_deadline" className={labelClass}>
            Application deadline
          </label>
          <input
            id="application_deadline"
            name="application_deadline"
            type="date"
            defaultValue={value("application_deadline")}
            className={inputClass}
          />
        </div>
      </fieldset>

      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}

      <div className="flex items-center gap-4 border-t border-border pt-6">
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-medium text-white shadow-sm transition-colors duration-150 hover:bg-accent-strong disabled:cursor-progress disabled:opacity-70"
        >
          {isPending ? "Saving…" : submitLabel}
        </button>
        {!jobId && (
          <p className="text-sm text-muted-foreground">
            Saved as a draft. You can add requirements before opening it.
          </p>
        )}
      </div>
    </form>
  );
}
