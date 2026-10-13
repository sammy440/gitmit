import { NOISE_CATEGORIES } from "../classify.js";
import { finalizeDraft, type Draft, type GenerateInput } from "../message.js";
import type { FileSummary } from "../types.js";
import { ProviderError, type Provider } from "./types.js";

/** Template messages from the analysis alone. No model, no network. */
export function rulesProvider(): Provider {
  return {
    name: "rules",
    remote: false,
    async generate(input) {
      const { suggestions, problems } = await finalizeDraft(draftFromRules(input), input);
      if (suggestions.length === 0) {
        throw new ProviderError("rules", `no template message passes the configured rules (${problems.join("; ")})`);
      }
      return suggestions;
    },
  };
}

function draftFromRules(input: GenerateInput): Draft {
  const files = input.summary.files.filter((f) => !NOISE_CATEGORIES.has(f.category));
  const relevant = files.length > 0 ? files : input.summary.files;
  const scope = input.scope.confidence === "high" ? (input.scope.scope ?? null) : null;
  const descriptions = [...new Set(describe(relevant, input))].slice(0, input.options.variants);
  const body = input.options.bodyStyle === "none" ? null : bodyFor(relevant);
  // The detected type may not be allowed by the team's rules; fall back to chore, then the first allowed type.
  const allowed = input.options.types;
  const type = allowed.includes(input.type.type) ? input.type.type : allowed.includes("chore") ? "chore" : allowed[0]!;
  return {
    suggestions: descriptions.map((description) => ({ type, scope, description, body })),
  };
}

function describe(files: readonly FileSummary[], input: GenerateInput): string[] {
  const out: string[] = [];
  const symbols = files.flatMap((f) => f.addedSymbols);
  const removed = files.flatMap((f) => f.removedSymbols);
  const names = files.map((f) => basename(f.path));
  const area = input.scope.scope ?? commonDir(files.map((f) => f.path));

  if (files.length === 1) {
    const file = files[0]!;
    const name = names[0]!;
    if (file.status === "added") out.push(`add ${name}`);
    else if (file.status === "deleted") out.push(`remove ${name}`);
    else if (file.status === "renamed") out.push(`rename ${basename(file.oldPath ?? "")} to ${name}`);
    else out.push(`update ${name}`);
  }
  if (symbols.length > 0) out.push(`add ${list(symbols.map((s) => `\`${s}\``))}`);
  if (removed.length > 0 && symbols.length === 0) out.push(`remove ${list(removed.map((s) => `\`${s}\``))}`);
  if (files.length > 1) out.push(`update ${list(names)}`);
  if (area) out.push(`update ${area}`);
  out.push(`update ${files.length} file${files.length === 1 ? "" : "s"}`);
  return out;
}

function bodyFor(files: readonly FileSummary[]): string | null {
  if (files.length < 2) return null;
  return files
    .slice(0, 8)
    .map((f) => `- ${f.status} ${f.path}`)
    .concat(files.length > 8 ? [`- and ${files.length - 8} more files`] : [])
    .join("\n");
}

function list(items: readonly string[], max = 3): string {
  const unique = [...new Set(items)];
  if (unique.length <= 1) return unique[0] ?? "";
  if (unique.length <= max) return `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
  return `${unique.slice(0, max).join(", ")} and ${unique.length - max} more`;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function commonDir(paths: readonly string[]): string | undefined {
  if (paths.length < 2) return undefined;
  const parts = paths.map((p) => p.split("/").slice(0, -1));
  const first = parts[0]!;
  let depth = 0;
  while (depth < first.length && parts.every((p) => p[depth] === first[depth])) depth++;
  return depth > 0 ? first.slice(0, depth).join("/") : undefined;
}
