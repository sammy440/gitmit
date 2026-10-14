export * from "./types.js";
export { parseDiff } from "./parse.js";
export { classifyFile, classifyFiles, filterNoise, isNoise, NOISE_CATEGORIES } from "./classify.js";
export { detectType } from "./detect-type.js";
export { inferScope, scopeForPath } from "./infer-scope.js";
export { summarize, renderSummary, DEFAULT_MAX_CHARS } from "./summarize.js";
export { extractSymbol, symbolChanges } from "./symbols.js";
export { globToRegExp, matchesAny } from "./glob.js";
export * from "./secrets.js";
export * from "./message.js";
export * from "./providers/index.js";
export { generate, EmptyDiffError, type GenerateOptions, type GenerateResult } from "./generate.js";
export { analyze, type AnalyzeOptions, type Analysis } from "./analyze.js";
export {
  parseRawDiff,
  diffUnits,
  buildPatch,
  heuristicPlan,
  planSplit,
  PlanSchema,
  type RawFile,
  type SplitUnit,
  type SplitGroup,
  type SplitPlan,
  type DiffUnits,
  type PlanOptions,
  type PlanResult,
} from "./split.js";

import { DraftSchema as _DraftSchema } from "./message.js";
import { PlanSchema as _PlanSchema } from "./split.js";

/**
 * The only structured outputs gitmit ever asks a model for, by name. A server
 * relaying prompts for the account provider accepts these and nothing else.
 */
export const OUTPUT_SCHEMAS = {
  commit_suggestions: _DraftSchema,
  commit_plan: _PlanSchema,
} as const;
export type OutputName = keyof typeof OUTPUT_SCHEMAS;
