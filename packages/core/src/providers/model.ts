import { buildPrompt, validateDraft } from "../message.js";
import { ProviderError, type CompleteFn, type Provider } from "./types.js";

/** Attempts per generate call: the first try plus regenerations after invalid output. */
export const MAX_ATTEMPTS = 3;

/**
 * Wrap a model call with the shared prompt, validation and bounded
 * regeneration loop. Invalid output is sent back to the model as feedback.
 */
export function modelProvider(name: string, remote: boolean, complete: CompleteFn): Provider {
  return {
    name,
    remote,
    async generate(input, signal) {
      let feedback: string | undefined;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const draft = await complete(buildPrompt(input, feedback), signal);
        const { suggestions, problems } = validateDraft(draft, input);
        if (suggestions.length > 0) return suggestions;
        feedback = problems.length ? problems.join("; ") : "no suggestions were returned";
      }
      throw new ProviderError(name, `no valid suggestions after ${MAX_ATTEMPTS} attempts (${feedback})`);
    },
  };
}
