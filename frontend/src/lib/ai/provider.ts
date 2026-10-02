import "server-only";
import type { JsonChatProvider } from "./chat.ts";
import { ProviderError, type ExtractionProvider } from "./extraction.ts";
import { createGeminiProvider } from "./gemini.ts";
import { createOllamaProvider } from "./ollama.ts";

// Which provider answers, decided once, from the environment.
//
// This is the whole abstraction: two small interfaces, one implementation per provider, and one
// function. There is no registry, no plugin loader and no configuration object, because only one
// thing genuinely varies — which implementation to construct. A third provider is a third file and a
// third case here.
//
// Credentials, endpoints and model names live in server-only environment variables and are never
// prefixed NEXT_PUBLIC_, so none of them can reach the browser.
//
// THERE IS NO FALLBACK, and that is a privacy decision rather than an oversight. AI_PROVIDER names
// exactly one provider. If it names ollama and Ollama is not running, the request fails and says so;
// it does not reach for Gemini, because that would mean a machine nobody reconfigured could start
// sending applicants' resumes to an external service. Changing where resume text goes is something a
// person does on purpose.

/** Everything the application can ask of a provider. */
export type AiProvider = ExtractionProvider & JsonChatProvider;

export function getAiProvider(): AiProvider {
  const configured = (process.env.AI_PROVIDER ?? "ollama").toLowerCase();

  switch (configured) {
    case "ollama":
      return createOllamaProvider();
    case "gemini":
      return createGeminiProvider();
    default:
      // Misconfiguration is a provider failure like any other: the caller maps it to the one
      // sentence the recruiter sees, and the detail stays in the server log.
      throw new ProviderError(`unknown AI_PROVIDER: ${configured}`);
  }
}

/** The requirement-extraction view of the same provider. Phase 5's call sites are unchanged. */
export function getExtractionProvider(): ExtractionProvider {
  return getAiProvider();
}
