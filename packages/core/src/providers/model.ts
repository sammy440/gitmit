import { buildPrompt, DraftSchema, finalizeDraft, type Draft } from "../message.js";
import { ProviderError, type CompleteFn, type Provider } from "./types.js";

/** Attempts per generate call: the first try plus regenerations after invalid output. */
export const MAX_ATTEMPTS = 3;

const DRAFT_OUTPUT = { schema: DraftSchema, name: "commit_suggestions" };

/** Wrap a model call with the shared prompt, validation and bounded regeneration. */
export function modelProvider(name: string, remote: boolean, complete: CompleteFn): Provider {
  // Validate every answer against its schema, whatever the adapter already checked.
  const checked: CompleteFn = async (prompt, output, signal) => {
    const result = output.schema.safeParse(await complete(prompt, output, signal));
    if (!result.success) throw new ProviderError(name, "the response did not match the expected format");
    return result.data;
  };
  return {
    name,
    remote,
    complete: checked,
    async generate(input, signal) {
      let feedback: string | undefined;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const draft = (await checked(buildPrompt(input, feedback), DRAFT_OUTPUT, signal)) as Draft;
        const { suggestions, problems } = await finalizeDraft(draft, input);
        if (suggestions.length > 0) return suggestions;
        feedback = problems.length ? problems.join("; ") : "no suggestions were returned";
      }
      throw new ProviderError(name, `no valid suggestions after ${MAX_ATTEMPTS} attempts (${feedback})`);
    },
  };
}
