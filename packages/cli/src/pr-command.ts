import * as p from "@clack/prompts";
import { generatePr, NoCommitsError, SecretsDetectedError, type PrResult } from "@gitmit/core";
import { UsageError, type ResolvedProvider } from "./provider.js";
import { pushCurrentBranch } from "./push.js";
import { copyToClipboard, createPr, editText, existingPr, ghAvailable, readBranch, readPrTemplate, updatePr, type Branch } from "./pr.js";
import type { Settings } from "./settings.js";

export interface PrContext {
  root: string;
  env: NodeJS.ProcessEnv;
  settings: Settings;
  provider: ResolvedProvider;
  base?: string;
  create: boolean;
  draft: boolean;
  update: boolean;
  redact: boolean;
  interactive: boolean;
  out: (line?: string) => void;
  err: (line: string) => void;
}

/** `gitmit pr`: a pull request title and description for the current branch. */
export async function prCommand(ctx: PrContext): Promise<number> {
  const branch = await readBranch(ctx.root, ctx.env, ctx.base);
  if (branch.commits.length === 0) throw new UsageError(new NoCommitsError(branch.baseRef).message);
  const template = await readPrTemplate(ctx.root);

  const write = (redact: boolean) =>
    generatePr(branch.diff, {
      provider: ctx.provider.provider,
      commits: branch.commits,
      branch: branch.head,
      base: branch.baseName,
      template,
      types: ctx.settings.options.types,
      subjectMaxLength: ctx.settings.options.subjectMaxLength,
      language: ctx.settings.options.language,
      ticket: ctx.settings.options.ticket,
      ignore: ctx.settings.options.ignore,
      scopeFromPaths: ctx.settings.options.scopeFromPaths,
      scopes: ctx.settings.options.scopes,
      validateTitle: ctx.settings.options.validate,
      secrets: { onDetect: redact ? "redact" : (ctx.settings.config.secrets?.onDetect ?? "abort") },
    });

  const label = `${ctx.provider.name}${ctx.provider.model ? ` (${ctx.provider.model})` : ""}`;
  const summary = `${branch.commits.length} commit${branch.commits.length === 1 ? "" : "s"} on ${branch.head}, compared with ${branch.baseRef}${template ? ", using your PR template" : ""}`;

  if (!ctx.interactive) {
    if (ctx.provider.note) ctx.err(ctx.provider.note);
    ctx.err(summary);
    const pr = await write(ctx.redact);
    if (pr.redacted) ctx.err(`Redacted ${pr.secrets.length} possible secret(s) before sending.`);
    ctx.out(pr.title);
    ctx.out("");
    ctx.out(pr.body);
    if (ctx.create || ctx.update) return publish(ctx, branch, pr, ctx.update ? "update" : "create");
    return 0;
  }

  p.intro("gitmit pr");
  if (ctx.provider.note) p.log.info(ctx.provider.note);
  p.log.info(summary);
  let redact = ctx.redact;
  let pr = await writeWithSpinner(() => write(redact), label, async () => {
    redact = true;
    return write(true);
  });
  if (!pr) return 1;

  const hasGh = await ghAvailable(ctx.root, ctx.env);
  const existing = hasGh ? await existingPr(ctx.root, ctx.env) : undefined;
  if (ctx.create || ctx.update) {
    p.note(`${pr.title}\n\n${pr.body}`, "Pull request");
    return publish(ctx, branch, pr, ctx.update || existing ? "update" : "create");
  }

  while (true) {
    p.note(`${pr.title}\n\n${pr.body}`, "Pull request");
    const action = await p.select({
      message: "What next?",
      options: [
        ...(hasGh
          ? existing
            ? [{ value: "update", label: "Update the open pull request", hint: existing }]
            : [
                { value: "create", label: "Create the pull request on GitHub" },
                { value: "draft", label: "Create it as a draft" },
              ]
          : []),
        { value: "copy", label: "Copy to clipboard" },
        { value: "edit", label: "Edit in your editor" },
        { value: "again", label: "Write a new version" },
        { value: "cancel", label: "Done" },
      ],
    });
    if (p.isCancel(action) || action === "cancel") {
      if (!hasGh) p.log.info("Install GitHub's CLI (https://cli.github.com) to create pull requests from here.");
      p.outro("Done.");
      return 0;
    }
    if (action === "copy") {
      const copied = await copyToClipboard(`${pr.title}\n\n${pr.body}`, ctx.env);
      p.log.success(copied ? "Copied the title and description." : "No clipboard tool found; copy it from above.");
      continue;
    }
    if (action === "edit") {
      const edited = await editText(ctx.root, ctx.env, `${pr.title}\n\n${pr.body}\n`);
      const [title = "", ...rest] = edited.split("\n");
      if (title.trim()) pr = { ...pr, title: title.trim(), body: rest.join("\n").trim() };
      continue;
    }
    if (action === "again") {
      const next = await writeWithSpinner(() => write(redact), label);
      if (next) pr = next;
      continue;
    }
    if (action === "create" || action === "draft" || action === "update") {
      return publish({ ...ctx, draft: action === "draft" || ctx.draft }, branch, pr, action === "update" ? "update" : "create");
    }
  }
}

