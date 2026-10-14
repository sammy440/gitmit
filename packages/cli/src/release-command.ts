import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as p from "@clack/prompts";
import {
  bumpVersion,
  isVersion,
  planRelease,
  prependChangelog,
  renderRelease,
  SecretsDetectedError,
  writeHighlights,
  type Bump,
  type ReleasePlan,
} from "@gitmit/core";
import { copyToClipboard, editText, ghAvailable } from "./pr.js";
import { UsageError, type ResolvedProvider } from "./provider.js";
import { applyRelease, checkReady, createGithubRelease, pushRelease, readReleaseInfo, today, type ReleaseInfo } from "./release.js";
import type { Settings } from "./settings.js";

export interface ReleaseContext {
  root: string;
  env: NodeJS.ProcessEnv;
  settings: Settings;
  provider: ResolvedProvider;
  bump?: string;
  dryRun: boolean;
  yes: boolean;
  push: boolean;
  github: boolean;
  redact: boolean;
  interactive: boolean;
  out: (line?: string) => void;
  err: (line: string) => void;
}

/** `gitmit release`: changelog, next version and tag from the commits since the last release. */
export async function releaseCommand(ctx: ReleaseContext): Promise<number> {
  const info = await readReleaseInfo(ctx.root, ctx.env);
  const prefix = info.last?.prefix ?? "v";
  let plan = makePlan(info, ctx.bump);
  const publish = ctx.push || ctx.github;
  if (ctx.github && !ctx.dryRun && !(await ghAvailable(ctx.root, ctx.env))) {
    throw new UsageError("--github needs GitHub's CLI. Install it from https://cli.github.com, then run `gh auth login`.");
  }
  if (!ctx.dryRun) await checkReady(ctx.root, ctx.env, `${prefix}${plan.version}`);

  const since = info.last ? `since ${info.last.tag}` : "so far (first release)";
  const summary = () => `${info.commits.length} commit${info.commits.length === 1 ? "" : "s"} ${since}. Next version: ${plan.version} (${plan.reason}).`;
  const label = `${ctx.provider.name}${ctx.provider.model ? ` (${ctx.provider.model})` : ""}`;

  if (!ctx.interactive) {
    if (ctx.provider.note) ctx.err(ctx.provider.note);
    ctx.err(summary());
    const highlights = await highlightsFor(plan, ctx, ctx.err);
    const release = render(info, plan, prefix, highlights);
    ctx.out(release.heading);
    ctx.out("");
    ctx.out(release.notes);
    if (ctx.dryRun) return 0;
    if (!ctx.yes) {
      ctx.err("Not a terminal, so nothing was released. Use --yes to write the changelog, commit and tag.");
      return 0;
    }
    return finish(ctx, plan, release, publish ? (ctx.github ? "github" : "push") : "local");
  }

  p.intro("gitmit release");
  if (ctx.provider.note) p.log.info(ctx.provider.note);
  let highlights: string | undefined;
  if (ctx.provider.provider.complete) {
    const spin = p.spinner();
    spin.start(`Writing the highlights with ${label}`);
    const notes: string[] = [];
    highlights = await highlightsFor(plan, ctx, (line) => notes.push(line));
    spin.stop(highlights ? "Done." : "Skipped the highlights.");
    for (const note of notes) p.log.warn(note);
  }
  let notesOverride: string | undefined;

  while (true) {
    const release = render(info, plan, prefix, highlights, notesOverride);
    p.log.info(summary());
    p.note(`${release.heading}\n\n${release.notes}`, `${prefix}${plan.version}`);
    const action = await p.select({
      message: "What next?",
      options: [
        { value: "release", label: `Release ${prefix}${plan.version}`, hint: "update CHANGELOG.md, commit and tag" },
        { value: "version", label: "Change the version" },
        { value: "edit", label: "Edit the notes in your editor" },
        { value: "copy", label: "Copy the notes" },
        { value: "cancel", label: "Cancel" },
      ],
    });
    if (p.isCancel(action) || action === "cancel") {
      p.cancel("Nothing released.");
      return 1;
    }
    if (action === "copy") {
      const copied = await copyToClipboard(release.notes, ctx.env);
      p.log.success(copied ? "Copied the notes." : "No clipboard tool found; copy them from above.");
      continue;
    }
    if (action === "edit") {
      notesOverride = (await editText(ctx.root, ctx.env, `${release.notes}\n`)).trim() || notesOverride;
      continue;
    }
    if (action === "version") {
      const next = await chooseVersion(info, plan);
      if (next) {
        plan = makePlan(info, next);
        await checkReady(ctx.root, ctx.env, `${prefix}${plan.version}`);
      }
      continue;
    }

    let mode: "local" | "push" | "github" = publish ? (ctx.github ? "github" : "push") : "local";
    if (!publish) {
      const hasGh = await ghAvailable(ctx.root, ctx.env);
      const choice = await p.select({
        message: "After tagging:",
        options: [
          ...(hasGh ? [{ value: "github", label: "Push, then create a GitHub release" }] : []),
          { value: "push", label: "Push the commit and tag" },
          { value: "local", label: "Keep it local", hint: "push later with git push --follow-tags" },
        ],
      });
      if (p.isCancel(choice)) continue;
      mode = choice as typeof mode;
    }
    return finish(ctx, plan, release, mode);
  }
}

