export type FileStatus = "added" | "deleted" | "modified" | "renamed" | "copied";

export interface DiffLine {
  kind: "add" | "del" | "context";
  content: string;
  /** The line was followed by "\ No newline at end of file". */
  noNewline?: boolean;
}

export interface Hunk {
  /** The raw "@@ -a,b +c,d @@ section" line. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the closing @@, usually the enclosing function or class. */
  section: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** Path after the change. For deleted files, the path that was removed. */
  path: string;
  /** Path before the change. Equal to `path` unless renamed or copied. */
  oldPath: string;
  status: FileStatus;
  binary: boolean;
  /** Similarity percentage for renames and copies. */
  similarity?: number;
  oldMode?: string;
  newMode?: string;
  additions: number;
  deletions: number;
  hunks: Hunk[];
}

export type FileCategory =
  | "source"
  | "test"
  | "docs"
  | "ci"
  | "config"
  | "manifest"
  | "asset"
  | "lockfile"
  | "snapshot"
  | "generated"
  | "minified"
  | "binary"
  | "ignored";

export interface ClassifiedFile extends DiffFile {
  category: FileCategory;
  /** Set when the file is noise: its content is never summarized or sent to a model. */
  noiseReason?: string;
}

export type CommitType =
  | "feat"
  | "fix"
  | "docs"
  | "style"
  | "refactor"
  | "perf"
  | "test"
  | "build"
  | "ci"
  | "chore"
  | "revert";

export type Confidence = "high" | "low";

export interface TypeDetection {
  type: CommitType;
  /** "low" means the type is a hint for the model rather than a decision. */
  confidence: Confidence;
  reasons: string[];
}

export interface ScopeInference {
  scope?: string;
  confidence: Confidence;
  /** Every scope seen, most frequent first. More than one means the change spans scopes. */
  candidates: string[];
  reasons: string[];
}

export interface FileSummary {
  path: string;
  oldPath?: string;
  status: FileStatus;
  category: FileCategory;
  additions: number;
  deletions: number;
  /** Declarations that appear only in added lines. */
  addedSymbols: string[];
  /** Declarations that appear only in removed lines. */
  removedSymbols: string[];
  /** Hunk section headings, usually enclosing functions. */
  sections: string[];
  /** Diff hunks as text, possibly truncated to fit the budget. */
  excerpt?: string;
  /** Why the excerpt is missing or incomplete. */
  omitted?: string;
}

export interface DiffSummary {
  files: FileSummary[];
  stats: { files: number; additions: number; deletions: number };
  /** True when any content was cut to stay within the budget. */
  truncated: boolean;
  /** Rendered summary, never longer than the configured maximum. */
  text: string;
}
