import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { modelProvider, rulesProvider } from "../src/providers/index.js";
import { buildPatch, diffUnits, heuristicPlan, parseRawDiff, planSplit, type DiffUnits } from "../src/split.js";

let dir: string;
let home: string;
let diffText: string;
let stagedTree: string;
let units: DiffUnits;

const env = () => ({
  PATH: process.env.PATH,
  HOME: home,
  GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
});
const git = (args: string[], extra: Record<string, string> = {}) =>
  execFileSync("git", args, { cwd: dir, env: { ...env(), ...extra }, encoding: "utf8" });
const write = (path: string, content: string | Buffer) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};
const lines = (n: number, label: string) => Array.from({ length: n }, (_, i) => `${label} line ${i + 1}`).join("\n") + "\n";

/** Apply patches in order onto HEAD in a throwaway index; return the resulting tree. */
function applyInOrder(patches: string[]): string {
  const index = join(home, `index-${Math.random().toString(36).slice(2)}`);
  const extra = { GIT_INDEX_FILE: index };
  git(["read-tree", "HEAD"], extra);
  patches.forEach((patch, i) => {
    const file = join(home, `p${i}.patch`);
    writeFileSync(file, patch);
    git(["apply", "--cached", "--whitespace=nowarn", file], extra);
  });
  const tree = git(["write-tree"], extra).trim();
  rmSync(index, { force: true });
  return tree;
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "gitmit-split-home-"));
  dir = mkdtempSync(join(tmpdir(), "gitmit-split-"));
  writeFileSync(join(home, "gitconfig"), "");
  git(["init", "-q", "-b", "main"]);

  write("src/app.ts", lines(60, "app"));
  write("src/old-name.ts", lines(20, "moved"));
  write("src/remove-me.ts", lines(5, "gone"));
  write("scripts/run.sh", "#!/bin/sh\necho run\n");
  write("win/crlf.txt", "one\r\ntwo\r\nthree\r\n" + lines(20, "crlf").replace(/\n/g, "\r\n") + "end\r\n");
  write("notrail.txt", "a\nb\nc\n" + lines(20, "nt") + "last");
  write("assets/logo.bin", Buffer.from([0, 1, 2, 3, 255, 0, 7]));
  write("docs/café notes.md", lines(30, "notes"));
  write("package.json", '{\n  "name": "x",\n  "version": "1.0.0"\n}\n');
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);

  // Three separate hunks in one file.
  const app = lines(60, "app").split("\n");
  app[2] = "app line 3 CHANGED";
  app[29] = "app line 30 CHANGED";
  app.splice(55, 0, "inserted near the end");
  write("src/app.ts", app.join("\n"));
  // Rename with an edit.
  git(["mv", "src/old-name.ts", "src/new-name.ts"]);
  write("src/new-name.ts", lines(20, "moved").replace("moved line 10", "moved line 10 edited"));
  unlinkSync(join(dir, "src/remove-me.ts"));
  write("src/added.ts", "export function added() {}\n");
  chmodSync(join(dir, "scripts/run.sh"), 0o755);
  write("win/crlf.txt", "one\r\nTWO\r\nthree\r\n" + lines(20, "crlf").replace(/\n/g, "\r\n") + "END\r\n");
  write("notrail.txt", "A\nb\nc\n" + lines(20, "nt") + "LAST");
  write("assets/logo.bin", Buffer.from([0, 1, 2, 3, 254, 0, 9, 9]));
  write("assets/new.bin", Buffer.from([0, 0, 1]));
  const notes = lines(30, "notes").split("\n");
  notes[1] = "notes line 2 edited";
  notes[25] = "notes line 26 edited";
  write("docs/café notes.md", notes.join("\n"));
  write("package.json", '{\n  "name": "x",\n  "version": "1.1.0"\n}\n');
  git(["add", "-A"]);

  diffText = git(["diff", "--staged", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "-M", "--binary"]);
  stagedTree = git(["write-tree"]).trim();
  units = diffUnits(diffText);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("diffUnits", () => {
  it("splits multi-hunk modified files and keeps the rest whole", () => {
    const byPath = (p: string) => units.units.filter((u) => u.path === p);
    expect(byPath("src/app.ts")).toHaveLength(3);
    expect(byPath("src/app.ts").every((u) => !u.wholeFile)).toBe(true);
    expect(byPath("docs/café notes.md")).toHaveLength(2);
    for (const path of ["src/new-name.ts", "src/remove-me.ts", "src/added.ts", "scripts/run.sh", "assets/logo.bin", "assets/new.bin"]) {
      expect(byPath(path), path).toHaveLength(1);
      expect(byPath(path)[0]!.wholeFile, path).toBe(true);
    }
    expect(byPath("src/new-name.ts")[0]!.label).toBe("src/old-name.ts -> src/new-name.ts");
  });

  it("keeps the raw bytes, including CRLF and binary data", () => {
    expect(buildPatch(units, units.units.map((u) => u.id))).toBe(diffText);
    expect(parseRawDiff(diffText).find((f) => f.header[0]!.includes("logo.bin"))!.header).toContain("GIT binary patch");
  });
});

