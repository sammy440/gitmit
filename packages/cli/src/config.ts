import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_NAMES, type ProviderName } from "@gitmit/core";
import { z } from "zod";
import { userConfigDir } from "./env.js";

const TYPE_NAME = z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase letters, digits and dashes");

export const ConfigSchema = z.strictObject({
  $schema: z.string().optional().describe("JSON schema for editor autocomplete."),
  provider: z
    .enum(PROVIDER_NAMES as [ProviderName, ...ProviderName[]])
    .optional()
    .describe("Where suggestions come from. Default: the first provider with an API key, else rules."),
  model: z.string().optional().describe("Model name for the provider."),
  types: z.array(TYPE_NAME).nonempty().optional().describe("Allowed commit types."),
  scopes: z.array(z.string()).optional().describe("Allowed scopes. Omit to allow any."),
  scopeFromPaths: z
    .record(z.string(), z.string())
    .optional()
    .describe('Glob to scope mapping, e.g. { "apps/web/**": "web" }. The first match wins.'),
  ticket: z
    .strictObject({
      fromBranch: z
        .string()
        .optional()
        .describe('Regex with one capture group for the ticket ID. Default: "([A-Z][A-Z0-9]+-\\\\d+)".'),
      position: z.enum(["prefix", "suffix", "footer"]).optional().describe("Where the ticket goes. Default: suffix."),
      required: z.boolean().optional().describe("Refuse to commit when the branch has no ticket ID."),
    })
    .optional()
    .describe("Add a ticket ID from the branch name, e.g. PROJ-123 from feat/PROJ-123-login."),
  subjectMaxLength: z.number().int().min(20).max(200).optional().describe("Maximum header length. Default: 72."),
  bodyStyle: z.enum(["none", "prose", "bullets"]).optional().describe("Body format. Default: bullets."),
  bodyLineLength: z.number().int().min(40).max(200).optional().describe("Wrap body lines at this width. Default: 72."),
  language: z.string().optional().describe('Language for messages, e.g. "en". Default: en.'),
  ignore: z.array(z.string()).optional().describe("Extra globs to treat as noise."),
  secrets: z
    .strictObject({ onDetect: z.enum(["abort", "redact"]) })
    .optional()
    .describe("What to do when a secret is found before calling a remote provider. Default: abort."),
  variants: z.number().int().min(1).max(5).optional().describe("Number of suggestions. Default: 3."),
  commitlint: z
    .boolean()
    .optional()
    .describe("Use the repository's commitlint config when present. Default: true."),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Typed helper for gitmit.config.ts. */
export function defineConfig(config: Config): Config {
  return config;
}

export const DEFAULT_TICKET_PATTERN = "([A-Z][A-Z0-9]+-\\d+)";

/** Project config files, in priority order. */
export const PROJECT_CONFIG_FILES = [
  "gitmit.config.ts",
  "gitmit.config.mts",
  "gitmit.config.cts",
  "gitmit.config.js",
  "gitmit.config.mjs",
  "gitmit.config.cjs",
  ".gitmitrc.json",
  ".gitmitrc",
];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface ConfigLayer {
  source: string;
  config: Config;
}

export interface ResolvedConfig {
  config: Config;
  /** Layers that contributed, lowest priority first. */
  layers: ConfigLayer[];
}

/**
 * Resolve config: user config, then project config (or `explicit`), then
 * `overrides` from flags. Later layers win; `ticket` is merged field by field.
 */
export async function resolveConfig(
  root: string,
  env: NodeJS.ProcessEnv,
  options: { explicit?: string; overrides?: Config } = {},
): Promise<ResolvedConfig> {
  const layers: ConfigLayer[] = [];

  const userFile = join(userConfigDir(env), "config.json");
  const user = await readConfigFile(userFile, false);
  if (user) layers.push({ source: userFile, config: user });

  const project = options.explicit
    ? { source: resolve(options.explicit), config: (await readConfigFile(resolve(options.explicit), true))! }
    : await findProjectConfig(root);
  if (project) layers.push(project);

  const overrides = Object.fromEntries(Object.entries(options.overrides ?? {}).filter(([, v]) => v !== undefined));
  if (Object.keys(overrides).length) layers.push({ source: "command-line flags", config: overrides });

  const config: Config = {};
  for (const layer of layers) {
    const { ticket, ...rest } = layer.config;
    Object.assign(config, rest);
    if (ticket) config.ticket = { ...config.ticket, ...ticket };
  }
  delete config.$schema;
  return { config, layers };
}

async function findProjectConfig(root: string): Promise<ConfigLayer | undefined> {
  for (const name of PROJECT_CONFIG_FILES) {
    const path = join(root, name);
    const config = await readConfigFile(path, false);
    if (config) return { source: path, config };
  }
  const pkg = await readFile(join(root, "package.json"), "utf8").catch(() => undefined);
  if (pkg) {
    let data: { gitmit?: unknown };
    try {
      data = JSON.parse(pkg) as { gitmit?: unknown };
    } catch {
      return undefined;
    }
    if (data.gitmit !== undefined) {
      const source = `${join(root, "package.json")} ("gitmit" key)`;
      return { source, config: validate(data.gitmit, source) };
    }
  }
  return undefined;
}

async function readConfigFile(path: string, required: boolean): Promise<Config | undefined> {
  const isCode = /\.(?:[cm]?ts|[cm]?js)$/.test(path);
  if (!isCode) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      if (required) throw new ConfigError(`Config file not found: ${path}`);
      return undefined;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
    }
    return validate(data, path);
  }

  try {
    await readFile(path);
  } catch {
    if (required) throw new ConfigError(`Config file not found: ${path}`);
    return undefined;
  }
  let data: unknown;
  try {
    const { createJiti } = await import("jiti");
    // Resolve `import { defineConfig } from "@gitmit/cli"` to this copy of gitmit, so config
    // files work even when the repository doesn't install @gitmit/cli itself.
    const self = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./index.ts" : "./index.js", import.meta.url));
    const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: { "@gitmit/cli": self } });
    data = await jiti.import(path, { default: true });
  } catch (error) {
    throw new ConfigError(`Could not load ${path}: ${(error as Error).message}`);
  }
  return validate(data, path);
}

function validate(data: unknown, source: string): Config {
  const parsed = ConfigSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid config in ${source}: ${issues}`);
  }
  return parsed.data;
}
