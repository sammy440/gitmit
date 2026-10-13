import { analyze, type AnalyzeOptions, type Analysis } from "./analyze.js";
import { DEFAULT_MESSAGE_OPTIONS, type GenerateInput, type MessageOptions, type Suggestion } from "./message.js";
import type { Provider } from "./providers/types.js";
import { redactSummary, scanSummary, SecretsDetectedError, type SecretFinding } from "./secrets.js";

export interface GenerateOptions extends AnalyzeOptions, Partial<Omit<MessageOptions, "scopes">> {
  provider: Provider;
  /** What to do when a secret is found before calling a remote provider. Default: abort. */
  secrets?: { onDetect: "abort" | "redact" };
  signal?: AbortSignal;
}

export interface GenerateResult {
  analysis: Analysis;
  suggestions: Suggestion[];
  /** Secrets found before the provider call. Empty for local providers, which are not scanned. */
  secrets: SecretFinding[];
  /** True when secrets were redacted from what the provider received. */
  redacted: boolean;
}

export class EmptyDiffError extends Error {
  constructor() {
    super("The diff has no changes to describe.");
    this.name = "EmptyDiffError";
  }
}

/**
 * The full pipeline: analyze the diff, scan for secrets before any remote
 * call, then ask the provider for validated suggestions.
 */
export async function generate(diff: string, options: GenerateOptions): Promise<GenerateResult> {
  const analysis = analyze(diff, options);
  if (analysis.files.length === 0) throw new EmptyDiffError();

  const messageOptions: MessageOptions = {
    types: options.types ?? DEFAULT_MESSAGE_OPTIONS.types,
    subjectMaxLength: options.subjectMaxLength ?? DEFAULT_MESSAGE_OPTIONS.subjectMaxLength,
    bodyStyle: options.bodyStyle ?? DEFAULT_MESSAGE_OPTIONS.bodyStyle,
    language: options.language ?? DEFAULT_MESSAGE_OPTIONS.language,
    variants: options.variants ?? DEFAULT_MESSAGE_OPTIONS.variants,
  };
  if (options.scopes) messageOptions.scopes = options.scopes;

  let summary = analysis.summary;
  let findings: SecretFinding[] = [];
  let redacted = false;

  if (options.provider.remote) {
    findings = scanSummary(summary);
    if (findings.length > 0) {
      if ((options.secrets?.onDetect ?? "abort") === "abort") throw new SecretsDetectedError(findings);
      summary = redactSummary(summary);
      redacted = true;
      // Never send anything the scanner still flags.
      const remaining = scanSummary(summary);
      if (remaining.length > 0) throw new SecretsDetectedError(remaining);
    }
  }

  const input: GenerateInput = { summary, type: analysis.type, scope: analysis.scope, options: messageOptions };
  const suggestions = await options.provider.generate(input, options.signal);
  return { analysis, suggestions, secrets: findings, redacted };
}
