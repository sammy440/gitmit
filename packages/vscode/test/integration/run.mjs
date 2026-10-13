// Launches a real VS Code (downloaded into .vscode-test) with the bundled extension, on a throwaway repo.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const here = dirname(fileURLToPath(import.meta.url));
const repo = mkdtempSync(join(tmpdir(), "gitmit-e2e-"));
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (...args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });
const write = (path, content) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
};

git("init", "-q", "-b", "main");
write("README.md", "# demo\n");
write("package.json", '{ "name": "demo", "version": "1.0.0" }\n');
git("add", "-A");
git("commit", "-qm", "chore: init");
git("checkout", "-q", "-b", "feat/ABC-1-login");
// A TypeScript gitmit config importing @gitmit/cli (not installed in this repo), and a commitlint config.
write(
  "gitmit.config.ts",
  'import { defineConfig } from "@gitmit/cli";\nexport default defineConfig({ provider: "rules", bodyStyle: "none", ticket: { position: "suffix" } });\n',
);
write(".commitlintrc.json", JSON.stringify({ rules: { "type-enum": [2, "always", ["feat", "fix", "chore", "docs"]], "header-max-length": [2, "always", 60] } }));
git("add", "-A");
git("commit", "-qm", "chore: add configs");
write("src/auth/login.ts", "export function login() {}\n");
write("package.json", '{ "name": "demo", "version": "1.1.0" }\n');
write("docs/guide.md", "# Guide\n");
git("add", "-A");

// When launched from a terminal inside VS Code, this makes Electron behave like plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

try {
  await runTests({
    extensionDevelopmentPath: resolve(here, "../.."),
    extensionTestsPath: resolve(here, "suite.cjs"),
    launchArgs: [repo, "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes"],
    extensionTestsEnv: { GITMIT_E2E_REPO: repo },
  });
} finally {
  rmSync(repo, { recursive: true, force: true });
}
