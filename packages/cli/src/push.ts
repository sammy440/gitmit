import { spawn } from "node:child_process";
import { git, gitRun } from "./git.js";

export class PushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushError";
  }
}

type Env = NodeJS.ProcessEnv;

/** Push the current branch, setting an upstream if it has none (like `git push -u`). */
export async function pushCurrentBranch(root: string, env: Env, interactive: boolean): Promise<string> {
  const upstream = await gitRun(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root, env);
  let args: string[];
  if (upstream.code === 0) {
    args = ["push"];
  } else {
    const branch = (await gitRun(["symbolic-ref", "--short", "-q", "HEAD"], root, env)).stdout.trim();
    if (!branch) throw new PushError("Not on a branch (detached HEAD), so there is nothing to push. Your commits were kept.");
    const remote = await pushRemote(root, env);
    args = ["push", "--set-upstream", remote, branch];
  }

  if (interactive) {
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn("git", args, { cwd: root, env, stdio: "inherit" });
      child.on("error", reject);
      child.on("close", (c) => resolve(c ?? 1));
    });
    if (code !== 0) throw new PushError("git push failed (see above). Your commits were kept; push again when it's sorted.");
    return "";
  }

  const result = await gitRun(args, root, env);
  const output = `${result.stderr}${result.stdout}`.trim();
  if (result.code !== 0) {
    throw new PushError(`git push failed. Your commits were kept; push again when it's sorted.${output ? `\n${output}` : ""}`);
  }
  return output;
}

async function pushRemote(root: string, env: Env): Promise<string> {
  const configured = (await gitRun(["config", "--get", "remote.pushDefault"], root, env)).stdout.trim();
  if (configured) return configured;
  const remotes = (await git(["remote"], root, env)).split("\n").filter(Boolean);
  if (remotes.includes("origin")) return "origin";
  if (remotes.length === 1) return remotes[0]!;
  if (remotes.length === 0) {
    throw new PushError("This repository has no remote to push to. Add one with `git remote add origin <url>`. Your commits were kept.");
  }
  throw new PushError(
    `Several remotes (${remotes.join(", ")}) and none is the default. Push once with \`git push -u <remote> <branch>\`, then --push will reuse it. Your commits were kept.`,
  );
}
