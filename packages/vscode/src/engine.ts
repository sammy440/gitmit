/**
 * Everything the extension does that doesn't need the VS Code API: choosing a
 * provider, generating messages and planning splits. It uses the same
 * building blocks as the `gitmit` command, so the editor and the terminal
 * always agree. Kept free of `vscode` imports so it can be tested directly.
 */
import { resolve } from "node:path";
import {
  buildPatch,
  createProvider,
  generate,
  planSplit,
  type DiffUnits,
  type GenerateResult,
  type Provider,
  type ProviderName,
} from "@gitmit/core";
import { loadEnv, loadSettings, type Settings } from "@gitmit/cli";

export type ProviderChoice = "auto" | ProviderName;

export interface ExtensionSettings {
  provider: ProviderChoice;
  model: string;
  ollamaHost: string;
  configPath: string;
}

/** API keys kept in VS Code's secret storage. */
export interface StoredKeys {
  openai?: string;
  anthropic?: string;
}

export class MissingKeyError extends Error {
  constructor(readonly provider: "openai" | "anthropic") {
    super(`No ${provider === "openai" ? "OpenAI" : "Anthropic"} API key is set.`);
    this.name = "MissingKeyError";
  }
}

export interface Prepared {
  settings: Settings;
  provider: Provider;
  providerName: ProviderName;
  model?: string;
  /** Shown to the user, e.g. why offline rules were chosen. */
  note?: string;
}

/**
 * Load the repository's settings (gitmit config, commitlint, branch ticket)
 * and pick the provider. Keys come from VS Code's secret storage first, then
 * the same places the CLI looks (environment, ~/.config/gitmit/.env).
 */
export async function prepare(
  root: string,
  keys: StoredKeys,
  options: ExtensionSettings,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Prepared> {
  const settings = await loadSettings(root, env, {
    explicit: options.configPath ? resolve(root, options.configPath) : undefined,
    overrides: {
      provider: options.provider === "auto" ? undefined : options.provider,
      model: options.model || undefined,
    },
  });

  const fileEnv = loadEnv(env);
  const openaiKey = keys.openai || fileEnv.OPENAI_API_KEY;
  const anthropicKey = keys.anthropic || fileEnv.ANTHROPIC_API_KEY;
  const providerName: ProviderName =
    settings.config.provider ?? (openaiKey ? "openai" : anthropicKey ? "anthropic" : "rules");

  const apiKey = providerName === "openai" ? openaiKey : providerName === "anthropic" ? anthropicKey : undefined;
  if ((providerName === "openai" || providerName === "anthropic") && !apiKey) throw new MissingKeyError(providerName);

  const model =
    settings.config.model ||
    (providerName === "openai" ? fileEnv.OPENAI_MODEL : providerName === "anthropic" ? fileEnv.ANTHROPIC_MODEL : providerName === "ollama" ? fileEnv.OLLAMA_MODEL : undefined) ||
    undefined;
  const baseURL = providerName === "ollama" ? options.ollamaHost || fileEnv.OLLAMA_HOST || undefined : undefined;

  const prepared: Prepared = {
    settings,
    provider: createProvider(providerName, { apiKey, model, baseURL }),
    providerName,
  };
  if (model) prepared.model = model;
  if (providerName === "rules" && options.provider === "auto" && !settings.config.provider) {
    prepared.note = "No API key set, so this message comes from offline rules. Run \"gitmit: Set API Key\" for AI-written messages.";
  }
  return prepared;
}

/** A short label for status messages, e.g. "openai (gpt-5-mini)". */
export function providerLabel(prepared: Prepared): string {
  return `${prepared.providerName}${prepared.model ? ` (${prepared.model})` : ""}`;
}

/** Commit message suggestions for a staged diff. */
export function generateMessages(diff: string, prepared: Prepared, redact: boolean, signal?: AbortSignal): Promise<GenerateResult> {
  return generate(diff, {
    ...prepared.settings.options,
    provider: prepared.provider,
    secrets: { onDetect: redact ? "redact" : "abort" },
    signal,
  });
}

export interface PlannedCommit {
  units: number[];
  reason: string;
  message: string;
}

export interface Plan {
  diff: DiffUnits;
  commits: PlannedCommit[];
  source: "model" | "rules";
  note?: string;
}

/** A split plan with a message for every commit, like `gitmit split`. */
export async function planCommits(diffText: string, prepared: Prepared, redact: boolean): Promise<Plan> {
  const secrets = { onDetect: redact ? ("redact" as const) : ("abort" as const) };
  const { diff, plan } = await planSplit(diffText, {
    provider: prepared.provider,
    ignore: prepared.settings.options.ignore,
    scopeFromPaths: prepared.settings.options.scopeFromPaths,
    secrets,
  });
  const commits = await Promise.all(
    plan.groups.map(async (group) => ({
      units: group.units,
      reason: group.reason,
      message: await messageFor(diff, group.units, prepared, redact),
    })),
  );
  const result: Plan = { diff, commits, source: plan.source };
  if (plan.note) result.note = plan.note;
  return result;
}

/** One message for a set of units (used after the user moves changes between commits). */
export async function messageFor(diff: DiffUnits, units: number[], prepared: Prepared, redact: boolean): Promise<string> {
  const result = await generate(buildPatch(diff, units), {
    ...prepared.settings.options,
    provider: prepared.provider,
    secrets: { onDetect: redact ? "redact" : "abort" },
    variants: 1,
  });
  return result.suggestions[0]!.message;
}
