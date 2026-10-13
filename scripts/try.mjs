#!/usr/bin/env node
// Try the core engine on a real repository without the CLI.
//
//   node scripts/try.mjs [repo]                  analyze staged changes
//   node scripts/try.mjs [repo] --commit <rev>   analyze one commit
//   node scripts/try.mjs [repo] --history <n>    compare guesses with the last n commit messages
//   add --summary to print the summary text a model would receive
//   add --generate [provider] to get commit messages (openai, anthropic, ollama, rules)
//   add --redact to redact secrets instead of aborting
//
// API keys and models are read from .env in the gitmit folder (see .env.example).

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "packages/core/dist/index.js");
if (!existsSync(dist)) {
  console.error("Build the core package first: corepack pnpm -r build");
  process.exit(1);
}
const { analyze, generate, createProvider, PROVIDER_NAMES } = await import(dist);

const envFile = join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const takeSwitch = (name) => args.includes(name) && Boolean(args.splice(args.indexOf(name), 1));
const showSummary = takeSwitch("--summary");
const redact = takeSwitch("--redact");
let providerName;
if (args.includes("--generate")) {
  const i = args.indexOf("--generate");
  const next = args[i + 1];
  const named = PROVIDER_NAMES.includes(next);
  providerName = named ? next : process.env.OPENAI_API_KEY ? "openai" : "rules";
  args.splice(i, named ? 2 : 1);
}
const commit = flag("--commit");
const history = flag("--history");
const repo = resolve(args[0] ?? ".");

const git = (...gitArgs) =>
  execFileSync("git", ["-C", repo, ...gitArgs], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "-M"];

if (history) {
  runHistory(Number(history));
} else {
  const diff = commit ? git("show", "--format=", ...DIFF_FLAGS, commit) : git("diff", "--staged", ...DIFF_FLAGS);
  if (!diff.trim()) {
    console.error(commit ? `Commit ${commit} has no diff.` : "No staged changes. Stage something, or use --commit or --history.");
    process.exit(1);
  }
  report(analyze(diff));
  if (providerName) await runGenerate(diff);
}

async function runGenerate(diff) {
  const settings = {
    openai: { apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || undefined },
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL || undefined },
    ollama: { baseURL: process.env.OLLAMA_HOST || undefined, model: process.env.OLLAMA_MODEL || undefined },
    rules: {},
  }[providerName];
  const provider = createProvider(providerName, settings);
  console.log(`\n  generating with ${providerName}${settings.model ? ` (${settings.model})` : ""}...\n`);
  const started = Date.now();
  try {
    const result = await generate(diff, { provider, secrets: { onDetect: redact ? "redact" : "abort" } });
    if (result.redacted) console.log(`  redacted ${result.secrets.length} possible secret(s) before sending\n`);
    result.suggestions.forEach((s, i) => {
      const [header, ...rest] = s.message.split("\n");
      console.log(`  ${i + 1}. ${header}`);
      for (const line of rest) console.log(line ? `     ${line}` : "");
      console.log("");
    });
    console.log(`  done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (error) {
    console.error(`  ${error.message}`);
    if (error.name === "SecretsDetectedError") console.error("  Re-run with --redact to send a redacted version instead.");
    process.exitCode = 1;
  }
}

function report(result) {
  const { type, scope, dropped, summary } = result;
  const header = scope.scope ? `${type.type}(${scope.scope})` : type.type;
  console.log(`\n  ${header}: ...\n`);
  console.log(`  type   ${type.type} (${type.confidence}) - ${type.reasons.join("; ")}`);
  console.log(`  scope  ${scope.scope ?? "none"} (${scope.confidence}) - ${scope.reasons.join("; ")}`);
  console.log(`  files  ${result.files.length} changed, ${dropped.length} treated as noise`);
  for (const file of dropped) console.log(`         - ${file.path} (${file.noiseReason})`);
  console.log(`  summary ${summary.text.length} chars${summary.truncated ? ", truncated to fit" : ""}`);
  if (showSummary) console.log(`\n${summary.text}\n`);
}

function runHistory(count) {
  const log = git("log", "--no-merges", `-n${count}`, "--format=%H%x00%s");
  const commits = log.trim().split("\n").filter(Boolean).map((line) => line.split("\0"));
  const conventional = /^(\w+)(?:\(([^)]*)\))?!?:/;
  let compared = 0;
  let typeHits = 0;
  let scopeHits = 0;

  console.log("");
  for (const [sha, subject] of commits) {
    const diff = git("show", "--format=", ...DIFF_FLAGS, sha);
    const { type, scope } = analyze(diff);
    const guess = scope.scope ? `${type.type}(${scope.scope})` : type.type;
    const mark = type.confidence === "high" ? "*" : " ";
    const actual = conventional.exec(subject);
    let verdict = "";
    if (actual) {
      compared++;
      const typeOk = actual[1].toLowerCase() === type.type;
      const scopeOk = (actual[2] || undefined) === scope.scope;
      if (typeOk) typeHits++;
      if (scopeOk) scopeHits++;
      verdict = typeOk ? (scopeOk ? "ok " : "~  ") : "x  ";
    }
    console.log(`${verdict.padEnd(3)} ${sha.slice(0, 7)}  ${(guess + mark).padEnd(22)} ${subject.slice(0, 70)}`);
  }

  console.log("\n* = high confidence (rules are sure). ok = type and scope match, ~ = type only, x = type differs.");
  if (compared > 0) {
    const pct = (n) => `${Math.round((n / compared) * 100)}%`;
    console.log(`Of ${compared} conventional commits: type matched ${pct(typeHits)}, scope matched ${pct(scopeHits)}.`);
  } else {
    console.log("No conventional-commit subjects found, so there is nothing to score. Compare the columns by eye.");
  }
}
