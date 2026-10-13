# gitmit

> Generate clean, convention-compliant git commit messages from your diff. Works offline, respects your team's rules, and can split messy changes into focused commits.

**Status:** Planning. This README doubles as the project roadmap and architecture document.
**Name:** gitmit. The unscoped npm name `gitmit` is taken by an unrelated package, so packages publish as `@gitmit/core` and `@gitmit/cli` (the installed command is still `gitmit`).
**License:** MIT

---

## Table of Contents

1. [Vision](#vision)
2. [Feature Overview](#feature-overview)
3. [Architecture](#architecture)
4. [Tech Stack](#tech-stack)
5. [Build Phases](#build-phases)
6. [Configuration Reference](#configuration-reference)
7. [CLI Reference](#cli-reference)
8. [Known Challenges](#known-challenges)
9. [Testing Strategy](#testing-strategy)
10. [Distribution and Positioning](#distribution-and-positioning)
11. [Decisions to Settle Early](#decisions-to-settle-early)

---

## Vision

Existing tools (aicommits, opencommit, the built-in VS Code generator) mostly do the same thing: send a diff to a model and return one message. gitmit differentiates on four points:

1. **Team conventions as config.** Messages always pass commitlint and match your ticket-ID and scope rules.
2. **Commit splitting.** A messy staged diff is split into several focused commits.
3. **Offline and private.** Supports local models (Ollama) and a rules-only mode, and scans for secrets before anything leaves the machine.
4. **Rules first, AI second.** Type and scope are detected deterministically. The model only writes the description, which makes output cheaper, faster, and more consistent.

---

## Feature Overview

### Core engine
- Diff parsing (including renames, binary files, deleted and new files)
- Noise filtering (lockfiles, generated files, minified output, snapshots)
- Rule-based commit type detection
- Path-based scope inference
- Hierarchical summarization for large diffs
- Secret scanning and redaction
- Message validation against config, with automatic regeneration on failure

### Providers
- Anthropic
- OpenAI
- Ollama (local, private)
- Rules-only fallback (no AI, no network)
- Bring-your-own-key by default

### CLI
- Interactive picker with 3 suggestions
- Edit-before-commit
- `--dry-run`
- Git hook mode (`prepare-commit-msg`)
- Provider and config overrides via flags

### Configuration
- `.gitmitrc` or `gitmit.config.ts`
- Allowed types and scopes
- Ticket ID extraction from branch name
- Subject length limit, language, body style
- Reads existing commitlint config

### Commit splitting
- Hunk-level grouping
- Proposed commit plan with explanations
- Safe application via `git apply --cached`
- Automatic index backup and restore

### Surfaces
- CLI (primary)
- Web demo and docs (Next.js)
- VS Code extension

---

## Architecture

### Monorepo layout

```
gitmit/
├── packages/
│   ├── core/        # engine: no terminal, no editor, no UI
│   ├── cli/         # npx entry point, prompts, git integration
│   ├── web/         # Next.js demo, docs, landing page
│   └── vscode/      # extension, thin wrapper over core
├── fixtures/        # real diffs with expected outputs
├── pnpm-workspace.yaml
├── package.json
└── README.md
```

### Design rule

**`core` must never touch the terminal, the filesystem UI, or the editor.** It takes a diff and a config and returns suggestions. Every surface (CLI, web, extension) is a thin adapter over it. This is what makes adding new surfaces cheap.

### Core pipeline

```
raw diff
   │
   ▼
[1] Parse            → structured files and hunks
   │
   ▼
[2] Filter noise     → drop lockfiles, generated, minified, binary
   │
   ▼
[3] Secret scan      → redact or abort before any remote call
   │
   ▼
[4] Detect type      → rules: test / docs / chore / ci / style ...
   │
   ▼
[5] Infer scope      → from file paths (apps/web → web)
   │
   ▼
[6] Summarize        → per-file summaries, then combine (large diffs)
   │
   ▼
[7] Generate         → provider writes description (3 variants)
   │
   ▼
[8] Validate         → against config / commitlint; regenerate if invalid
   │
   ▼
suggestions[]
```

### Provider interface

```ts
interface Provider {
  name: string;
  generate(input: GenerateInput): Promise<string[]>;
}

interface GenerateInput {
  summary: DiffSummary;      // already filtered and redacted
  type: CommitType;          // already detected by rules
  scope?: string;            // already inferred
  config: ResolvedConfig;
  variants: number;          // usually 3
}
```

Adapters: `anthropic`, `openai`, `ollama`, `rules` (template-based, no model).

### Type detection rules (examples)

| Signal | Detected type |
|---|---|
| Only test files changed | `test` |
| Only `*.md` or `docs/` changed | `docs` |
| Only `package.json` or lockfile changed | `chore` |
| Only CI config changed (`.github/`, etc.) | `ci` |
| Only formatting or whitespace changes | `style` |
| New files with exported functions and no tests | `feat` (candidate) |
| Small edits with "fix", "bug", "error" in surrounding context | `fix` (candidate) |

Ambiguous cases are passed to the model with the rule-based guess as a hint.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Language | TypeScript |
| Package manager | pnpm workspaces |
| Build | tsup (core, cli), Next.js (web), esbuild (vscode) |
| Diff parsing | `parse-diff` or a custom parser |
| CLI prompts | `@clack/prompts` or `inquirer` |
| Git operations | `simple-git` or direct `git` via child process |
| Validation | Zod (config), `@commitlint/lint` (rules) |
| Tests | Vitest |
| Web UI | Next.js, Tailwind CSS |

---

## Build Phases

Time is not a constraint, so each phase is built to a finished, tested state before the next begins.

### Phase 1: Core pipeline
**Goal:** a tested library that turns a diff into structured, filtered, typed input.

- [x] Monorepo scaffold (pnpm workspaces, shared tsconfig, Vitest, CI). Lint still to add
- [x] Diff parser: files, hunks, additions, deletions
- [x] Handle renames, copies, deletions, new files, binary files
- [x] Noise filter: lockfiles, generated code, minified files, snapshots
- [x] Rule-based type detection
- [x] Path-based scope inference
- [ ] Hierarchical summarization for large diffs (deterministic bounded summary done; model-written per-file summaries not built yet)
- [ ] Fixture set of real diffs with expected type and scope (16 generated + 4 from unjs/ofetch; diffs from your own projects still needed)

**Done when:** feeding any fixture diff returns the expected type, scope, and a bounded-size summary.

### Phase 2: Provider abstraction
**Goal:** swappable generation backends, including a fully offline one.

- [x] `Provider` interface
- [x] Anthropic adapter (official SDK, structured output, server-side refusal fallbacks)
- [x] OpenAI adapter (official SDK, strict JSON schema output)
- [x] Ollama adapter (local models)
- [x] Rules-only adapter (template messages, no network)
- [x] Prompt builder with strict output format, validation and bounded regeneration
- [x] Retry and timeout handling
- [x] Secret scanner with redact-or-abort behavior

**Done when:** the same input produces valid messages from every provider, and no secret pattern ever reaches a remote adapter.

### Phase 3: CLI
**Goal:** a usable tool that commits from the terminal.

- [x] `gitmit` reads `git diff --staged`
- [x] Interactive picker with 3 suggestions, plus edit option
- [x] Commit the chosen message
- [x] `--dry-run`, `--provider`, `--config`, `--yes` flags (plus `--model`, `--redact`)
- [x] `prepare-commit-msg` hook installer (`gitmit hook install`)
- [x] Clear errors: no staged changes, not a git repo, missing API key
- [ ] Publish to npm, verify `npx @gitmit/cli` works

**Done when:** a developer can run `npx @gitmit/cli` in any repo and commit with a generated message.

### Phase 4: Configuration
**Goal:** teams get messages that match their conventions.

- [x] Config loading (`.gitmitrc`, `.gitmitrc.json`, `gitmit.config.ts`, `package.json` key, user config)
- [x] Allowed types and scopes (custom types allowed)
- [x] Ticket ID extraction from branch name (e.g. `PROJ-123`) and placement rule
- [x] Max subject length, body style, body line length, language
- [x] Read existing commitlint config so rules aren't duplicated
- [x] Validate every generated message; regenerate on failure (bounded retries)
- [x] Config schema published for editor autocomplete

**Done when:** generated messages pass the repo's commitlint setup without manual fixes.

### Phase 5: Commit splitting
**Goal:** turn one messy staged diff into several focused commits. This is the main differentiator and the riskiest feature.

- [ ] Hunk-level representation of the staged diff
- [ ] Grouping heuristics: file path, change kind, proximity
- [ ] Model-assisted grouping: label each hunk group by intent
- [ ] Present a plan: "Commit 1: fix (hunks 1, 4), Commit 2: refactor (hunks 2, 3, 5)"
- [ ] Let the user reassign hunks before applying
- [ ] Apply with generated patches and `git apply --cached`
- [ ] **Safety:** snapshot the index first (`git write-tree`), restore on any failure
- [ ] Never modify the working tree, only the index
- [ ] Extensive tests on tricky diffs (overlapping hunks, renames, partial files)

**Done when:** splitting works reliably on fixtures, a failed split always restores the original staging state, and the user can abort at any point.

### Phase 6: Web demo and docs
**Goal:** a shareable landing page and documentation site.

- [ ] Next.js app with paste-a-diff demo
- [ ] Rules-only mode by default (no cost per visitor)
- [ ] Optional bring-your-own-key mode, key never stored server-side
- [ ] Side-by-side view: input diff and suggestions
- [ ] Docs: install, config reference, provider setup, splitting guide
- [ ] Animated demo GIF for the README and landing page

**Done when:** a visitor can try the tool in under 30 seconds without signing up.

### Phase 7: VS Code extension
**Goal:** the same engine inside the editor.

- [ ] Button in the Source Control panel
- [ ] Read staged changes via the built-in Git extension API
- [ ] Call `core` and fill the commit message box
- [ ] Settings UI: provider, API key (via SecretStorage), config path
- [ ] Commit splitting view
- [ ] Publish to the VS Code Marketplace (and Open VSX)

**Done when:** a user can generate a message from the Source Control panel with one click.

### Phase 8: Polish and growth
- [ ] Windows and line-ending testing
- [ ] Shell completions
- [ ] Telemetry: none by default (opt-in only, if ever)
- [ ] Contribution guide and issue templates
- [ ] Launch post on the commit-splitting design
- [ ] Benchmark page comparing providers on the fixture set

---

## Configuration Reference

Example `gitmit.config.ts`:

```ts
import { defineConfig } from "@gitmit/cli";

export default defineConfig({
  provider: "anthropic",            // anthropic | openai | ollama | rules
  types: ["feat", "fix", "docs", "style", "refactor", "test", "chore", "ci"],
  scopes: ["web", "api", "ui", "docs"],  // omit to allow any
  scopeFromPaths: {
    "apps/web/**": "web",
    "apps/api/**": "api",
    "packages/ui/**": "ui",
  },
  ticket: {
    fromBranch: "([A-Z]+-\\d+)",    // PROJ-123 from feat/PROJ-123-login
    position: "suffix",              // prefix | suffix | footer
    required: false,
  },
  subjectMaxLength: 72,
  bodyStyle: "bullets",              // none | prose | bullets
  language: "en",
  ignore: ["**/*.lock", "**/dist/**", "**/*.snap"],
  secrets: { onDetect: "abort" },    // abort | redact
  variants: 3,
  bodyLineLength: 72,
  commitlint: true,                  // follow the repo's commitlint config when present
});
```

API keys and models come from environment variables or from a user-level file outside every repository, `~/.config/gitmit/.env` (`%APPDATA%\gitmit\.env` on Windows): `OPENAI_API_KEY`, `OPENAI_MODEL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `OLLAMA_HOST`, `OLLAMA_MODEL`. Keys never go in project config. Without a key, gitmit falls back to the offline rules provider.


Config resolution order: CLI flags, then project config, then user config (`~/.config/gitmit/config.json`), then defaults.

Project config is the first of these found in the repository root: `gitmit.config.{ts,mts,cts,js,mjs,cjs}`, `.gitmitrc.json`, `.gitmitrc` (JSON), or a `"gitmit"` key in `package.json`. JSON files can set `"$schema": "https://unpkg.com/@gitmit/cli/schema.json"` for autocomplete. `gitmit init` writes a starter file and `gitmit config` shows the resolved settings and where they came from.

When the repository has a commitlint config, gitmit loads it with commitlint itself (presets and plugins included). Error-level `type-enum`, `scope-enum`, `header-max-length` and `body-max-line-length` rules narrow gitmit's options, and every suggestion is linted before it is shown; failures are sent back to the model to fix, up to 3 attempts. Set `commitlint: false` to opt out.

---

## CLI Reference

```
gitmit                     Generate suggestions for staged changes
gitmit --dry-run           Show suggestions without committing
gitmit --provider ollama   Override the provider
gitmit --yes               Accept the top suggestion without prompting
gitmit split               Propose and apply a commit split
gitmit hook install        Install the prepare-commit-msg hook
gitmit hook uninstall      Remove the hook
gitmit init                Create a starter config
gitmit config              Print the resolved config
```

---

## Known Challenges

| Challenge | Approach |
|---|---|
| Token limits on large diffs | Filter noise, summarize per file, then combine summaries |
| Secrets in diffs | Scan before any remote call; abort or redact; advertise this behavior |
| Binary files and renames | Handle explicitly in the parser; never send binary content |
| Bad splits corrupting staging | Snapshot index first; restore on failure; only touch the index |
| Inconsistent model output | Strict output format, validation, bounded regeneration |
| Windows paths and line endings | Test on Windows in CI from Phase 3 |
| Provider differences | Same fixtures run against every provider; compare in benchmarks |

---

## Testing Strategy

- **Unit tests:** parser, filter, type detection, scope inference, secret scanner.
- **Fixture tests:** a growing set of real diffs, each with expected type, scope, and an acceptable-message checklist.
- **Provider contract tests:** every adapter must satisfy the same interface tests (mocked network).
- **Splitting tests:** run against temporary git repos; assert the final index and commit history, and that failures restore the original state.
- **CLI end-to-end tests:** run in temp repos with the rules-only provider.
- **CI:** Linux, macOS, and Windows; Node LTS versions.

---

## Distribution and Positioning

- **npm:** publish `@gitmit/core` and `@gitmit/cli` (`npx @gitmit/cli` works with no install; the installed command is `gitmit`).
- **README lead line:** "Works offline. Respects your commitlint rules. Splits messy commits."
- **Demo GIF** at the top of the README.
- **Launch post:** a technical write-up of the commit-splitting design.
- **Where to share:** Hacker News (Show HN), Reddit r/programming and r/node, dev.to, X.
- **Bring-your-own-key** means you never proxy or pay for anyone's usage.

---

## Decisions to Settle Early

1. **Name:** gitmit (decided). npm packages live under the `@gitmit` scope; reserve it on npm and the repo on GitHub.
2. **License:** MIT recommended for adoption.
3. **Default provider:** bring-your-own-key; rules-only as the zero-config fallback.
4. **Monorepo vs. single package:** monorepo is recommended given the multiple surfaces.
5. **Telemetry:** none by default.

---

## Suggested First Steps

1. Reserve the package name on npm and the repo on GitHub.
2. Scaffold the monorepo and set up Vitest and CI.
3. Collect 20 to 30 real diffs from your own projects as the first fixtures.
4. Build Phase 1 against those fixtures before touching any model.
