import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, type Io } from "../src/main.js";

const CLI_DIST = join(__dirname, "../dist/cli.js");

let dir: string;
let home: string;

/** An isolated environment: no global git config, no API keys, a private config dir. */
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_EDITOR: "true",
    ...extra,
  };
}

function sh(args: string[], cwd = dir) {
  return execFileSync("git", args, { cwd, env: env(), encoding: "utf8" });
}

function write(path: string, content: string) {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
}

async function run(args: string[], extraEnv: Record<string, string> = {}) {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    cwd: dir,
    env: env(extraEnv),
    stdout: { write: (s: string) => (stdout += s), isTTY: false },
    stderr: { write: (s: string) => (stderr += s) },
    stdinIsTTY: false,
    cliPath: CLI_DIST,
    nodePath: process.execPath,
  };
  const code = await main(args, io);
  return { code, stdout, stderr };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gitmit-home-"));
  dir = mkdtempSync(join(tmpdir(), "gitmit-repo-"));
  writeFileSync(join(home, "gitconfig"), "");
  sh(["init", "-q", "-b", "main"]);
  write("README.md", "# demo\n");
  sh(["add", "-A"]);
  sh(["commit", "-qm", "chore: initial"]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("gitmit", () => {
  it("prints help and version", async () => {
    expect((await run(["--help"])).stdout).toMatch(/Usage:/);
    expect((await run(["--version"])).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("explains when not in a repository", async () => {
    dir = mkdtempSync(join(tmpdir(), "gitmit-norepo-"));
    const result = await run(["--dry-run"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Not inside a git repository/);
  });

  it("explains when nothing is staged", async () => {
    const result = await run(["--dry-run"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/No staged changes/);
  });

  it("explains a missing API key for an explicit provider", async () => {
    write("docs/a.md", "hi\n");
    sh(["add", "-A"]);
    const result = await run(["--dry-run", "--provider", "openai"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/OPENAI_API_KEY is not set.*--provider rules/);
  });

  it("rejects unknown providers and flags", async () => {
    expect((await run(["--provider", "gpt"])).code).toBe(2);
    expect((await run(["--nope"])).code).toBe(2);
  });

  it("falls back to offline rules and prints suggestions with --dry-run", async () => {
    write("docs/guide.md", "# Guide\n");
    sh(["add", "-A"]);
    const result = await run(["--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^docs: /m);
    expect(result.stderr).toMatch(/No API key found/);
    expect(sh(["log", "--oneline"]).trim().split("\n")).toHaveLength(1);
  });

  it("commits the top suggestion with --yes", async () => {
    write("src/auth/login.ts", "export function login() {}\n");
    sh(["add", "-A"]);
    const result = await run(["--yes", "--provider", "rules"]);
    expect(result.code).toBe(0);
    expect(sh(["log", "-1", "--format=%s"]).trim()).toMatch(/^feat\(auth\): /);
    expect(sh(["status", "--porcelain"]).trim()).toBe("");
  });

  it("reads API keys from the user config dir and options from .gitmitrc.json", async () => {
    mkdirSync(join(home, ".config", "gitmit"), { recursive: true });
    writeFileSync(join(home, ".config", "gitmit", ".env"), "ANTHROPIC_API_KEY=from-file\n");
    write(".gitmitrc.json", JSON.stringify({ provider: "rules", bodyStyle: "none", subjectMaxLength: 50 }));
    write("docs/guide.md", "# Guide\n");
    sh(["add", "docs"]);
    const result = await run(["--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toMatch(/No API key/);
    for (const line of result.stdout.split("\n").filter((l) => /^\w+(\(.*\))?: /.test(l))) {
      expect(line.length).toBeLessThanOrEqual(50);
    }
  });

  it("reports invalid config clearly", async () => {
    write(".gitmitrc.json", JSON.stringify({ provider: "gpt", variants: 9 }));
    write("a.md", "x\n");
    sh(["add", "a.md"]);
    const result = await run(["--dry-run"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Invalid config.*provider.*variants/);
  });

  it("stops before sending secrets to a remote provider", async () => {
    write("src/config.ts", `export const KEY = "sk-proj-${"Ab3".repeat(10)}";\n`);
    sh(["add", "-A"]);
    // The key is fake; the scan must stop the run before any network call.
    const result = await run(["--dry-run", "--provider", "openai"], { OPENAI_API_KEY: "sk-test" });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Possible secrets.*OpenAI API key in src\/config\.ts.*--redact/s);
  });
});

describe("gitmit hook", () => {
  it("installs, refuses to overwrite a foreign hook without --force, and uninstalls", async () => {
    const hook = join(dir, ".git", "hooks", "prepare-commit-msg");
    writeFileSync(hook, "#!/bin/sh\necho mine\n");
    expect((await run(["hook", "install"])).stderr).toMatch(/already exists.*--force/);

    const installed = await run(["hook", "install", "--force"]);
    expect(installed.code).toBe(0);
    expect(readFileSync(hook, "utf8")).toMatch(/Installed by gitmit/);
    if (process.platform !== "win32") expect(statSync(hook).mode & 0o111).not.toBe(0);
    expect(existsSync(`${hook}.gitmit-backup`)).toBe(true);

    const removed = await run(["hook", "uninstall"]);
    expect(removed.stdout).toMatch(/Restored your previous hook/);
    expect(readFileSync(hook, "utf8")).toMatch(/echo mine/);
  });

  it("honors core.hooksPath", async () => {
    sh(["config", "core.hooksPath", ".husky"]);
    await run(["hook", "install"]);
    expect(existsSync(join(dir, ".husky", "prepare-commit-msg"))).toBe(true);
  });

  it("hook run writes the suggestion above git's comments", async () => {
    write("docs/guide.md", "# Guide\n");
    sh(["add", "-A"]);
    const file = join(dir, ".git", "COMMIT_EDITMSG");
    writeFileSync(file, "\n# Please enter the commit message.\n");
    expect((await run(["hook", "run", file])).code).toBe(0);
    const content = readFileSync(file, "utf8");
    expect(content).toMatch(/^docs: .+\n/);
    expect(content).toMatch(/# Please enter the commit message\./);
  });

  it("hook run never fails the commit", async () => {
    const file = join(dir, ".git", "COMMIT_EDITMSG");
    writeFileSync(file, "");
    const result = await run(["hook", "run", file]);
    expect(result.code).toBe(0);
    expect(readFileSync(file, "utf8")).toMatch(/^# gitmit: no suggestion \(No staged changes/);
  });

  it.skipIf(!existsSync(CLI_DIST) || process.platform === "win32")("fills the message during a real git commit", async () => {
    await run(["hook", "install"]);
    write("src/auth/login.ts", "export function login() {}\n");
    sh(["add", "-A"]);
    // GIT_EDITOR=true accepts the prepared message unchanged.
    const commit = spawnSync("git", ["commit"], { cwd: dir, env: env(), encoding: "utf8" });
    expect(commit.status, commit.stderr).toBe(0);
    expect(sh(["log", "-1", "--format=%s"]).trim()).toMatch(/^feat\(auth\): /);
  });

  it.skipIf(!existsSync(CLI_DIST) || process.platform === "win32")("leaves `git commit -m` alone", async () => {
    await run(["hook", "install"]);
    write("a.md", "x\n");
    sh(["add", "-A"]);
    sh(["commit", "-qm", "my own message"]);
    expect(sh(["log", "-1", "--format=%s"]).trim()).toBe("my own message");
  });
});
