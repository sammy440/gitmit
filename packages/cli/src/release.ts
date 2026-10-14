import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareVersions, type PrCommit } from "@gitmit/core";
import { commit, git, gitRun, logCommits } from "./git.js";
import { runCommand } from "./pr.js";
import { UsageError } from "./provider.js";
import { pushCurrentBranch } from "./push.js";

type Env = NodeJS.ProcessEnv;

export interface ReleaseInfo {
  /** The newest version tag reachable from HEAD. */
  last?: { tag: string; version: string; prefix: string };
  /** Commits since that tag, oldest first. */
  commits: PrCommit[];
  /** package.json's version, used for a first release. */
  manifestVersion?: string;
  /** e.g. https://github.com/owner/repo, for links. */
  repoUrl?: string;
}

const TAG = /^(v?)(\d+\.\d+\.\d+)$/;

export async function readReleaseInfo(root: string, env: Env): Promise<ReleaseInfo> {
  const tags = (await git(["tag", "--merged", "HEAD"], root, env)).split("\n").map((t) => t.trim());
  let last: ReleaseInfo["last"];
  for (const tag of tags) {
    const match = TAG.exec(tag);
    if (match && (!last || compareVersions(match[2]!, last.version) > 0)) last = { tag, version: match[2]!, prefix: match[1]! };
  }
  const hasHead = (await gitRun(["rev-parse", "--verify", "--quiet", "HEAD"], root, env)).code === 0;
  const commits = hasHead ? await logCommits(root, last ? `${last.tag}..HEAD` : "HEAD", env) : [];
  return { last, commits, manifestVersion: (await readManifest(root))?.version, repoUrl: await repoWebUrl(root, env) };
}

async function readManifest(root: string): Promise<{ text: string; version?: string } | undefined> {
  try {
    const text = await readFile(join(root, "package.json"), "utf8");
    const version = (JSON.parse(text) as { version?: unknown }).version;
    return { text, version: typeof version === "string" ? version : undefined };
  } catch {
    return undefined;
  }
}

/** The GitHub page for origin, from an https or ssh remote URL. */
export async function repoWebUrl(root: string, env: Env): Promise<string | undefined> {
  const url = (await gitRun(["remote", "get-url", "origin"], root, env)).stdout.trim();
  const match = /^(?:https:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  return match ? `https://github.com/${match[1]}/${match[2]}` : undefined;
}

const FILES = ["CHANGELOG.md", "package.json"];

/** Refuse to release when committing would sweep up unrelated work, or the tag exists. */
export async function checkReady(root: string, env: Env, tag: string): Promise<void> {
  if (!(await gitRun(["symbolic-ref", "--quiet", "HEAD"], root, env)).stdout.trim()) {
    throw new UsageError("You're not on a branch (detached HEAD). Check out the branch you release from.");
  }
  if ((await gitRun(["diff", "--cached", "--quiet"], root, env)).code !== 0) {
    throw new UsageError("You have staged changes. Commit or unstage them first, so the release commit only has the changelog.");
  }
  const dirty = (await git(["status", "--porcelain", "--", ...FILES], root, env)).trim();
  if (dirty) throw new UsageError(`Commit or discard your changes to ${FILES.join(" and ")} first; the release updates them.`);
  if ((await gitRun(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], root, env)).code === 0) {
    throw new UsageError(`The tag ${tag} already exists. Pick another version with --bump.`);
  }
}

/** Write the changelog (and package.json's version), commit, and tag. Restores the files if anything fails. */
export async function applyRelease(
  root: string,
  env: Env,
  release: { version: string; tag: string; changelog: string; interactive: boolean },
): Promise<string[]> {
  const changelogPath = join(root, "CHANGELOG.md");
  const original = await readFile(changelogPath, "utf8").catch(() => undefined);
  const manifest = await readManifest(root);
  const changed = ["CHANGELOG.md"];

  const restore = async () => {
    await gitRun(["reset", "-q", "--", ...changed], root, env);
    if (original === undefined) await rm(changelogPath, { force: true });
    else await writeFile(changelogPath, original);
    if (manifest && changed.includes("package.json")) await writeFile(join(root, "package.json"), manifest.text);
  };

  try {
    await writeFile(changelogPath, release.changelog);
    if (manifest?.version !== undefined && manifest.version !== release.version) {
      const updated = manifest.text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${release.version}$2`);
      await writeFile(join(root, "package.json"), updated);
      changed.push("package.json");
    }
    await git(["add", "--", ...changed], root, env);
    const message = `chore(release): ${release.tag}`;
    if (release.interactive) {
      if ((await commit(root, message, { env })) !== 0) throw new UsageError("git commit failed (see above). Nothing was released.");
    } else {
      const result = await gitRun(["commit", "-q", "-m", message], root, env);
      if (result.code !== 0) throw new UsageError(`git commit failed. Nothing was released.\n${(result.stderr || result.stdout).trim()}`);
    }
  } catch (error) {
    await restore();
    throw error;
  }

  const tagged = await gitRun(["tag", "-a", release.tag, "-m", release.tag], root, env);
  if (tagged.code !== 0) {
    await gitRun(["reset", "-q", "--soft", "HEAD~1"], root, env);
    await restore();
    throw new UsageError(`git tag failed, so the release commit was undone.\n${tagged.stderr.trim()}`);
  }
  return changed;
}

/** Push the branch, then the tag to the same remote. */
export async function pushRelease(root: string, env: Env, tag: string, interactive: boolean): Promise<void> {
  await pushCurrentBranch(root, env, interactive);
  const upstream = (await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root, env)).trim();
  const remote = upstream.split("/")[0]!;
  const result = await gitRun(["push", "-q", remote, `refs/tags/${tag}`], root, env);
  if (result.code !== 0) throw new UsageError(`Pushing the tag failed. Run \`git push ${remote} ${tag}\` when it's sorted.\n${result.stderr.trim()}`);
}

/** Create a GitHub release for a pushed tag with GitHub's CLI; returns its URL. */
export async function createGithubRelease(root: string, env: Env, tag: string, notes: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gitmit-release-"));
  const file = join(dir, "notes.md");
  try {
    await writeFile(file, `${notes.trim()}\n`);
    const result = await runCommand("gh", ["release", "create", tag, "--title", tag, "--notes-file", file, "--verify-tag"], root, env);
    if (result.code !== 0) throw new UsageError(`gh release create failed: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout.trim().split("\n").pop() ?? "";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Today in the local timezone, as YYYY-MM-DD. */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
