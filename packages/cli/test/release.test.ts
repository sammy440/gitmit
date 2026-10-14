import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { today } from "../src/release.js";
import { TestRepo } from "./harness.js";

let repo: TestRepo;
const cleanup: string[] = [];

function commit(subject: string, file = `f${Math.random()}.txt`) {
  repo.write(file, subject);
  repo.git("add", "-A");
  repo.git("commit", "-qm", subject);
}

/** A released v1.0.0 with a package.json, then a feature, a fix and docs. */
function released() {
  repo.write("package.json", '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n');
  repo.git("add", "-A");
  repo.git("commit", "-qm", "chore: add package.json");
  repo.git("tag", "v1.0.0");
  commit("feat(auth): add login");
  commit("fix: handle empty input");
  commit("docs: tidy readme");
}

const pkgVersion = () => JSON.parse(readFileSync(join(repo.dir, "package.json"), "utf8")).version;

beforeEach(() => {
  repo = new TestRepo();
});
afterEach(() => {
  repo.cleanup();
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("gitmit release", () => {
  it("--dry-run shows the next version and notes, and changes nothing", async () => {
    released();
    const result = await repo.run(["release", "--dry-run", "--provider", "rules"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/3 commits since v1\.0\.0\. Next version: 1\.1\.0 \(minor: 1 feature, 1 fix\)/);
    expect(result.stdout).toMatch(new RegExp(`^## 1\\.1\\.0 \\(${today()}\\)\\n\\n### Features\\n\\n- \\*\\*auth:\\*\\* add login \\([0-9a-f]{7}\\)\\n\\n### Bug fixes\\n\\n- handle empty input`));
    expect(result.stdout).not.toMatch(/tidy readme/);
    expect(existsSync(join(repo.dir, "CHANGELOG.md"))).toBe(false);
  });

  it("--yes writes the changelog, bumps package.json, commits and tags", async () => {
    released();
    const result = await repo.run(["release", "--yes", "--provider", "rules"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/Updated CHANGELOG\.md and package\.json, committed and tagged v1\.1\.0/);
    expect(readFileSync(join(repo.dir, "CHANGELOG.md"), "utf8")).toMatch(/^# Changelog\n\n## 1\.1\.0 /);
    expect(pkgVersion()).toBe("1.1.0");
    expect(repo.git("log", "-1", "--format=%s").trim()).toBe("chore(release): v1.1.0");
    expect(repo.git("cat-file", "-t", "v1.1.0").trim()).toBe("tag");
    expect(repo.git("status", "--porcelain").trim()).toBe("");

    const again = await repo.run(["release", "--dry-run", "--provider", "rules"]);
    expect(again.stderr).toMatch(/No commits since v1\.1\.0/);
    commit("docs: more docs");
    expect((await repo.run(["release", "--dry-run", "--provider", "rules"])).stderr).toMatch(/Nothing to release: the 1 commit since v1\.1\.0 has no features[\s\S]*--bump patch/);
  });

  it("a first release uses package.json's version; tags keep the existing prefix", async () => {
    repo.write("package.json", '{ "version": "0.3.0" }\n');
    repo.git("add", "-A");
    repo.git("commit", "-qm", "feat: first feature");
    const first = await repo.run(["release", "--yes", "--provider", "rules"]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stderr).toMatch(/2 commits so far \(first release\)\. Next version: 0\.3\.0/);
    expect(repo.git("tag").trim()).toBe("v0.3.0");

    repo.git("tag", "0.4.0");
    commit("fix: something");
    expect((await repo.run(["release", "--dry-run", "--provider", "rules"])).stderr).toMatch(/since 0\.4\.0\. Next version: 0\.4\.1/);
  });

  it("--bump overrides the suggestion", async () => {
    released();
    expect((await repo.run(["release", "--dry-run", "--provider", "rules", "--bump", "major"])).stderr).toMatch(/Next version: 2\.0\.0/);
    expect((await repo.run(["release", "--dry-run", "--provider", "rules", "--bump", "1.0.0"])).stderr).toMatch(/isn't newer than the current version 1\.0\.0/);
  });

  it("refuses to sweep up staged work, and leaves everything as it was", async () => {
    released();
    repo.write("wip.txt", "wip");
    repo.git("add", "wip.txt");
    const result = await repo.run(["release", "--yes", "--provider", "rules"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/You have staged changes/);
    expect(existsSync(join(repo.dir, "CHANGELOG.md"))).toBe(false);
  });

  it("restores the files when a commit hook rejects the release commit", async () => {
    released();
    const hook = join(repo.dir, ".git", "hooks", "commit-msg");
    writeFileSync(hook, "#!/bin/sh\necho 'rejected by hook' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const result = await repo.run(["release", "--yes", "--provider", "rules"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/git commit failed[\s\S]*rejected by hook/);
    expect(existsSync(join(repo.dir, "CHANGELOG.md"))).toBe(false);
    expect(pkgVersion()).toBe("1.0.0");
    expect(repo.git("status", "--porcelain").trim()).toBe("");
    expect(repo.git("tag").trim()).toBe("v1.0.0");
  });

  it("--github pushes the commit and tag, then creates the release with gh", async () => {
    released();
    const remote = mkdtempSync(join(tmpdir(), "gitmit-release-remote-"));
    const bin = mkdtempSync(join(tmpdir(), "gitmit-gh-"));
    cleanup.push(remote, bin);
    execFileSync("git", ["init", "-q", "--bare", remote]);
    repo.git("remote", "add", "origin", remote);
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh
echo "$*" >> "${bin}/gh.log"
if [ "$1" = "release" ]; then
  while [ $# -gt 0 ]; do if [ "$1" = "--notes-file" ]; then cp "$2" "${bin}/notes.md"; fi; shift; done
  echo "https://github.com/acme/demo/releases/tag/v1.1.0"
fi
exit 0
`,
    );
    chmodSync(join(bin, "gh"), 0o755);

    const result = await repo.run(["release", "--yes", "--github", "--provider", "rules"], { PATH: `${bin}:${process.env.PATH}` });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/https:\/\/github\.com\/acme\/demo\/releases\/tag\/v1\.1\.0/);
    expect(execFileSync("git", ["tag"], { cwd: remote, encoding: "utf8" })).toMatch(/v1\.1\.0/);
    expect(execFileSync("git", ["log", "-1", "--format=%s", "main"], { cwd: remote, encoding: "utf8" }).trim()).toBe("chore(release): v1.1.0");
    expect(readFileSync(join(bin, "gh.log"), "utf8")).toMatch(/^release create v1\.1\.0 --title v1\.1\.0 --notes-file \S+ --verify-tag$/m);
    expect(readFileSync(join(bin, "notes.md"), "utf8")).toMatch(/^### Features/);
  });
});
