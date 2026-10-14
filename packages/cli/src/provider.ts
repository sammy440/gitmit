import { createProvider, type Provider, type ProviderName } from "@gitmit/core";
import type { Auth } from "./auth.js";
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

/** Pick the provider: explicit choice, then a local API key, then the gitmit account, then offline rules. */
export function resolveProvider(
  env: NodeJS.ProcessEnv,
  requested?: ProviderName,
  model?: string,
  auth?: Pick<Auth, "token" | "apiUrl">,
): ResolvedProvider {
  const name: ProviderName =
    requested ?? (env.OPENAI_API_KEY ? "openai" : env.ANTHROPIC_API_KEY ? "anthropic" : auth ? "account" : "rules");
  const keyVar = KEY_VARS[name];
  if (keyVar && !env[keyVar]) {
    throw new UsageError(
      `${keyVar} is not set. Add it to ${userEnvFile(env)}, export it in your shell, or run \`gitmit login\` to use the key saved in your gitmit account. Use --provider rules to work offline.`,
    );
  }
  if (name === "account" && !auth) {
    throw new UsageError("Not signed in to gitmit. Run `gitmit login` to use the API key saved in your account.");
  }

  const settings = {
    openai: { apiKey: env.OPENAI_API_KEY, model: model ?? (env.OPENAI_MODEL || undefined) },
    anthropic: { apiKey: env.ANTHROPIC_API_KEY, model: model ?? (env.ANTHROPIC_MODEL || undefined) },
    ollama: { baseURL: env.OLLAMA_HOST || undefined, model: model ?? (env.OLLAMA_MODEL || undefined) },
    rules: {},
    account: { apiKey: auth?.token, baseURL: auth?.apiUrl, model },
  }[name];

  const resolved: ResolvedProvider = { provider: createProvider(name, settings), name };
  if ("model" in settings && settings.model) resolved.model = settings.model;
  if (!requested && name === "rules") {
    resolved.note = `No API key found, so messages come from offline rules. For AI messages, run \`gitmit login\` to use your gitmit account, or add OPENAI_API_KEY or ANTHROPIC_API_KEY to ${userEnvFile(env)}.`;
  }
  return resolved;
}
