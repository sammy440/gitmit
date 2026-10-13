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
import { ConfigError, loadConfig, type Config } from "./config.js";
import { loadEnv, userEnvFile } from "./env.js";
import { commit, GitError, repoRoot, stagedDiff } from "./git.js";
import { installHook, uninstallHook, writeHookMessage } from "./hook.js";
import { resolveProvider, UsageError, type ResolvedProvider } from "./provider.js";

export const VERSION = "0.0.0";

const HELP = `gitmit: commit messages from your staged changes

Usage:
  gitmit [options]               Suggest messages for staged changes and commit
  gitmit hook install [--force]  Fill in a suggestion whenever you run \`git commit\`
  gitmit hook uninstall          Remove the hook

Options:
  --dry-run              Show suggestions without committing
  -y, --yes              Commit the top suggestion without asking
  --provider <name>      openai, anthropic, ollama or rules (offline)
  --model <name>         Model for the provider
  --config <path>        Config file (default: .gitmitrc.json in the repo root)
  --redact               Redact secrets instead of stopping when one is found
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
  };

  try {
    const root = await repoRoot(io.cwd, io.env);
    if (!root) throw new UsageError("Not inside a git repository.");

    const [command, sub, arg] = positionals;
    if (command === "hook") return await hookCommand(root, sub, arg, flags, io, out);
    if (command !== undefined) throw new UsageError(`Unknown command "${command}". Run gitmit --help for usage.`);
    return await commitCommand(root, flags, io, out, err);
  } catch (error) {
    if (error instanceof UsageError || error instanceof ConfigError || error instanceof GitError) {
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

async function prepare(root: string, flags: Flags, io: Io) {
  const { config } = await loadConfig(root, flags.config);
  const env = loadEnv(io.env);
  const provider = resolveProvider(env, flags.provider ?? config.provider, flags.model ?? config.model);
  const diff = await stagedDiff(root, io.env);
  if (!diff.trim()) throw new UsageError("No staged changes. Stage files with `git add` first.");
  return { config, provider, diff };
}

function generateOptions(config: Config, provider: ResolvedProvider, redact: boolean) {
  const { provider: _name, model: _model, secrets, ...rest } = config;
  return {
    ...rest,
    provider: provider.provider,
    secrets: { onDetect: redact ? ("redact" as const) : (secrets?.onDetect ?? "abort") },
  };
}

async function commitCommand(
  root: string,
  flags: Flags,
  io: Io,
  out: (line?: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const { config, provider, diff } = await prepare(root, flags, io);
  const interactive = Boolean(io.stdout.isTTY) && io.stdinIsTTY && !flags.yes && !flags.dryRun;
  const label = `${provider.name}${provider.model ? ` (${provider.model})` : ""}`;

  if (!interactive) {
    if (provider.note) err(provider.note);
    const result = await generate(diff, generateOptions(config, provider, flags.redact));
    if (result.redacted) err(`Redacted ${result.secrets.length} possible secret(s) before sending.`);
    if (flags.yes && !flags.dryRun) {
      const code = await commit(root, result.suggestions[0]!.message, { env: io.env });
      return code;
    }
    printSuggestions(result.suggestions, out);
    if (!flags.dryRun) err("Not a terminal, so nothing was committed. Use --yes to commit the first suggestion.");
    return 0;
  }

  p.intro("gitmit");
  if (provider.note) p.log.info(provider.note);

  let redact = flags.redact;
  while (true) {
    const result = await runWithSpinner(diff, config, provider, redact, label);
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
    return commit(root, choice.message, { edit: action === "edit", env: io.env });
  }
}

async function runWithSpinner(
  diff: string,
  config: Config,
  provider: ResolvedProvider,
  redact: boolean,
  label: string,
): Promise<GenerateResult | "redact" | "cancel"> {
  const spin = p.spinner();
  spin.start(`Writing suggestions with ${label}`);
  try {
    const result = await generate(diff, generateOptions(config, provider, redact));
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
    const { config, provider, diff } = await prepare(root, flags, io);
    const result = await generate(diff, generateOptions(config, provider, flags.redact));
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
