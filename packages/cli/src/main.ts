import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import * as p from "@clack/prompts";
import {
  EmptyDiffError,
  generate,
  PROVIDER_NAMES,
  SecretsDetectedError,
  type GenerateResult,
  type ProviderName,
  type Suggestion,
} from "@gitmit/core";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError } from "./config.js";
import { loadSettings, type Settings } from "./settings.js";
import { splitCommand } from "./split-command.js";
import { prCommand } from "./pr-command.js";
import { releaseCommand } from "./release-command.js";
import { SplitError } from "./split.js";
import { PushError, pushCurrentBranch } from "./push.js";
import { account, login, logout, readAuth } from "./auth.js";
import { loadEnv, userEnvFile } from "./env.js";
import { commit, GitError, nothingStagedMessage, repoRoot, stagedDiff, unpushedCount } from "./git.js";
import { installHook, uninstallHook, writeHookMessage } from "./hook.js";
import { resolveProvider, UsageError, type ResolvedProvider } from "./provider.js";

// Read from package.json so the version is set in one place. Resolves from both src/ and dist/.
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;

const HELP = `gitmit: commit messages from your staged changes

Usage:
  gitmit [options]               Suggest messages for staged changes and commit
  gitmit split                   Split staged changes into several focused commits
  gitmit pr                      Write a pull request title and description for this branch
  gitmit pr --create [--draft]   ...and open the pull request on GitHub (needs the gh CLI)
  gitmit pr --update             ...and replace the open pull request's title and description
  gitmit release                 Changelog, next version and tag from the commits since the last release
  gitmit release --yes [--push | --github]   ...without asking; then push, or push and create a GitHub release
  gitmit init [--force]          Create a starter .gitmitrc.json
  gitmit config                  Show the settings gitmit will use here
  gitmit hook install [--force]  Fill in a suggestion whenever you run \`git commit\`
  gitmit hook uninstall          Remove the hook
  gitmit login                   Sign in with GitHub to use the API key saved in your gitmit account
  gitmit logout                  Sign out on this computer
  gitmit account                 Show your gitmit account and saved keys

Options:
  --dry-run              Show suggestions (or the split plan) without committing
  -y, --yes              Commit the top suggestion (or apply the split) without asking
  --provider <name>      openai, anthropic, ollama or rules (offline)
  --model <name>         Model for the provider
  --config <path>        Config file (default: gitmit.config.ts or .gitmitrc.json in the repo root)
  --redact               Redact secrets instead of stopping when one is found
  --push                 Push after committing (sets the upstream on a new branch)
  --no-push              Don't push, even if the config says to
  --base <branch>        For pr: the branch to compare with (default: the remote's default branch)
  --bump <level>         For release: major, minor, patch or an exact version, instead of the suggestion
  --github               For release: push, then create a GitHub release (needs the gh CLI)
  -h, --help             Show this help
  -v, --version          Show the version

API keys are read from the environment or from:
  ${"<config dir>"}/gitmit/.env   (OPENAI_API_KEY, ANTHROPIC_API_KEY, ...)
`;

export interface Io {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: NodeJS.WriteStream | { write(s: string): unknown; isTTY?: boolean };
  stderr: { write(s: string): unknown };
  stdinIsTTY: boolean;
  /** Path of the CLI entry file, recorded in the git hook. */
  cliPath: string;
  nodePath: string;
}

export function defaultIo(): Io {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    cliPath: process.argv[1] ?? "",
    nodePath: process.execPath,
  };
}

interface Flags {
  dryRun: boolean;
  yes: boolean;
  provider?: ProviderName;
  model?: string;
  config?: string;
  redact: boolean;
  force: boolean;
  push?: boolean;
  base?: string;
  create: boolean;
  draft: boolean;
  update: boolean;
  bump?: string;
  github: boolean;
}

