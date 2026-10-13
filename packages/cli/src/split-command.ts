import * as p from "@clack/prompts";
import { buildPatch, generate, planSplit, type DiffUnits, type SplitPlan } from "@gitmit/core";
import { stagedDiff } from "./git.js";
import type { ResolvedProvider } from "./provider.js";
import { UsageError } from "./provider.js";
import type { Settings } from "./settings.js";
import { applySplit, checkSplittable } from "./split.js";

export interface SplitContext {
  root: string;
  env: NodeJS.ProcessEnv;
  settings: Settings;
  provider: ResolvedProvider;
  redact: boolean;
  dryRun: boolean;
  yes: boolean;
  interactive: boolean;
  out: (line?: string) => void;
  err: (line: string) => void;
}

interface Commit {
  units: number[];
  reason: string;
  message: string;
}

export async function splitCommand(ctx: SplitContext): Promise<number> {
  await checkSplittable(ctx.root, ctx.env);
  const diffText = await stagedDiff(ctx.root, ctx.env, { binary: true });
  if (!diffText.trim()) throw new UsageError("No staged changes. Stage files with `git add` first.");

  const secrets = { onDetect: ctx.redact ? ("redact" as const) : (ctx.settings.config.secrets?.onDetect ?? "abort") };
  const label = `${ctx.provider.name}${ctx.provider.model ? ` (${ctx.provider.model})` : ""}`;
  const spin = ctx.interactive ? p.spinner() : undefined;

  if (ctx.interactive) p.intro("gitmit split");
  spin?.start(`Planning commits with ${label}`);
  let diff: DiffUnits;
  let plan: SplitPlan;
  try {
    ({ diff, plan } = await planSplit(diffText, {
      provider: ctx.provider.provider,
      ignore: ctx.settings.options.ignore,
      scopeFromPaths: ctx.settings.options.scopeFromPaths,
      secrets,
    }));
  } catch (error) {
    spin?.stop("Planning failed.");
    throw error;
  }

  if (plan.groups.length < 2) {
    spin?.stop("Planned.");
    const text = "These changes already form one focused commit. Run `gitmit` to commit them.";
    if (ctx.interactive) p.outro(text);
    else ctx.out(text);
    return 0;
  }

  spin?.message(`Writing ${plan.groups.length} commit messages`);
  const messageFor = async (units: number[]) => {
    const result = await generate(buildPatch(diff, units), {
      ...ctx.settings.options,
      provider: ctx.provider.provider,
      secrets,
      variants: 1,
    });
    return result.suggestions[0]!.message;
  };
  let commits: Commit[];
  try {
    commits = await Promise.all(
      plan.groups.map(async (g) => ({ units: g.units, reason: g.reason, message: await messageFor(g.units) })),
    );
  } catch (error) {
    spin?.stop("Writing messages failed.");
    throw error;
  }
  spin?.stop(`Planned ${commits.length} commits${plan.source === "model" ? "" : " (offline grouping)"}.`);
  if (plan.note) (ctx.interactive ? p.log.warn : ctx.err)(`Note: ${plan.note}`);

  if (!ctx.interactive) {
    ctx.out(renderPlan(commits, diff));
    if (ctx.dryRun) return 0;
    if (!ctx.yes) {
      ctx.err("Not a terminal, so nothing was committed. Use --yes to apply this plan.");
      return 0;
    }
    return apply(ctx, diff, commits);
  }

  while (true) {
    p.note(renderPlan(commits, diff), `Proposed commits (${commits.length})`);
    const action = await p.select({
      message: "What next?",
      options: [
        { value: "apply", label: `Create these ${commits.length} commits` },
        { value: "move", label: "Move a change to another commit" },
        { value: "edit", label: "Edit a commit message" },
        { value: "cancel", label: "Cancel" },
      ],
    });
    if (p.isCancel(action) || action === "cancel") {
      p.cancel("Nothing changed.");
      return 1;
    }

    if (action === "apply") {
      return apply(ctx, diff, commits);
    }

    if (action === "edit") {
      const index = await p.select({
        message: "Which commit?",
        options: commits.map((c, i) => ({ value: i, label: `${i + 1}. ${header(c.message)}` })),
      });
      if (p.isCancel(index)) continue;
      const commit = commits[index]!;
      const text = await p.text({
        message: "Commit message header",
        initialValue: header(commit.message),
        validate: (value) => (value?.trim() ? undefined : "The header cannot be empty."),
      });
      if (p.isCancel(text)) continue;
      const rest = commit.message.split("\n").slice(1).join("\n");
      commit.message = `${text.trim()}${rest ? `\n${rest}` : ""}`;
      continue;
    }

    // Move a unit to another (or a new) commit, then rewrite the affected messages.
    const unitId = await p.select({
      message: "Which change?",
      options: diff.units.map((u) => ({
        value: u.id,
        label: `${u.label}  +${u.additions} -${u.deletions}`,
        hint: `commit ${commits.findIndex((c) => c.units.includes(u.id)) + 1}`,
      })),
    });
    if (p.isCancel(unitId)) continue;
    const from = commits.findIndex((c) => c.units.includes(unitId));
    const target = await p.select({
      message: "Move it to",
      options: [
        ...commits.map((c, i) => ({ value: i, label: `${i + 1}. ${header(c.message)}`, disabled: i === from })),
        { value: -1, label: "A new commit" },
      ],
    });
    if (p.isCancel(target)) continue;

    const source = commits[from]!;
    let destination = commits[target];
    if (!destination) {
      destination = { units: [], reason: "moved by you", message: "" };
      commits.push(destination);
    }
    source.units = source.units.filter((id) => id !== unitId);
    destination.units = [...destination.units, unitId].sort((a, b) => a - b);
    commits = commits.filter((c) => c.units.length > 0);

    const spinner = p.spinner();
    spinner.start("Rewriting affected commit messages");
    try {
      for (const commit of [source, destination]) {
        if (commits.includes(commit)) commit.message = await messageFor(commit.units);
      }
      spinner.stop("Updated.");
    } catch (error) {
      spinner.stop("Could not rewrite messages.");
      throw error;
    }
  }
}

