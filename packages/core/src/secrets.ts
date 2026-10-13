import { matchesAny } from "./glob.js";
import { renderSummary } from "./summarize.js";
import type { DiffSummary, FileSummary } from "./types.js";

export interface SecretFinding {
  rule: string;
  /** File the secret was found in, when known. */
  path?: string;
  /** A masked preview, safe to print: first and last characters only. */
  preview: string;
}

interface SecretRule {
  name: string;
  pattern: RegExp;
}

/** Each pattern must use the global flag; capture group 1 (if any) is the secret part. */
const RULES: SecretRule[] = [
  { name: "private key", pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { name: "AWS access key", pattern: /\b((?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16})\b/g },
  {
    name: "AWS secret key",
    pattern: /aws_?secret_?(?:access_?)?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})\b/gi,
  },
  { name: "GitHub token", pattern: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,})\b/g },
  { name: "GitHub token", pattern: /\b(github_pat_[A-Za-z0-9_]{60,})\b/g },
  { name: "GitLab token", pattern: /\b(glpat-[A-Za-z0-9_-]{20,})\b/g },
  { name: "Anthropic API key", pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,})/g },
  { name: "OpenAI API key", pattern: /\b(sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,})/g },
  { name: "Slack token", pattern: /\b(xox[abposr]-[A-Za-z0-9-]{10,})\b/g },
  { name: "Slack webhook", pattern: /(https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+)/g },
  { name: "Stripe key", pattern: /\b((?:sk|rk)_live_[A-Za-z0-9]{20,})\b/g },
  { name: "Google API key", pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/g },
  { name: "npm token", pattern: /\b(npm_[A-Za-z0-9]{36})\b/g },
  { name: "SendGrid key", pattern: /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/g },
  { name: "JWT", pattern: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g },
  {
    name: "credentials in URL",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'`]+:([^\s:/@"'`]{3,})@[^\s"'`]+/gi,
  },
  {
    name: "hardcoded secret",
    pattern:
      /\b(?:password|passwd|pwd|secret|api_?key|apikey|access_?token|auth_?token|client_?secret|private_?key)["']?\s*[:=]\s*["'`]([^"'`\s]{8,})["'`]/gi,
  },
];

/** Values that look like secrets but are placeholders. */
const PLACEHOLDER = /^(?:x+|\*+|\.+|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|changeme|change_me|password|secret|example|your[_-]?\w*|test\w*|dummy\w*|placeholder|redacted|process\.env\.\w+)$/i;

/** Files whose content should never leave the machine, whatever it contains. */
const SENSITIVE_FILES = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials.json",
  "service-account*.json",
];
const SAFE_ENV_FILES = [".env.example", ".env.sample", ".env.template", ".env.dist"];

export function isSensitiveFile(path: string): boolean {
  return matchesAny(path, SENSITIVE_FILES, { nocase: true }) && !matchesAny(path, SAFE_ENV_FILES, { nocase: true });
}

/** Find secrets in arbitrary text. */
export function scanText(text: string, path?: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const value = match[1] ?? match[0];
      if (PLACEHOLDER.test(value) || seen.has(value)) continue;
      seen.add(value);
      const finding: SecretFinding = { rule: rule.name, preview: mask(value) };
      if (path !== undefined) finding.path = path;
      findings.push(finding);
    }
  }
  return findings;
}

/** Replace every secret in the text with a marker naming the rule. */
export function redactText(text: string): string {
  let result = text;
  for (const rule of RULES) {
    result = result.replace(rule.pattern, (whole: string, secret?: string) => {
      const value = typeof secret === "string" ? secret : whole;
      if (PLACEHOLDER.test(value)) return whole;
      return whole.replace(value, `[REDACTED ${rule.name}]`);
    });
  }
  return result;
}

/** Scan everything a summary would send: paths, symbols, sections, excerpts and the rendered text. */
export function scanSummary(summary: DiffSummary): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of summary.files) {
    if (isSensitiveFile(file.path) && file.excerpt) {
      findings.push({ rule: "sensitive file", path: file.path, preview: file.path });
    }
    findings.push(...scanText(fileText(file), file.path));
  }
  // Catch anything outside per-file fields, without double-reporting.
  const known = new Set(findings.map((f) => f.preview));
  for (const finding of scanText(summary.text)) {
    if (!known.has(finding.preview)) findings.push(finding);
  }
  return findings;
}

/** Return a copy of the summary with secrets redacted and sensitive files' content removed. */
export function redactSummary(summary: DiffSummary): DiffSummary {
  const files = summary.files.map((file): FileSummary => {
    const copy: FileSummary = {
      ...file,
      addedSymbols: file.addedSymbols.map(redactText),
      removedSymbols: file.removedSymbols.map(redactText),
      sections: file.sections.map(redactText),
    };
    if (file.excerpt !== undefined) {
      if (isSensitiveFile(file.path)) {
        delete copy.excerpt;
        copy.omitted = "sensitive file, content withheld";
      } else {
        copy.excerpt = redactText(file.excerpt);
      }
    }
    return copy;
  });

  // Re-render from the cleaned files so withheld content cannot survive in the text.
  const limit = Math.max(summary.text.length, 1);
  const { text, clipped } = renderSummary(files, summary.stats, limit);
  return { ...summary, files, text: redactText(text), truncated: summary.truncated || clipped };
}

export class SecretsDetectedError extends Error {
  readonly findings: SecretFinding[];
  constructor(findings: SecretFinding[]) {
    const list = findings.map((f) => `${f.rule}${f.path ? ` in ${f.path}` : ""} (${f.preview})`).join(", ");
    super(`Possible secrets found in the staged changes: ${list}. Nothing was sent.`);
    this.name = "SecretsDetectedError";
    this.findings = findings;
  }
}

function fileText(file: FileSummary): string {
  return [file.path, file.oldPath ?? "", ...file.addedSymbols, ...file.removedSymbols, ...file.sections, file.excerpt ?? ""].join("\n");
}

function mask(value: string): string {
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}
