"use client";

import { useCallback, useId, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FAILURES,
  FORMAT_LABELS,
  MAX_BATCH_FILES,
  MAX_RESUME_BYTES,
  RESUME_ACCEPT,
  STATE_LABELS,
  UPLOAD_CONCURRENCY,
  checkBatchSize,
  checkResumeFile,
  formatBytes,
  isAccepted,
  retryable,
  runBounded,
  summariseBatch,
  type IntakeOutcome,
  type IntakeState,
  type ResumeFormat,
} from "@/lib/resumes/types";

// The intake queue.
//
// Progress is never invented. Each row's percentage comes from that request's own upload progress
// events, and the batch bar is the count of files that have actually reached a final state — so a
// stalled upload looks stalled rather than looking nearly done.
//
// Four requests are in flight at a time. A hundred at once would not be faster; it would be a queue
// the browser hides, with every file competing for the same bandwidth and nothing legible on screen.
//
// Nothing here parses a resume, reads its text, or guesses at a candidate. The only states a file can
// be in are the six in IntakeState, and none of them is "parsing" or "scoring", because those
// processes do not exist.

type QueueItem = {
  /** Stable for the life of the queue, so progress lands on the right row. */
  key: string;
  file: File;
  name: string;
  size: number;
  format: ResumeFormat | null;
  state: IntakeState;
  /** Whole percent of this file's body sent. Meaningful only while uploading. */
  progress: number;
  message: string | null;
};

type Props = { organizationSlug: string; jobId: string };

/**
 * Sends one file and resolves with the server's answer.
 *
 * It never rejects. A network error, a timeout and a 500 are all outcomes of the same kind as a
 * refusal, and turning any of them into a thrown error would take the rest of the batch with it.
 *
 * XMLHttpRequest rather than fetch, for the one reason that matters here: fetch cannot report how
 * much of a request body has been sent, so with fetch the progress bar would be a guess.
 */
function uploadOne(
  endpoint: string,
  batchId: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<IntakeOutcome> {
  return new Promise((resolve) => {
    const body = new FormData();
    body.append("batchId", batchId);
    body.append("file", file);

    const request = new XMLHttpRequest();
    request.open("POST", endpoint);
    request.responseType = "json";

    let reported = 0;
    request.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || event.total === 0) return;
      const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
      // One update per whole percent. A hundred files re-rendering on every chunk is how a progress
      // bar makes the upload it is describing slower.
      if (percent > reported) {
        reported = percent;
        onProgress(percent);
      }
    });

    const fail = () => resolve({ status: "failed", message: FAILURES.generic });
    request.addEventListener("load", () => {
      const payload: unknown = request.response;
      if (payload && typeof payload === "object" && "status" in payload) {
        resolve(payload as IntakeOutcome);
        return;
      }
      fail();
    });
    request.addEventListener("error", fail);
    request.addEventListener("abort", fail);
    request.addEventListener("timeout", fail);
    request.send(body);
  });
}

function patchFor(outcome: IntakeOutcome): Partial<QueueItem> {
  switch (outcome.status) {
    case "uploaded":
      return { state: "uploaded", progress: 100, message: null };
    case "duplicate":
      return { state: "duplicate", progress: 100, message: outcome.message };
    case "rejected":
      return { state: "rejected", progress: 0, message: outcome.message };
    default:
      return { state: "failed", progress: 0, message: outcome.message };
  }
}

const STATE_TONE: Record<IntakeState, string> = {
  waiting: "text-muted-foreground",
  uploading: "text-accent",
  uploaded: "text-accent-strong",
  duplicate: "text-muted-foreground",
  failed: "text-destructive",
  rejected: "text-destructive",
};

