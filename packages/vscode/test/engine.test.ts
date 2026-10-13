import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stagedDiff } from "@gitmit/cli";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateMessages, messageFor, MissingKeyError, planCommits, prepare, providerLabel, type ExtensionSettings } from "../src/engine";

let dir: string;
let home: string;

const AUTO: ExtensionSettings = { provider: "auto", model: "", ollamaHost: "", configPath: "" };

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    ...extra,
  };
}
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: env(), encoding: "utf8" });
const write = (path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gitmit-vsc-home-"));
  dir = mkdtempSync(join(tmpdir(), "gitmit-vsc-"));
  writeFileSync(join(home, "gitconfig"), "");
  git("init", "-q", "-b", "main");
  write("README.md", "# demo\n");
  git("add", "-A");
  git("commit", "-qm", "chore: init");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("prepare: choosing the provider", () => {
  it("falls back to offline rules with a note when no key is set", async () => {
    const prepared = await prepare(dir, {}, AUTO, env());
    expect(prepared.providerName).toBe("rules");
    expect(prepared.note).toMatch(/Set API Key/);
  });

  it("prefers a key from VS Code's secret storage", async () => {
    const prepared = await prepare(dir, { anthropic: "sk-ant-x" }, AUTO, env({ OPENAI_API_KEY: "" }));
    expect(providerLabel(prepared)).toBe("anthropic");
    expect(prepared.provider.remote).toBe(true);
  });

  it("also finds keys where the CLI does (~/.config/gitmit/.env)", async () => {
    mkdirSync(join(home, ".config", "gitmit"), { recursive: true });
    writeFileSync(join(home, ".config", "gitmit", ".env"), "OPENAI_API_KEY=sk-file\nOPENAI_MODEL=gpt-test\n");
    const prepared = await prepare(dir, {}, AUTO, env());
    expect(providerLabel(prepared)).toBe("openai (gpt-test)");
  });

  it("explains a missing key when a provider is chosen explicitly", async () => {
    await expect(prepare(dir, {}, { ...AUTO, provider: "openai" }, env())).rejects.toBeInstanceOf(MissingKeyError);
  });

  it("lets the extension setting override the project config, like a CLI flag", async () => {
    write(".gitmitrc.json", JSON.stringify({ provider: "openai" }));
    const prepared = await prepare(dir, {}, { ...AUTO, provider: "rules" }, env());
    expect(prepared.providerName).toBe("rules");
    expect(prepared.note).toBeUndefined();
  });

  it("uses the project config, commitlint and ticket settings", async () => {
    git("checkout", "-q", "-b", "feat/ABC-7-login");
    write(".gitmitrc.json", JSON.stringify({ provider: "rules", ticket: { position: "suffix" } }));
    write(".commitlintrc.json", JSON.stringify({ rules: { "header-max-length": [2, "always", 60] } }));
    const prepared = await prepare(dir, {}, AUTO, env());
    expect(prepared.settings.ticket).toEqual({ id: "ABC-7", position: "suffix" });
    expect(prepared.settings.options.subjectMaxLength).toBe(60);
  });

  it("points Ollama at the configured host", async () => {
    const local = await prepare(dir, {}, { ...AUTO, provider: "ollama" }, env());
    expect(local.provider.remote).toBe(false);
    const remote = await prepare(dir, {}, { ...AUTO, provider: "ollama", ollamaHost: "http://gpu.lan:11434" }, env());
    expect(remote.provider.remote).toBe(true);
  });

  it("reads a config file from the configPath setting", async () => {
    write("config/gitmit.json", JSON.stringify({ provider: "rules", bodyStyle: "none" }));
    const prepared = await prepare(dir, {}, { ...AUTO, configPath: "config/gitmit.json" }, env());
    expect(prepared.settings.options.bodyStyle).toBe("none");
  });
});

describe("generating", () => {
  it("writes messages for the staged diff, with the branch ticket", async () => {
    git("checkout", "-q", "-b", "feat/ABC-7-login");
    write(".gitmitrc.json", JSON.stringify({ provider: "rules", ticket: { position: "suffix" } }));
    write("src/auth/login.ts", "export function login() {}\n");
    git("add", "src");
    const prepared = await prepare(dir, {}, AUTO, env());
    const result = await generateMessages(await stagedDiff(dir, env()), prepared, false);
    expect(result.suggestions[0]!.message).toMatch(/^feat\(auth\): .+ \(ABC-7\)/);
  });

  it("plans a split with a message per commit, and rewrites one after a move", async () => {
    write("package.json", '{ "version": "1.0.0" }\n');
    write("src/auth/login.ts", "export function login() {}\n");
    write("docs/guide.md", "# Guide\n");
    git("add", "-A");
    const prepared = await prepare(dir, {}, { ...AUTO, provider: "rules" }, env());
    const plan = await planCommits(await stagedDiff(dir, env(), { binary: true }), prepared, false);
    expect(plan.commits.map((c) => c.message.split("\n")[0]!.split(":")[0])).toEqual(["chore", "feat(auth)", "docs"]);

    const docs = plan.commits[2]!.units;
    const merged = await messageFor(plan.diff, [...plan.commits[1]!.units, ...docs], prepared, false);
    // The merged commit spans auth and docs, so gitmit leaves the scope out rather than guess.
    expect(merged).toMatch(/^feat: add `login`/);
  });
});
