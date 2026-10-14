import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrCommit } from "@gitmit/core";
import { git, gitRun, logCommits } from "./git.js";
import { UsageError } from "./provider.js";

type Env = NodeJS.ProcessEnv;

export interface Branch {
  /** The branch being described. */
  head: string;
  /** The ref it is compared with, e.g. "origin/main". */
  baseRef: string;
  /** The base branch name for GitHub, e.g. "main". */
  baseName: string;
  /** Where the branch split off from the base. */
  mergeBase: string;
  commits: PrCommit[];
  diff: string;
}

/** The base branch: `explicit`, else origin/HEAD, origin/main, origin/master, main, master. */
export async function findBase(root: string, env: Env, explicit?: string): Promise<{ ref: string; name: string }> {
  const exists = async (ref: string) => (await gitRun(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root, env)).code === 0;
  // "origin/main" -> "main"
  const nameOf = (remoteRef: string) => remoteRef.split("/").slice(1).join("/");

  if (explicit) {
    for (const ref of [explicit, `origin/${explicit}`]) if (await exists(ref)) return { ref, name: explicit.replace(/^origin\//, "") };
    throw new UsageError(`Can't find the base branch "${explicit}".`);
  }
  const head = await gitRun(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], root, env);
  if (head.code === 0 && head.stdout.trim()) {
    const ref = head.stdout.trim();
    return { ref, name: nameOf(ref) };
  }
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (await exists(ref)) return { ref, name: ref.replace(/^origin\//, "") };
  }
  throw new UsageError("Can't tell which branch this would merge into. Pass it with --base, e.g. --base main.");
}

/** Everything on the current branch that isn't on the base: commits (oldest first) and the combined diff. */
export async function readBranch(root: string, env: Env, explicitBase?: string): Promise<Branch> {
  const head = (await gitRun(["symbolic-ref", "--quiet", "--short", "HEAD"], root, env)).stdout.trim();
  if (!head) throw new UsageError("You're not on a branch (detached HEAD). Check out the branch you want to describe.");
  const base = await findBase(root, env, explicitBase);
  if (head === base.name) {
    throw new UsageError(`You're on ${head}, the base branch. Switch to the branch you want to open a pull request for.`);
  }
  const mergeBase = (await git(["merge-base", base.ref, "HEAD"], root, env)).trim();

  const commits = await logCommits(root, `${mergeBase}..HEAD`, env);

  const diff = await git(
    ["-c", "core.quotePath=true", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "-M", mergeBase, "HEAD"],
    root,
    env,
  );
  return { head, baseRef: base.ref, baseName: base.name, mergeBase, commits, diff };
}

const TEMPLATE_FILES = [".github/pull_request_template.md", "pull_request_template.md", "docs/pull_request_template.md"];

/** The repository's pull request template, wherever GitHub looks for it. */
export async function readPrTemplate(root: string): Promise<string | undefined> {
  for (const relative of TEMPLATE_FILES) {
    const dir = join(root, relative, "..");
    const wanted = relative.split("/").pop()!.toLowerCase();
    const names = await readdir(dir).catch(() => [] as string[]);
    const match = names.find((n) => n.toLowerCase() === wanted);
    if (match) return readFile(join(dir, match), "utf8");
  }
  // A folder of templates: use the first one.
  for (const dirName of [".github/PULL_REQUEST_TEMPLATE", ".github/pull_request_template"]) {
    const names = (await readdir(join(root, dirName)).catch(() => [] as string[])).filter((n) => n.endsWith(".md")).sort();
    if (names[0]) return readFile(join(root, dirName, names[0]), "utf8");
  }
  return undefined;
}

// ---------------------------------------------------------------- GitHub CLI

export async function ghAvailable(root: string, env: Env): Promise<boolean> {
  return (await runCommand("gh", ["--version"], root, env)).code === 0;
}

/** The URL of an open pull request for the current branch, if there is one. */
export async function existingPr(root: string, env: Env): Promise<string | undefined> {
  const result = await runCommand("gh", ["pr", "view", "--json", "url,state", "--jq", 'select(.state == "OPEN") | .url'], root, env);
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

export async function createPr(
  root: string,
  env: Env,
  pr: { title: string; body: string; base: string; draft: boolean },
): Promise<string> {
  return withBodyFile(pr.body, async (file) => {
    const args = ["pr", "create", "--title", pr.title, "--body-file", file, "--base", pr.base, ...(pr.draft ? ["--draft"] : [])];
    const result = await runCommand("gh", args, root, env);
    if (result.code !== 0) throw new UsageError(`gh pr create failed: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout.trim().split("\n").pop() ?? "";
  });
}

export async function updatePr(root: string, env: Env, pr: { title: string; body: string }): Promise<void> {
  await withBodyFile(pr.body, async (file) => {
    const result = await runCommand("gh", ["pr", "edit", "--title", pr.title, "--body-file", file], root, env);
    if (result.code !== 0) throw new UsageError(`gh pr edit failed: ${(result.stderr || result.stdout).trim()}`);
  });
}

async function withBodyFile<T>(body: string, use: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "gitmit-pr-"));
  const file = join(dir, "body.md");
  try {
    await writeFile(file, body.endsWith("\n") ? body : `${body}\n`);
    return await use(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Copy text to the system clipboard. Returns false when no clipboard tool is available. */
export async function copyToClipboard(text: string, env: Env): Promise<boolean> {
  const candidates: [string, string[]][] =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ];
  for (const [command, args] of candidates) {
    const result = await runCommand(command, args, process.cwd(), env, text);
    if (result.code === 0) return true;
  }
  return false;
}

/** Let the user edit text in their git editor; returns the edited text. */
export async function editText(root: string, env: Env, text: string): Promise<string> {
  const editor = (await gitRun(["var", "GIT_EDITOR"], root, env)).stdout.trim() || "vi";
  const dir = await mkdtemp(join(tmpdir(), "gitmit-pr-"));
  const file = join(dir, "PULL_REQUEST.md");
  try {
    await writeFile(file, text);
    const code = await new Promise<number>((resolve, reject) => {
      // GIT_EDITOR may include arguments (e.g. "code --wait"), so run it through the shell.
      const child = spawn(`${editor} "$GITMIT_FILE"`, { cwd: root, env: { ...env, GITMIT_FILE: file }, stdio: "inherit", shell: true });
      child.on("error", reject);
      child.on("close", (c) => resolve(c ?? 1));
    });
    if (code !== 0) throw new UsageError("The editor exited with an error; keeping the previous text.");
    return await readFile(file, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function runCommand(command: string, args: string[], cwd: string, env: Env, input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    } catch {
      resolve({ code: 127, stdout, stderr: `${command} not found` });
      return;
    }
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", () => resolve({ code: 127, stdout, stderr: `${command} not found` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin?.end(input);
  });
}
