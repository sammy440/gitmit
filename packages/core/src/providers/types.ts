import type { z } from "zod";
import type { GenerateInput, Prompt, Suggestion } from "../message.js";

export interface Provider {
  name: string;
  /** True when the provider sends data off this machine. Remote providers only receive secret-scanned input. */
  remote: boolean;
  generate(input: GenerateInput, signal?: AbortSignal): Promise<Suggestion[]>;
  /** Structured completion for other tasks (e.g. split planning). Absent for providers without a model. */
  complete?: CompleteFn;
}

/** The structured answer a prompt must produce. */
export interface OutputSpec {
  schema: z.ZodType;
  /** Short identifier for the format, e.g. "commit_suggestions". */
  name: string;
}

/** Sends one prompt to a model and returns its structured answer, validated against `output.schema`. */
export type CompleteFn = (prompt: Prompt, output: OutputSpec, signal?: AbortSignal) => Promise<unknown>;

export interface ProviderSettings {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Retries for rate limits, server errors and network failures. */
  maxRetries?: number;
  /** Custom fetch, for tests or proxies. */
  fetch?: typeof globalThis.fetch;
}

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;

export class ProviderError extends Error {
  readonly provider: string;
  readonly status?: number;
  constructor(provider: string, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(`${provider}: ${message}`, { cause: options.cause });
    this.name = "ProviderError";
    this.provider = provider;
    if (options.status !== undefined) this.status = options.status;
  }
}
