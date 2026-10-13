import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import lint from "@commitlint/lint";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { headers, TestRepo } from "./harness.js";

let repo: TestRepo;
beforeEach(() => {
  repo = new TestRepo();
});
afterEach(() => repo.cleanup());

describe("config files", () => {
  it("loads gitmit.config.ts with defineConfig, even though the repo doesn't install @gitmit/cli", async () => {
    repo.write(
      "gitmit.config.ts",
      `import { defineConfig } from "@gitmit/cli";
const max: number = 40;
export default defineConfig({ provider: "rules", bodyStyle: "none", subjectMaxLength: max });
`,
    );
    repo.write("docs/guide.md", "# Guide\n");
    repo.git("add", "docs");
    const result = await repo.run(["--dry-run"]);
    expect(result.code, result.stderr).toBe(0);
    for (const header of headers(result.stdout)) expect(header.length).toBeLessThanOrEqual(40);
    expect(result.stdout).not.toMatch(/^- /m);
  });

  it("layers user config under project config, and flags over both", async () => {
    repo.writeUserConfig("config.json", JSON.stringify({ provider: "rules", language: "fr", bodyStyle: "prose" }));
    repo.write(".gitmitrc.json", JSON.stringify({ bodyStyle: "none" }));
    const shown = await repo.run(["config", "--provider", "rules"]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toMatch(/config\.json[\s\S]*\.gitmitrc\.json[\s\S]*command-line flags/);
    expect(shown.stdout).toMatch(/"language": "fr"/);
    expect(shown.stdout).toMatch(/"bodyStyle": "none"/);
  });

  it("reads a \"gitmit\" key in package.json", async () => {
    repo.write("package.json", JSON.stringify({ name: "x", gitmit: { subjectMaxLength: 60 } }));
    const shown = await repo.run(["config"]);
    expect(shown.stdout).toMatch(/package\.json \("gitmit" key\)/);
    expect(shown.stdout).toMatch(/"subjectMaxLength": 60/);
  });

  it("reports errors in a TypeScript config", async () => {
    repo.write("gitmit.config.ts", `export default { variants: 99 };\n`);
    const result = await repo.run(["config"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Invalid config in .*gitmit\.config\.ts: variants/);
  });
});

describe("gitmit init", () => {
  it("creates a starter config and refuses to overwrite without --force", async () => {
    expect((await repo.run(["init"])).code).toBe(0);
    const path = join(repo.dir, ".gitmitrc.json");
    expect(JSON.parse(readFileSync(path, "utf8")).$schema).toMatch(/schema\.json$/);
    expect((await repo.run(["init"])).stderr).toMatch(/already exists.*--force/);
    expect((await repo.run(["init", "--force"])).code).toBe(0);
  });

  it("the starter config passes validation", async () => {
    await repo.run(["init"]);
    expect((await repo.run(["config"])).code).toBe(0);
  });
});

describe("commitlint", () => {
  const RULES = {
    rules: {
      "type-enum": [2, "always", ["feat", "fix", "chore", "wip"]],
      "header-max-length": [2, "always", 50],
      "subject-case": [2, "always", "lower-case"],
      "body-max-line-length": [2, "always", 60],
      "scope-enum": [1, "always", ["ignored-because-warning"]],
    },
  };

  it("adopts the team's types and limits, and every suggestion passes their lint", async () => {
    repo.write(".commitlintrc.json", JSON.stringify(RULES));
    repo.write("docs/guide.md", "# Guide\nMore text here.\n");
    repo.write("docs/other.md", "# Other\n");
    repo.git("add", "docs");

    const shown = await repo.run(["config", "--provider", "rules"]);
    expect(shown.stdout).toMatch(/commitlint: .*\.commitlintrc\.json/);
    expect(shown.stdout).toMatch(/"types": \[\s*"feat",\s*"fix",\s*"chore",\s*"wip"\s*\]/);
    expect(shown.stdout).toMatch(/"subjectMaxLength": 50/);
    expect(shown.stdout).toMatch(/"bodyLineLength": 60/);
    expect(shown.stdout).not.toMatch(/ignored-because-warning/);

    const result = await repo.run(["--dry-run", "--provider", "rules"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/Following commitlint rules/);
    const messages = result.stdout.split("\n---\n").map((m) => m.trim());
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      // docs is not an allowed type here, so the offline rules fall back to chore.
      expect(message).toMatch(/^chore/);
      const outcome = await lint(message, RULES.rules as never);
      expect(outcome.errors, message).toEqual([]);
    }
  });

  it("can be turned off", async () => {
    repo.write(".commitlintrc.json", JSON.stringify(RULES));
    repo.write(".gitmitrc.json", JSON.stringify({ commitlint: false }));
    expect((await repo.run(["config"])).stdout).toMatch(/commitlint: disabled/);
  });

  it("explains a config whose preset is not installed", async () => {
    repo.write(".commitlintrc.json", JSON.stringify({ extends: ["@commitlint/config-not-installed"] }));
    repo.write("a.md", "x\n");
    repo.git("add", "a.md");
    const result = await repo.run(["--dry-run", "--provider", "rules"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Could not load the commitlint config.*"commitlint": false/);
  });
});

describe("tickets from the branch name", () => {
  it("adds the ticket from the branch", async () => {
    repo.git("checkout", "-q", "-b", "feat/PROJ-42-login");
    repo.write(".gitmitrc.json", JSON.stringify({ provider: "rules", ticket: { position: "suffix" } }));
    repo.write("src/auth/login.ts", "export function login() {}\n");
    repo.git("add", "src");
    const result = await repo.run(["--yes"]);
    expect(result.code, result.stderr).toBe(0);
    expect(repo.git("log", "-1", "--format=%s").trim()).toMatch(/^feat\(auth\): .+ \(PROJ-42\)$/);
  });

  it("supports a custom pattern and footer placement", async () => {
    repo.git("checkout", "-q", "-b", "gh-1234/fix-thing");
    repo.write(".gitmitrc.json", JSON.stringify({ provider: "rules", ticket: { fromBranch: "^gh-(\\d+)", position: "footer" } }));
    repo.write("src/auth/login.ts", "export function login() {}\n");
    repo.git("add", "src");
    await repo.run(["--yes"]);
    expect(repo.git("log", "-1", "--format=%B").trim()).toMatch(/\n\nRefs: 1234$/);
  });

  it("refuses to commit when a required ticket is missing, but config still shows settings", async () => {
    repo.write(".gitmitrc.json", JSON.stringify({ provider: "rules", ticket: { required: true } }));
    repo.write("a.md", "x\n");
    repo.git("add", "a.md");
    const result = await repo.run(["--yes"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/ticket ID is required, but the branch "main" has none/);
    const shown = await repo.run(["config"]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toMatch(/Ticket: none on this branch, branch main/);
  });
});

describe("package", () => {
  it.skipIf(!existsSync(join(__dirname, "../schema.json")))("publishes a JSON schema matching the config", () => {
    const schema = JSON.parse(readFileSync(join(__dirname, "../schema.json"), "utf8"));
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(["provider", "types", "ticket", "commitlint", "bodyLineLength"]),
    );
    expect(schema.additionalProperties).toBe(false);
  });
});
