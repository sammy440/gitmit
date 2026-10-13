import type { DiffFile } from "./types.js";

export interface Symbol {
  name: string;
  /** Visible outside its module: JS/TS export, Go capitalized, Rust pub, Python top-level public. */
  exported: boolean;
}

interface Rule {
  pattern: RegExp;
  exported: (match: RegExpExecArray, line: string) => boolean;
}

const RULES: Rule[] = [
  // JS/TS: export function/class/const/interface/type/enum
  {
    pattern:
      /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    exported: () => true,
  },
  // Python
  {
    pattern: /^(\s*)(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)\s*[(:]/,
    exported: (m) => m[1] === "" && !m[2]!.startsWith("_"),
  },
  // JS/TS: non-exported function or class
  {
    pattern: /^\s*(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/,
    exported: () => false,
  },
  // Go
  {
    pattern: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
    exported: (m) => /^[A-Z]/.test(m[1]!),
  },
  {
    pattern: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/,
    exported: (m) => /^[A-Z]/.test(m[1]!),
  },
  // Rust
  {
    pattern: /^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/,
    exported: (m) => m[1] !== undefined,
  },
];

export function extractSymbol(line: string): Symbol | undefined {
  for (const rule of RULES) {
    const match = rule.pattern.exec(line);
    if (!match) continue;
    const name = match[match.length - 1]!;
    return { name, exported: rule.exported(match, line) };
  }
  return undefined;
}

export interface SymbolChanges {
  /** Declared in added lines but not in removed lines. */
  added: Symbol[];
  /** Declared in removed lines but not in added lines. */
  removed: Symbol[];
  /** Declared on both sides: signature or body changed. */
  changed: Symbol[];
}

export function symbolChanges(file: DiffFile): SymbolChanges {
  const added = new Map<string, Symbol>();
  const removed = new Map<string, Symbol>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "context") continue;
      const symbol = extractSymbol(line.content);
      if (!symbol) continue;
      (line.kind === "add" ? added : removed).set(symbol.name, symbol);
    }
  }
  const result: SymbolChanges = { added: [], removed: [], changed: [] };
  for (const [name, symbol] of added) {
    (removed.has(name) ? result.changed : result.added).push(symbol);
  }
  for (const [name, symbol] of removed) {
    if (!added.has(name)) result.removed.push(symbol);
  }
  return result;
}
