import { modelProvider } from "./model.js";
import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS, ProviderError, type Provider, type ProviderSettings } from "./types.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

/** Models that accept server-side refusal fallbacks with `fallbacks: "default"`. */
const FALLBACK_MODELS = /^claude-(?:opus-5-5|opus-5|fable-5-1|sonnet-5-5)$/;
/** Models that accept `output_config.effort`. */
const EFFORT_MODELS = /^claude-(?:(?:opus|fable|mythos|sonnet|haiku)-5|opus-4-[5-9]|sonnet-4-[6-9])/;

export function anthropicProvider(settings: ProviderSettings = {}): Provider {
  const model = settings.model ?? ANTHROPIC_DEFAULT_MODEL;
  let client: Promise<import("@anthropic-ai/sdk").default> | undefined;

  const getClient = () =>
    (client ??= import("@anthropic-ai/sdk").then(({ default: Anthropic }) => {
      if (!settings.apiKey) throw new ProviderError("anthropic", "missing API key (set ANTHROPIC_API_KEY)");
      return new Anthropic({
        apiKey: settings.apiKey,
        baseURL: settings.baseURL,
        timeout: settings.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxRetries: settings.maxRetries ?? DEFAULT_MAX_RETRIES,
        fetch: settings.fetch,
      });
    }));

  return modelProvider("anthropic", true, async (prompt, output, signal) => {
    const [anthropic, { betaZodOutputFormat }] = await Promise.all([
      getClient(),
      import("@anthropic-ai/sdk/helpers/beta/zod"),
    ]);
    const useFallbacks = FALLBACK_MODELS.test(model) && !settings.baseURL;
    try {
      const response = await anthropic.beta.messages.parse(
        {
          model,
          max_tokens: 16000,
          system: prompt.system,
          messages: [{ role: "user", content: prompt.user }],
          output_config: {
            format: betaZodOutputFormat(output.schema),
            // Commit messages and split plans are simple tasks; low effort keeps them fast and cheap.
            ...(EFFORT_MODELS.test(model) ? { effort: "low" as const } : {}),
          },
          ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal },
      );
      if (response.stop_reason === "refusal") {
        throw new ProviderError("anthropic", `the model declined the request (${response.stop_details?.category ?? "no category"})`);
      }
      if (response.stop_reason === "max_tokens") throw new ProviderError("anthropic", "the response was cut off");
      if (!response.parsed_output) throw new ProviderError("anthropic", "the response did not match the expected format");
      return response.parsed_output;
    } catch (error) {
      throw toProviderError(error);
    }
  });
}

function toProviderError(error: unknown): unknown {
  if (error instanceof ProviderError) return error;
  if (error instanceof Error && "status" in error && typeof error.status === "number") {
    const hint = error.status === 401 ? "invalid API key" : error.status === 404 ? "unknown model" : error.message;
    return new ProviderError("anthropic", `${hint} (HTTP ${error.status})`, { status: error.status, cause: error });
  }
  return error;
}
