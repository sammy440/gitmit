import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { git, gitRun } from "./git.js";

export interface PlannedCommit {
  patch: string;
  message: string;
}

export class SplitError extends Error {
  /** True when the original HEAD and staging area were restored. */
  readonly restored: boolean;
  constructor(message: string, restored: boolean) {
    super(message);
    this.name = "SplitError";
    this.restored = restored;
  }
}

type Env = NodeJS.ProcessEnv;

const IN_PROGRESS = [
  ["MERGE_HEAD", "a merge"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"],
  ["REVERT_HEAD", "a revert"],
  ["rebase-merge", "a rebase"],
  ["rebase-apply", "a rebase or am"],
  ["BISECT_LOG", "a bisect"],
] as const;

/** Refuse to split while git is in the middle of another operation. */
export async function checkSplittable(root: string, env: Env): Promise<void> {
  for (const [name, what] of IN_PROGRESS) {
    const path = resolve(root, (await git(["rev-parse", "--git-path", name], root, env)).trim());
    if (existsSync(path)) throw new SplitError(`Cannot split during ${what}. Finish or abort it first.`, true);
  }
}

async function headCommit(root: string, env: Env): Promise<string | undefined> {
  const result = await gitRun(["rev-parse", "-q", "--verify", "HEAD^{commit}"], root, env);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** Point an index at HEAD's tree, or empty it when the branch has no commits yet. */
async function resetIndex(root: string, env: Env, head: string | undefined): Promise<void> {
  await git(head ? ["read-tree", head] : ["read-tree", "--empty"], root, env);
}

async function applyCached(root: string, env: Env, dir: string, patch: string, index: number): Promise<void> {
  const file = join(dir, `part-${index}.patch`);
  await writeFile(file, patch);
  const result = await gitRun(["apply", "--cached", "--whitespace=nowarn", file], root, env);
  if (result.code !== 0) throw new Error(`commit ${index + 1} does not apply: ${result.stderr.trim()}`);
}

/**
 * Create one commit per planned patch. Only the index and HEAD change; the
 * working tree is never touched.
 *
 * 1. Rehearse in a temporary index: the patches, applied in order on HEAD,
 *    must reproduce exactly the staged tree. Otherwise nothing is changed.
 * 2. For each patch: reset the real index to HEAD, apply it, commit (hooks run).
 * 3. On any failure, move HEAD back and restore the original staged tree.
 */
export async function applySplit(
  root: string,
  commits: readonly PlannedCommit[],
  env: Env,
  onCommit?: (index: number, sha: string) => void,
): Promise<string[]> {
  await checkSplittable(root, env);
  const originalHead = await headCommit(root, env);
  const originalTree = (await git(["write-tree"], root, env)).trim();
  const dir = await mkdtemp(join(tmpdir(), "gitmit-split-"));

  try {
    const rehearsal = { ...env, GIT_INDEX_FILE: join(dir, "index") };
    try {
      await resetIndex(root, rehearsal, originalHead);
      for (const [i, c] of commits.entries()) await applyCached(root, rehearsal, dir, c.patch, i);
    } catch (error) {
      throw new SplitError(`The split plan is not valid: ${(error as Error).message}. Nothing was changed.`, true);
    }
    const rehearsedTree = (await git(["write-tree"], root, rehearsal)).trim();
    if (rehearsedTree !== originalTree) {
      throw new SplitError("The split plan does not reproduce your staged changes exactly. Nothing was changed.", true);
    }

    const shas: string[] = [];
    try {
      for (const [i, c] of commits.entries()) {
        await resetIndex(root, env, i === 0 ? originalHead : shas.at(-1));
        await applyCached(root, env, dir, c.patch, i);
        const messageFile = join(dir, `message-${i}`);
        await writeFile(messageFile, c.message.endsWith("\n") ? c.message : `${c.message}\n`);
        const result = await gitRun(["commit", "-q", "-F", messageFile], root, env);
        if (result.code !== 0) {
          const output = `${result.stderr}${result.stdout}`.trim();
          throw new Error(`git commit failed for commit ${i + 1}${output ? `:\n${output}` : ""}`);
        }
        const sha = (await git(["rev-parse", "HEAD"], root, env)).trim();
        shas.push(sha);
        onCommit?.(i, sha);
      }
    } catch (error) {
      const restored = await restore(root, env, originalHead, originalTree);
      throw new SplitError(
        `${(error as Error).message}\n${restored ? "Your original commit and staged changes were restored." : "Could not fully restore; see `git reflog`."}`,
        restored,
      );
    }

    // Belt and braces: whatever is still staged-but-uncommitted stays staged.
    const finalTree = (await git(["write-tree"], root, env)).trim();
    if (finalTree !== originalTree) await git(["read-tree", originalTree], root, env);
    return shas;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function restore(root: string, env: Env, head: string | undefined, tree: string): Promise<boolean> {
  try {
    if (head) await git(["reset", "-q", "--soft", head], root, env);
    else await git(["update-ref", "-d", "HEAD"], root, env);
    await git(["read-tree", tree], root, env);
    return (await git(["write-tree"], root, env)).trim() === tree && (await headCommit(root, env)) === head;
  } catch {
    return false;
  }
}
