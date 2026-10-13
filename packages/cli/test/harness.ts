import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Io } from "../src/main.js";

export const CLI_DIST = join(__dirname, "../dist/cli.js");

/** A throwaway repository with an isolated HOME, git config and gitmit config dir. */
export class TestRepo {
  readonly home = mkdtempSync(join(tmpdir(), "gitmit-home-"));
  dir = mkdtempSync(join(tmpdir(), "gitmit-repo-"));

  constructor() {
    writeFileSync(join(this.home, "gitconfig"), "");
    this.git("init", "-q", "-b", "main");
    this.write("README.md", "# demo\n");
    this.git("add", "-A");
    this.git("commit", "-qm", "chore: initial");
  }

  env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      HOME: this.home,
      XDG_CONFIG_HOME: join(this.home, ".config"),
      GIT_CONFIG_GLOBAL: join(this.home, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_EDITOR: "true",
      ...extra,
    };
  }

  git(...args: string[]): string {
    return execFileSync("git", args, { cwd: this.dir, env: this.env(), encoding: "utf8" });
  }

  write(path: string, content: string) {
    mkdirSync(join(this.dir, path, ".."), { recursive: true });
    writeFileSync(join(this.dir, path), content);
  }

  writeUserConfig(name: string, content: string) {
    const dir = join(this.home, ".config", "gitmit");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), content);
  }

  async run(args: string[], extraEnv: Record<string, string> = {}) {
    let stdout = "";
    let stderr = "";
    const io: Io = {
      cwd: this.dir,
      env: this.env(extraEnv),
      stdout: { write: (s: string) => (stdout += s), isTTY: false },
      stderr: { write: (s: string) => (stderr += s) },
      stdinIsTTY: false,
      cliPath: CLI_DIST,
      nodePath: process.execPath,
    };
    const code = await main(args, io);
    return { code, stdout, stderr };
  }

  cleanup() {
    rmSync(this.dir, { recursive: true, force: true });
    rmSync(this.home, { recursive: true, force: true });
  }
}

/** Headers from --dry-run output (suggestions are separated by "---"). */
export function headers(stdout: string): string[] {
  return stdout
    .split("\n---\n")
    .map((block) => block.trim().split("\n")[0]!)
    .filter(Boolean);
}
