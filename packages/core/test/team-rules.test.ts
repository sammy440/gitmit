import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { generate } from "../src/generate.js";
import { modelProvider, rulesProvider } from "../src/providers/index.js";
import type { Draft } from "../src/message.js";

const FIXTURES = join(__dirname, "../../../fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES, name, "input.diff"), "utf8");

const draft = (description: string, type = "feat"): Draft => ({
  suggestions: [{ type, scope: null, description, body: "- details" }],
});

describe("tickets", () => {
  it.each([
    ["suffix", /^feat\(web\): add login form \(PROJ-7\)$/m, false],
    ["prefix", /^feat\(web\): PROJ-7 add login form$/m, false],
    ["footer", /^feat\(web\): add login form$/m, true],
  ] as const)("places the ticket as a %s", async (position, header, footer) => {
    const provider = modelProvider("fake", true, async () => draft("add login form"));
    const { suggestions } = await generate(fixture("feat-login-form"), { provider, ticket: { id: "PROJ-7", position } });
    expect(suggestions[0]!.message).toMatch(header);
    expect(suggestions[0]!.message.endsWith("\n\nRefs: PROJ-7")).toBe(footer);
  });

  it("does not add the ticket twice", async () => {
    const provider = modelProvider("fake", true, async () => draft("add login form for PROJ-7"));
    const { suggestions } = await generate(fixture("feat-login-form"), { provider, ticket: { id: "PROJ-7", position: "suffix" } });
    expect(suggestions[0]!.message.split("\n")[0]).toBe("feat(web): add login form for PROJ-7");
  });

  it("counts the ticket in the header limit and tells the model the remaining budget", async () => {
    const prompts: string[] = [];
    const provider = modelProvider("fake", true, async (prompt) => {
      prompts.push(prompt.user);
      return draft("a".repeat(40));
    });
    await expect(
      generate(fixture("feat-login-form"), { provider, subjectMaxLength: 50, ticket: { id: "PROJ-1234", position: "suffix" } }),
    ).rejects.toThrow(/header is \d+ characters, limit is 50/);
    expect(prompts[0]).toMatch(/at most 38 characters/);
    expect(prompts[0]).toMatch(/Do not mention the ticket PROJ-1234/);
  });
});

describe("custom types and external validation", () => {
  it("accepts team-specific types", async () => {
    const provider = modelProvider("fake", true, async () => draft("save progress", "wip"));
    const { suggestions } = await generate(fixture("fix-null-guard"), { provider, types: ["feat", "fix", "wip"] });
    expect(suggestions[0]!.type).toBe("wip");
  });

  it("regenerates when the external validator rejects, passing its problems back", async () => {
    const prompts: string[] = [];
    const complete = vi.fn(async (prompt: { user: string }) => {
      prompts.push(prompt.user);
      return draft(prompts.length === 1 ? "Add Login Form" : "add login form");
    });
    const validate = async (message: string) => (/[A-Z]/.test(message.split("\n")[0]!) ? ["subject must be lower-case [subject-case]"] : []);
    const { suggestions } = await generate(fixture("feat-login-form"), { provider: modelProvider("fake", true, complete), validate });
    // "Add Login Form" is normalized to "add Login Form", which still fails the validator.
    expect(complete).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toMatch(/subject must be lower-case \[subject-case\]/);
    expect(suggestions[0]!.message.split("\n")[0]).toBe("feat(web): add login form");
  });

  it("the rules provider falls back to an allowed type", async () => {
    const { suggestions, analysis } = await generate(fixture("docs-only"), { provider: rulesProvider(), types: ["feat", "fix", "chore"] });
    expect(analysis.type.type).toBe("docs");
    expect(suggestions.every((s) => s.type === "chore")).toBe(true);
  });

  it("the rules provider reports when nothing passes validation", async () => {
    await expect(
      generate(fixture("docs-only"), { provider: rulesProvider(), validate: async () => ["never valid"] }),
    ).rejects.toThrow(/no template message passes/);
  });

  it("wraps the body at the configured width", async () => {
    const provider = modelProvider("fake", true, async () => ({
      suggestions: [{ type: "feat", scope: null, description: "add x", body: "- " + "word ".repeat(30).trim() }],
    }));
    const { suggestions } = await generate(fixture("feat-login-form"), { provider, bodyLineLength: 40 });
    for (const line of suggestions[0]!.body!.split("\n")) expect(line.length).toBeLessThanOrEqual(40);
  });
});

describe("message length", () => {
  const withBody = (prompts: string[]) =>
    modelProvider("fake", true, async (prompt) => {
      prompts.push(prompt.user);
      return { suggestions: [{ type: "fix", scope: null, description: "guard against a missing profile", body: "- add a null check\n- return an empty name" }] };
    });

  it("leaves the body out for a small change, even if the model writes one", async () => {
    const prompts: string[] = [];
    const { suggestions, analysis } = await generate(fixture("fix-null-guard"), { provider: withBody(prompts) });
    expect(analysis.summary.stats.additions + analysis.summary.stats.deletions).toBeLessThanOrEqual(10);
    expect(prompts[0]).toMatch(/Body: null\. This change is small/);
    expect(suggestions[0]!.message).toBe("fix(api): guard against a missing profile");
    expect(suggestions[0]!.body).toBeUndefined();
  });

  it("keeps a short body for larger changes", async () => {
    const prompts: string[] = [];
    const { suggestions } = await generate(fixture("feat-login-form"), { provider: withBody(prompts) });
    expect(prompts[0]).toMatch(/at most 3 short "- " bullet points/);
    expect(suggestions[0]!.body).toBe("- add a null check\n- return an empty name");
  });
});

