// The one thing every provider in this project can do: take a system instruction and a user message
// and return parsed JSON.
//
// This exists so Phase 8 could reuse the AI layer instead of starting a second one. The JD path's
// ExtractionProvider.extract() in ./extraction stays exactly as it was; this adds the primitive both
// it and resume profiling are built on, so a new provider is still one file implementing one small
// surface, and a new USE of AI is a prompt plus a parser rather than a new architecture.
//
// Prompts deliberately do not live here. They belong with the domain that owns the vocabulary - the
// resume profile prompt is in lib/resumes/profile.ts next to the parser that validates its output -
// so a second provider never has to carry a copy of them.

/** A system instruction and a user message. Nothing provider-specific. */
export type JsonChatRequest = { system: string; user: string };

export interface JsonChatProvider {
  /** Recorded on the result so it can be understood later. Never a credential. */
  readonly name: string;
  readonly model: string;
  /**
   * Resolves with the provider's reply, parsed as JSON and otherwise UNVALIDATED.
   *
   * The caller validates. Returning `unknown` rather than a typed shape is the point: there is no
   * path by which a model's output reaches the application without passing a parser first.
   *
   * Throws ProviderError for transport, configuration and provider failures.
   */
  completeJson(request: JsonChatRequest): Promise<unknown>;
}

/**
 * Whether a provider failure was the clock running out rather than the provider being absent.
 *
 * Worth telling apart because they ask different things of a recruiter: "try again" is reasonable
 * advice for a timeout on a long resume, and misleading when nothing is listening on the port. Read
 * from the failure's own message rather than from a type, because every provider here wraps a fetch
 * abort and an abort is what a timeout looks like from the outside.
 */
export function isTimeoutFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /timeout|timed out|aborted/i.test(error.message);
}
