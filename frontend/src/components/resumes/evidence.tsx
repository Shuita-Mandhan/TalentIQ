import type { ReactNode } from "react";
import { EVIDENCE_LABELS, GENERATED_NOTICE, type EvidenceRecord } from "@/lib/resumes/profile";

// Why the system believes a fact, shown next to the fact.
//
// A recruiter should never have to take an extracted detail on faith, so every one of them carries
// its own disclosure: the status is always visible, and the quote from the resume is one press away.
// Built on <details>, which means it opens from the keyboard, is announced by a screen reader and
// works with JavaScript switched off — none of which a div with an onClick would do.
//
// The quote is the exact wording from the document. `quote_verified` is the application's own finding
// after searching the extracted text, so a fact whose quote is not actually in the resume says so
// plainly rather than looking like every other fact.

const STATUS_TONE: Record<string, string> = {
  verified: "text-accent-strong",
  likely: "text-foreground",
  indirect: "text-muted-foreground",
  not_found: "text-destructive",
  contradictory: "text-destructive",
  unable_to_determine: "text-muted-foreground",
};

export function EvidenceBadge({ evidence }: { evidence: EvidenceRecord | null }) {
  if (evidence === null) {
    return (
      <span className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground/70 uppercase">
        No evidence
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-[10px] tracking-[0.08em] uppercase ${
        STATUS_TONE[evidence.evidence_status] ?? "text-muted-foreground"
      }`}
    >
      <span
        aria-hidden
        className={`size-1 shrink-0 rounded-full ${
          evidence.quote_verified ? "bg-current" : "border border-current"
        }`}
      />
      {EVIDENCE_LABELS[evidence.evidence_status]}
    </span>
  );
}

/**
 * Text the model wrote rather than text the document contains.
 *
 * Deliberately unlike a quote in every visible respect: a dashed rule instead of the solid accent one,
 * muted type, and a label saying what it is. A recruiter deciding about a person must be able to tell
 * at a glance which sentences the applicant wrote and which a model composed, and the audit that
 * prompted this found three such fields being rendered as though they were the former.
 */
export function GeneratedText({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2 border-l-2 border-dashed border-border-strong pl-3">
      <p className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
        {GENERATED_NOTICE}
      </p>
      <p className="mt-1 max-w-prose text-sm leading-relaxed text-pretty text-muted-foreground">
        {children}
      </p>
    </div>
  );
}

/** The quote itself, with where it was found. Shown inside a disclosure, never on its own. */
function Quote({ evidence }: { evidence: EvidenceRecord }) {
  const where = [
    evidence.source_page !== null ? `Page ${evidence.source_page}` : null,
    evidence.source_section,
  ].filter((part): part is string => part !== null && part.length > 0);

  return (
    <div className="mt-2.5 border-l-2 border-accent/40 pl-3">
      {evidence.source_quote !== null ? (
        // The resume's wording, marked up as a quotation because that is what it is.
        <blockquote className="text-sm leading-relaxed text-pretty break-words">
          &ldquo;{evidence.source_quote}&rdquo;
        </blockquote>
      ) : (
        <p className="text-sm text-muted-foreground">
          The model gave no supporting quote for this.
        </p>
      )}
      <p className="mt-1.5 font-mono text-[11px] text-muted-foreground tabular-nums">
        {where.length > 0 ? where.join(" · ") : "Location not determined"}
        {evidence.confidence !== null && ` · confidence ${evidence.confidence.toFixed(2)}`}
      </p>
      {!evidence.quote_verified && (
        // The honest note. A quote the application could not find in the document is not provenance,
        // and a recruiter deciding about a person deserves to know which of the two they are reading.
        <p className="mt-1.5 text-xs text-pretty text-destructive">
          This quote was not found in the document, so the detail above is unconfirmed.
        </p>
      )}
    </div>
  );
}

/**
 * One extracted detail and its provenance.
 *
 * `detail` is the value; `label` names it. Both stay visible. The quote is behind the disclosure so a
 * profile with sixty facts is still readable, and so the recruiter chooses what to scrutinise.
 */
export function FactWithEvidence({
  label,
  detail,
  evidence,
  generated,
}: {
  label: ReactNode;
  detail?: ReactNode;
  evidence: EvidenceRecord | null;
  /** Model prose about this fact. Rendered below the quote, labelled, never beside the badge. */
  generated?: string | null;
}) {
  return (
    <details className="group border-b border-border last:border-b-0">
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5 transition-colors duration-150 hover:text-accent-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        <span
          aria-hidden
          className="mt-[0.3rem] text-[10px] text-muted-foreground transition-transform duration-200 ease-out group-open:rotate-90 motion-reduce:transition-none"
        >
          &#9656;
        </span>
        <span className="min-w-0 flex-1 text-sm break-words">{label}</span>
        {detail !== undefined && (
          <span className="text-sm text-muted-foreground">{detail}</span>
        )}
        <EvidenceBadge evidence={evidence} />
      </summary>
      <div className="pb-3.5 pl-5">
        {evidence !== null ? (
          <Quote evidence={evidence} />
        ) : (
          <p className="mt-1 text-sm text-pretty text-muted-foreground">
            Nothing in the document was recorded as supporting this, so it should be checked against
            the original resume before it is relied on.
          </p>
        )}
        {generated != null && generated.length > 0 && <GeneratedText>{generated}</GeneratedText>}
      </div>
    </details>
  );
}

/** How much of a profile is actually backed by a quote found in the document. */
export function EvidenceCoverage({
  total,
  verified,
}: {
  total: number;
  verified: number;
}) {
  const percent = total === 0 ? 0 : Math.round((verified / total) * 100);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <p className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
          Evidence
        </p>
        <p className="text-sm tabular-nums">
          <span className="font-medium">{verified}</span>
          <span className="text-muted-foreground"> of {total} quoted from the document</span>
        </p>
      </div>
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Facts supported by a verified quote"
        className="mt-2 h-1 overflow-hidden rounded-full bg-surface-sunken"
      >
        <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
