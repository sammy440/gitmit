/**
 * Public API of @gitmit/cli.
 *
 * - `defineConfig` and `Config` for gitmit.config.ts files.
 * - The building blocks the CLI is made of, for editor integrations that
 *   should behave exactly like the `gitmit` command.
 */
export { defineConfig, ConfigSchema, type Config } from "./config.js";
export { loadSettings, type Settings, type MessageSettings } from "./settings.js";
export { loadEnv, userConfigDir, userEnvFile } from "./env.js";
export { stagedDiff, nothingStagedMessage, repoRoot, GitError } from "./git.js";
export { applySplit, checkSplittable, SplitError, type PlannedCommit } from "./split.js";
export { pushCurrentBranch, PushError } from "./push.js";
export { UsageError } from "./provider.js";
export { ConfigError } from "./config.js";
