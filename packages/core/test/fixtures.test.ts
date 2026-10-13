import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyze } from "../src/index.js";

interface Expected {
  type: string;
  confidence?: "high" | "low";
  scope: string | null;
  candidates?: string[];
  dropped?: string[];
  paths?: string[];
}

const FIXTURES = join(__dirname, "../../../fixtures");
const names = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe("fixtures", () => {
  it("has fixtures to run", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  for (const name of names) {
    it(name, () => {
      const diff = readFileSync(join(FIXTURES, name, "input.diff"), "utf8");
      const expected = JSON.parse(readFileSync(join(FIXTURES, name, "expected.json"), "utf8")) as Expected;
      const result = analyze(diff);

      expect(result.type.type, result.type.reasons.join("; ")).toBe(expected.type);
      if (expected.confidence) expect(result.type.confidence).toBe(expected.confidence);
      expect(result.scope.scope ?? null, result.scope.reasons.join("; ")).toBe(expected.scope);
      if (expected.candidates) expect(result.scope.candidates).toEqual(expected.candidates);
      expect(result.dropped.map((f) => f.path).sort()).toEqual([...(expected.dropped ?? [])].sort());
      if (expected.paths) expect(result.files.map((f) => f.path)).toEqual(expected.paths);

      // Noise content must never reach the summary.
      for (const file of result.dropped) {
        const summary = result.summary.files.find((f) => f.path === file.path);
        expect(summary?.excerpt).toBeUndefined();
      }
      expect(result.summary.text.length).toBeLessThanOrEqual(12_000);
    });
  }
});
