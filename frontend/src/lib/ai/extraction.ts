import {
  IMPORTANCES,
  REQUIREMENT_CATEGORIES,
  type Importance,
  type RequirementCategory,
} from "../jobs/types.ts";

// The contract between the application and whatever model answers it, plus the validation that
// makes the answer safe to use.
//
// Nothing here imports a provider, a server client or Next. A model's reply is untrusted input in
// exactly the way a form submission is, so parsing it is a pure function that can be tested with
// the malformed shapes a model actually produces.

export type ExtractedRequirement = {
  requirement: string;
  category: RequirementCategory;
  importance: Importance;
  weight: number;
};

export type ExtractionRequest = { jobTitle: string; description: string };

/** What a provider must return. Anything else is rejected before the application sees it. */
export type ExtractionResult = { requirements: ExtractedRequirement[] };

export interface ExtractionProvider {
  /** Recorded on the run so a result can be understood later. Never a credential. */
  readonly name: string;
  readonly model: string;
  /** Resolves with the raw, unvalidated reply. Throws for transport or provider failures. */
  extract(request: ExtractionRequest): Promise<unknown>;
}

/** Thrown by a provider. The message is for the server log, never for the browser. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export const MIN_DESCRIPTION = 40;
export const MAX_DESCRIPTION = 20000;
/** A single run cannot flood the review queue, however enthusiastic the model is. */
export const MAX_REQUIREMENTS = 40;

/** Server-side validation of the job description. The client's copy of this is only a courtesy. */
export function validateDescription(input: string): { text?: string; error?: string } {
  const text = input.trim();
  if (text.length === 0) return { error: "Paste the job description you want analyzed." };
  if (text.length < MIN_DESCRIPTION) {
    return { error: `That is too short to analyze — ${MIN_DESCRIPTION} characters at minimum.` };
  }
  if (text.length > MAX_DESCRIPTION) {
    return { error: `That is too long to analyze — ${MAX_DESCRIPTION} characters at most.` };
  }
  return { text };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Validates a model's reply into requirements, or explains why it could not be used.
 *
 * Strict on purpose: a model is never assumed to have followed the format. Rows that do not fit
 * the existing requirement vocabulary are dropped rather than coerced, because a silently
 * corrected requirement is worse than a missing one — a recruiter can see what is absent.
 */
export function parseExtraction(raw: unknown): { result?: ExtractionResult; error?: string } {
  // Accepted shapes: { requirements: [...] } or a bare array. Nothing else.
  const record = asRecord(raw);
  const list = Array.isArray(raw) ? raw : record ? record.requirements : undefined;
  if (!Array.isArray(list)) {
    return { error: "The model did not return a list of requirements." };
  }

  const requirements: ExtractedRequirement[] = [];
  for (const entry of list) {
    const row = asRecord(entry);
    if (!row) continue;

    const text = typeof row.requirement === "string" ? row.requirement.trim() : "";
    if (text.length === 0 || text.length > 500) continue;

    const category = (REQUIREMENT_CATEGORIES as readonly string[]).includes(row.category as string)
      ? (row.category as RequirementCategory)
      : "other";
    const importance = (IMPORTANCES as readonly string[]).includes(row.importance as string)
      ? (row.importance as Importance)
      : "required";

    // Weights arrive as numbers, as numeric strings, or not at all. Anything outside the column's
    // range becomes the default rather than being clamped to a number nobody chose.
    const rawWeight = typeof row.weight === "string" ? Number(row.weight) : row.weight;
    const weight =
      typeof rawWeight === "number" && Number.isFinite(rawWeight) && rawWeight >= 0 && rawWeight <= 10
        ? Math.round(rawWeight * 2) / 2
        : 1;

    requirements.push({ requirement: text, category, importance, weight });
    if (requirements.length >= MAX_REQUIREMENTS) break;
  }

  if (requirements.length === 0) {
    return { error: "The model returned nothing usable from that job description." };
  }
  return { result: { requirements } };
}

/** Normalized form used to spot obvious repeats. Deterministic, and never used to merge anything. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !["a", "an", "the", "of", "with", "in", "at", "least", "and", "or", "to", "for"].includes(word))
    .sort()
    .join(" ");
}

/**
 * Groups requirements that look like repeats of one another, so review can flag them.
 *
 * Deterministic and deliberately shallow: identical significant words in any order. "3 years of
 * React experience" and "At least 3 years experience with React" land together; nothing merges
 * them, and a recruiter decides. Returns a group number per requirement, or null when it stands
 * alone.
 */
export function groupDuplicates(requirements: ExtractedRequirement[]): (number | null)[] {
  const keys = requirements.map((item) => normalize(item.requirement));
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);

  const groups = new Map<string, number>();
  let nextGroup = 0;
  return keys.map((key) => {
    if ((counts.get(key) ?? 0) < 2) return null;
    if (!groups.has(key)) groups.set(key, nextGroup++);
    return groups.get(key) ?? null;
  });
}

/**
 * The one message a failed analysis is allowed to show. Provider wording, URLs, stack traces and
 * credentials stay on the server; the recruiter gets something true and retryable.
 */
export function describeProviderFailure(error: unknown): string {
  if (error instanceof ProviderError) return "AI analysis is currently unavailable. Please try again.";
  return "AI analysis could not be completed. Please try again.";
}

/**
 * How long a provider may take. Server configuration only: the browser has no say, and an absurd
 * value is refused rather than honoured.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 300_000;

export function resolveTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return DEFAULT_TIMEOUT_MS;
  if (parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

/**
 * When a run that still says "running" should be taken as abandoned.
 *
 * A request cannot legitimately outlive its own timeout, so anything older than that plus a minute
 * of slack had its process disappear before it could record an answer. Derived from the timeout
 * rather than configured separately, so the two can never drift apart.
 */
export function staleAfterMs(timeoutMs: number): number {
  return timeoutMs + 60_000;
}

/** The shape the model is asked to produce, built from the vocabulary the database accepts. */
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    requirements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          requirement: { type: "string" },
          category: { type: "string", enum: [...REQUIREMENT_CATEGORIES] },
          importance: { type: "string", enum: [...IMPORTANCES] },
          weight: { type: "number" },
        },
        required: ["requirement", "category", "importance", "weight"],
      },
    },
  },
  required: ["requirements"],
} as const;
