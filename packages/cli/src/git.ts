import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

type Env = NodeJS.ProcessEnv;

export function git(args: readonly string[], cwd: string, env: Env = process.env): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd, env, maxBuffer: 512 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new GitError(stderr.trim() || error.message));
      else resolvePromise(stdout);
    });
  });
}

/** The repository's top-level directory, or undefined outside a repository. */
export async function repoRoot(cwd: string, env?: Env): Promise<string | undefined> {
  try {
    return (await git(["rev-parse", "--show-toplevel"], cwd, env)).trim();
  } catch {
    return undefined;
  }
}

/**
 * The staged diff in the exact format the parser expects, regardless of user
 * settings such as diff.noprefix, diff.mnemonicPrefix, color.ui or diff.relative.
 */
export function stagedDiff(root: string, env?: Env, options: { binary?: boolean } = {}): Promise<string> {
  return git(
    [
      "-c",
      "core.quotePath=true",
      "diff",
      "--staged",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-relative",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "-M",
      // Binary patch data, so a split can re-apply binary files exactly.
      ...(options.binary ? ["--binary"] : []),
    ],
    root,
    env,
  );
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git without throwing; capture output. */
export function gitRun(args: readonly string[], cwd: string, env: Env = process.env): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

/** The directory git runs hooks from, honoring core.hooksPath (e.g. husky). */
export async function hooksDir(root: string, env?: Env): Promise<string> {
  return resolve(root, (await git(["rev-parse", "--git-path", "hooks"], root, env)).trim());
}

/**
 * Run `git commit` with the message. Hooks run as usual and their output goes
 * to the terminal. With `edit`, git opens the user's editor first.
 */
export async function commit(
  root: string,
  message: string,
  options: { edit?: boolean; env?: Env; stdio?: "inherit" | "pipe" } = {},
): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "gitmit-"));
  const file = join(dir, "COMMIT_MSG");
  try {
    await writeFile(file, message.endsWith("\n") ? message : `${message}\n`);
    const args = ["commit", "-F", file, ...(options.edit ? ["--edit"] : [])];
    return await new Promise<number>((resolvePromise, reject) => {
      const child = spawn("git", args, { cwd: root, env: options.env ?? process.env, stdio: options.stdio ?? "inherit" });
      child.on("error", reject);
      child.on("close", (code) => resolvePromise(code ?? 1));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
