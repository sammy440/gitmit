import type { GenerateOptions, Ticket } from "@gitmit/core";
import { loadCommitlint, type CommitlintSettings } from "./commitlint.js";
import { ConfigError, DEFAULT_TICKET_PATTERN, resolveConfig, type Config, type ConfigLayer } from "./config.js";
import { UsageError } from "./provider.js";
import { currentBranch, ticketFromBranch } from "./ticket.js";

export type MessageSettings = Omit<GenerateOptions, "provider" | "signal" | "secrets">;

export interface Settings {
  config: Config;
  layers: ConfigLayer[];
  commitlint?: CommitlintSettings;
  branch?: string;
  ticket?: Ticket;
  /** Options passed to generate(), with commitlint rules applied. */
  options: MessageSettings;
  /** Things worth telling the user, e.g. which rules are in effect. */
  notes: string[];
}

/**
 * Everything that shapes a message: config layers, the repository's
 * commitlint rules (which win where they are stricter) and the branch ticket.
 */
export async function loadSettings(
  root: string,
  env: NodeJS.ProcessEnv,
  options: { explicit?: string; overrides?: Config; requireTicket?: boolean } = {},
): Promise<Settings> {
  const { config, layers } = await resolveConfig(root, env, options);
  const notes: string[] = [];

  let commitlint: CommitlintSettings | undefined;
  if (config.commitlint !== false) {
    try {
      commitlint = await loadCommitlint(root);
    } catch (error) {
      throw new ConfigError((error as Error).message);
    }
  }

  const { provider: _p, model: _m, secrets: _s, ticket: ticketConfig, commitlint: _c, $schema: _x, ...rest } = config;
  const message: MessageSettings = { ...rest };

  if (commitlint) {
    notes.push(`Following commitlint rules from ${commitlint.source}.`);
    message.validate = commitlint.validate;
    if (commitlint.types) {
      const both = config.types?.filter((t) => commitlint!.types!.includes(t));
      message.types = both?.length ? both : commitlint.types;
    }
    if (commitlint.scopes) {
      const both = config.scopes?.filter((s) => commitlint!.scopes!.includes(s));
      message.scopes = both?.length ? both : commitlint.scopes;
    }
    if (commitlint.subjectMaxLength) {
      message.subjectMaxLength = Math.min(commitlint.subjectMaxLength, config.subjectMaxLength ?? Infinity);
    }
    if (commitlint.bodyLineLength) {
      message.bodyLineLength = Math.min(commitlint.bodyLineLength, config.bodyLineLength ?? Infinity);
    }
  }

  const settings: Settings = { config, layers, options: message, notes };
  if (commitlint) settings.commitlint = commitlint;

  if (ticketConfig) {
    const branch = await currentBranch(root, env);
    if (branch) settings.branch = branch;
    const id = ticketFromBranch(branch, ticketConfig.fromBranch ?? DEFAULT_TICKET_PATTERN);
    if (id) {
      settings.ticket = { id, position: ticketConfig.position ?? "suffix" };
      message.ticket = settings.ticket;
    } else if (ticketConfig.required && options.requireTicket !== false) {
      throw new UsageError(
        `A ticket ID is required, but the branch ${branch ? `"${branch}"` : "(detached HEAD)"} has none. Rename the branch to include one, e.g. feat/PROJ-123-short-name.`,
      );
    }
  }

  return settings;
}
