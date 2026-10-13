import { describe, expect, it } from "vitest";
import { parseDiff } from "../src/parse.js";

describe("parseDiff", () => {
  it("returns nothing for empty input", () => {
    expect(parseDiff("")).toEqual([]);
  });

  it("parses a modified file with several hunks", () => {
    const [file] = parseDiff(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 111..222 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,3 +1,3 @@ function one() {",
        " a",
        "-b",
        "+B",
        " c",
        "@@ -10 +10,2 @@",
        " x",
        "+y",
        "",
      ].join("\n"),
    );
    expect(file).toMatchObject({ path: "src/a.ts", oldPath: "src/a.ts", status: "modified", additions: 2, deletions: 1 });
    expect(file!.hunks).toHaveLength(2);
    expect(file!.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, section: "function one() {" });
    expect(file!.hunks[1]).toMatchObject({ oldStart: 10, oldLines: 1, newStart: 10, newLines: 2 });
  });

  it("parses new and deleted files", () => {
    const files = parseDiff(
      [
        "diff --git a/new.ts b/new.ts",
        "new file mode 100644",
        "index 0000000..abc",
        "--- /dev/null",
        "+++ b/new.ts",
        "@@ -0,0 +1 @@",
        "+hello",
        "diff --git a/old.ts b/old.ts",
        "deleted file mode 100644",
        "index abc..0000000",
        "--- a/old.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-bye",
      ].join("\n"),
    );
    expect(files.map((f) => [f.path, f.oldPath, f.status])).toEqual([
      ["new.ts", "new.ts", "added"],
      ["old.ts", "old.ts", "deleted"],
    ]);
  });

  it("parses renames with and without content changes", () => {
    const files = parseDiff(
      [
        "diff --git a/a.ts b/b.ts",
        "similarity index 100%",
        "rename from a.ts",
        "rename to b.ts",
        "diff --git a/c.ts b/d.ts",
        "similarity index 90%",
        "rename from c.ts",
        "rename to d.ts",
        "index 1..2 100644",
        "--- a/c.ts",
        "+++ b/d.ts",
        "@@ -1 +1 @@",
        "-x",
        "+y",
      ].join("\n"),
    );
    expect(files[0]).toMatchObject({ oldPath: "a.ts", path: "b.ts", status: "renamed", similarity: 100, hunks: [] });
    expect(files[1]).toMatchObject({ oldPath: "c.ts", path: "d.ts", status: "renamed", similarity: 90, additions: 1 });
  });

  it("parses copies", () => {
    const [file] = parseDiff(
      ["diff --git a/a.ts b/b.ts", "similarity index 100%", "copy from a.ts", "copy to b.ts"].join("\n"),
    );
    expect(file).toMatchObject({ oldPath: "a.ts", path: "b.ts", status: "copied" });
  });

  it("marks binary files and skips binary patch data", () => {
    const files = parseDiff(
      [
        "diff --git a/img.png b/img.png",
        "new file mode 100644",
        "index 0000000..abc",
        "GIT binary patch",
        "literal 12",
        "zcmZ?wbhEHbWMp7uXkcIn",
        "",
        "literal 0",
        "",
        "diff --git a/b.png b/b.png",
        "index 1..2 100644",
        "Binary files a/b.png and b/b.png differ",
      ].join("\n"),
    );
    expect(files.map((f) => [f.path, f.binary, f.status, f.hunks.length])).toEqual([
      ["img.png", true, "added", 0],
      ["b.png", true, "modified", 0],
    ]);
  });

  it("decodes quoted paths with spaces and UTF-8 octal escapes", () => {
    const [file] = parseDiff(
      [
        'diff --git "a/docs/caf\\303\\251 notes.md" "b/docs/caf\\303\\251 notes.md"',
        "index 1..2 100644",
        '--- "a/docs/caf\\303\\251 notes.md"\t',
        '+++ "b/docs/caf\\303\\251 notes.md"\t',
        "@@ -1 +1,2 @@",
        " a",
        "+b",
      ].join("\n"),
    );
    expect(file!.path).toBe("docs/café notes.md");
  });

  it("handles unquoted paths containing spaces and ' b/'", () => {
    const [file] = parseDiff(
      ["diff --git a/my dir b/x.ts b/my dir b/x.ts", "old mode 100644", "new mode 100755"].join("\n"),
    );
    expect(file).toMatchObject({ path: "my dir b/x.ts", oldMode: "100644", newMode: "100755", status: "modified" });
  });

  it("records missing newline at end of file", () => {
    const [file] = parseDiff(
      [
        "diff --git a/a b/a",
        "--- a/a",
        "+++ b/a",
        "@@ -1 +1 @@",
        "-x",
        "\\ No newline at end of file",
        "+x",
      ].join("\n"),
    );
    expect(file!.hunks[0]!.lines).toEqual([
      { kind: "del", content: "x", noNewline: true },
      { kind: "add", content: "x" },
    ]);
    expect(file!.hunks).toHaveLength(1);
  });

  it("does not treat content that looks like a header as a new file", () => {
    const [file, second] = parseDiff(
      [
        "diff --git a/a.md b/a.md",
        "--- a/a.md",
        "+++ b/a.md",
        "@@ -1 +1,2 @@",
        " text",
        "+--- not a header",
        "diff --git a/b.md b/b.md",
        "--- a/b.md",
        "+++ b/b.md",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ].join("\n"),
    );
    expect(file!.hunks[0]!.lines.at(-1)).toEqual({ kind: "add", content: "--- not a header" });
    expect(second!.path).toBe("b.md");
  });

  it("accepts CRLF line endings", () => {
    const [file] = parseDiff(["diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1 +1 @@", "-x", "+y", ""].join("\r\n"));
    expect(file).toMatchObject({ additions: 1, deletions: 1 });
    expect(file!.hunks[0]!.lines[1]!.content).toBe("y");
  });

  it("ignores text before the first diff header", () => {
    const files = parseDiff(["commit abc", "Author: x", "", "diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1 +1 @@", "-x", "+y"].join("\n"));
    expect(files).toHaveLength(1);
  });
});