export function IntakeUploader({ organizationSlug, jobId }: Props) {
  const router = useRouter();
  const inputId = useId();

  const [items, setItems] = useState<QueueItem[]>([]);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [dragging, setDragging] = useState(false);

  const endpoint = `/api/workspace/${organizationSlug}/jobs/${jobId}/resumes`;
  const progress = summariseBatch(items.map((item) => item.state));

  const update = useCallback((key: string, patch: Partial<QueueItem>) => {
    setItems((previous) =>
      previous.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  }, []);

  const run = useCallback(
    async (queue: QueueItem[], batch: string) => {
      const pending = queue.filter((item) => item.state === "waiting");
      if (pending.length === 0) return;

      setRunning(true);
      await runBounded(pending, UPLOAD_CONCURRENCY, async (item) => {
        update(item.key, { state: "uploading", progress: 0, message: null });
        const outcome = await uploadOne(endpoint, batch, item.file, (percent) =>
          update(item.key, { progress: percent }),
        );
        update(item.key, patchFor(outcome));
      });
      setRunning(false);
      // The persisted list below is a server read, so it is told to catch up once per batch rather
      // than once per file.
      router.refresh();
    },
    [endpoint, router, update],
  );

  const select = useCallback(
    (files: File[]) => {
      const problem = checkBatchSize(files.length);
      if (problem !== null) {
        setSelectionError(problem);
        return;
      }
      setSelectionError(null);

      const batch = crypto.randomUUID();
      const stamp = Date.now();
      const queue: QueueItem[] = files.map((file, index) => {
        const check = checkResumeFile({ name: file.name, size: file.size, type: file.type });
        const accepted = isAccepted(check);
        return {
          key: `${stamp}-${index}`,
          file,
          name: file.name,
          size: file.size,
          format: accepted ? check.format : null,
          // A file the browser already knows is wrong never leaves the machine.
          state: accepted ? "waiting" : "rejected",
          progress: 0,
          message: accepted ? null : check.rejection,
        };
      });

      setBatchId(batch);
      setItems(queue);
      void run(queue, batch);
    },
    [run],
  );

  /** Resends only what failed, under the same batch, so a success is never sent twice. */
  const retry = useCallback(() => {
    if (batchId === null || retryable(items).length === 0) return;
    const queue = items.map((item) =>
      item.state === "failed"
        ? { ...item, state: "waiting" as IntakeState, progress: 0, message: null }
        : item,
    );
    setItems(queue);
    void run(queue, batchId);
  }, [batchId, items, run]);

  const clear = useCallback(() => {
    setItems([]);
    setBatchId(null);
    setSelectionError(null);
  }, []);

  const failedCount = progress.failed;
  const busy = running || (items.length > 0 && !progress.done);

  return (
    <div className="mt-6">
      {/* A real file input, labelled: the button is the input, so it is reachable from the keyboard
          and announced by a screen reader without a role being invented for it. Dropping is an
          additional way in, never the only one. */}
      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={(event) => {
          // dragleave also fires when the pointer crosses into a child, which would make the zone
          // flicker the whole time a recruiter is holding a hundred files over it.
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (busy) return;
          select([...event.dataTransfer.files]);
        }}
        className={`rounded-xl border border-dashed p-6 text-center transition-colors duration-150 sm:p-10 ${
          dragging ? "border-accent bg-accent-soft/60" : "border-border-strong bg-surface-sunken/50"
        }`}
      >
        <input
          id={inputId}
          type="file"
          multiple
          accept={RESUME_ACCEPT}
          disabled={busy}
          className="peer sr-only"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            // Cleared so picking the same files again is still a change.
            event.target.value = "";
            if (files.length > 0) select(files);
          }}
        />
        <label
          htmlFor={inputId}
          className="inline-flex h-10 cursor-pointer items-center rounded-md bg-accent px-4 text-sm font-medium text-white shadow-sm transition-colors duration-150 hover:bg-accent-strong peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background peer-disabled:cursor-not-allowed peer-disabled:opacity-60"
        >
          Select resumes
        </label>
        <p className="mt-3 text-sm text-muted-foreground">
          or drop them here &middot; PDF and DOCX &middot; up to {MAX_BATCH_FILES} per batch &middot;{" "}
          {formatBytes(MAX_RESUME_BYTES)} each
        </p>
      </div>

      {selectionError !== null && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {selectionError}
        </p>
      )}

      {items.length > 0 && (
        <section className="mt-6" aria-label="Intake queue">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <p role="status" className="text-sm font-medium tabular-nums">
              {progress.settled} / {progress.total} processed
              <span className="ml-2 font-normal text-muted-foreground">
                {progress.uploaded} uploaded
                {progress.duplicates > 0 && ` · ${progress.duplicates} duplicate`}
                {progress.failed > 0 && ` · ${progress.failed} failed`}
                {progress.rejected > 0 && ` · ${progress.rejected} rejected`}
              </span>
            </p>
            <div className="flex items-center gap-2">
              {failedCount > 0 && progress.done && (
                <button
                  type="button"
                  onClick={retry}
                  className="h-9 rounded-md border border-border bg-surface px-3.5 text-sm font-medium shadow-sm transition-colors duration-150 hover:border-border-strong"
                >
                  Retry {failedCount} failed
                </button>
              )}
              <button
                type="button"
                onClick={clear}
                disabled={busy}
                className="h-9 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                Clear
              </button>
            </div>
          </div>

          <div
            role="progressbar"
            aria-valuenow={progress.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Batch progress"
            className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-sunken"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-200 ease-out motion-reduce:transition-none"
              style={{ width: `${progress.percent}%` }}
            />
          </div>

          {/* A hundred rows scroll inside the page rather than pushing the persisted list out of
              reach. The header stays above the scroll area. */}
          <ul className="mt-4 max-h-[26rem] divide-y divide-border overflow-y-auto rounded-xl border border-border bg-surface">
            {items.map((item) => (
              <li key={item.key} className="px-4 py-3 sm:px-5">
                <div className="flex items-center gap-x-4">
                  <div className="min-w-0 flex-1">
                    {/* title so a truncated name is still readable, which a 90-character filename
                        on a phone otherwise would not be. */}
                    <p className="truncate text-sm" title={item.name}>
                      {item.name}
                    </p>
                    <p className="mt-0.5 font-mono text-xs text-muted-foreground tabular-nums">
                      {item.format === null ? "Unsupported" : FORMAT_LABELS[item.format]} ·{" "}
                      {formatBytes(item.size)}
                    </p>
                  </div>
                  <p
                    className={`shrink-0 text-xs font-medium tabular-nums ${STATE_TONE[item.state]}`}
                  >
                    {item.state === "uploading"
                      ? `${item.progress}%`
                      : STATE_LABELS[item.state]}
                  </p>
                </div>
                {item.state === "uploading" && (
                  <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-surface-sunken">
                    <div
                      className="h-full bg-accent transition-[width] duration-150 ease-out motion-reduce:transition-none"
                      style={{ width: `${item.progress}%` }}
                    />
                  </div>
                )}
                {item.message !== null && (
                  <p className="mt-1 text-xs text-pretty text-muted-foreground">{item.message}</p>
                )}
              </li>
            ))}
          </ul>

          {progress.done && (
            <p className="mt-3 text-sm text-muted-foreground">
              {progress.uploaded === 0
                ? "Nothing was added to this job."
                : `${progress.uploaded} resume${progress.uploaded === 1 ? "" : "s"} added to this job. ${
                    progress.failed + progress.rejected + progress.duplicates > 0
                      ? "The rest are listed above with the reason."
                      : ""
                  }`}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
