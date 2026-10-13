import { isNoise } from "./classify.js";
import { symbolChanges } from "./symbols.js";
import type { ClassifiedFile, DiffSummary, FileSummary, Hunk } from "./types.js";

export interface SummarizeOptions {
  /** Hard upper bound on the rendered summary length, in characters. */
  maxChars?: number;
}

export const DEFAULT_MAX_CHARS = 12_000;

const OMITTED_NOTE_ROOM = "\n(excerpt truncated to fit the size limit)".length;

/** Below this many characters an excerpt is not worth including. */
const MIN_EXCERPT = 160;

/**
 * Build a summary that fits in `maxChars`. Every file gets a header line with
 * its stats and changed symbols. The remaining budget is shared between file
 * excerpts so that small files are shown whole and large files are truncated.
 * Noise files are listed but their content is never included.
 */
export function summarize(files: readonly ClassifiedFile[], options: SummarizeOptions = {}): DiffSummary {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const summaries = files.map(toFileSummary);
  const fullExcerpts = files.map((file) => (isNoise(file) ? "" : renderHunks(file.hunks)));

  const stats = {
    files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };

  const headerText = renderText(summaries, stats);
  // Room for the "(... omitted ...)" note each content file may get after measuring.
  const contentFiles = fullExcerpts.filter(Boolean).length;
  const budget = maxChars - headerText.length - contentFiles * OMITTED_NOTE_ROOM;
  let truncated = false;

  if (budget > 0) {
    const shares = allocate(
      fullExcerpts.map((excerpt) => (excerpt ? excerpt.length + EXCERPT_OVERHEAD : 0)),
      budget,
    );
    summaries.forEach((summary, index) => {
      const full = fullExcerpts[index]!;
      if (!full) return;
      const share = shares[index]! - EXCERPT_OVERHEAD;
      if (share >= full.length) {
        summary.excerpt = full;
      } else if (share >= MIN_EXCERPT) {
        summary.excerpt = truncateLines(full, share);
        summary.omitted = "excerpt truncated to fit the size limit";
        truncated = true;
      } else {
        summary.omitted = "content omitted to fit the size limit";
        truncated = true;
      }
    });
  } else {
    truncated = summaries.some((_, index) => fullExcerpts[index] !== "");
    for (const [index, summary] of summaries.entries()) {
      if (fullExcerpts[index]) summary.omitted = "content omitted to fit the size limit";
    }
  }

  const { text, clipped } = renderSummary(summaries, stats, maxChars);
  return { files: summaries, stats, truncated: truncated || clipped, text };
}

function toFileSummary(file: ClassifiedFile): FileSummary {
  const symbols = isNoise(file) ? { added: [], removed: [] } : symbolChanges(file);
  const summary: FileSummary = {
    path: file.path,
    status: file.status,
    category: file.category,
    additions: file.additions,
    deletions: file.deletions,
    addedSymbols: symbols.added.map((s) => s.name),
    removedSymbols: symbols.removed.map((s) => s.name),
    sections: [...new Set(file.hunks.map((h) => h.section).filter(Boolean))],
  };
  if (file.oldPath !== file.path) summary.oldPath = file.oldPath;
  if (file.noiseReason) summary.omitted = file.noiseReason;
  return summary;
}

/**
 * Water-filling allocation: each item gets at most what it needs, and budget
 * left over by small items is shared among the larger ones.
 */
function allocate(needs: readonly number[], budget: number): number[] {
  const shares = needs.map(() => 0);
  const order = needs
    .map((need, index) => ({ need, index }))
    .filter((item) => item.need > 0)
    .sort((a, b) => a.need - b.need);
  let remaining = budget;
  order.forEach((item, position) => {
    const fair = Math.floor(remaining / (order.length - position));
    const share = Math.min(item.need, fair);
    shares[item.index] = share;
    remaining -= share;
  });
  return shares;
}

function renderHunks(hunks: readonly Hunk[]): string {
  const out: string[] = [];
  for (const hunk of hunks) {
    out.push(hunk.header);
    for (const line of hunk.lines) {
      out.push((line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ") + line.content);
    }
  }
  return out.join("\n");
}

/** Keep whole lines up to `max` characters, then note how many were dropped. */
function truncateLines(text: string, max: number): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let length = 0;
  const markerRoom = 40;
  for (const line of lines) {
    if (length + line.length + 1 > max - markerRoom) break;
    kept.push(line);
    length += line.length + 1;
  }
  const dropped = lines.length - kept.length;
  if (dropped > 0) kept.push(`... ${dropped} more lines`);
  return kept.join("\n");
}

const EXCERPT_OVERHEAD = "```diff\n\n```\n".length;

function renderText(summaries: readonly FileSummary[], stats: DiffSummary["stats"]): string {
  const out = [`${stats.files} files changed, +${stats.additions} -${stats.deletions}`];
  for (const file of summaries) {
    const path = file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path;
    out.push("", `## ${path} (${file.status}, ${file.category}, +${file.additions} -${file.deletions})`);
    if (file.addedSymbols.length) out.push(`added: ${file.addedSymbols.join(", ")}`);
    if (file.removedSymbols.length) out.push(`removed: ${file.removedSymbols.join(", ")}`);
    if (file.sections.length) out.push(`in: ${file.sections.join("; ")}`);
    if (file.omitted) out.push(`(${file.omitted})`);
    if (file.excerpt) out.push("```diff", file.excerpt, "```");
  }
  return out.join("\n");
}

/** Render summaries to text no longer than `maxChars`. */
export function renderSummary(
  summaries: readonly FileSummary[],
  stats: DiffSummary["stats"],
  maxChars: number,
): { text: string; clipped: boolean } {
  const text = renderText(summaries, stats);
  return text.length > maxChars ? { text: clip(text, maxChars), clipped: true } : { text, clipped: false };
}

function clip(text: string, max: number): string {
  const marker = "\n... (summary truncated)";
  const cut = text.lastIndexOf("\n", max - marker.length);
  return text.slice(0, cut > 0 ? cut : Math.max(0, max - marker.length)) + marker;
}
