import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

/** Where users keep their API keys: outside every repository. */
export function userConfigDir(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_CONFIG_HOME || (process.platform === "win32" && env.APPDATA) || join(homedir(), ".config");
  return join(base, "gitmit");
}

export function userEnvFile(env: NodeJS.ProcessEnv): string {
  return join(userConfigDir(env), ".env");
}

/** The environment plus keys from the user's gitmit .env file; real environment variables win. */
export function loadEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let fromFile: Record<string, string> = {};
  try {
    fromFile = parseEnv(readFileSync(userEnvFile(env), "utf8")) as Record<string, string>;
  } catch {
    // No file: environment variables only.
  }
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(fromFile)) {
    if (merged[key] === undefined || merged[key] === "") merged[key] = value;
  }
  return merged;
}
