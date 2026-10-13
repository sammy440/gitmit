import { DraftSchema } from "../message.js";
import { modelProvider } from "./model.js";
import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS, ProviderError, type Provider, type ProviderSettings } from "./types.js";

export const OPENAI_DEFAULT_MODEL = "gpt-5-mini";

export function openaiProvider(settings: ProviderSettings = {}): Provider {
  const model = settings.model ?? OPENAI_DEFAULT_MODEL;
  let client: Promise<import("openai").default> | undefined;

  const getClient = () =>
    (client ??= import("openai").then(({ default: OpenAI }) => {
      if (!settings.apiKey) throw new ProviderError("openai", "missing API key (set OPENAI_API_KEY)");
      return new OpenAI({
        apiKey: settings.apiKey,
        baseURL: settings.baseURL,
        timeout: settings.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxRetries: settings.maxRetries ?? DEFAULT_MAX_RETRIES,
        fetch: settings.fetch,
      });
    }));

  return modelProvider("openai", true, async (prompt, signal) => {
    const [openai, { zodResponseFormat }] = await Promise.all([getClient(), import("openai/helpers/zod")]);
    try {
      const completion = await openai.chat.completions.parse(
        {
          model,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          response_format: zodResponseFormat(DraftSchema, "commit_suggestions"),
        },
        { signal },
      );
      const message = completion.choices[0]?.message;
      if (message?.refusal) throw new ProviderError("openai", `the model declined the request (${message.refusal})`);
      if (completion.choices[0]?.finish_reason === "length") throw new ProviderError("openai", "the response was cut off");
      if (!message?.parsed) throw new ProviderError("openai", "the response did not match the expected format");
      return message.parsed;
    } catch (error) {
      throw toProviderError(error);
    }
  });
}

function toProviderError(error: unknown): unknown {
  if (error instanceof ProviderError) return error;
  if (error instanceof Error && "status" in error && typeof error.status === "number") {
    const hint =
      error.status === 401 ? "invalid API key" : error.status === 404 ? "unknown model or no access to it" : error.message;
    return new ProviderError("openai", `${hint} (HTTP ${error.status})`, { status: error.status, cause: error });
  }
  return error;
}
