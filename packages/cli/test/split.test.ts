import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestRepo } from "./harness.js";

let repo: TestRepo;

/** Stage a change that spans three areas, and leave an unstaged edit in the working tree. */
function messyChange() {
  repo.write("package.json", '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n');
  repo.write("src/auth/login.ts", "export function login() {\n  return 1;\n}\n");
  repo.write("src/billing/pay.ts", "export function pay() {\n  return 1;\n}\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "chore: base");

  repo.write("package.json", '{\n  "name": "demo",\n  "version": "1.1.0"\n}\n');
  repo.write("src/auth/login.ts", "export function login() {\n  return 2;\n}\n");
  repo.write("src/auth/__tests__/login.test.ts", "test('login', () => {});\n");
  repo.write("src/billing/pay.ts", "export function pay() {\n  return 2;\n}\n");
  repo.write("docs/guide.md", "# Guide\n");
  repo.git("add", "-A");
  // Not staged: must survive the split untouched.
  repo.write("src/billing/pay.ts", "export function pay() {\n  return 3; // unstaged\n}\n");
}

const snapshot = () => ({
  head: repo.git("rev-parse", "HEAD").trim(),
  tree: repo.git("write-tree").trim(),
  status: repo.git("status", "--porcelain"),
  pay: readFileSync(join(repo.dir, "src/billing/pay.ts"), "utf8"),
});

beforeEach(() => {
  repo = new TestRepo();
});
afterEach(() => repo.cleanup());

describe("gitmit split", () => {
  it("--dry-run shows the plan and changes nothing", async () => {
    messyChange();
    const before = snapshot();
    const result = await repo.run(["split", "--dry-run", "--provider", "rules"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^1\. chore.*\n {3}package\.json/m);
    expect(result.stdout).toMatch(/^\d\. \w+\(auth\): .*\n {3}src\/auth\/__tests__\/login\.test\.ts\n {3}src\/auth\/login\.ts/m);
    expect(result.stdout).toMatch(/^\d\. docs: /m);
    expect(snapshot()).toEqual(before);
  });

  it("--yes creates one commit per group, and the working tree is untouched", async () => {
    messyChange();
    const before = snapshot();
    const result = await repo.run(["split", "--yes", "--provider", "rules"]);
    expect(result.code, result.stderr).toBe(0);

    const subjects = repo.git("log", "--format=%s", `${before.head}..HEAD`).trim().split("\n").reverse();
    expect(subjects).toHaveLength(4);
    expect(subjects[0]).toMatch(/^chore/);
    expect(subjects.some((s) => /\(auth\)/.test(s))).toBe(true);
    expect(subjects.some((s) => /\(billing\)/.test(s))).toBe(true);
    expect(subjects.at(-1)).toMatch(/^docs/);

    // The commits together equal what was staged, and the unstaged edit is still there, unstaged.
    expect(repo.git("rev-parse", "HEAD^{tree}").trim()).toBe(before.tree);
    expect(readFileSync(join(repo.dir, "src/billing/pay.ts"), "utf8")).toBe(before.pay);
    expect(repo.git("status", "--porcelain").trim()).toBe("M src/billing/pay.ts");
    expect(repo.git("show", "--stat", "--format=", "HEAD~3")).toMatch(/package\.json/);
  });

  it("restores everything when a commit hook fails midway", async () => {
    messyChange();
    // Fail the second commit.
    const hook = join(repo.dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, `#!/bin/sh\ncount=$(git rev-list --count HEAD)\n[ "$count" -ge 3 ] && { echo "hook says no" >&2; exit 1; }\nexit 0\n`);
    chmodSync(hook, 0o755);
    const before = snapshot();

    const result = await repo.run(["split", "--yes", "--provider", "rules"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/git commit failed for commit 2:\nhook says no/);
    expect(result.stderr).toMatch(/original commit and staged changes were restored/);
    expect(snapshot()).toEqual(before);
  });

  it("works on a branch with no commits yet", async () => {
    const fresh = new TestRepo();
    try {
      fresh.git("checkout", "-q", "--orphan", "fresh");
      fresh.git("rm", "-rq", "--cached", ".");
      fresh.write("src/a/one.ts", "export const one = 1;\n");
      fresh.write("docs/two.md", "# two\n");
      fresh.git("add", "src", "docs");
      const result = await fresh.run(["split", "--yes", "--provider", "rules"]);
      expect(result.code, result.stderr).toBe(0);
      expect(fresh.git("rev-list", "--count", "HEAD").trim()).toBe("2");
    } finally {
      fresh.cleanup();
    }
  });

  it("says so when the changes are already one focused commit", async () => {
    repo.write("src/auth/login.ts", "export function login() {}\n");
    repo.git("add", "-A");
    const result = await repo.run(["split", "--dry-run", "--provider", "rules"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/already form one focused commit/);
  });

  it("refuses to split during a merge", async () => {
    messyChange();
    writeFileSync(join(repo.dir, ".git", "MERGE_HEAD"), repo.git("rev-parse", "HEAD"));
    const result = await repo.run(["split", "--yes", "--provider", "rules"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Cannot split during a merge/);
  });

  it("explains when nothing is staged", async () => {
    const result = await repo.run(["split", "--provider", "rules"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/No staged changes/);
  });

  it("follows commitlint rules in every split commit message", async () => {
    repo.write(".commitlintrc.json", JSON.stringify({ rules: { "type-enum": [2, "always", ["feat", "fix", "chore"]] } }));
    messyChange();
    const result = await repo.run(["split", "--yes", "--provider", "rules"]);
    expect(result.code, result.stderr).toBe(0);
    for (const subject of repo.git("log", "--format=%s", "-4").trim().split("\n")) {
      expect(subject).toMatch(/^(feat|fix|chore)/);
    }
  });
});
