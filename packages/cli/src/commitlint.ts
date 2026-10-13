import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { MessageValidator } from "@gitmit/core";

/** File names commitlint looks for (cosmiconfig search places). */
const COMMITLINT_FILE = /^(?:\.commitlintrc(?:\.(?:json|ya?ml|[cm]?js|[cm]?ts))?|commitlint\.config\.[cm]?[jt]s)$/;

/** Severity 2 = error. Warnings and disabled rules don't constrain suggestions. */
const ERROR = 2;

export interface CommitlintSettings {
  /** Where the config was found. */
  source: string;
  /** From type-enum. */
  types?: string[];
  /** From scope-enum. */
  scopes?: string[];
  /** From header-max-length. */
  subjectMaxLength?: number;
  /** From body-max-line-length. */
  bodyLineLength?: number;
  /** Lints a full message against the repository's rules. */
  validate: MessageValidator;
}

/** Cheap check before loading commitlint: a config file or a "commitlint" key in package.json. */
export async function findCommitlintConfig(root: string): Promise<string | undefined> {
  const names = await readdir(root).catch(() => [] as string[]);
  const file = names.find((name) => COMMITLINT_FILE.test(name));
  if (file) return join(root, file);
  const pkg = await readFile(join(root, "package.json"), "utf8").catch(() => undefined);
  try {
    if (pkg && (JSON.parse(pkg) as { commitlint?: unknown }).commitlint !== undefined) {
      return `${join(root, "package.json")} ("commitlint" key)`;
    }
  } catch {
    // Invalid package.json: no commitlint config.
  }
  return undefined;
}

type Rule = readonly [number, string?, unknown?] | undefined;

/**
 * Load the repository's commitlint config with commitlint itself, so presets
 * (extends), plugins and parser options behave exactly as in the team's
 * commit-msg hook. Returns undefined when the repo has no commitlint config.
 */
export async function loadCommitlint(root: string): Promise<CommitlintSettings | undefined> {
  const source = await findCommitlintConfig(root);
  if (!source) return undefined;

  const [{ default: load }, { default: lint }] = await Promise.all([
    import("@commitlint/load"),
    import("@commitlint/lint"),
  ]);
  let config;
  try {
    config = await load({}, { cwd: root });
  } catch (error) {
    throw new Error(
      `Could not load the commitlint config (${source}): ${(error as Error).message}. Install the repository's dependencies, or set "commitlint": false in the gitmit config.`,
    );
  }

  const rules = config.rules as Record<string, Rule>;
  const settings: CommitlintSettings = {
    source,
    validate: async (message) => {
      const outcome = await lint(message, config.rules, {
        parserOpts: config.parserPreset?.parserOpts as never,
        plugins: config.plugins,
        ignores: config.ignores,
        defaultIgnores: config.defaultIgnores,
      });
      return outcome.errors.map((e) => `${e.message} [${e.name}]`);
    },
  };

  const typeEnum = enforced(rules["type-enum"], "always");
  if (Array.isArray(typeEnum) && typeEnum.length) settings.types = typeEnum.map(String);
  const scopeEnum = enforced(rules["scope-enum"], "always");
  if (Array.isArray(scopeEnum) && scopeEnum.length) settings.scopes = scopeEnum.map(String);
  const header = enforced(rules["header-max-length"], "always");
  if (typeof header === "number") settings.subjectMaxLength = header;
  const bodyLine = enforced(rules["body-max-line-length"], "always");
  if (typeof bodyLine === "number" && Number.isFinite(bodyLine)) settings.bodyLineLength = bodyLine;
  return settings;
}

/** The rule's value when it is an error-level rule with the given condition. */
function enforced(rule: Rule, when: "always" | "never"): unknown {
  if (!rule || rule[0] !== ERROR || (rule[1] ?? "always") !== when) return undefined;
  return rule[2];
}
