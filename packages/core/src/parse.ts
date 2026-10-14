import type { DiffFile, DiffLine, Hunk } from "./types.js";

const DIFF_HEADER = "diff --git ";
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Parse `git diff` output, including renames, copies, mode changes, binaries and quoted paths. */
export function parseDiff(input: string): DiffFile[] {
  const lines = input.split(/\r?\n/);
  const files: DiffFile[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.startsWith(DIFF_HEADER)) {
      const [file, next] = parseFile(lines, i);
      files.push(file);
      i = next;
    } else {
      i++;
    }
  }
  return files;
}

function parseFile(lines: string[], start: number): [DiffFile, number] {
  const header = parseGitHeader(lines[start]!.slice(DIFF_HEADER.length));
  const file: DiffFile = {
    path: header.newPath,
    oldPath: header.oldPath,
    status: "modified",
    binary: false,
    additions: 0,
    deletions: 0,
    hunks: [],
  };

  let i = start + 1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith(DIFF_HEADER) || line.startsWith("@@ ")) break;

    if (line.startsWith("new file mode ")) {
      file.status = "added";
      file.newMode = line.slice("new file mode ".length);
    } else if (line.startsWith("deleted file mode ")) {
      file.status = "deleted";
      file.oldMode = line.slice("deleted file mode ".length);
    } else if (line.startsWith("old mode ")) {
      file.oldMode = line.slice("old mode ".length);
    } else if (line.startsWith("new mode ")) {
      file.newMode = line.slice("new mode ".length);
    } else if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = unquote(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      file.status = "renamed";
      file.path = unquote(line.slice("rename to ".length));
    } else if (line.startsWith("copy from ")) {
      file.status = "copied";
      file.oldPath = unquote(line.slice("copy from ".length));
    } else if (line.startsWith("copy to ")) {
      file.status = "copied";
      file.path = unquote(line.slice("copy to ".length));
    } else if (line.startsWith("similarity index ")) {
      file.similarity = parseInt(line.slice("similarity index ".length), 10);
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      file.binary = true;
    } else if (line.startsWith("--- ")) {
      const path = parsePathLine(line.slice(4));
      if (path !== null) file.oldPath = path;
    } else if (line.startsWith("+++ ")) {
      const path = parsePathLine(line.slice(4));
      if (path !== null) file.path = path;
    }
  }

  while (i < lines.length && lines[i]!.startsWith("@@ ")) {
    const [hunk, next] = parseHunk(lines, i);
    if (!hunk) {
      i = next;
      break;
    }
    file.hunks.push(hunk);
    i = next;
  }

  // Skip anything left over (binary patch data, malformed lines) up to the next file.
  while (i < lines.length && !lines[i]!.startsWith(DIFF_HEADER)) i++;

  if (file.status === "deleted") file.path = file.oldPath;
  if (file.status === "added") file.oldPath = file.path;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") file.additions++;
      else if (line.kind === "del") file.deletions++;
    }
  }
  return [file, i];
}

function parseHunk(lines: string[], start: number): [Hunk | null, number] {
  const header = lines[start]!;
  const match = HUNK_HEADER.exec(header);
  if (!match) return [null, start + 1];

  const hunk: Hunk = {
    header,
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
    section: (match[5] ?? "").trim(),
    lines: [],
  };

  let oldLeft = hunk.oldLines;
  let newLeft = hunk.newLines;
  let i = start + 1;
  let last: DiffLine | undefined;

  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("\\")) {
      if (last) last.noNewline = true;
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) break;

    const marker = line[0];
    if (marker === "+") {
      last = { kind: "add", content: line.slice(1) };
      newLeft--;
    } else if (marker === "-") {
      last = { kind: "del", content: line.slice(1) };
      oldLeft--;
    } else if (marker === " " || line === "") {
      // An empty line is a context line whose leading space was stripped (e.g. by an editor).
      last = { kind: "context", content: line.slice(1) };
      oldLeft--;
      newLeft--;
    } else {
      break;
    }
    hunk.lines.push(last);
  }
  return [hunk, i];
}

interface GitHeader {
  oldPath: string;
  newPath: string;
}

/** Paths from `diff --git a/x b/y`; ambiguous with spaces, so later headers override them. */
function parseGitHeader(rest: string): GitHeader {
  if (rest.startsWith('"')) {
    const [first, after] = readQuoted(rest);
    const second = after.trimStart();
    const newRaw = second.startsWith('"') ? readQuoted(second)[0] : second;
    return { oldPath: stripPrefix(first), newPath: stripPrefix(newRaw) };
  }

  // Same path on both sides: "a/P b/P", so P has length (len - 5) / 2.
  const n = (rest.length - 5) / 2;
  if (Number.isInteger(n) && n > 0) {
    const a = rest.slice(2, 2 + n);
    const b = rest.slice(5 + n);
    if (a === b && rest.startsWith("a/") && rest.slice(2 + n, 5 + n) === " b/") {
      return { oldPath: a, newPath: b };
    }
  }

  const quotedSecond = rest.indexOf(' "');
  if (quotedSecond !== -1) {
    return {
      oldPath: stripPrefix(rest.slice(0, quotedSecond)),
      newPath: stripPrefix(readQuoted(rest.slice(quotedSecond + 1))[0]),
    };
  }

  const split = rest.lastIndexOf(" b/");
  if (split === -1) return { oldPath: stripPrefix(rest), newPath: stripPrefix(rest) };
  return { oldPath: stripPrefix(rest.slice(0, split)), newPath: stripPrefix(rest.slice(split + 1)) };
}

/** Parse the path from a `---` or `+++` line. Returns null for /dev/null. */
function parsePathLine(raw: string): string | null {
  let value = raw;
  if (!value.startsWith('"')) {
    // GNU diff appends a tab and a timestamp.
    const tab = value.indexOf("\t");
    if (tab !== -1) value = value.slice(0, tab);
  }
  value = unquote(value);
  if (value === "/dev/null") return null;
  return stripPrefix(value);
}

function stripPrefix(path: string): string {
  return /^[ab]\//.test(path) ? path.slice(2) : path;
}

function unquote(value: string): string {
  return value.startsWith('"') ? readQuoted(value)[0] : value;
}

const ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/** Read a git C-quoted string, decoding octal escapes as UTF-8; returns the value and the rest. */
function readQuoted(input: string): [string, string] {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let i = 1;
  for (; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === '"') {
      i++;
      break;
    }
    if (ch !== "\\") {
      bytes.push(...encoder.encode(ch));
      continue;
    }
    const next = input[i + 1] ?? "";
    const octal = /^[0-7]{3}/.exec(input.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else {
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return [new TextDecoder().decode(new Uint8Array(bytes)), input.slice(i)];
}
