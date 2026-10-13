import { classifyFiles, filterNoise } from "./classify.js";
import { detectType } from "./detect-type.js";
import { inferScope } from "./infer-scope.js";
import { parseDiff } from "./parse.js";
import { summarize } from "./summarize.js";
import type { ClassifiedFile, DiffSummary, ScopeInference, TypeDetection } from "./types.js";

export interface AnalyzeOptions {
  /** Extra globs to treat as noise. */
  ignore?: readonly string[];
  /** Glob to scope mapping. The first matching glob wins. */
  scopeFromPaths?: Record<string, string>;
  /** Allowed scopes. */
  scopes?: readonly string[];
  /** Upper bound on the summary length, in characters. */
  maxSummaryChars?: number;
}

export interface Analysis {
  /** Every file in the diff, with its category. */
  files: ClassifiedFile[];
  /** Files whose content feeds the summary. */
  kept: ClassifiedFile[];
  /** Noise files: listed in the summary, content never included. */
  dropped: ClassifiedFile[];
  type: TypeDetection;
  scope: ScopeInference;
  summary: DiffSummary;
}

/** Run pipeline steps 1, 2, 4, 5 and 6: parse, filter, detect type, infer scope, summarize. */
export function analyze(diff: string, options: AnalyzeOptions = {}): Analysis {
  const files = classifyFiles(parseDiff(diff), { ignore: options.ignore });
  const { kept, dropped } = filterNoise(files);
  return {
    files,
    kept,
    dropped,
    type: detectType(files),
    scope: inferScope(files, { scopeFromPaths: options.scopeFromPaths, scopes: options.scopes }),
    summary: summarize(files, { maxChars: options.maxSummaryChars }),
  };
}
