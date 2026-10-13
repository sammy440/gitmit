export interface GlobOptions {
  nocase?: boolean;
}

const cache = new Map<string, RegExp>();

/**
 * Convert a glob to a RegExp. Supports `**`, `*`, `?` and `{a,b}`.
 * A pattern without a slash matches the basename at any depth, like .gitignore.
 */
export function globToRegExp(pattern: string, options: GlobOptions = {}): RegExp {
  const key = `${options.nocase ? "i" : ""}:${pattern}`;
  const cached = cache.get(key);
  if (cached) return cached;

  let glob = pattern.replace(/^\.\//, "");
  if (!glob.includes("/")) glob = `**/${glob}`;

  let source = "";
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const atSegmentStart = i === 0 || glob[i - 1] === "/";
        const followedBySlash = glob[i + 2] === "/";
        if (atSegmentStart && followedBySlash) {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else if (ch === "{") {
      braceDepth++;
      source += "(?:";
    } else if (ch === "}" && braceDepth > 0) {
      braceDepth--;
      source += ")";
    } else if (ch === "," && braceDepth > 0) {
      source += "|";
    } else {
      source += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
  }

  const regexp = new RegExp(`^${source}$`, options.nocase ? "i" : "");
  cache.set(key, regexp);
  return regexp;
}

export function matchesAny(path: string, patterns: readonly string[], options: GlobOptions = {}): boolean {
  return patterns.some((pattern) => globToRegExp(pattern, options).test(path));
}
