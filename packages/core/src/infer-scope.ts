import { isNoise } from "./classify.js";
import { globToRegExp } from "./glob.js";
import type { ClassifiedFile, ScopeInference } from "./types.js";

export interface ScopeOptions {
  /** Glob to scope mapping. The first matching glob wins. */
  scopeFromPaths?: Record<string, string>;
  /** Allowed scopes. An inferred scope outside this list is dropped. */
  scopes?: readonly string[];
}

/** Top-level directories whose children are workspace packages. */
const WORKSPACE_DIRS = new Set(["apps", "packages", "services", "libs", "modules", "crates", "plugins", "extensions"]);

/** Directories whose immediate child is a meaningful module name. */
const SOURCE_ROOTS = new Set(["src", "lib", "app", "pkg", "internal", "cmd"]);

/** Top-level directories that are never a scope on their own. */
const GENERIC_DIRS = new Set([
  ...WORKSPACE_DIRS,
  ...SOURCE_ROOTS,
  "test",
  "tests",
  "spec",
  "fixtures",
  "examples",
  "example",
  "docs",
  "doc",
  "scripts",
  "bin",
  "public",
  "static",
  "assets",
  "config",
  ".github",
  ".vscode",
  ".husky",
]);

export function scopeForPath(path: string, options: ScopeOptions = {}): string | undefined {
  if (options.scopeFromPaths) {
    for (const [glob, scope] of Object.entries(options.scopeFromPaths)) {
      if (globToRegExp(glob).test(path)) return scope;
    }
  }

  const segments = path.split("/");
  const dirs = segments.slice(0, -1);
  if (dirs.length === 0) return undefined;

  if (WORKSPACE_DIRS.has(dirs[0]!) && dirs.length >= 2) return normalize(dirs[1]!);

  const rootIndex = dirs.findIndex((d) => SOURCE_ROOTS.has(d));
  if (rootIndex !== -1 && rootIndex + 1 < dirs.length) return normalize(dirs[rootIndex + 1]!);

  if (!GENERIC_DIRS.has(dirs[0]!) && !dirs[0]!.startsWith(".")) return normalize(dirs[0]!);
  return undefined;
}

/** Infer one scope for the whole change, or none when files span several scopes. */
export function inferScope(files: readonly ClassifiedFile[], options: ScopeOptions = {}): ScopeInference {
  const meaningful = files.filter((f) => !isNoise(f));
  const considered = meaningful.length > 0 ? meaningful : files;

  const counts = new Map<string, number>();
  let unscoped = 0;
  for (const file of considered) {
    const scope = scopeForPath(file.path, options);
    if (scope === undefined) unscoped++;
    else counts.set(scope, (counts.get(scope) ?? 0) + 1);
  }
  const candidates = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([scope]) => scope);

  if (candidates.length === 0) {
    return { confidence: "high", candidates, reasons: ["no file maps to a scope"] };
  }
  if (candidates.length > 1) {
    return { confidence: "low", candidates, reasons: [`files span several scopes: ${candidates.join(", ")}`] };
  }

  const scope = candidates[0]!;
  if (options.scopes && !options.scopes.includes(scope)) {
    return { confidence: "low", candidates, reasons: [`inferred scope "${scope}" is not in the allowed list`] };
  }
  if (unscoped > 0) {
    return {
      scope,
      confidence: "low",
      candidates,
      reasons: [`most files are in "${scope}", ${unscoped} have no scope`],
    };
  }
  return { scope, confidence: "high", candidates, reasons: [`all files are in "${scope}"`] };
}

function normalize(name: string): string {
  return name.replace(/^@/, "").toLowerCase();
}
