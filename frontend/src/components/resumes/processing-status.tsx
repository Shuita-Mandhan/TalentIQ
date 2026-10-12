import {
  PROCESSING_LABELS,
  type ProcessingStatus,
  type ResumeProcessing,
} from "@/lib/resumes/processing-types";

// Where a resume stands, said in one phrase and one mark.
//
// State is never carried by colour alone: the dot distinguishes the states by fill and ring as well
// as hue, and the phrase is always present. A recruiter scanning sixty rows reads the shape first and
// the word second, which is why "Ready for review" and "Needs review" do not look alike.

const TONES: Record<ProcessingStatus | "none", { dot: string; text: string }> = {
  none: { dot: "border border-border-strong", text: "text-muted-foreground" },
  waiting: { dot: "border border-border-strong", text: "text-muted-foreground" },
  // A ring rather than a fill, so "in flight" reads as unfinished at a glance.
  processing: { dot: "border-2 border-accent", text: "text-accent" },
  succeeded: { dot: "bg-accent", text: "text-accent-strong" },
  needs_review: { dot: "bg-border-strong ring-2 ring-border-strong/40", text: "text-foreground" },
  failed: { dot: "bg-destructive", text: "text-destructive" },
};

export function ProcessingStatusPill({
  attempt,
}: {
  attempt: ResumeProcessing | null | undefined;
}) {
  const status = attempt?.status ?? null;
  // A stalled attempt is shown as stopped rather than as still running. Saying "Processing" beside a
  // Retry button would contradict itself, and a recruiter watching a row that will never finish
  // deserves to be told so.
  const stalled = attempt?.stalled === true;
  const tone = stalled ? TONES.failed : TONES[status ?? "none"];
  const label =
    status === null
      ? // "Not read yet" rather than "none": the resume is here and nothing has gone wrong with it.
        "Not read yet"
      : stalled
        ? "Stopped unexpectedly"
        : PROCESSING_LABELS[status];

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${tone.text}`}>
      <span
        aria-hidden
        className={`size-1.5 shrink-0 rounded-full ${tone.dot} ${
          status === "processing" && !stalled ? "animate-pulse motion-reduce:animate-none" : ""
        }`}
      />
      {label}
      {attempt !== null && attempt !== undefined && attempt.attempt > 1 && (
        <span className="font-mono text-[10px] font-normal text-muted-foreground tabular-nums">
          attempt {attempt.attempt}
        </span>
      )}
    </span>
  );
}
