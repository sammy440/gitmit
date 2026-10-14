import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { generatePr, NoCommitsError } from "../src/pr.js";
import { modelProvider, rulesProvider } from "../src/providers/index.js";

const FIXTURES = join(__dirname, "../../../fixtures");
const DIFF = readFileSync(join(FIXTURES, "feat-login-form", "input.diff"), "utf8");
const COMMITS = [
  { sha: "a1", subject: "feat(web): add login form component", body: "Email field and submit button." },
  { sha: "b2", subject: "feat(web): wire login form into the app", body: "" },
];

function model(answers: { title: string; body: string }[]) {
  const prompts: string[] = [];
  let i = 0;
  const complete = vi.fn(async (prompt: { user: string }) => {
    prompts.push(prompt.user);
    return answers[Math.min(i++, answers.length - 1)];
  });
  return { provider: modelProvider("fake", true, complete), complete, prompts };
}

describe("generatePr", () => {
  it("needs at least one commit", async () => {
    await expect(generatePr(DIFF, { provider: rulesProvider(), commits: [], base: "main" })).rejects.toBeInstanceOf(NoCommitsError);
  });

  it("offline: uses a single conventional commit's subject and lists the commits", async () => {
    const pr = await generatePr(DIFF, { provider: rulesProvider(), commits: [COMMITS[0]!] });
    expect(pr.source).toBe("rules");
    expect(pr.title).toBe("feat(web): add login form component");
    expect(pr.body).toMatch(/## Summary\n\n1 commit changing 2 files/);
    expect(pr.body).toMatch(/## Changes\n\n- feat\(web\): add login form component/);
    expect(pr.body).toMatch(/## How to test/);
  });

  it("offline: builds a title from the overall change for several commits", async () => {
    const pr = await generatePr(DIFF, { provider: rulesProvider(), commits: COMMITS });
    expect(pr.title).toMatch(/^feat\(web\): /);
    expect(pr.body).toContain("- feat(web): wire login form into the app");
  });

  it("asks the model with the commits, template and summary, and tidies the answer", async () => {
    const { provider, prompts } = model([
      { title: "feat(web): Add a login form.", body: "# feat(web): add a login form\n\n## Summary\n\nAdds a login form." },
    ]);
    const pr = await generatePr(DIFF, {
      provider,
      commits: COMMITS,
      branch: "feat/login",
      base: "main",
      template: "## What\n<!-- describe -->\n## Checklist\n- [ ] Tests",
    });
    expect(pr.source).toBe("model");
    expect(pr.title).toBe("feat(web): add a login form");
    expect(pr.body).toBe("## Summary\n\nAdds a login form.");
    expect(prompts[0]).toMatch(/Branch: feat\/login, into main/);
    expect(prompts[0]).toMatch(/<commits>\n- feat\(web\): add login form component\n  Email field and submit button\.\n- feat\(web\): wire login form into the app\n<\/commits>/);
    expect(prompts[0]).toMatch(/<template>\n## What/);
    expect(prompts[0]).toMatch(/<diff_summary>[\s\S]*LoginForm[\s\S]*<\/diff_summary>$/);
  });

  it("regenerates with feedback when the title breaks the rules, then gives up", async () => {
    const bad = { title: "Added login stuff", body: "## Summary\n\nx" };
    const good = { title: "feat(web): add login form", body: "## Summary\n\nx" };
    const { provider, prompts } = model([bad, good]);
    const pr = await generatePr(DIFF, { provider, commits: COMMITS });
    expect(pr.title).toBe("feat(web): add login form");
    expect(prompts[1]).toMatch(/rejected: the title "Added login stuff" is not in type\(scope\): description form/);

    const always = model([{ title: "wip: login", body: "x" }]);
    await expect(generatePr(DIFF, { provider: always.provider, commits: COMMITS, types: ["feat", "fix"] })).rejects.toThrow(/no valid pull request description after 3 attempts.*title type "wip"/);
    expect(always.complete).toHaveBeenCalledTimes(3);
  });

  it("applies the team's title rules: length, ticket and commitlint", async () => {
    const { provider, prompts } = model([
      { title: "feat(web): add login form", body: "ok" },
      { title: "feat(web): add login form", body: "ok" },
    ]);
    const validateTitle = vi.fn(async (title: string) => (prompts.length < 2 ? [`header "${title}" fails rule X [x]`] : []));
    const pr = await generatePr(DIFF, {
      provider,
      commits: COMMITS,
      subjectMaxLength: 50,
      ticket: { id: "PROJ-9", position: "suffix" },
      validateTitle,
    });
    expect(pr.title).toBe("feat(web): add login form (PROJ-9)");
    expect(prompts[0]).toMatch(/Title length: at most 41 characters/);
    expect(prompts[1]).toMatch(/fails rule X/);
  });

  it("never sends a secret from a commit message to a remote model", async () => {
    const secret = "ghp_" + "z".repeat(36);
    const commits = [{ sha: "c", subject: "fix: rotate token", body: `old token was ${secret}` }];
    const { provider, complete, prompts } = model([{ title: "fix(web): rotate token", body: "x" }]);
    await expect(generatePr(DIFF, { provider, commits })).rejects.toThrow(/Possible secrets/);
    expect(complete).not.toHaveBeenCalled();
    const pr = await generatePr(DIFF, { provider, commits, secrets: { onDetect: "redact" } });
    expect(pr.redacted).toBe(true);
    expect(prompts.join("\n")).not.toContain(secret);
  });
});
