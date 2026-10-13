import { isNoise } from "./classify.js";
import { symbolChanges } from "./symbols.js";
import type { ClassifiedFile, FileCategory, TypeDetection } from "./types.js";

/** At or below this many changed source lines, an edit counts as small. */
const SMALL_CHANGE = 30;

const FIX_WORDS =
  /\b(?:fix(?:es|ed)?|bug|regression|crash|broken|incorrect|wrong|typo|null|undefined|NaN|nil|None|edge case|off[- ]by[- ]one|race|leak|guard|sanitize|escape)\b/i;

/**
 * Decide the commit type from file categories and change shape. Rules give a
 * "high" confidence answer when the diff is unambiguous (only tests, only docs, ...).
 * Otherwise the result is a "low" confidence hint the model may override.
 */
export function detectType(files: readonly ClassifiedFile[]): TypeDetection {
  if (files.length === 0) return low("chore", "empty diff");

  const meaningful = files.filter((f) => !isNoise(f) || f.category === "binary");
  if (meaningful.length === 0) {
    if (files.every((f) => f.category === "snapshot")) return high("test", "only test snapshots changed");
    return high("chore", "only lockfiles or generated files changed");
  }

  const only = (...categories: FileCategory[]) => meaningful.every((f) => categories.includes(f.category));

  if (only("test")) return high("test", "only test files changed");
  if (only("docs")) return high("docs", "only documentation changed");
  if (only("ci")) return high("ci", "only CI configuration changed");
  if (only("manifest", "docs") && isVersionBump(meaningful)) return high("chore", "version bump (release)");
  if (only("manifest")) return high("chore", "only package manifests changed");
  if (only("config", "manifest")) return high("chore", "only tooling configuration changed");
  if (only("asset", "binary")) return low("chore", "only assets changed");
  if (only("test", "manifest")) return low("test", "tests changed along with dependencies");

  if (meaningful.every((f) => f.status === "modified" && f.hunks.length === 0 && f.oldMode !== f.newMode)) {
    return high("chore", "only file permissions changed");
  }
  if (isWhitespaceOnly(meaningful)) return high("style", "only whitespace or formatting changed");

  const source = meaningful.filter((f) => f.category === "source");
  if (source.length === 0) return low("chore", "mixed non-source changes");

  if (only("source", "docs") && source.every(isCommentOnly)) return low("docs", "only comments and docs changed");

  if (source.every((f) => (f.status === "renamed" || f.status === "copied") && f.hunks.length === 0)) {
    return high("refactor", "files moved or renamed without content changes");
  }
  if (source.every((f) => f.status === "deleted")) return low("refactor", "only source deletions");

  const additions = sum(source, (f) => f.additions);
  const deletions = sum(source, (f) => f.deletions);
  const changes = source.map(symbolChanges);
  const newExports = changes.flatMap((c) => c.added.filter((s) => s.exported).map((s) => s.name));
  const removedExports = changes.flatMap((c) => c.removed.filter((s) => s.exported).map((s) => s.name));
  const addedFiles = source.filter((f) => f.status === "added");
  const small = additions + deletions <= SMALL_CHANGE && addedFiles.length === 0;

  if (newExports.length > 0 && newExports.length > removedExports.length) {
    const reason = addedFiles.length
      ? `new files add exported symbols: ${list(newExports)}`
      : `new exported symbols: ${list(newExports)}`;
    return low("feat", reason);
  }
  if (addedFiles.length > 0) return low("feat", `new source files: ${list(addedFiles.map((f) => f.path))}`);

  if (small && source.some(hasFixSignal)) return low("fix", "small edit with fix-related wording");
  if (small) return low("fix", "small edit to existing code");

  if (deletions > additions * 2) return low("refactor", "mostly removes code");
  if (removedExports.length > 0 && newExports.length === removedExports.length) {
    return low("refactor", "exported symbols renamed");
  }
  return low("feat", "ambiguous change; model should decide");
}

function hasFixSignal(file: ClassifiedFile): boolean {
  return file.hunks.some(
    (hunk) => FIX_WORDS.test(hunk.section) || hunk.lines.some((l) => l.kind !== "context" && FIX_WORDS.test(l.content)),
  );
}

const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#(?![!\[]|include|define|if|endif|else|pragma)|--|<!--|$)/;

/** True when every changed line is a comment or blank. */
function isCommentOnly(file: ClassifiedFile): boolean {
  if (file.status !== "modified" || file.hunks.length === 0) return false;
  return file.hunks.every((hunk) => hunk.lines.every((l) => l.kind === "context" || COMMENT_LINE.test(l.content)));
}

const VERSION_LINE = /^\s*"?version"?\s*[:=]/;

/** True when every manifest change only touches its version field. */
function isVersionBump(files: readonly ClassifiedFile[]): boolean {
  const manifests = files.filter((f) => f.category === "manifest");
  return (
    manifests.length > 0 &&
    manifests.every(
      (f) =>
        f.hunks.length > 0 &&
        f.hunks.every((hunk) => hunk.lines.every((l) => l.kind === "context" || VERSION_LINE.test(l.content))),
    )
  );
}

/** True when every changed line pair differs only in whitespace. */
function isWhitespaceOnly(files: readonly ClassifiedFile[]): boolean {
  if (files.some((f) => f.status !== "modified" || f.binary || f.hunks.length === 0)) return false;
  return files.every((file) =>
    file.hunks.every((hunk) => {
      const strip = (kind: "add" | "del") =>
        hunk.lines
          .filter((l) => l.kind === kind)
          .map((l) => l.content.replace(/\s+/g, ""))
          .join("");
      return strip("add") === strip("del");
    }),
  );
}

function high(type: TypeDetection["type"], reason: string): TypeDetection {
  return { type, confidence: "high", reasons: [reason] };
}

function low(type: TypeDetection["type"], reason: string): TypeDetection {
  return { type, confidence: "low", reasons: [reason] };
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

function list(items: readonly string[], max = 3): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}