function makePlan(info: ReleaseInfo, bump?: string): ReleasePlan {
  try {
    return planRelease(info.commits, { current: info.last?.version, initial: info.manifestVersion, bump, since: info.last?.tag });
  } catch (error) {
    if (error instanceof Error) throw new UsageError(error.message);
    throw error;
  }
}

/** AI highlights when the provider has a model; problems are reported and the release goes on without them. */
async function highlightsFor(plan: ReleasePlan, ctx: ReleaseContext, warn: (line: string) => void): Promise<string | undefined> {
  if (!ctx.provider.provider.complete) return undefined;
  try {
    const result = await writeHighlights(plan, {
      provider: ctx.provider.provider,
      language: ctx.settings.options.language,
      secrets: { onDetect: ctx.redact ? "redact" : (ctx.settings.config.secrets?.onDetect ?? "abort") },
    });
    if (result.redacted) warn(`Redacted ${result.secrets.length} possible secret(s) before sending.`);
    return result.text;
  } catch (error) {
    if (error instanceof SecretsDetectedError) {
      warn("Skipped the AI highlights: the commit messages contain a possible secret. Use --redact to send a redacted version.");
      return undefined;
    }
    if (error instanceof Error && error.name === "ProviderError") {
      warn(`Skipped the AI highlights: ${error.message}`);
      return undefined;
    }
    throw error;
  }
}

interface Rendered {
  tag: string;
  heading: string;
  notes: string;
}

function render(info: ReleaseInfo, plan: ReleasePlan, prefix: string, highlights?: string, notes?: string): Rendered {
  const tag = `${prefix}${plan.version}`;
  const rendered = renderRelease(plan, { tag, previousTag: info.last?.tag, repoUrl: info.repoUrl, date: today(), highlights });
  return { tag, heading: rendered.heading, notes: notes ?? rendered.notes };
}

async function chooseVersion(info: ReleaseInfo, plan: ReleasePlan): Promise<string | undefined> {
  const base = info.last?.version ?? info.manifestVersion ?? "0.0.0";
  const bumps: Bump[] = ["patch", "minor", "major"];
  const choice = await p.select({
    message: `Version (now ${plan.version})`,
    options: [
      ...bumps.map((b) => ({ value: b, label: `${bumpVersion(base, b)}`, hint: b })),
      { value: "custom", label: "Type a version" },
    ],
  });
  if (p.isCancel(choice)) return undefined;
  if (choice !== "custom") return choice as string;
  const typed = await p.text({
    message: "Version",
    placeholder: "1.0.0",
    validate: (v) => (v && isVersion(v.trim()) ? undefined : "A version like 1.2.3"),
  });
  return p.isCancel(typed) ? undefined : typed.trim();
}

async function finish(ctx: ReleaseContext, plan: ReleasePlan, release: Rendered, mode: "local" | "push" | "github"): Promise<number> {
  const say = (line: string) => (ctx.interactive ? p.log.step(line) : ctx.err(line));
  const existing = await readFile(join(ctx.root, "CHANGELOG.md"), "utf8").catch(() => undefined);
  let changelog: string;
  try {
    changelog = prependChangelog(existing, `${release.heading}\n\n${release.notes}`, plan.version);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }

  const changed = await applyRelease(ctx.root, ctx.env, { version: plan.version, tag: release.tag, changelog, interactive: ctx.interactive });
  say(`Updated ${changed.join(" and ")}, committed and tagged ${release.tag}.`);

  if (mode === "local") {
    const next = "Push it with `git push --follow-tags`.";
    if (ctx.interactive) p.outro(`Released ${release.tag} locally. ${next}`);
    else ctx.err(next);
    return 0;
  }
  say("Pushing the commit and tag...");
  await pushRelease(ctx.root, ctx.env, release.tag, ctx.interactive);
  if (mode === "push") {
    if (ctx.interactive) p.outro(`Released ${release.tag}.`);
    else ctx.err(`Pushed ${release.tag}.`);
    return 0;
  }
  const url = await createGithubRelease(ctx.root, ctx.env, release.tag, release.notes);
  if (ctx.interactive) p.outro(`Released ${release.tag}: ${url}`);
  else ctx.out(`\n${url}`);
  return 0;
}
