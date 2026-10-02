"use client";

import { useActionState, useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { runBounded } from "@/lib/resumes/types";
import { PROCESSING_CONCURRENCY } from "@/lib/resumes/processing-types";
import { processResume } from "./processing-actions";

// The two ways processing gets started, and neither of them starts on its own.
//
// Nothing here runs during render and nothing runs on load: a recruiter presses something. That is
// the whole of the performance design, and it is also the safety design — a page that processed on
// render would launch a fresh set of model requests every time somebody refreshed it.
//
// Running one resume never blocks another. Each row owns its own pending state, so a resume that
// takes ninety seconds leaves the rest of the list live, and the batch runner below holds two in
// flight because a third makes all three slower on a local model rather than finishing any sooner.

type RowProps = {
  organizationSlug: string;
  jobId: string;
  resumeId: string;
  /** "Process" for a resume never read, "Retry" for one that failed or needs another look. */
  label: "Process" | "Retry";
};

function fields(organizationSlug: string, jobId: string, resumeId: string): FormData {
  const data = new FormData();
  data.set("organizationSlug", organizationSlug);
  data.set("jobId", jobId);
  data.set("resumeId", resumeId);
  return data;
}

export function ProcessButton({ organizationSlug, jobId, resumeId, label }: RowProps) {
  const [state, submit, isPending] = useActionState(processResume, {});

  return (
    <form
      action={() => submit(fields(organizationSlug, jobId, resumeId))}
      className="flex flex-col items-end gap-1.5"
    >
      <button
        type="submit"
        disabled={isPending}
        className="h-9 rounded-md border border-accent/30 bg-accent-soft px-3.5 text-sm font-medium text-accent-strong shadow-sm transition-colors duration-150 hover:border-accent/60 disabled:cursor-progress disabled:opacity-70"
      >
        {/* Reading, not "processing": the recruiter is told what is happening to their document. */}
        {isPending ? "Reading…" : label}
      </button>
      {state.error && (
        <p role="alert" className="max-w-[22rem] text-right text-xs text-pretty text-destructive">
          {state.error}
        </p>
      )}
      {state.done && state.message && !state.error && (
        <p role="status" className="max-w-[22rem] text-right text-xs text-pretty text-muted-foreground">
          {state.message}
        </p>
      )}
    </form>
  );
}

type BatchProps = {
  organizationSlug: string;
  jobId: string;
  /** The resumes with no profile yet. Already filtered on the server. */
  resumeIds: string[];
};

export function ProcessAllButton({ organizationSlug, jobId, resumeIds }: BatchProps) {
  const router = useRouter();
  const [done, setDone] = useState(0);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(0);

  const run = useCallback(async () => {
    if (running || resumeIds.length === 0) return;
    setRunning(true);
    setDone(0);
    setFailed(0);

    // The same bounded-concurrency helper the Phase 7 uploader uses, with a smaller budget. It
    // settles every item, so one resume failing does not stop the rest of the batch.
    await runBounded(resumeIds, PROCESSING_CONCURRENCY, async (resumeId) => {
      const result = await processResume({}, fields(organizationSlug, jobId, resumeId));
      setDone((value) => value + 1);
      if (result.error) setFailed((value) => value + 1);
      return result;
    });

    setRunning(false);
    router.refresh();
  }, [jobId, organizationSlug, resumeIds, router, running]);

  if (resumeIds.length === 0) return null;

  const percent = resumeIds.length === 0 ? 0 : Math.round((done / resumeIds.length) * 100);

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <button
        type="button"
        onClick={run}
        disabled={running}
        className="h-10 rounded-md bg-accent px-4 text-sm font-medium text-white shadow-sm transition-colors duration-150 hover:bg-accent-strong disabled:cursor-progress disabled:opacity-70"
      >
        {running
          ? `Reading ${done} of ${resumeIds.length}…`
          : `Read ${resumeIds.length} resume${resumeIds.length === 1 ? "" : "s"}`}
      </button>
      {running && (
        <div
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Reading resumes"
          className="h-1 w-48 overflow-hidden rounded-full bg-surface-sunken"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out motion-reduce:transition-none"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      {!running && done > 0 && (
        <p role="status" className="text-xs text-muted-foreground tabular-nums">
          {done - failed} read{failed > 0 && `, ${failed} could not be`}
        </p>
      )}
    </div>
  );
}
