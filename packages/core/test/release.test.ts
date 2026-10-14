import { describe, expect, it, vi } from "vitest";
import {
  bumpVersion,
  NothingToReleaseError,
  parseCommit,
  planRelease,
  prependChangelog,
  renderRelease,
  writeHighlights,
} from "../src/release.js";
import { modelProvider, rulesProvider } from "../src/providers/index.js";
import { OUTPUT_SCHEMAS } from "../src/index.js";

const c = (subject: string, body = "", sha = "abcdef1234567890") => ({ sha, subject, body });

describe("parseCommit", () => {
  it("reads type, scope, description and breaking changes", () => {
    expect(parseCommit(c("feat(auth): add login"))).toMatchObject({ type: "feat", scope: "auth", description: "add login", breaking: undefined });
    expect(parseCommit(c("fix!: drop node 18"))).toMatchObject({ type: "fix", breaking: "drop node 18" });
    expect(parseCommit(c("refactor(api): rename routes", "Details.\n\nBREAKING CHANGE: /v1 routes are now\n/v2.\n\nRefs: #12"))).toMatchObject({
      breaking: "/v1 routes are now /v2.",
    });
    expect(parseCommit(c('Revert "feat: add login"'))).toMatchObject({ type: "revert", description: "feat: add login" });
    expect(parseCommit(c("Update readme"))).toEqual({ sha: "abcdef1234567890", subject: "Update readme", description: "Update readme", breaking: undefined });
  });
});

describe("bumpVersion", () => {
  it("bumps each part and resets the lower ones", () => {
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
  });
});

describe("planRelease", () => {
  const commits = [c("feat(auth): add login"), c("fix: handle empty input"), c("docs: tidy readme"), c("Update stuff")];

  it("suggests the bump from the commits and groups them", () => {
    const plan = planRelease(commits, { current: "1.4.2" });
    expect(plan.version).toBe("1.5.0");
    expect(plan.reason).toBe("minor: 1 feature, 1 fix");
    expect(plan.sections.map((s) => s.title)).toEqual(["Features", "Bug fixes", "Other changes"]);
  });

  it("breaking changes bump major, or minor before 1.0.0", () => {
    expect(planRelease([c("feat!: new config format")], { current: "1.4.2" }).version).toBe("2.0.0");
    const pre = planRelease([c("feat!: new config format")], { current: "0.6.0" });
    expect(pre.version).toBe("0.7.0");
    expect(pre.reason).toMatch(/before 1\.0\.0/);
  });

  it("fixes alone are a patch", () => {
    expect(planRelease([c("fix: x"), c("perf: y")], { current: "0.6.0" }).version).toBe("0.6.1");
  });

  it("refuses when nothing needs a release, unless a bump is given", () => {
    expect(() => planRelease([c("docs: x"), c("chore: y")], { current: "1.0.0", since: "v1.0.0" })).toThrow(NothingToReleaseError);
    expect(() => planRelease([], { current: "1.0.0" })).toThrow(/No commits/);
    expect(planRelease([c("docs: x")], { current: "1.0.0", bump: "patch" }).version).toBe("1.0.1");
  });

  it("accepts an exact version, but only a newer one", () => {
    expect(planRelease(commits, { current: "1.4.2", bump: "2.0.0" }).version).toBe("2.0.0");
    expect(() => planRelease(commits, { current: "1.4.2", bump: "1.4.0" })).toThrow(/isn't newer/);
    expect(() => planRelease(commits, { current: "1.4.2", bump: "huge" })).toThrow(/--bump takes/);
  });

  it("a first release uses the manifest version as is", () => {
    expect(planRelease(commits, { initial: "0.6.0" })).toMatchObject({ version: "0.6.0", reason: "first release" });
    expect(planRelease(commits).version).toBe("0.1.0");
  });
});

describe("renderRelease", () => {
  it("links the compare view and commits when the repository URL is known", () => {
    const plan = planRelease([c("feat(auth): add login", "", "1111111aaaa"), c("feat!: new config", "", "2222222bbbb")], { current: "1.0.0" });
    const { heading, notes } = renderRelease(plan, {
      tag: "v2.0.0",
      previousTag: "v1.0.0",
      repoUrl: "https://github.com/acme/app",
      date: "2026-10-14",
      highlights: "A new config format and login.",
    });
    expect(heading).toBe("## [2.0.0](https://github.com/acme/app/compare/v1.0.0...v2.0.0) (2026-10-14)");
    expect(notes).toBe(
      [
        "A new config format and login.",
        "### Breaking changes\n\n- new config ([2222222](https://github.com/acme/app/commit/2222222bbbb))",
        "### Features\n\n- **auth:** add login ([1111111](https://github.com/acme/app/commit/1111111aaaa))\n- new config ([2222222](https://github.com/acme/app/commit/2222222bbbb))",
      ].join("\n\n"),
    );
  });

  it("works without a remote", () => {
    const { heading, notes } = renderRelease(planRelease([c("fix: x", "", "abc1234def")]), { tag: "v0.1.0", date: "2026-10-14" });
    expect(heading).toBe("## 0.1.0 (2026-10-14)");
    expect(notes).toBe("### Bug fixes\n\n- x (abc1234)");
  });
});

describe("prependChangelog", () => {
  it("creates the file, or adds the newest section on top", () => {
    expect(prependChangelog(undefined, "## 1.0.0 (d)\n\n- a", "1.0.0")).toBe("# Changelog\n\n## 1.0.0 (d)\n\n- a\n");
    const existing = "# Changelog\n\nAll notable changes.\n\n## 1.0.0 (d)\n\n- a\n";
    expect(prependChangelog(existing, "## 1.1.0 (e)\n\n- b", "1.1.0")).toBe("# Changelog\n\nAll notable changes.\n\n## 1.1.0 (e)\n\n- b\n\n## 1.0.0 (d)\n\n- a\n");
  });

  it("refuses a version that's already there", () => {
    expect(() => prependChangelog("## [1.0.0](x) (d)\n", "## 1.0.0", "1.0.0")).toThrow(/already has a section/);
  });
});

describe("writeHighlights", () => {
  const plan = planRelease([c("feat(auth): add login")], { current: "1.0.0" });

  it("skips providers without a model", async () => {
    expect(await writeHighlights(plan, { provider: rulesProvider() })).toEqual({ secrets: [], redacted: false });
  });

  it("asks the model and retries answers that aren't prose", async () => {
    const answers = [{ highlights: "## Big\n- login" }, { highlights: "Sign-in arrives:  you can now log in." }];
    const complete = vi.fn(async (_prompt: { user: string }, _output: { name: string }) => answers.shift());
    const result = await writeHighlights(plan, { provider: modelProvider("fake", true, complete) });
    expect(result.text).toBe("Sign-in arrives: you can now log in.");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]![0].user).toMatch(/<changes>\n### Features\n\n- \*\*auth:\*\* add login\n<\/changes>/);
    expect(complete.mock.calls[0]![1].name).toBe("release_notes");
    expect(Object.keys(OUTPUT_SCHEMAS)).toContain("release_notes");
  });

  it("never sends a secret to a remote model", async () => {
    const leaky = planRelease([c("fix: rotate key AKIAIOSFODNN7EXAMPLE")], { current: "1.0.0" });
    const complete = vi.fn();
    await expect(writeHighlights(leaky, { provider: modelProvider("fake", true, complete) })).rejects.toThrow(/secret/i);
    expect(complete).not.toHaveBeenCalled();
  });
});
