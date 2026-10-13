import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_TYPES, PROVIDER_NAMES, type CommitType, type ProviderName } from "@gitmit/core";
import { z } from "zod";

/** Project settings. Phase 4 extends this (gitmit.config.ts, user config, commitlint). */
const ConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  provider: z.enum(PROVIDER_NAMES as [ProviderName, ...ProviderName[]]).optional(),
  model: z.string().optional(),
  types: z.array(z.enum(DEFAULT_TYPES as [CommitType, ...CommitType[]])).nonempty().optional(),
  scopes: z.array(z.string()).optional(),
  scopeFromPaths: z.record(z.string(), z.string()).optional(),
  subjectMaxLength: z.number().int().min(20).max(200).optional(),
  bodyStyle: z.enum(["none", "prose", "bullets"]).optional(),
  language: z.string().optional(),
  ignore: z.array(z.string()).optional(),
  secrets: z.strictObject({ onDetect: z.enum(["abort", "redact"]) }).optional(),
  variants: z.number().int().min(1).max(5).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

const CONFIG_FILES = [".gitmitrc.json", ".gitmitrc"];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Load `explicit` if given, otherwise the first config file found in the repository root. */
export async function loadConfig(root: string, explicit?: string): Promise<{ config: Config; path?: string }> {
  const candidates = explicit ? [resolve(explicit)] : CONFIG_FILES.map((name) => join(root, name));
  for (const path of candidates) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      if (explicit) throw new ConfigError(`Config file not found: ${path}`);
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
    }
    const parsed = ConfigSchema.safeParse(data);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      throw new ConfigError(`Invalid config in ${path}: ${issues}`);
    }
    return { config: parsed.data, path };
  }
  return { config: {} };
}
