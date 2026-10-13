import { describe, expect, it } from "vitest";
import { analyze } from "../src/analyze.js";
import { isSensitiveFile, redactSummary, redactText, scanSummary, scanText } from "../src/secrets.js";

// Built from parts so this file does not itself look like it contains secrets.
const FAKE = {
  aws: "AKIA" + "ABCDEFGHIJKLMNOP",
  github: "ghp_" + "a".repeat(36),
  openai: "sk-proj-" + "Ab3".repeat(10),
  anthropic: "sk-ant-api03-" + "Xy9".repeat(10),
  stripe: "sk_live_" + "Q".repeat(24),
  google: "AIza" + "B".repeat(35),
  slack: "xoxb-" + "1234567890-abcdef",
  jwt: "eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiIxMjM0NTY3ODkwIn0" + ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
};

function addedFileDiff(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
  ].join("\n");
}

describe("scanText", () => {
  it.each([
    ["AWS access key", `const id = "${FAKE.aws}";`],
    ["GitHub token", `token: ${FAKE.github}`],
    ["OpenAI API key", `OPENAI_API_KEY=${FAKE.openai}`],
    ["Anthropic API key", `key = "${FAKE.anthropic}"`],
    ["Stripe key", `stripe(${JSON.stringify(FAKE.stripe)})`],
    ["Google API key", `apiKey: '${FAKE.google}'`],
    ["Slack token", FAKE.slack],
    ["JWT", `Authorization: Bearer ${FAKE.jwt}`],
    ["private key", "-----BEGIN RSA PRIVATE KEY-----"],
    ["credentials in URL", "DATABASE_URL=postgres://admin:hunter22@db.example.com:5432/app"],
    ["hardcoded secret", `const password = "correct-horse-battery";`],
  ])("finds %s", (rule, text) => {
    expect(scanText(text).map((f) => f.rule)).toContain(rule);
  });

  it("reports an Anthropic key once, not also as an OpenAI key", () => {
    expect(scanText(FAKE.anthropic).map((f) => f.rule)).toEqual(["Anthropic API key"]);
  });

  it.each([
    'const password = "changeme";',
    'api_key: "${API_KEY}"',
    'secret = "<your-secret-here>"',
    "const apiKey = process.env.OPENAI_API_KEY;",
    "token: xxxxxxxxxxxx",
    "see https://example.com/docs",
  ])("ignores placeholder %s", (text) => {
    expect(scanText(text)).toEqual([]);
  });

  it("masks the preview", () => {
    const [finding] = scanText(FAKE.github);
    expect(finding!.preview).not.toContain(FAKE.github);
    expect(finding!.preview).toMatch(/^ghp_…/);
  });
});

describe("redactText", () => {
  it("replaces secrets and keeps the surrounding text", () => {
    const text = `const key = "${FAKE.openai}"; // prod`;
    const result = redactText(text);
    expect(result).toBe('const key = "[REDACTED OpenAI API key]"; // prod');
    expect(scanText(result)).toEqual([]);
  });
});

describe("sensitive files", () => {
  it.each([
    [".env", true],
    ["apps/web/.env.local", true],
    ["certs/server.pem", true],
    [".ssh/id_rsa", true],
    [".env.example", false],
    ["src/env.ts", false],
  ])("%s -> %s", (path, expected) => {
    expect(isSensitiveFile(path)).toBe(expected);
  });
});

describe("scanSummary and redactSummary", () => {
  it("finds secrets in excerpts with their file path", () => {
    const { summary } = analyze(addedFileDiff("src/config.ts", [`export const KEY = "${FAKE.openai}";`]));
    expect(scanSummary(summary)).toEqual([expect.objectContaining({ rule: "OpenAI API key", path: "src/config.ts" })]);
  });

  it("flags any sensitive file that has content, even without known patterns", () => {
    const { summary } = analyze(addedFileDiff(".env", ["DB_HOST=internal.example", "FEATURE_X=1"]));
    expect(scanSummary(summary).map((f) => f.rule)).toContain("sensitive file");
  });

  it("redacts excerpts, withholds sensitive files, and re-renders the text", () => {
    const diff = [
      addedFileDiff("src/config.ts", [`export const KEY = "${FAKE.openai}";`]),
      addedFileDiff(".env", ["DB_HOST=internal.example"]),
    ].join("\n");
    const redacted = redactSummary(analyze(diff).summary);
    expect(redacted.text).not.toContain(FAKE.openai);
    expect(redacted.text).not.toContain("internal.example");
    expect(redacted.text).toContain("[REDACTED OpenAI API key]");
    expect(redacted.text).toContain("sensitive file, content withheld");
    expect(scanSummary(redacted)).toEqual([]);
  });
});
