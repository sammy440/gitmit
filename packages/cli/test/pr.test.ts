import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestRepo } from "./harness.js";

let repo: TestRepo;
let remote: string;
let bin: string;
let ghLog: string;

/** A stand-in for GitHub's CLI that records how it was called. */
function installFakeGh() {
  bin = mkdtempSync(join(tmpdir(), "gitmit-gh-"));
  ghLog = join(bin, "gh.log");
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
echo "$*" >> "${ghLog}"
case "$1 $2" in
  "--version "*) echo "gh version 2.0.0"; exit 0 ;;
  "pr view") if [ -n "$FAKE_GH_EXISTING" ]; then echo "$FAKE_GH_EXISTING"; exit 0; else echo "no pull requests found" >&2; exit 1; fi ;;
  "pr create")
    while [ $# -gt 0 ]; do if [ "$1" = "--body-file" ]; then cp "$2" "${bin}/body.md"; fi; shift; done
    echo "https://github.com/acme/demo/pull/7"; exit 0 ;;
  "pr edit")
    while [ $# -gt 0 ]; do if [ "$1" = "--body-file" ]; then cp "$2" "${bin}/body.md"; fi; shift; done
    exit 0 ;;
esac
exit 1
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
}

const withGh = (extra: Record<string, string> = {}) => ({ PATH: `${bin}:${process.env.PATH}`, ...extra });
const ghCalls = () => {
  try {
    return readFileSync(ghLog, "utf8").trim().split("\n");
  } catch {
    return [];
  }
};

/** A repo with a GitHub-like remote whose default branch is main, and a feature branch with two commits. */
function featureBranch() {
  remote = mkdtempSync(join(tmpdir(), "gitmit-pr-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env: repo.env() });
  repo.git("remote", "add", "origin", remote);
  repo.git("push", "-q", "origin", "main");
  repo.git("remote", "set-head", "origin", "main");
  repo.git("checkout", "-q", "-b", "feat/login");
  repo.write("src/auth/login.ts", "export function login() {}\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "feat(auth): add login function");
  repo.write("src/auth/login.test.ts", "test('login', () => {});\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "test(auth): cover login", "-m", "Adds a basic test.");
}

beforeEach(() => {
  repo = new TestRepo();
  installFakeGh();
});
afterEach(() => {
  repo.cleanup();
  rmSync(bin, { recursive: true, force: true });
  if (remote) rmSync(remote, { recursive: true, force: true });
});

describe("gitmit pr", () => {
  it("describes the branch against the remote's default branch", async () => {
    featureBranch();
    const result = await repo.run(["pr", "--dry-run", "--provider", "rules"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/2 commits on feat\/login, compared with origin\/main/);
    const [title, blank, ...body] = result.stdout.trim().split("\n");
    expect(title).toMatch(/^feat\(auth\): /);
    expect(blank).toBe("");
    expect(body.join("\n")).toMatch(/## Changes\n\n- feat\(auth\): add login function\n- test\(auth\): cover login/);
  });

  it("uses the repository's pull request template when there is one", async () => {
    featureBranch();
    mkdirSync(join(repo.dir, ".github"), { recursive: true });
    writeFileSync(join(repo.dir, ".github", "PULL_REQUEST_TEMPLATE.md"), "## What\n");
    const result = await repo.run(["pr", "--dry-run", "--provider", "rules"]);
    expect(result.stderr).toMatch(/using your PR template/);
  });

  it("explains when on the base branch, or when there's nothing to describe", async () => {
    featureBranch();
    repo.git("checkout", "-q", "main");
    expect((await repo.run(["pr", "--dry-run", "--provider", "rules"])).stderr).toMatch(/You're on main, the base branch/);
    repo.git("checkout", "-q", "-b", "empty");
    expect((await repo.run(["pr", "--dry-run", "--provider", "rules"])).stderr).toMatch(/no commits that aren't on origin\/main/);
  });

  it("--base picks the comparison branch", async () => {
    featureBranch();
    const result = await repo.run(["pr", "--dry-run", "--provider", "rules", "--base", "nope"]);
    expect(result.stderr).toMatch(/Can't find the base branch "nope"/);
  });

  it("--create pushes the branch and opens the pull request with gh", async () => {
    featureBranch();
    const result = await repo.run(["pr", "--create", "--provider", "rules"], withGh());
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/https:\/\/github\.com\/acme\/demo\/pull\/7/);
    // The branch now exists on the remote.
    expect(execFileSync("git", ["branch", "--list", "feat/login"], { cwd: remote, encoding: "utf8" })).toMatch(/feat\/login/);
    const create = ghCalls().find((c) => c.startsWith("pr create"))!;
    expect(create).toMatch(/--title feat\(auth\): .+ --body-file .+ --base main$/);
    expect(readFileSync(join(bin, "body.md"), "utf8")).toMatch(/## Changes/);
  });

  it("--draft opens a draft", async () => {
    featureBranch();
    await repo.run(["pr", "--draft", "--provider", "rules"], withGh());
    expect(ghCalls().find((c) => c.startsWith("pr create"))).toMatch(/--draft$/);
  });

  it("won't open a second pull request, and --update replaces the open one", async () => {
    featureBranch();
    const existing = withGh({ FAKE_GH_EXISTING: "https://github.com/acme/demo/pull/3" });
    const again = await repo.run(["pr", "--create", "--provider", "rules"], existing);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/already open for feat\/login: https:\/\/github\.com\/acme\/demo\/pull\/3[\s\S]*--update/);

    const updated = await repo.run(["pr", "--update", "--provider", "rules"], existing);
    expect(updated.code, updated.stderr).toBe(0);
    expect(updated.stdout).toMatch(/Updated https:\/\/github\.com\/acme\/demo\/pull\/3/);
    expect(ghCalls().some((c) => /^pr edit --title feat\(auth\): /.test(c))).toBe(true);
  });

  it("explains how to get gh when it isn't installed", async () => {
    featureBranch();
    const result = await repo.run(["pr", "--create", "--provider", "rules"], { PATH: "/usr/bin:/bin" });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/needs GitHub's CLI.*cli\.github\.com/);
  });
});