async function writeWithSpinner(
  work: () => Promise<PrResult>,
  label: string,
  redactRetry?: () => Promise<PrResult>,
): Promise<PrResult | undefined> {
  const spin = p.spinner();
  spin.start(`Writing the pull request with ${label}`);
  try {
    const pr = await work();
    spin.stop(pr.redacted ? `Done. Redacted ${pr.secrets.length} possible secret(s) before sending.` : "Done.");
    return pr;
  } catch (error) {
    if (error instanceof SecretsDetectedError && redactRetry) {
      spin.stop("Possible secrets in the branch. Nothing was sent.");
      p.log.warn(error.findings.map((f) => `${f.rule}${f.path ? ` in ${f.path}` : ""}: ${f.preview}`).join("\n"));
      const ok = await p.confirm({ message: "Send a version with the secrets redacted?", initialValue: false });
      if (p.isCancel(ok) || !ok) {
        p.cancel("Nothing sent.");
        return undefined;
      }
      return writeWithSpinner(redactRetry, label);
    }
    spin.stop("Failed.");
    throw error;
  }
}

/** Create or update the pull request with GitHub's CLI, pushing the branch first if needed. */
async function publish(ctx: PrContext, branch: Branch, pr: PrResult, mode: "create" | "update"): Promise<number> {
  if (!(await ghAvailable(ctx.root, ctx.env))) {
    throw new UsageError("Creating pull requests needs GitHub's CLI. Install it from https://cli.github.com, then run `gh auth login`.");
  }
  const say = (line: string) => (ctx.interactive ? p.log.step(line) : ctx.err(line));

  if (mode === "create") {
    const existing = await existingPr(ctx.root, ctx.env);
    if (existing) throw new UsageError(`A pull request is already open for ${branch.head}: ${existing}\nUse --update to replace its title and description.`);
    say("Pushing the branch...");
    await pushCurrentBranch(ctx.root, ctx.env, ctx.interactive);
    const url = await createPr(ctx.root, ctx.env, { title: pr.title, body: pr.body, base: branch.baseName, draft: ctx.draft });
    if (ctx.interactive) p.outro(`Created ${ctx.draft ? "a draft " : ""}pull request: ${url}`);
    else ctx.out(`\n${url}`);
    return 0;
  }

  const existing = await existingPr(ctx.root, ctx.env);
  if (!existing) throw new UsageError(`No open pull request for ${branch.head}. Use --create to open one.`);
  await updatePr(ctx.root, ctx.env, { title: pr.title, body: pr.body });
  if (ctx.interactive) p.outro(`Updated ${existing}`);
  else ctx.out(`\nUpdated ${existing}`);
  return 0;
}
