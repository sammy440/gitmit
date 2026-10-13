import { describe, expect, it } from "vitest";
import { analyze } from "../src/index.js";

function newFileDiff(path: string, lineCount: number, lineLength = 40): string {
  const lines = Array.from({ length: lineCount }, (_, i) => `+${`line ${i} `.padEnd(lineLength, "x")}`);
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lineCount} @@`,
    ...lines,
  ].join("\n");
}

describe("summarize", () => {
  it("includes small diffs whole", () => {
    const result = analyze(newFileDiff("src/a.ts", 5));
    expect(result.summary.truncated).toBe(false);
    expect(result.summary.files[0]!.excerpt).toContain("+line 4");
  });

  it.each([2_000, 4_000, 12_000])("stays within maxChars=%i for a huge diff", (maxChars) => {
    const diff = Array.from({ length: 40 }, (_, i) => newFileDiff(`src/mod${i}/file.ts`, 500)).join("\n");
    const result = analyze(diff, { maxSummaryChars: maxChars });
    expect(result.summary.text.length).toBeLessThanOrEqual(maxChars);
    expect(result.summary.truncated).toBe(true);
    expect(result.summary.stats).toEqual({ files: 40, additions: 20_000, deletions: 0 });
  });

  it("stays within the limit when the file list alone is too long", () => {
    const diff = Array.from({ length: 2_000 }, (_, i) => newFileDiff(`src/m${i}/f.ts`, 1)).join("\n");
    const result = analyze(diff, { maxSummaryChars: 3_000 });
    expect(result.summary.text.length).toBeLessThanOrEqual(3_000);
    expect(result.summary.text).toContain("(summary truncated)");
  });

  it("shows small files whole and truncates the large one", () => {
    const diff = [newFileDiff("src/a/small.ts", 3), newFileDiff("src/b/huge.ts", 2_000)].join("\n");
    const result = analyze(diff, { maxSummaryChars: 6_000 });
    const [small, huge] = result.summary.files;
    expect(small!.omitted).toBeUndefined();
    expect(small!.excerpt).toContain("+line 2");
    expect(huge!.omitted).toMatch(/truncated/);
    expect(huge!.excerpt).toMatch(/more lines$/);
    expect(result.summary.text.length).toBeLessThanOrEqual(6_000);
  });

  it("never includes the content of noise files", () => {
    const diff = [newFileDiff("pnpm-lock.yaml", 3), newFileDiff("src/a.ts", 3)].join("\n");
    const result = analyze(diff);
    expect(result.summary.text).not.toContain("pnpm-lock.yaml (added, lockfile, +3 -0)\n```");
    expect(result.summary.files[0]).toMatchObject({ path: "pnpm-lock.yaml", omitted: "lockfile" });
    expect(result.summary.files[0]!.excerpt).toBeUndefined();
  });

  it("lists added symbols", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,2 @@",
      "-export function oldName() {}",
      "+export function newName() {}",
      "+export const VERSION = 1;",
    ].join("\n");
    const [file] = analyze(diff).summary.files;
    expect(file!.addedSymbols).toEqual(["newName", "VERSION"]);
    expect(file!.removedSymbols).toEqual(["oldName"]);
  });
});
