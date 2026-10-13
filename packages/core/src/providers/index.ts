import { anthropicProvider } from "./anthropic.js";
import { ollamaProvider } from "./ollama.js";
import { openaiProvider } from "./openai.js";
import { rulesProvider } from "./rules.js";
import type { Provider, ProviderSettings } from "./types.js";

export type ProviderName = "anthropic" | "openai" | "ollama" | "rules";
export const PROVIDER_NAMES: readonly ProviderName[] = ["anthropic", "openai", "ollama", "rules"];

export function createProvider(name: ProviderName, settings: ProviderSettings = {}): Provider {
  switch (name) {
    case "anthropic":
      return anthropicProvider(settings);
    case "openai":
      return openaiProvider(settings);
    case "ollama":
      return ollamaProvider(settings);
    case "rules":
      return rulesProvider();
  }
}

export { anthropicProvider, ANTHROPIC_DEFAULT_MODEL } from "./anthropic.js";
export { openaiProvider, OPENAI_DEFAULT_MODEL } from "./openai.js";
export { ollamaProvider, OLLAMA_DEFAULT_MODEL, OLLAMA_DEFAULT_URL } from "./ollama.js";
export { rulesProvider } from "./rules.js";
export { modelProvider, MAX_ATTEMPTS } from "./model.js";
export { withRetry, RetryableError, timeoutSignal } from "./retry.js";
export { ProviderError, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RETRIES } from "./types.js";
export type { Provider, ProviderSettings, CompleteFn, OutputSpec } from "./types.js";
