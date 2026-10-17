import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestRepo } from "./harness.js";

let repo: TestRepo;

function commit(message: string, file = `src/f${Math.random().toString(36).slice(2)}.ts`) {
  repo.write(file, "export const x = 1;\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", message);
}

beforeEach(() => {
  repo = new TestRepo();
  repo.git("checkout", "-q", "-b", "feat/login");
});
afterEach(() => repo.cleanup());

describe("gitmit check", () => {
  it("passes when every commit on the branch follows the rules", async () => {
    commit("feat(auth): add login");
    commit("test(auth): cover login");
    const result = await repo.run(["check"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toMatch(/Checking 2 commits since main\./);
    expect(result.stdout).toMatch(/✓ All 2 messages follow the rules\./);
  });

  it("lists each problem and fails", async () => {
    commit("feat(auth): add login");
    commit("Fixed the bug.");
    const result = await repo.run(["check"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/✗ [0-9a-f]{7}  Fixed the bug\.\n    - not in "type\(scope\): description" form/);
    expect(result.stdout).toMatch(/✗ 1 of 2 messages needs changes\./);
  });

  it("--suggest proposes a fixed message from the commit's diff", async () => {
    commit("stuff", "docs/guide.md");
    const result = await repo.run(["check", "--suggest", "--provider", "rules"]);
    expect(result.stdout).toMatch(/Suggested: docs: /);
  });

  it("checks a pull request title, alone or with the commits", async () => {
    commit("feat(auth): add login");
    const bad = await repo.run(["check", "--title", "Login page", "--no-commits"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/Checking the pull request title\./);
    expect(bad.stdout).toMatch(/✗ PR title  Login page/);
    const good = await repo.run(["check", "--title", "feat(auth): add login"]);
    expect(good.code, good.stdout).toBe(0);
    expect(good.stdout).toMatch(/All 2 messages/);
  });

  it("follows the team's config and the branch ticket", async () => {
    repo.write(".gitmitrc.json", JSON.stringify({ types: ["feat", "fix"], ticket: { required: true } }));
    repo.git("add", "-A");
    repo.git("commit", "-qm", "feat: add config ABC-1");
    repo.git("checkout", "-q", "-b", "feat/PROJ-7-login");
    commit("feat: add login (PROJ-7)");
    commit("docs: explain login");
    const result = await repo.run(["check"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/docs: explain login\n    - type "docs" isn't one of feat, fix\n    - mention the ticket PROJ-7/);
    expect(result.stdout).not.toMatch(/add login \(PROJ-7\)/);
  });

  it("--range and --json", async () => {
    commit("feat: one");
    commit("bad message");
    const result = await repo.run(["check", "--range", "HEAD~1..HEAD", "--json"]);
    const json = JSON.parse(result.stdout);
    expect(json.ok).toBe(false);
    expect(json.results).toHaveLength(1);
    expect(json.results[0]).toMatchObject({ kind: "commit", message: "bad message" });
  });

  it("explains when there's nothing to compare", async () => {
    repo.git("checkout", "-q", "main");
    expect((await repo.run(["check"])).stderr).toMatch(/HEAD is main, so there's nothing to compare/);
  });

  it("explains missing history in a shallow clone", async () => {
    commit("feat: one");
    commit("feat: two");
    const shallow = `${repo.dir}-shallow`;
    execFileSync("git", ["clone", "-q", "--depth", "1", "--branch", "feat/login", `file://${repo.dir}`, shallow], { env: repo.env() });
    const original = repo.dir;
    repo.dir = shallow;
    try {
      const result = await repo.run(["check", "--range", "HEAD~1..HEAD"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/shallow clone[\s\S]*fetch-depth: 0/);
    } finally {
      repo.dir = original;
      execFileSync("rm", ["-rf", shallow]);
    }
  });

  it("in GitHub Actions: annotations, a job summary, and the PR branch's ticket", async () => {
    repo.write(".gitmitrc.json", JSON.stringify({ ticket: {} }));
    repo.git("add", "-A");
    repo.git("commit", "-qm", "chore: config");
    commit("feat: add login");
    repo.git("checkout", "-q", "--detach");
    const summary = join(repo.home, "summary.md");
    writeFileSync(summary, "");
    const result = await repo.run(["check", "--range", "HEAD~1..HEAD", "--title", "feat: add login (PROJ-3)"], {
      GITHUB_ACTIONS: "true",
      GITHUB_HEAD_REF: "feat/PROJ-3-login",
      GITHUB_STEP_SUMMARY: summary,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^::error title=gitmit check: Commit [0-9a-f]{7}::"feat: add login"%0A- mention the ticket PROJ-3$/m);
    expect(readFileSync(summary, "utf8")).toMatch(/### ❌ gitmit check\n\n1 of 2 messages needs changes\.\n\n\*\*Commit [0-9a-f]{7}:\*\* `feat: add login`\n\n- mention the ticket PROJ-3/);
  });
});
