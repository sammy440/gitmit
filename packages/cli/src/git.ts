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

/** The staged diff in the format the parser expects, regardless of the user's diff settings. */
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

/** Why nothing is staged, with a hint when there are changes git add would pick up. */
export async function nothingStagedMessage(root: string, env?: Env): Promise<string> {
  const status = await git(["status", "--porcelain", "--untracked-files=normal"], root, env).catch(() => "");
  const pending = status.split("\n").filter((line) => line && (line[0] === " " || line.startsWith("??"))).length;
  if (pending === 0) return "No staged changes, and nothing else has changed. There is nothing to commit.";
  return `No staged changes, but ${pending} file${pending === 1 ? " has" : "s have"} changes that aren't staged. Run \`git add -A\` to stage everything (\`git add .\` only stages the current folder).`;
}

/** How many local commits the remote doesn't have yet; undefined when the branch has no upstream. */
export async function unpushedCount(root: string, env?: Env): Promise<number | undefined> {
  const result = await gitRun(["rev-list", "--count", "@{u}..HEAD"], root, env);
  return result.code === 0 ? Number(result.stdout.trim()) : undefined;
}

/** Commits in `range` (oldest first, merges skipped), as subject and body. */
export async function logCommits(root: string, range: string, env?: Env): Promise<{ sha: string; subject: string; body: string }[]> {
  const log = await git(["log", "--reverse", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", range], root, env);
  return log
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = "", subject = "", body = ""] = record.split("\x1f");
      return { sha, subject: subject.trim(), body: body.trim() };
    });
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

/** Run `git commit` with the message; hooks run as usual, and `edit` opens the editor first. */
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
