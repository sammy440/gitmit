import { appendFile } from "node:fs/promises";
import { checkMessage, generate, generatePr, isGenerated, type CheckRules, type PrCommit } from "@gitmit/core";
import { git, GitError, gitRun, logCommits } from "./git.js";
import { findBase } from "./pr.js";
import { UsageError, type ResolvedProvider } from "./provider.js";
import type { Settings } from "./settings.js";

export interface CheckContext {
  root: string;
  env: NodeJS.ProcessEnv;
  settings: Settings;
  provider: ResolvedProvider;
  range?: string;
  base?: string;
  title?: string;
  commits: boolean;
  suggest: boolean;
  redact: boolean;
  json: boolean;
  out: (line?: string) => void;
  err: (line: string) => void;
}

interface Result {
  kind: "commit" | "title";
  sha?: string;
  message: string;
  problems: string[];
  suggestion?: string;
}

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "-M"];

/** `gitmit check`: do the branch's commit messages (and the PR title) follow the team's rules? */
export async function checkCommand(ctx: CheckContext): Promise<number> {
  if (!ctx.commits && ctx.title === undefined) throw new UsageError("Nothing to check: --no-commits needs --title.");
  const { settings } = ctx;
  const rules: CheckRules = {
    types: settings.options.types,
    scopes: settings.options.scopes,
    subjectMaxLength: settings.options.subjectMaxLength,
    ticket: settings.ticket?.id,
    requireTicket: settings.config.ticket?.required,
    validate: settings.options.validate,
  };

  const { range, label } = await withShallowHint(ctx, () => resolveRange(ctx));
  const needCommits = ctx.commits || (ctx.suggest && ctx.title !== undefined);
  const commits = needCommits ? await withShallowHint(ctx, () => logCommits(ctx.root, range, ctx.env)) : [];
  const results: Result[] = [];
  if (ctx.title !== undefined) results.push({ kind: "title", message: ctx.title, problems: await checkMessage(ctx.title, rules, { headerOnly: true }) });
  if (ctx.commits) {
    for (const c of commits) {
      const message = c.body ? `${c.subject}\n\n${c.body}` : c.subject;
      results.push({ kind: "commit", sha: c.sha, message, problems: await checkMessage(message, rules) });
    }
  }

  const failed = results.filter((r) => r.problems.length > 0);
  if (ctx.suggest) for (const r of failed) r.suggestion = await suggest(ctx, r, range, commits);

  const checked = results.filter((r) => r.kind === "title" || !isGenerated(r.message));
  const summary =
    checked.length === 0
      ? `No commits to check ${label}.`
      : failed.length === 0
        ? `All ${plural(checked.length, "message")} follow the rules.`
        : `${failed.length} of ${plural(checked.length, "message")} ${failed.length === 1 ? "needs" : "need"} changes.`;

  if (ctx.json) {
    ctx.out(JSON.stringify({ ok: failed.length === 0, rules: settings.commitlint ? `commitlint (${settings.commitlint.source})` : "gitmit", range, results }, null, 2));
  } else {
    if (settings.commitlint) ctx.err(`Following commitlint rules from ${settings.commitlint.source}.`);
    ctx.err(`Checking ${ctx.commits ? `${plural(commits.length, "commit")} ${label}` : ""}${ctx.commits && ctx.title !== undefined ? " and " : ""}${ctx.title !== undefined ? "the pull request title" : ""}.`);
    for (const r of failed) {
      ctx.out(`✗ ${r.kind === "title" ? "PR title" : r.sha!.slice(0, 7)}  ${r.message.split("\n")[0]}`);
      for (const problem of r.problems) ctx.out(`    - ${problem}`);
      if (r.suggestion) ctx.out(`    Suggested: ${r.suggestion.split("\n")[0]}`);
    }
    ctx.out(`${failed.length === 0 ? "✓" : "✗"} ${summary}`);
  }

  if (ctx.env.GITHUB_ACTIONS === "true") await reportToGithub(ctx, failed, summary);
  return failed.length === 0 ? 0 : 1;
}

