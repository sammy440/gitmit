import { RetryableError, timeoutSignal, withRetry } from "./retry.js";
import { modelProvider } from "./model.js";
import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS, ProviderError, type Provider, type ProviderSettings } from "./types.js";

/** The hosted gitmit API. */
export const GITMIT_API_URL = "https://gitmit-api-production.up.railway.app";

/** Relays the locally built, secret-scanned prompt through gitmit's API using the account's saved key. */
export function accountProvider(settings: ProviderSettings = {}): Provider {
  const baseURL = (settings.baseURL ?? GITMIT_API_URL).replace(/\/+$/, "");
  const fetchFn = settings.fetch ?? globalThis.fetch;

  return modelProvider("account", true, (prompt, output, signal) => {
    if (!settings.apiKey) throw new ProviderError("account", "not signed in; run gitmit login");
    return withRetry(
      async () => {
        let response: Response;
        try {
          response = await fetchFn(`${baseURL}/api/complete`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
            body: JSON.stringify({
              system: prompt.system,
              user: prompt.user,
              output: output.name,
              ...(settings.model ? { model: settings.model } : {}),
            }),
            signal: timeoutSignal(settings.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal),
          });
        } catch (error) {
          if (signal?.aborted) throw error;
          if (error instanceof Error && error.name === "TimeoutError") throw new RetryableError("account: request timed out");
          throw new ProviderError("account", `cannot reach ${baseURL}`, { cause: error });
        }

        const body = (await response.json().catch(() => null)) as { result?: unknown; error?: { code?: string; message?: string } } | null;
        if (response.ok && body && "result" in body) return body.result;

        const message = body?.error?.message ?? `HTTP ${response.status}`;
        if (response.status === 429 || response.status >= 500) throw new RetryableError(`account: ${message}`);
        if (response.status === 401) {
          throw new ProviderError("account", "your gitmit sign-in has expired or was revoked; run gitmit login", { status: 401 });
        }
        throw new ProviderError("account", message, { status: response.status });
      },
      { retries: settings.maxRetries ?? DEFAULT_MAX_RETRIES, signal },
    );
  });
}