describe("buildPatch", () => {
  it("reproduces the staged tree when all units are applied at once", () => {
    expect(applyInOrder([buildPatch(units, units.units.map((u) => u.id))])).toBe(stagedTree);
  });

  it("reproduces the staged tree with one commit per unit, in order and reversed", () => {
    const ids = units.units.map((u) => u.id);
    expect(applyInOrder(ids.map((id) => buildPatch(units, [id])))).toBe(stagedTree);
    expect(applyInOrder([...ids].reverse().map((id) => buildPatch(units, [id])))).toBe(stagedTree);
  });

  it("reproduces the staged tree for random groupings and orders", () => {
    let seed = 42;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let round = 0; round < 15; round++) {
      const groups: number[][] = [[], [], [], []];
      for (const unit of units.units) groups[Math.floor(random() * groups.length)]!.push(unit.id);
      const order = groups.filter((g) => g.length).sort(() => random() - 0.5);
      expect(applyInOrder(order.map((g) => buildPatch(units, g))), `round ${round}`).toBe(stagedTree);
    }
  });

  it("splits hunks of one file across commits", () => {
    const app = units.units.filter((u) => u.path === "src/app.ts").map((u) => u.id);
    const rest = units.units.filter((u) => u.path !== "src/app.ts").map((u) => u.id);
    const patches = [buildPatch(units, [app[2]!]), buildPatch(units, [app[0]!, ...rest]), buildPatch(units, [app[1]!])];
    expect(applyInOrder(patches)).toBe(stagedTree);
  });
});

describe("heuristicPlan", () => {
  it("groups build changes first, then source areas, then docs", () => {
    const plan = heuristicPlan(units);
    const reasons = plan.groups.map((g) => g.reason);
    expect(reasons[0]).toBe("build, dependency and tooling configuration");
    expect(reasons.at(-1)).toBe("documentation");
    expect(plan.groups.flatMap((g) => g.units).sort((a, b) => a - b)).toEqual(units.units.map((u) => u.id));
  });

  it("keeps tests with the code they test", () => {
    const diff = [
      "diff --git a/src/auth/login.ts b/src/auth/login.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/auth/login.ts\n@@ -0,0 +1 @@\n+export const a = 1;",
      "diff --git a/src/auth/__tests__/login.test.ts b/src/auth/__tests__/login.test.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/auth/__tests__/login.test.ts\n@@ -0,0 +1 @@\n+test('a', () => {});",
      "diff --git a/src/billing/pay.ts b/src/billing/pay.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/billing/pay.ts\n@@ -0,0 +1 @@\n+export const b = 1;",
    ].join("\n");
    const plan = heuristicPlan(diffUnits(diff));
    expect(plan.groups.map((g) => g.units)).toEqual([[0, 1], [2]]);
  });
});

describe("planSplit", () => {
  const validPlan = () => ({
    commits: [
      { units: units.units.filter((u) => u.path.startsWith("src/")).map((u) => u.id), type: "feat", scope: null, description: "x", reason: "code" },
      { units: units.units.filter((u) => !u.path.startsWith("src/")).map((u) => u.id), type: "chore", scope: null, description: "y", reason: "rest" },
    ],
  });

  it("uses the offline heuristics without a model", async () => {
    const { plan } = await planSplit(diffText, { provider: rulesProvider() });
    expect(plan.source).toBe("rules");
  });

  it("uses a valid model plan", async () => {
    const complete = vi.fn(async (_prompt: { user: string }) => validPlan());
    const { plan } = await planSplit(diffText, { provider: modelProvider("fake", false, complete) });
    expect(plan.source).toBe("model");
    expect(plan.groups).toHaveLength(2);
    expect(complete.mock.calls[0]![0].user).toMatch(/<changes>[\s\S]*\[0\][\s\S]*<\/changes>/);
  });

  it("retries an invalid plan with feedback, then falls back to heuristics", async () => {
    const prompts: string[] = [];
    const complete = vi.fn(async (prompt: { user: string }) => {
      prompts.push(prompt.user);
      return { commits: [{ units: [0, 0, 999], type: "feat", scope: null, description: "x", reason: "r" }] };
    });
    const { plan } = await planSplit(diffText, { provider: modelProvider("fake", false, complete) });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toMatch(/rejected: .*unit 999 does not exist.*more than once: 0.*units missing/);
    expect(plan.source).toBe("rules");
    expect(plan.note).toMatch(/offline grouping/);
  });

  it("never sends secrets to a remote planner", async () => {
    const secret = "ghp_" + "b".repeat(36);
    const diff = [
      `diff --git a/a.ts b/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+const t = "${secret}";`,
      "diff --git a/b.ts b/b.ts\nnew file mode 100644\n--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1 @@\n+export const b = 1;",
    ].join("\n");
    const complete = vi.fn(async () => ({ commits: [{ units: [0, 1], type: "feat", scope: null, description: "x", reason: "r" }] }));
    await expect(planSplit(diff, { provider: modelProvider("fake", true, complete) })).rejects.toThrow(/Possible secrets/);
    expect(complete).not.toHaveBeenCalled();

    await planSplit(diff, { provider: modelProvider("fake", true, complete), secrets: { onDetect: "redact" } });
    expect(JSON.stringify(complete.mock.calls)).not.toContain(secret);
  });

  it("withholds sensitive files from the planner", async () => {
    const diff = [
      "diff --git a/.env b/.env\nnew file mode 100644\n--- /dev/null\n+++ b/.env\n@@ -0,0 +1 @@\n+DB_HOST=internal.example",
      "diff --git a/b.ts b/b.ts\nnew file mode 100644\n--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1 @@\n+export const b = 1;",
    ].join("\n");
    const complete = vi.fn(async () => ({ commits: [{ units: [0, 1], type: "feat", scope: null, description: "x", reason: "r" }] }));
    await planSplit(diff, { provider: modelProvider("fake", true, complete) });
    expect(JSON.stringify(complete.mock.calls)).not.toContain("internal.example");
  });
});
