import { git } from "./git.js";
import { DEFAULT_TICKET_PATTERN } from "./config.js";
import { UsageError } from "./provider.js";

/** The current branch name; in a GitHub Actions pull request checkout (detached), the PR's branch. */
export async function currentBranch(root: string, env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  let name = "";
  try {
    name = (await git(["symbolic-ref", "--short", "-q", "HEAD"], root, env)).trim();
  } catch {
    // Detached HEAD.
  }
  return name || env?.GITHUB_HEAD_REF || undefined;
}

/** Extract a ticket ID from a branch name with a regex; group 1 is the ID if present. */
export function ticketFromBranch(branch: string | undefined, pattern = DEFAULT_TICKET_PATTERN): string | undefined {
  if (!branch) return undefined;
  let regexp: RegExp;
  try {
    regexp = new RegExp(pattern);
  } catch (error) {
    throw new UsageError(`ticket.fromBranch is not a valid regular expression: ${(error as Error).message}`);
  }
  const match = regexp.exec(branch);
  return match ? (match[1] ?? match[0]) : undefined;
}
