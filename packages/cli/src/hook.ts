import { chmod, readFile, rename, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hooksDir } from "./git.js";
import { UsageError } from "./provider.js";

export const HOOK_NAME = "prepare-commit-msg";
const MARKER = "# Installed by gitmit";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Fills in a message only for a plain `git commit`, and never blocks the commit. */
export function hookScript(nodePath: string, cliPath: string): string {
  return `#!/bin/sh
${MARKER} (gitmit hook install). Remove with: gitmit hook uninstall
# Suggests a commit message when you run \`git commit\` without -m.
case "$2" in
  "") ;;
  *) exit 0 ;;
esac
if command -v gitmit >/dev/null 2>&1; then
  gitmit hook run "$1" </dev/null || true
elif [ -f ${shellQuote(cliPath)} ]; then
  ${shellQuote(nodePath)} ${shellQuote(cliPath)} hook run "$1" </dev/null || true
fi
exit 0
`;
}

export async function installHook(root: string, nodePath: string, cliPath: string, force: boolean, env?: NodeJS.ProcessEnv) {
  const dir = await hooksDir(root, env);
  const path = join(dir, HOOK_NAME);
  const existing = await readFile(path, "utf8").catch(() => undefined);
  let backup: string | undefined;
  if (existing !== undefined && !existing.includes(MARKER)) {
    if (!force) {
      throw new UsageError(`${path} already exists and was not installed by gitmit. Re-run with --force to replace it (a backup is kept).`);
    }
    backup = `${path}.gitmit-backup`;
    await rename(path, backup);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(path, hookScript(nodePath, cliPath));
  await chmod(path, 0o755);
  return { path, backup };
}

export async function uninstallHook(root: string, env?: NodeJS.ProcessEnv) {
  const path = join(await hooksDir(root, env), HOOK_NAME);
  const existing = await readFile(path, "utf8").catch(() => undefined);
  if (existing === undefined) return { path, removed: false, restored: false };
  if (!existing.includes(MARKER)) throw new UsageError(`${path} was not installed by gitmit; leaving it alone.`);
  await rm(path);
  const backup = `${path}.gitmit-backup`;
  const restored = await rename(backup, path).then(
    () => true,
    () => false,
  );
  return { path, removed: true, restored };
}

/** Put the message above whatever git already wrote (its instructions and status, as comments). */
export async function writeHookMessage(file: string, message: string, alternatives: readonly string[]) {
  const existing = await readFile(file, "utf8").catch(() => "");
  const extra = alternatives.length
    ? `# gitmit alternatives:\n${alternatives.map((a) => `#   ${a}`).join("\n")}\n`
    : "";
  await writeFile(file, `${message}\n${extra}${existing.startsWith("\n") ? "" : "\n"}${existing}`);
}