async function apply(ctx: SplitContext, diff: DiffUnits, commits: Commit[]): Promise<number> {
  const planned = commits.map((c) => ({ patch: buildPatch(diff, c.units), message: c.message }));
  const spin = ctx.interactive ? p.spinner() : undefined;
  spin?.start("Creating commits");
  try {
    const shas = await applySplit(ctx.root, planned, ctx.env, (i, sha) => {
      spin?.message(`Created ${i + 1} of ${planned.length}`);
      if (!ctx.interactive) ctx.out(`${sha.slice(0, 7)} ${header(planned[i]!.message)}`);
    });
    spin?.stop(`Created ${shas.length} commits.`);
    if (ctx.interactive) {
      p.outro(shas.map((sha, i) => `${sha.slice(0, 7)} ${header(planned[i]!.message)}`).join("\n"));
    }
    return 0;
  } catch (error) {
    spin?.stop("Split failed.");
    throw error;
  }
}

function header(message: string): string {
  return message.split("\n")[0] ?? "";
}

function renderPlan(commits: readonly Commit[], diff: DiffUnits): string {
  return commits
    .map((commit, i) => {
      const files = new Map<string, number>();
      for (const id of commit.units) {
        const unit = diff.units[id]!;
        files.set(unit.path, (files.get(unit.path) ?? 0) + (unit.wholeFile ? 0 : 1));
      }
      const list = [...files]
        .map(([path, hunks]) => `   ${path}${hunks > 0 ? ` (${hunks} change${hunks === 1 ? "" : "s"})` : ""}`)
        .join("\n");
      return `${i + 1}. ${header(commit.message)}\n${list}`;
    })
    .join("\n\n");
}
