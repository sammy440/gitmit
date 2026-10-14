/** Public API of @gitmit/cli: defineConfig plus the building blocks editor integrations reuse. */
export { defineConfig, ConfigSchema, type Config } from "./config.js";
export { loadSettings, type Settings, type MessageSettings } from "./settings.js";
export { loadEnv, userConfigDir, userEnvFile } from "./env.js";
export { stagedDiff, nothingStagedMessage, repoRoot, GitError } from "./git.js";
export { applySplit, checkSplittable, SplitError, type PlannedCommit } from "./split.js";
export { pushCurrentBranch, PushError } from "./push.js";
export { UsageError } from "./provider.js";
export { ConfigError } from "./config.js";
