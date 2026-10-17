import { describe, expect, it } from "vitest";
import { checkMessage } from "../src/check.js";

describe("checkMessage", () => {
  it("accepts a good message", async () => {
    expect(await checkMessage("feat(auth): add login\n\nWith a body.")).toEqual([]);
    expect(await checkMessage("fix!: drop node 18")).toEqual([]);
  });

  it("explains what's wrong", async () => {
    expect(await checkMessage("Fixed the login bug")).toEqual([`not in "type(scope): description" form, e.g. "fix(auth): handle expired tokens"`]);
    expect(await checkMessage("feature: Add login.")).toEqual([
      expect.stringMatching(/^type "feature" isn't one of feat, fix/),
      "start the description with a lowercase letter",
      "remove the period at the end of the header",
    ]);
    expect(await checkMessage("feat(): add x")).toEqual(["the scope is empty; remove the parentheses or name one"]);
    expect(await checkMessage("feat: add x\nno blank line")).toEqual(["put a blank line between the header and the body"]);
    expect(await checkMessage(`feat: ${"x".repeat(80)}`)).toEqual(["the header is 86 characters, limit is 72"]);
  });

  it("follows the team's types, scopes, length and ticket", async () => {
    const rules = { types: ["feat", "wip"], scopes: ["web"], subjectMaxLength: 30, ticket: "PROJ-9" };
    expect(await checkMessage("wip(web): try things (PROJ-9)", rules)).toEqual([]);
    expect(await checkMessage("fix(api): a much longer description here", rules)).toEqual([
      `type "fix" isn't one of feat, wip`,
      "scope \"api\" isn't one of web",
      "the header is 40 characters, limit is 30",
      "mention the ticket PROJ-9",
    ]);
    expect(await checkMessage("feat: x", { requireTicket: true })).toEqual(["mention a ticket ID, e.g. PROJ-123"]);
    expect(await checkMessage("feat: x\n\nRefs: ABC-1", { requireTicket: true })).toEqual([]);
  });

  it("skips messages git writes, and flags fixups", async () => {
    expect(await checkMessage("Merge branch 'main' into feat/x")).toEqual([]);
    expect(await checkMessage('Revert "feat: add x"')).toEqual([]);
    expect(await checkMessage("fixup! feat: add x")).toEqual([expect.stringMatching(/squash it before merging/)]);
  });

  it("uses commitlint instead of its own header rules when given", async () => {
    const validate = async (m: string) => (m.includes("\n") ? ["got the body"] : ["header only"]);
    expect(await checkMessage("Anything\n\nbody", { validate })).toEqual(["got the body"]);
    expect(await checkMessage("Anything\n\nbody", { validate }, { headerOnly: true })).toEqual(["header only"]);
  });
});
