import { createProvider, type Provider, type ProviderName } from "@gitmit/core";
import { userEnvFile } from "./env.js";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface ResolvedProvider {
  provider: Provider;
  name: ProviderName;
  model?: string;
  /** Shown to the user, e.g. why the offline fallback was chosen. */
  note?: string;
}

const KEY_VARS: Partial<Record<ProviderName, string>> = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };

/**
 * Pick the provider: an explicit choice wins; otherwise the first provider
 * with an API key; otherwise the offline rules provider.
 */
export function resolveProvider(
  env: NodeJS.ProcessEnv,
  requested?: ProviderName,
  model?: string,
): ResolvedProvider {
  const name = requested ?? (env.OPENAI_API_KEY ? "openai" : env.ANTHROPIC_API_KEY ? "anthropic" : "rules");
  const keyVar = KEY_VARS[name];
  if (keyVar && !env[keyVar]) {
    throw new UsageError(
      `${keyVar} is not set. Add it to ${userEnvFile(env)} or export it in your shell, or use --provider rules to work offline.`,
    );
  }

  const settings = {
    openai: { apiKey: env.OPENAI_API_KEY, model: model ?? (env.OPENAI_MODEL || undefined) },
    anthropic: { apiKey: env.ANTHROPIC_API_KEY, model: model ?? (env.ANTHROPIC_MODEL || undefined) },
    ollama: { baseURL: env.OLLAMA_HOST || undefined, model: model ?? (env.OLLAMA_MODEL || undefined) },
    rules: {},
  }[name];

  const resolved: ResolvedProvider = { provider: createProvider(name, settings), name };
  if ("model" in settings && settings.model) resolved.model = settings.model;
  if (!requested && name === "rules") {
    resolved.note = `No API key found, so messages come from offline rules. For AI messages, add OPENAI_API_KEY or ANTHROPIC_API_KEY to ${userEnvFile(env)}.`;
  }
  return resolved;
}
