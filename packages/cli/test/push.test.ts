import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestRepo } from "./harness.js";

let repo: TestRepo;
let remote: string;

/** Commits the remote has on a branch, newest first. */
const remoteLog = (branch = "main") =>
  execFileSync("git", ["log", "--format=%s", branch], { cwd: remote, env: repo.env(), encoding: "utf8" }).trim().split("\n");

function stage(path: string, content: string) {
  repo.write(path, content);
  repo.git("add", "-A");
}

beforeEach(() => {
  repo = new TestRepo();
  remote = mkdtempSync(join(tmpdir(), "gitmit-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env: repo.env() });
  repo.git("remote", "add", "origin", remote);
});
afterEach(() => {
  repo.cleanup();
  rmSync(remote, { recursive: true, force: true });
});

describe("--push", () => {
  it("pushes a new branch, setting the upstream, then reuses it", async () => {
    stage("src/auth/login.ts", "export function login() {}\n");
    const first = await repo.run(["--yes", "--push", "--provider", "rules"]);
    expect(first.code, first.stderr).toBe(0);
    expect(remoteLog()[0]).toMatch(/^feat\(auth\): /);
    expect(repo.git("rev-parse", "--abbrev-ref", "@{u}").trim()).toBe("origin/main");

    stage("docs/guide.md", "# Guide\n");
    const second = await repo.run(["--yes", "--push", "--provider", "rules"]);
    expect(second.code, second.stderr).toBe(0);
    expect(remoteLog()[0]).toMatch(/^docs: /);
    expect(repo.git("status", "-sb").split("\n")[0]).not.toMatch(/ahead/);
  });

  it("does not push without the flag", async () => {
    stage("docs/guide.md", "# Guide\n");
    await repo.run(["--yes", "--provider", "rules"]);
    expect(() => remoteLog()).toThrow();
  });

  it('pushes when the config says "push": true, unless --no-push is given', async () => {
    repo.write(".gitmitrc.json", JSON.stringify({ provider: "rules", push: true }));
    stage("docs/a.md", "a\n");
    await repo.run(["--yes", "--no-push"]);
    expect(() => remoteLog()).toThrow();

    stage("docs/b.md", "b\n");
    const result = await repo.run(["--yes"]);
    expect(result.code, result.stderr).toBe(0);
    expect(remoteLog()).toHaveLength(3);
  });

  it("keeps the commit and explains when the push is rejected", async () => {
    // Someone else pushed first: the remote has a commit we don't.
    const other = new TestRepo();
    try {
      other.write("THEIRS.md", "their change\n");
      other.git("add", "-A");
      other.git("commit", "-qm", "chore: their commit");
      other.git("remote", "add", "origin", remote);
      other.git("push", "-q", "origin", "main");
    } finally {
      other.cleanup();
    }
    stage("docs/guide.md", "# Guide\n");
    const before = repo.git("rev-parse", "HEAD").trim();
    const result = await repo.run(["--yes", "--push", "--provider", "rules"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/git push failed\. Your commits were kept/);
    expect(result.stderr).toMatch(/rejected|fetch first|non-fast-forward/);
    expect(repo.git("rev-parse", "HEAD~1").trim()).toBe(before);
  });

  it("explains when there is no remote", async () => {
    repo.git("remote", "remove", "origin");
    stage("docs/guide.md", "# Guide\n");
    const result = await repo.run(["--yes", "--push", "--provider", "rules"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/no remote to push to.*git remote add origin.*commits were kept/);
    expect(repo.git("log", "-1", "--format=%s").trim()).toMatch(/^docs: /);
  });

  it("split --push pushes all the new commits once", async () => {
    stage("package.json", '{ "version": "1.0.0" }\n');
    repo.write("src/auth/login.ts", "export function login() {}\n");
    repo.write("docs/guide.md", "# Guide\n");
    repo.git("add", "-A");
    const result = await repo.run(["split", "--yes", "--push", "--provider", "rules"]);
    expect(result.code, result.stderr).toBe(0);
    expect(remoteLog()).toHaveLength(4);
  });

  it("pushes waiting commits when nothing is staged", async () => {
    stage("docs/a.md", "a\n");
    await repo.run(["--yes", "--provider", "rules"]);
    stage("docs/b.md", "b\n");
    await repo.run(["--yes", "--provider", "rules"]);
    const result = await repo.run(["--push"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/Nothing staged to commit\. Pushing this branch/);
    expect(remoteLog()).toHaveLength(3);

    stage("docs/c.md", "c\n");
    await repo.run(["--yes", "--provider", "rules"]);
    const again = await repo.run(["split", "--push"]);
    expect(again.stderr).toMatch(/Pushing 1 commit\.\.\./);
    expect(remoteLog()).toHaveLength(4);
  });

  it("says there is nothing to do when nothing is staged or waiting", async () => {
    stage("docs/a.md", "a\n");
    await repo.run(["--yes", "--push", "--provider", "rules"]);
    const result = await repo.run(["--push"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/nothing else has changed/);
  });

  it("is listed in the help", async () => {
    const help = await repo.run(["--help"]);
    expect(help.stdout).toMatch(/--push/);
    expect(help.stdout).toMatch(/--no-push/);
  });
});
