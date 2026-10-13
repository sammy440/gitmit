import { z } from "zod";
import { DraftSchema } from "../message.js";
import { modelProvider } from "./model.js";
import { RetryableError, timeoutSignal, withRetry } from "./retry.js";
import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS, ProviderError, type Provider, type ProviderSettings } from "./types.js";

export const OLLAMA_DEFAULT_MODEL = "llama3.2";
export const OLLAMA_DEFAULT_URL = "http://localhost:11434";

const OUTPUT_SCHEMA = z.toJSONSchema(DraftSchema);

/** Local models through Ollama. Counts as remote only when the URL points to another machine. */
export function ollamaProvider(settings: ProviderSettings = {}): Provider {
  const model = settings.model ?? OLLAMA_DEFAULT_MODEL;
  const baseURL = (settings.baseURL ?? OLLAMA_DEFAULT_URL).replace(/\/+$/, "");
  const fetchFn = settings.fetch ?? globalThis.fetch;

  return modelProvider("ollama", !isLocal(baseURL), (prompt, signal) =>
    withRetry(
      async () => {
        let response: Response;
        try {
          response = await fetchFn(`${baseURL}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model,
              stream: false,
              format: OUTPUT_SCHEMA,
              messages: [
                { role: "system", content: prompt.system },
                { role: "user", content: prompt.user },
              ],
            }),
            signal: timeoutSignal(settings.timeoutMs ?? DEFAULT_TIMEOUT_MS * 2, signal),
          });
        } catch (error) {
          if (signal?.aborted) throw error;
          if (error instanceof Error && error.name === "TimeoutError") throw new RetryableError("ollama: request timed out");
          throw new ProviderError("ollama", `cannot reach ${baseURL}; is Ollama running? (ollama serve)`, { cause: error });
        }

        if (response.status === 429 || response.status >= 500) {
          throw new RetryableError(`ollama: HTTP ${response.status}`);
        }
        if (response.status === 404) {
          throw new ProviderError("ollama", `model "${model}" not found; run: ollama pull ${model}`, { status: 404 });
        }
        if (!response.ok) {
          throw new ProviderError("ollama", `HTTP ${response.status}: ${await response.text()}`, { status: response.status });
        }

        const body = (await response.json()) as { message?: { content?: string } };
        try {
          return DraftSchema.parse(JSON.parse(body.message?.content ?? ""));
        } catch (error) {
          throw new ProviderError("ollama", "the response did not match the expected format", { cause: error });
        }
      },
      { retries: settings.maxRetries ?? DEFAULT_MAX_RETRIES, signal },
    ),
  );
}

function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}