/** Run the CLI. Returns the process exit code. */
export async function main(argv: readonly string[], io: Io = defaultIo()): Promise<number> {
  const out = (line = "") => io.stdout.write(`${line}\n`);
  const err = (line: string) => io.stderr.write(`${line}\n`);

  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        "dry-run": { type: "boolean", default: false },
        yes: { type: "boolean", short: "y", default: false },
        provider: { type: "string" },
        model: { type: "string" },
        config: { type: "string" },
        redact: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        push: { type: "boolean" },
        base: { type: "string" },
        create: { type: "boolean", default: false },
        draft: { type: "boolean", default: false },
        update: { type: "boolean", default: false },
        bump: { type: "string" },
        github: { type: "boolean", default: false },
        "no-push": { type: "boolean" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    err(`gitmit: ${(error as Error).message}\nRun gitmit --help for usage.`);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    out(HELP.replace("<config dir>/gitmit/.env", userEnvFile(io.env)));
    return 0;
  }
  if (values.version) {
    out(VERSION);
    return 0;
  }
  if (values.provider && !PROVIDER_NAMES.includes(values.provider as ProviderName)) {
    err(`gitmit: unknown provider "${values.provider}". Choose one of: ${PROVIDER_NAMES.join(", ")}.`);
    return 2;
  }

  const flags: Flags = {
    dryRun: values["dry-run"],
    yes: values.yes,
    provider: values.provider as ProviderName | undefined,
    model: values.model,
    config: values.config,
    redact: values.redact,
    force: values.force,
    push: values["no-push"] ? false : values.push,
    base: values.base,
    create: values.create || values.draft,
    draft: values.draft,
    update: values.update,
    bump: values.bump,
    github: values.github,
  };

  try {
    // Account commands work anywhere, not just inside a repository.
    if (positionals[0] === "login") return await loginCommand(io, out);
    if (positionals[0] === "logout") return await logoutCommand(io, out);
    if (positionals[0] === "account") return await accountCommand(io, out);

    const root = await repoRoot(io.cwd, io.env);
    if (!root) throw new UsageError("Not inside a git repository.");

    const [command, sub, arg] = positionals;
    if (command === "hook") return await hookCommand(root, sub, arg, flags, io, out);
    if (command === "init") return await initCommand(root, flags, out);
    if (command === "pr") {
      const { settings, provider } = await loadAll(root, flags, io, false);
      return await prCommand({
        root,
        env: io.env,
        settings,
        provider,
        base: flags.base,
        create: flags.create,
        draft: flags.draft,
        update: flags.update,
        redact: flags.redact,
        interactive: Boolean(io.stdout.isTTY) && io.stdinIsTTY && !flags.dryRun,
        out,
        err,
      });
    }
    if (command === "release") {
      const { settings, provider } = await loadAll(root, flags, io, false);
      return await releaseCommand({
        root,
        env: io.env,
        settings,
        provider,
        bump: flags.bump,
        dryRun: flags.dryRun,
        yes: flags.yes,
        push: shouldPush(flags, settings),
        github: flags.github,
        redact: flags.redact,
        interactive: Boolean(io.stdout.isTTY) && io.stdinIsTTY && !flags.yes && !flags.dryRun,
        out,
        err,
      });
    }
    if (command === "split") {
      if (flags.push && !flags.dryRun) {
        const pushed = await pushIfNothingStaged(root, io, err);
        if (pushed !== undefined) return pushed;
      }
      const { settings, provider } = await loadAll(root, flags, io);
      const interactive = Boolean(io.stdout.isTTY) && io.stdinIsTTY && !flags.yes && !flags.dryRun;
      if (!interactive && provider.note) err(provider.note);
      return await splitCommand({
        root,
        env: io.env,
        settings,
        provider,
        redact: flags.redact,
        dryRun: flags.dryRun,
        yes: flags.yes,
        push: shouldPush(flags, settings),
        interactive,
        out,
        err,
      });
    }
    if (command === "config") return await configCommand(root, flags, io, out);
    if (command !== undefined) throw new UsageError(`Unknown command "${command}". Run gitmit --help for usage.`);
    return await commitCommand(root, flags, io, out, err);
  } catch (error) {
    if (
      error instanceof UsageError ||
      error instanceof ConfigError ||
      error instanceof GitError ||
      error instanceof SplitError ||
      error instanceof PushError
    ) {
      err(`gitmit: ${error.message}`);
      return 1;
    }
    if (error instanceof SecretsDetectedError) {
      err(`gitmit: ${error.message}`);
      err("Unstage the secret, or re-run with --redact to send a redacted version.");
      return 1;
    }
    if (error instanceof Error && error.name === "ProviderError") {
      err(`gitmit: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function loadAll(root: string, flags: Flags, io: Io, requireTicket = true) {
  const env = loadEnv(io.env);
  const settings = await loadSettings(root, io.env, {
    explicit: flags.config,
    overrides: { provider: flags.provider, model: flags.model },
    requireTicket,
  });
  const auth = await readAuth(io.env);
  const provider = resolveProvider(env, settings.config.provider, settings.config.model, auth);
  return { settings, provider };
}

async function prepare(root: string, flags: Flags, io: Io) {
  const diff = await stagedDiff(root, io.env);
  if (!diff.trim()) throw new UsageError(await nothingStagedMessage(root, io.env));
  return { ...(await loadAll(root, flags, io)), diff };
}

function generateOptions(settings: Settings, provider: ResolvedProvider, redact: boolean) {
  return {
    ...settings.options,
    provider: provider.provider,
    secrets: { onDetect: redact ? ("redact" as const) : (settings.config.secrets?.onDetect ?? "abort") },
  };
}

async function commitCommand(
  root: string,
  flags: Flags,
  io: Io,
  out: (line?: string) => void,
  err: (line: string) => void,
): Promise<number> {
  if (flags.push && !flags.dryRun) {
    const pushed = await pushIfNothingStaged(root, io, err);
    if (pushed !== undefined) return pushed;
  }
  const { settings, provider, diff } = await prepare(root, flags, io);
  const interactive = Boolean(io.stdout.isTTY) && io.stdinIsTTY && !flags.yes && !flags.dryRun;
  const label = `${provider.name}${provider.model ? ` (${provider.model})` : ""}`;

  if (!interactive) {
    if (provider.note) err(provider.note);
    for (const note of settings.notes) err(note);
    const result = await generate(diff, generateOptions(settings, provider, flags.redact));
    if (result.redacted) err(`Redacted ${result.secrets.length} possible secret(s) before sending.`);
    if (flags.yes && !flags.dryRun) {
      const code = await commit(root, result.suggestions[0]!.message, { env: io.env });
      if (code !== 0 || !shouldPush(flags, settings)) return code;
      const output = await pushCurrentBranch(root, io.env, false);
      if (output) err(output);
      return 0;
    }
    printSuggestions(result.suggestions, out);
    if (!flags.dryRun) err("Not a terminal, so nothing was committed. Use --yes to commit the first suggestion.");
    return 0;
  }

  p.intro("gitmit");
  if (provider.note) p.log.info(provider.note);
  for (const note of settings.notes) p.log.info(note);
  if (settings.ticket) p.log.info(`Ticket ${settings.ticket.id} from branch ${settings.branch}.`);

  let redact = flags.redact;
  while (true) {
    const result = await runWithSpinner(diff, settings, provider, redact, label);
    if (result === "redact") {
      redact = true;
      continue;
    }
    if (result === "cancel") return 1;

    const choice = await pick(result);
    if (choice === "regenerate") continue;
    if (choice === "cancel") {
      p.cancel("Nothing committed.");
      return 1;
    }

    const action = await p.select({
      message: "Commit with this message?",
      options: [
        { value: "commit", label: "Commit" },
        { value: "edit", label: "Edit in your editor, then commit" },
        { value: "back", label: "Back to the suggestions" },
      ],
    });
    if (p.isCancel(action)) {
      p.cancel("Nothing committed.");
      return 1;
    }
    if (action === "back") continue;

    p.outro(action === "edit" ? "Opening your editor..." : "Committing...");
    const code = await commit(root, choice.message, { edit: action === "edit", env: io.env });
    if (code !== 0 || !shouldPush(flags, settings)) return code;
    p.log.step("Pushing...");
    await pushCurrentBranch(root, io.env, true);
    p.log.success("Pushed.");
    return 0;
  }
}

async function runWithSpinner(
  diff: string,
  settings: Settings,
  provider: ResolvedProvider,
  redact: boolean,
  label: string,
): Promise<GenerateResult | "redact" | "cancel"> {
  const spin = p.spinner();
  spin.start(`Writing suggestions with ${label}`);
  try {
    const result = await generate(diff, generateOptions(settings, provider, redact));
    spin.stop(result.redacted ? `Done. Redacted ${result.secrets.length} possible secret(s) before sending.` : "Done.");
    return result;
  } catch (error) {
    if (error instanceof SecretsDetectedError) {
      spin.stop("Possible secrets in the staged changes. Nothing was sent.");
      p.log.warn(error.findings.map((f) => `${f.rule}${f.path ? ` in ${f.path}` : ""}: ${f.preview}`).join("\n"));
      const ok = await p.confirm({ message: "Send a version with the secrets redacted?", initialValue: false });
      if (p.isCancel(ok) || !ok) {
        p.cancel("Nothing sent. Unstage the secret and try again.");
        return "cancel";
      }
      return "redact";
    }
    spin.stop("Failed.");
    throw error;
  }
}

async function pick(result: GenerateResult): Promise<Suggestion | "regenerate" | "cancel"> {
  p.note(
    result.suggestions.map((s, i) => `${i + 1}. ${s.message.replace(/\n/g, "\n   ")}`).join("\n\n"),
    `${result.suggestions.length} suggestion${result.suggestions.length === 1 ? "" : "s"}`,
  );
  const choice = await p.select<Suggestion | "regenerate" | "cancel">({
    message: "Pick a message",
    options: [
      ...result.suggestions.map((s, i) => ({ value: s, label: `${i + 1}. ${s.message.split("\n")[0]}` })),
      { value: "regenerate" as const, label: "Generate new suggestions" },
      { value: "cancel" as const, label: "Cancel" },
    ],
  });
  return p.isCancel(choice) ? "cancel" : choice;
}

function printSuggestions(suggestions: readonly Suggestion[], out: (line?: string) => void) {
  suggestions.forEach((s, i) => {
    if (i > 0) out("\n---\n");
    out(s.message);
  });
}

async function hookCommand(
  root: string,
  sub: string | undefined,
  arg: string | undefined,
  flags: Flags,
  io: Io,
  out: (line?: string) => void,
): Promise<number> {
  if (sub === "install") {
    const { path, backup } = await installHook(root, io.nodePath, io.cliPath, flags.force, io.env);
    out(`Installed ${path}`);
    if (backup) out(`Your previous hook was saved as ${backup}`);
    out("Run `git commit` without -m and gitmit will fill in a suggested message.");
    return 0;
  }
  if (sub === "uninstall") {
    const { path, removed, restored } = await uninstallHook(root, io.env);
    out(removed ? `Removed ${path}` : "No gitmit hook installed.");
    if (restored) out("Restored your previous hook.");
    return 0;
  }
  if (sub === "run") {
    if (!arg) throw new UsageError("hook run needs the commit message file.");
    return hookRun(root, arg, flags, io);
  }
  throw new UsageError("Usage: gitmit hook install | uninstall");
}

/** Called by the git hook. Never fails the commit: problems become a comment in the message file. */
async function hookRun(root: string, file: string, flags: Flags, io: Io): Promise<number> {
  try {
    const { settings, provider, diff } = await prepare(root, flags, io);
    const result = await generate(diff, generateOptions(settings, provider, flags.redact));
    const [first, ...rest] = result.suggestions;
    if (first) await writeHookMessage(file, first.message, rest.map((s) => s.message.split("\n")[0]!));
  } catch (error) {
    const reason =
      error instanceof SecretsDetectedError
        ? "possible secrets in the staged changes, nothing was sent"
        : error instanceof EmptyDiffError || error instanceof UsageError
          ? error.message
          : (error as Error).message;
    await writeHookMessage(file, `# gitmit: no suggestion (${reason})`, []).catch(() => {});
  }
  return 0;
}

const STARTER_CONFIG = {
  $schema: "https://unpkg.com/@gitmit/cli/schema.json",
  types: ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"],
  subjectMaxLength: 72,
  bodyStyle: "bullets",
  language: "en",
};

async function initCommand(root: string, flags: Flags, out: (line?: string) => void): Promise<number> {
  const path = join(root, ".gitmitrc.json");
  try {
    await writeFile(path, `${JSON.stringify(STARTER_CONFIG, null, 2)}\n`, { flag: flags.force ? "w" : "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new UsageError(`${path} already exists. Re-run with --force to overwrite it.`);
    }
    throw error;
  }
  out(`Created ${path}`);
  out("Edit it to match your team's rules. Commit it so everyone shares the same settings.");
  out("API keys never go in this file; they belong in your environment or your user .env file.");
  return 0;
}

async function configCommand(root: string, flags: Flags, io: Io, out: (line?: string) => void): Promise<number> {
  const { settings, provider } = await loadAll(root, flags, io, false);
  const { validate: _v, ...options } = settings.options;
  out(`Provider: ${provider.name}${provider.model ? ` (${provider.model})` : ""}`);
  if (provider.note) out(provider.note);
  out(`Config sources (later wins): ${settings.layers.length ? "" : "none, using defaults"}`);
  for (const layer of settings.layers) out(`  - ${layer.source}`);
  out(`commitlint: ${settings.commitlint ? settings.commitlint.source : settings.config.commitlint === false ? "disabled" : "not found"}`);
  if (settings.config.ticket) {
    out(`Ticket: ${settings.ticket ? `${settings.ticket.id} (${settings.ticket.position})` : "none on this branch"}${settings.branch ? `, branch ${settings.branch}` : ""}`);
  }
  out("Message options:");
  out(JSON.stringify(options, null, 2));
  return 0;
}

/** The --push / --no-push flag wins over the config's "push" setting. */
function shouldPush(flags: Flags, settings: Settings): boolean {
  return flags.push ?? settings.config.push ?? false;
}

/** With --push and nothing staged, push waiting commits instead; undefined when there's nothing to do. */
async function pushIfNothingStaged(root: string, io: Io, err: (line: string) => void): Promise<number | undefined> {
  if ((await stagedDiff(root, io.env)).trim()) return undefined;
  const waiting = await unpushedCount(root, io.env);
  if (waiting === 0) return undefined;
  const what = waiting === undefined ? "this branch" : `${waiting} commit${waiting === 1 ? "" : "s"}`;
  err(`Nothing staged to commit. Pushing ${what}...`);
  const output = await pushCurrentBranch(root, io.env, Boolean(io.stdout.isTTY) && io.stdinIsTTY);
  if (output) err(output);
  return 0;
}

async function loginCommand(io: Io, out: (line?: string) => void): Promise<number> {
  const existing = await readAuth(io.env);
  if (existing) out(`Already signed in as ${existing.login}. Signing in again replaces this session.`);
  const auth = await login(io.env, { out, openBrowser: Boolean(io.stdout.isTTY) && io.stdinIsTTY });
  out(`Signed in as ${auth.login}.`);
  const { keys } = await account(io.env, auth);
  if (keys.length) {
    out(`gitmit will use the ${keys.map((k) => k.provider).join(" and ")} key saved in your account.`);
  } else {
    out("No API key is saved in your account yet. Add one at https://gitmit-frontend.vercel.app/account");
  }
  return 0;
}

async function logoutCommand(io: Io, out: (line?: string) => void): Promise<number> {
  const auth = await logout(io.env);
  out(auth ? `Signed out ${auth.login} on this computer.` : "Not signed in.");
  return 0;
}

async function accountCommand(io: Io, out: (line?: string) => void): Promise<number> {
  const auth = await readAuth(io.env);
  if (!auth) {
    out("Not signed in. Run `gitmit login` to use the API key saved in your gitmit account.");
    return 1;
  }
  const { user, keys, sessions } = await account(io.env, auth);
  out(`Signed in as ${user.login}${user.name ? ` (${user.name})` : ""}`);
  out(keys.length ? "Saved keys:" : "Saved keys: none. Add one at https://gitmit-frontend.vercel.app/account");
  for (const key of keys) out(`  ${key.provider.padEnd(10)} ${key.last4}${key.model ? `  model ${key.model}` : ""}`);
  out(`Signed-in devices: ${sessions.length} (manage them at https://gitmit-frontend.vercel.app/account)`);
  return 0;
}