async function resolveRange(ctx: CheckContext): Promise<{ range: string; label: string }> {
  if (ctx.range) return { range: ctx.range, label: `in ${ctx.range}` };
  const base = await findBase(ctx.root, ctx.env, ctx.base);
  const [head, baseSha] = await Promise.all([
    git(["rev-parse", "HEAD"], ctx.root, ctx.env),
    git(["rev-parse", `${base.ref}^{commit}`], ctx.root, ctx.env),
  ]);
  if (head.trim() === baseSha.trim()) {
    throw new UsageError(`HEAD is ${base.ref}, so there's nothing to compare. Check from a branch, or pass --range, e.g. --range HEAD~5..HEAD.`);
  }
  const mergeBase = (await git(["merge-base", base.ref, "HEAD"], ctx.root, ctx.env)).trim();
  return { range: `${mergeBase}..HEAD`, label: `since ${base.ref}` };
}

/** Git errors in a shallow clone usually mean missing history; say so. */
async function withShallowHint<T>(ctx: CheckContext, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const shallow = (await gitRun(["rev-parse", "--is-shallow-repository"], ctx.root, ctx.env)).stdout.trim() === "true";
    if (shallow && (error instanceof GitError || error instanceof UsageError)) {
      throw new UsageError(`${error.message}\nThis is a shallow clone, so the history may be missing. In GitHub Actions, check out with fetch-depth: 0.`);
    }
    throw error;
  }
}

/** A fixed message: from the commit's own diff, or for the title, from the whole range. */
async function suggest(ctx: CheckContext, result: Result, range: string, commits: PrCommit[]): Promise<string | undefined> {
  const secrets = { onDetect: ctx.redact ? ("redact" as const) : (ctx.settings.config.secrets?.onDetect ?? "abort") };
  try {
    if (result.kind === "commit") {
      const diff = await git(["-c", "core.quotePath=true", "show", "--format=", ...DIFF_FLAGS, result.sha!], ctx.root, ctx.env);
      const generated = await generate(diff, { ...ctx.settings.options, provider: ctx.provider.provider, variants: 1, secrets });
      return generated.suggestions[0]?.message;
    }
    if (commits.length === 0) return undefined;
    const [from, to = "HEAD"] = range.split("..");
    const diff = await git(["-c", "core.quotePath=true", "diff", ...DIFF_FLAGS, from!, to], ctx.root, ctx.env);
    const pr = await generatePr(diff, {
      ...ctx.settings.options,
      provider: ctx.provider.provider,
      commits,
      validateTitle: ctx.settings.options.validate,
      secrets,
    });
    return pr.title;
  } catch (error) {
    if (!ctx.json) ctx.err(`Couldn't suggest a fix for ${result.kind === "title" ? "the title" : result.sha!.slice(0, 7)}: ${(error as Error).message}`);
    return undefined;
  }
}

/** Annotations on the run, and a job summary. */
async function reportToGithub(ctx: CheckContext, failed: Result[], summary: string): Promise<void> {
  const escape = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const name = (r: Result) => (r.kind === "title" ? "Pull request title" : `Commit ${r.sha!.slice(0, 7)}`);
  for (const r of failed) {
    const detail = [`"${r.message.split("\n")[0]}"`, ...r.problems.map((p) => `- ${p}`), ...(r.suggestion ? [`Suggested: ${r.suggestion.split("\n")[0]}`] : [])];
    ctx.out(`::error title=${escape(`gitmit check: ${name(r)}`)}::${escape(detail.join("\n"))}`);
  }
  const file = ctx.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;
  const lines = [`### ${failed.length === 0 ? "✅" : "❌"} gitmit check`, "", summary, ""];
  for (const r of failed) {
    lines.push(`**${name(r)}:** ${code(r.message.split("\n")[0]!)}`, "");
    for (const p of r.problems) lines.push(`- ${p}`);
    if (r.suggestion) lines.push(`- Suggested: ${code(r.suggestion.split("\n")[0]!)}`);
    lines.push("");
  }
  await appendFile(file, `${lines.join("\n")}\n`);
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
