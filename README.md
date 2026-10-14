# gitmit

**Clean, convention-compliant commit messages from your staged changes. Works offline, keeps secrets on your machine, follows your team's rules, and splits messy changes into focused commits.**

[![npm](https://img.shields.io/npm/v/@gitmit/cli?label=%40gitmit%2Fcli)](https://www.npmjs.com/package/@gitmit/cli)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![website](https://img.shields.io/badge/try_it-in_your_browser-88d982)](https://gitmit-frontend.vercel.app)

**[Try it in your browser](https://gitmit-frontend.vercel.app)** · [Documentation](https://gitmit-frontend.vercel.app/docs) · [npm](https://www.npmjs.com/package/@gitmit/cli)

```
$ git add -A
$ gitmit

  1. feat(auth): add password reset flow with email token
     - add reset request endpoint and token expiry check
     - send the reset link through the existing mailer

  2. feat(auth): support resetting a forgotten password
  3. feat(auth): add password reset via emailed token

  ● Pick a message
  │ ● 1. feat(auth): add password reset flow with email token
  │ ○ 2. feat(auth): support resetting a forgotten password
  │ ○ 3. feat(auth): add password reset via emailed token
  │ ○ Generate new suggestions
  │ ○ Cancel
```

---

## Contents

- [Why gitmit](#why-gitmit)
- [Install](#install)
- [Quick start](#quick-start)
- [Choosing an AI provider](#choosing-an-ai-provider)
- [Commands](#commands)
- [Splitting messy changes](#splitting-messy-changes)
- [Pull requests](#pull-requests)
- [The git hook](#the-git-hook)
- [Team configuration](#team-configuration)
- [commitlint](#commitlint)
- [Ticket IDs from branch names](#ticket-ids-from-branch-names)
- [Privacy and secrets](#privacy-and-secrets)
- [How it works](#how-it-works)
- [Using the engine in your own tools](#using-the-engine-in-your-own-tools)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Roadmap](#roadmap)
- [License](#license)

---

## Why gitmit

Most AI commit tools send your whole diff to a model and paste back whatever comes out. gitmit is built differently:

- **Rules first, AI second.** The commit type (`feat`, `fix`, `docs`, ...) and scope are worked out from your changes by deterministic rules. When the rules are sure (only tests changed, only docs changed, a version bump), the AI is not allowed to override them. The model's job is the part rules can't do: describing *what* changed and *why*.
- **Your team's rules, enforced.** If your repository uses [commitlint](https://commitlint.js.org), every suggestion is checked against it before you see it. Allowed types, scopes, length limits and ticket IDs come from your config.
- **Secrets never leave your machine.** Before anything is sent to a remote AI, gitmit scans for API keys, tokens, private keys and files like `.env`. If it finds one, nothing is sent.
- **Works offline.** No API key? gitmit still writes messages, using rules alone. Prefer local models? Use [Ollama](https://ollama.com).
- **Splits messy changes.** Staged three unrelated things at once? `gitmit split` turns them into focused commits, safely.
- **Writes pull requests too.** `gitmit pr` describes your whole branch for reviewers, fills in your PR template, and can open the pull request for you.
- **Noise is ignored.** Lockfiles, build output, minified files, snapshots and binaries are recognized and never sent to a model, so they don't drown out the real change or cost you tokens.

---

## Install

Requires **Node.js 20.12 or later** and **git**.

```bash
npm install -g @gitmit/cli
```

This installs the `gitmit` command. To see it work before installing anything, paste a diff into the [online demo](https://gitmit-frontend.vercel.app). It runs offline in your browser.

To try the CLI without installing:

```bash
npx @gitmit/cli
```

---

## Quick start

```bash
git add -A        # stage your changes as usual
gitmit            # get suggestions, pick one, commit
```

gitmit shows three suggestions. Use the arrow keys to pick one, then:

- **Commit**: commit with that message.
- **Edit in your editor, then commit**: opens your usual git editor with the message filled in.
- **Back to the suggestions**: pick a different one.

You can also choose **Generate new suggestions** or **Cancel** from the list.

### Committing is not pushing

Like `git commit`, gitmit saves commits in your **local** repository. To send them to GitHub (or any remote), run `git push`, or let gitmit do it:

```bash
gitmit --push             # commit, then push
gitmit split --push       # create all the split commits, then push once
```

To always push, set `"push": true` in your [config](#team-configuration); `--no-push` skips it for one run. On a branch that has never been pushed, gitmit pushes to `origin` (or your `remote.pushDefault`) and sets it as the upstream. If a push fails, for example because the remote has commits you don't, your commits are kept and git's explanation is shown; pull, then push again.

Without an API key, gitmit uses offline rules and tells you so. For better messages, add a key (next section).

---

## Choosing an AI provider

gitmit supports five providers:

| Provider | Needs | Data leaves your machine | Default model |
|---|---|---|---|
| `account` | `gitmit login`, with a key saved in your [gitmit account](#your-gitmit-account) | Yes, after the secret scan, through gitmit's server | Your saved model, or the provider's default |
| `openai` | `OPENAI_API_KEY` | Yes, after the secret scan | `gpt-5-mini` |
| `anthropic` | `ANTHROPIC_API_KEY` | Yes, after the secret scan | `claude-opus-5-5` |
| `ollama` | [Ollama](https://ollama.com) running locally | No (unless `OLLAMA_HOST` points to another machine) | `llama3.2` |
| `rules` | Nothing | No | No model; template messages |

### Adding an API key

Put keys in your **personal gitmit file**, which lives outside every repository so it can never be committed by accident:

| System | File |
|---|---|
| macOS and Linux | `~/.config/gitmit/.env` (or `$XDG_CONFIG_HOME/gitmit/.env`) |
| Windows | `%APPDATA%\gitmit\.env` |

```bash
mkdir -p ~/.config/gitmit
echo 'OPENAI_API_KEY=sk-...' >> ~/.config/gitmit/.env
```

The file can hold any of these:

```bash
OPENAI_API_KEY=
OPENAI_MODEL=           # optional, default gpt-5-mini
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=        # optional, default claude-opus-5-5
OLLAMA_HOST=            # optional, default http://localhost:11434
OLLAMA_MODEL=           # optional, default llama3.2
```

Environment variables with the same names work too, and take priority over the file.

### Your gitmit account

Instead of putting a key on every computer, you can save it once in your gitmit account and use it everywhere: on the website, in the CLI and in VS Code.

1. Go to [gitmit-frontend.vercel.app/account](https://gitmit-frontend.vercel.app/account), sign in with GitHub, and save your OpenAI or Anthropic key.
2. In your terminal, run `gitmit login`. It shows a short code; approve it on github.com.
3. In VS Code, run **gitmit: Sign In with GitHub**.

That's it: gitmit now uses your saved key wherever you're signed in. `gitmit account` shows what's saved, and `gitmit logout` signs this computer out.

**How your key is protected:**

- **Write-only.** Once saved, the key can't be read back by anyone, including you. The website only shows its last four characters.
- **Encrypted.** Keys are encrypted with AES-256-GCM. The encryption key is kept only in the server's environment, never in the database.
- **Your code stays on your machine.** The CLI and VS Code read, filter and secret-scan your changes locally, and send only the final summary, the same text the AI provider would receive. gitmit's server adds your key and passes it on.
- **Nothing is logged.** Not prompts, not diffs, not keys.
- **You're in control.** Sign out any device, remove a key, or delete your account and everything in it, from the account page.

Accounts are optional. Everything else in this section works without one.

### Which provider is used

1. `--provider` on the command line, if given.
2. `provider` in your gitmit config, if set.
3. Otherwise, the first provider with a local key: OpenAI, then Anthropic.
4. Otherwise, your gitmit account, if you're signed in.
5. Otherwise, the offline `rules` provider.

Run `gitmit config` at any time to see which provider and model will be used.

### Using Ollama (local models)

```bash
ollama pull llama3.2
gitmit --provider ollama
```

Or set `"provider": "ollama"` in your config. Nothing leaves your machine, so no secret scan is needed. If `OLLAMA_HOST` points to another machine, gitmit treats it as remote and scans first.

---

## Commands

```
gitmit [options]               Suggest messages for staged changes and commit
gitmit split                   Split staged changes into several focused commits
gitmit pr                      Write a pull request title and description for this branch
gitmit pr --create [--draft]   ...then push the branch and open the pull request
gitmit pr --update             ...then replace the open pull request's title and description
gitmit init [--force]          Create a starter .gitmitrc.json
gitmit config                  Show the settings gitmit will use here
gitmit hook install [--force]  Fill in a suggestion whenever you run `git commit`
gitmit hook uninstall          Remove the hook
gitmit login                   Sign in with GitHub to use the key saved in your gitmit account
gitmit logout                  Sign out on this computer
gitmit account                 Show your account and saved keys
```

| Option | What it does |
|---|---|
| `--dry-run` | Show suggestions (or the split plan) without committing. |
| `-y`, `--yes` | Commit the top suggestion (or apply the split) without asking. |
| `--provider <name>` | `account`, `openai`, `anthropic`, `ollama` or `rules`. |
| `--model <name>` | Model for the provider, e.g. `--model gpt-5`. |
| `--config <path>` | Use this config file instead of searching the repository. |
| `--redact` | When a secret is found, send a redacted version instead of stopping. |
| `--push` | Push to the remote after committing. A new branch gets its upstream set, like `git push -u`. |
| `--no-push` | Don't push, even if the config has `"push": true`. |
| `--base <branch>` | For `pr`: the branch to compare with. Defaults to the remote's default branch. |
| `--create`, `--draft`, `--update` | For `pr`: open the pull request (or a draft), or update the open one, with GitHub's CLI. |
| `--force` | For `init` and `hook install`: overwrite an existing file. |
| `-h`, `--help` | Show help. |
| `-v`, `--version` | Show the version. |

### Scripts and CI

When gitmit isn't running in an interactive terminal, it never prompts:

```bash
gitmit --dry-run            # print suggestions, separated by ---
gitmit --yes                # commit the top suggestion
gitmit split --dry-run      # print the split plan
gitmit split --yes          # apply the split plan
gitmit pr                   # print the PR title, a blank line, then the description
gitmit pr --create          # ...and open the pull request
```

Without `--yes` or `--dry-run`, a non-interactive run prints the suggestions and commits nothing.

---

## Splitting messy changes

Staged a bug fix, a dependency bump and some docs all at once? `gitmit split` proposes a separate commit for each:

```
$ git add -A
$ gitmit split

  Proposed commits (4)
  1. chore: bump version to 1.1.0
     package.json
  2. fix(auth): return null when no user is signed in
     src/auth/__tests__/login.test.ts
     src/auth/login.ts
  3. feat(billing): add refund support
     src/billing/pay.ts (2 changes)
  4. docs: add setup guide
     README.md

  ● What next?
  │ ● Create these 4 commits
  │ ○ Move a change to another commit
  │ ○ Edit a commit message
  │ ○ Cancel
```

### How changes are grouped

gitmit breaks your staged changes into **units**. A unit is one hunk (a block of changed lines). A file that can't be split stays one unit: new, deleted, renamed and binary files, permission changes, and files with a single block of changes.

- **With an AI provider**, the model groups units by intent: one commit per logical change, tests kept with the code they test, ordered so earlier commits don't depend on later ones. Its plan must use every unit exactly once. If it doesn't, the model gets one retry with the problems listed, and then gitmit falls back to offline grouping.
- **Offline**, units are grouped by kind and area: build, dependency and tooling changes first, then one commit per area of code (with that area's tests), then docs, then CI.

Each commit then gets its own message, following the same rules as a normal `gitmit` run.

### Adjusting the plan

Before anything happens you can:

- **Move a change to another commit**, or into a brand new one. The affected messages are rewritten.
- **Edit a commit message.**
- **Cancel.** Nothing is changed.

### Safety

Splitting rewrites what's in your staging area, so it is built to be safe:

- **Only the staging area and commits change.** Your files on disk are never touched. Changes you haven't staged stay exactly as they are.
- **Rehearsed first.** Before touching anything, gitmit replays the whole plan in a throwaway staging area and checks that the commits add up to exactly what you staged. If they don't, nothing happens.
- **Restored on failure.** If anything fails partway, for example a pre-commit hook rejecting commit 2, gitmit moves your branch back and restores your staged changes exactly as they were.
- **Refuses to run mid-operation.** It won't split during a merge, rebase, cherry-pick, revert or bisect.

Your normal commit hooks (pre-commit, commit-msg) run for every commit gitmit creates.

**Limits:** the smallest piece gitmit can move is one hunk; lines right next to each other can't go into different commits. If a pre-commit hook reformats staged files while committing (for example lint-staged with Prettier), a split may fail partway; when it does, everything is restored.

---

## Pull requests

On a feature branch, `gitmit pr` writes a pull request title and description from the branch's commits and its overall diff:

```
$ gitmit pr

  3 commits on feat/password-reset, compared with origin/main

  Pull request
  feat(auth): add password reset via emailed link

  ## Summary
  Users who forget their password can now request a reset link by email.
  The link expires after an hour and can only be used once.

  ## Changes
  - Add `POST /auth/reset` and `POST /auth/reset/confirm`
  - Store hashed reset tokens with an expiry
  - Cover the happy path and expired tokens in tests

  ## How to test
  - Request a reset for an existing account and open the emailed link
  - Try the same link twice; the second attempt is rejected

  ● What next?
  │ ● Create the pull request on GitHub
  │ ○ Create it as a draft
  │ ○ Copy to clipboard
  │ ○ Edit in your editor
  │ ○ Write a new version
  │ ○ Done
```

- **The base branch** is the remote's default branch (`origin/HEAD`), falling back to `main` or `master`. Pick another with `--base develop`.
- **The title** follows the same rules as a commit header: your types, scopes, length limit, ticket ID and commitlint config. When the pull request is squash-merged, it becomes a good commit message.
- **Your template is used.** If the repository has a pull request template (`.github/pull_request_template.md`, in the root, in `docs/`, or in `.github/PULL_REQUEST_TEMPLATE/`), gitmit fills it in instead of using its own sections.
- **Creating the pull request** uses [GitHub's CLI](https://cli.github.com). `gitmit pr --create` pushes the branch (setting its upstream if needed) and runs `gh pr create`. If a pull request is already open for the branch, use `gitmit pr --update` to replace its title and description. Without `gh`, copy the text instead.
- **Offline**, the title comes from the rules and the description lists the branch's commits.
- **Secrets** are scanned for before anything is sent, exactly as for commits. Use `--redact` to send a redacted version instead of stopping.

---

## The git hook

Prefer plain `git commit`? Install the hook once per repository:

```bash
gitmit hook install
```

Now `git commit` (without `-m`) opens your editor with a suggestion already filled in, and the other suggestions listed as comments:

```
feat(auth): add password reset flow with email token

- add reset request endpoint and token expiry check
# gitmit alternatives:
#   feat(auth): support resetting a forgotten password
#   feat(auth): add password reset via emailed token

# Please enter the commit message for your changes. ...
```

- **It stays out of the way.** `git commit -m`, `-F`, merges, squashes, amends and commit templates are left alone.
- **It never blocks a commit.** If gitmit can't produce a suggestion (no API key, a secret found, a network problem), it leaves a comment explaining why and git carries on.
- **It respects existing setups.** It installs into your hooks directory, including a custom `core.hooksPath` such as husky's. If a `prepare-commit-msg` hook already exists, gitmit won't replace it unless you pass `--force`, and then it keeps a backup.
- **Removing it:** `gitmit hook uninstall` removes the hook and restores any backup.

---

## Team configuration

Settings that should be shared by everyone on a project go in a config file committed to the repository. Create one with:

```bash
gitmit init
```

### Config files

gitmit uses the first of these it finds in the repository root:

1. `gitmit.config.ts` (also `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`)
2. `.gitmitrc.json`
3. `.gitmitrc` (JSON)
4. A `"gitmit"` key in `package.json`

A TypeScript config gets full autocomplete:

```ts
// gitmit.config.ts
import { defineConfig } from "@gitmit/cli";

export default defineConfig({
  types: ["feat", "fix", "docs", "refactor", "test", "chore"],
  scopeFromPaths: {
    "apps/web/**": "web",
    "apps/api/**": "api",
    "packages/ui/**": "ui",
  },
  ticket: { position: "suffix" },
  subjectMaxLength: 72,
  bodyStyle: "bullets",
});
```

This works even when gitmit is installed globally and the repository doesn't list `@gitmit/cli` as a dependency.

JSON configs get autocomplete through the published schema:

```json
{
  "$schema": "https://unpkg.com/@gitmit/cli/schema.json",
  "types": ["feat", "fix", "docs", "chore"],
  "bodyStyle": "none"
}
```

### Personal defaults

Your own preferences for every repository go in `~/.config/gitmit/config.json` (`%APPDATA%\gitmit\config.json` on Windows), in the same format. Project settings override them.

**Order of priority**, highest first:

1. Command-line flags
2. The project config
3. Your personal config
4. Built-in defaults

Run `gitmit config` to see the result and which file each setting came from. API keys never go in config files; they belong in your environment or your personal `.env`.

### All settings

| Setting | Type | Default | What it does |
|---|---|---|---|
| `provider` | `"openai"` \| `"anthropic"` \| `"ollama"` \| `"rules"` | first provider with a key, else `rules` | Where suggestions come from. |
| `model` | string | per provider | Model name for the provider. |
| `types` | string[] | the 11 Conventional Commits types | Allowed commit types. Custom ones like `"wip"` are fine. |
| `scopes` | string[] | any | Allowed scopes. |
| `scopeFromPaths` | `{ glob: scope }` | built-in rules | Map paths to scopes. The first matching glob wins. |
| `ticket` | object | off | Add a ticket ID from the branch name. See [below](#ticket-ids-from-branch-names). |
| `subjectMaxLength` | number (20 to 200) | `72` | Maximum header length, including any ticket. |
| `bodyStyle` | `"none"` \| `"prose"` \| `"bullets"` | `"bullets"` | Format of the message body. |
| `bodyLineLength` | number (40 to 200) | `72` | Wrap body lines at this width. |
| `language` | string | `"en"` | Language of the description and body, e.g. `"fr"`. |
| `ignore` | string[] | none | Extra globs to treat as noise (listed, never sent to a model). |
| `secrets.onDetect` | `"abort"` \| `"redact"` | `"abort"` | What happens when a secret is found before a remote call. |
| `variants` | number (1 to 5) | `3` | How many suggestions to show. |
| `commitlint` | boolean | `true` | Follow the repository's commitlint config when there is one. |
| `push` | boolean | `false` | Push after every successful commit or split. |

The 11 default types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore` and `revert`.

### How scopes are chosen

Without `scopeFromPaths`, gitmit infers a scope from where the changed files live:

| Path | Scope |
|---|---|
| `apps/web/src/App.tsx` | `web` (also `packages/`, `services/`, `libs/`, `modules/`, `crates/`, `plugins/`, `extensions/`) |
| `src/auth/login.ts` | `auth` (also under `lib/`, `app/`, `pkg/`, `internal/`, `cmd/`) |
| `api/handlers/users.go` | `api` (a top-level folder, unless it's generic like `docs` or `scripts`) |
| `README.md`, `src/index.ts` | no scope |

If the changes span several scopes, gitmit leaves the scope out rather than guess. Consider `gitmit split` in that case.

---

## commitlint

If your repository has a commitlint config (`commitlint.config.js`, `.commitlintrc.json` or any other form commitlint supports, or a `"commitlint"` key in `package.json`), gitmit loads it with commitlint itself. Presets (`extends`), plugins and parser settings behave exactly as in your commit-msg hook.

- **Your rules shape the suggestions.** Error-level `type-enum`, `scope-enum`, `header-max-length` and `body-max-line-length` rules narrow gitmit's options. Where gitmit's config also sets them, the stricter value wins.
- **Every suggestion is linted.** A suggestion that fails is sent back to the model along with the exact rule it broke, for up to 3 attempts in total. You only see messages that pass.
- **Warnings don't block.** Rules at warning level are ignored.

If your commitlint config extends a preset that isn't installed (for example `@commitlint/config-conventional`), gitmit says so. Install your repository's dependencies, or set `"commitlint": false` to opt out.

---

## Ticket IDs from branch names

Working on `feat/PROJ-123-login`? gitmit can add `PROJ-123` to every message:

```json
{ "ticket": { "position": "suffix" } }
```

| `position` | Result |
|---|---|
| `"suffix"` (default) | `feat(auth): add login form (PROJ-123)` |
| `"prefix"` | `feat(auth): PROJ-123 add login form` |
| `"footer"` | `feat(auth): add login form` with a `Refs: PROJ-123` trailer |

- **Pattern:** by default, gitmit looks for IDs like `ABC-123` (`([A-Z][A-Z0-9]+-\d+)`). Set your own with `fromBranch`, a regular expression whose first capture group is the ID. For example, `"^gh-(\\d+)"` takes `1234` from `gh-1234/fix-thing`.
- **Required tickets:** with `"required": true`, gitmit refuses to commit on a branch without a ticket ID.
- **Length:** the ticket counts toward `subjectMaxLength`, and the model is told how much room is left.
- **No duplicates:** an ID the description already mentions isn't added twice.

---

## Privacy and secrets

**What is sent to a remote AI:**

- A summary of your staged changes: file names, change counts, names of added or removed functions and classes, and the changed lines, up to about 12,000 characters. Large diffs are trimmed to fit.
- Your settings: allowed types, the scope, the length limit and so on.

**Where it goes:** straight to the AI provider when you use your own key. When you use your [gitmit account](#your-gitmit-account), it goes through gitmit's server, which adds your saved key and passes it on without logging it.

**What is never sent:**

- **Unstaged changes, and files you didn't stage.**
- **The content of noise files.** Lockfiles, build output, minified files, snapshots, binary files, and anything matching your `ignore` globs. They're listed by name only.
- **Anything flagged by the secret scan.**

### The secret scan

Before any remote call, gitmit scans everything it is about to send for:

- **Keys and tokens:** AWS access and secret keys; GitHub, GitLab, npm and Slack tokens; Slack webhooks; Stripe, Google, SendGrid, OpenAI and Anthropic keys; JWTs.
- **Private keys:** PEM blocks.
- **Embedded credentials:** usernames and passwords in URLs, such as `postgres://user:pass@host`, and hardcoded `password`, `secret`, `api_key` or `token` values.
- **Sensitive files:** `.env` and `.env.*` (except `.env.example` and similar templates), `*.pem`, `*.key`, SSH private keys, `.npmrc`, `.netrc`, `credentials.json` and service-account files.

Obvious placeholders such as `changeme`, `<your-key>` or `${API_KEY}` are ignored.

**When something is found:**

- **By default, gitmit stops and sends nothing.** It shows the file and a masked preview, such as `ghp_…aa`, so you can unstage it.
- **With `--redact`** (or `"secrets": { "onDetect": "redact" }`), it replaces each secret with a marker like `[REDACTED GitHub token]` and withholds sensitive files' content entirely. Before sending, it scans again to confirm nothing remains.
- **In interactive mode,** gitmit asks whether to send a redacted version.

Local providers (`rules`, and Ollama on your own machine) aren't scanned, because nothing leaves your computer.

The diff is always presented to the model as data, with explicit instructions not to follow anything written inside it. That protects against "prompt injection" hidden in code comments.

---

## How it works

```
staged diff
   │
   ▼
[1] Parse          files, hunks, renames, binary files, permission changes
[2] Classify       source, test, docs, CI, config, lockfile, generated, ...
[3] Detect type    rules decide when they can (only docs changed → docs)
[4] Infer scope    from paths and your scopeFromPaths
[5] Summarize      bounded size; noise listed but never included
[6] Secret scan    before any remote call; abort or redact
[7] Generate       the model writes descriptions as structured JSON
[8] Validate       type, scope, length, ticket, commitlint; regenerate on failure
   │
   ▼
suggestions
```

### Type detection

When the rules are certain, the model must use their answer:

| Staged changes | Type |
|---|---|
| Only tests | `test` |
| Only docs (including `examples/`) | `docs` |
| Only CI config | `ci` |
| Only package manifests or lockfiles | `chore` |
| Version bump plus changelog | `chore` |
| Only tooling config (tsconfig, eslint, Docker, ...) | `chore` |
| Only file permissions | `chore` |
| Only whitespace or formatting | `style` |
| Files moved or renamed without edits | `refactor` |

Otherwise the rules make a best guess (for example `feat` for new exported functions, or `fix` for a small edit mentioning a null check or crash), and the model may override it based on what the code actually does.

### Talking to the model

- **OpenAI and Anthropic** are called through their official SDKs with structured outputs, so replies always match the expected JSON format.
- **Anthropic** requests use low effort, since commit messages are a simple task. On supported models, Anthropic's server-side fallback is enabled, so a declined request is retried on a backup model.
- **Retries:** requests time out after 60 seconds (120 for Ollama). Rate limits, server errors and network failures are retried twice with backoff.
- **Invalid suggestions** (wrong type, too long, failing commitlint) go back to the model with the reasons, for up to 3 attempts in total.

---

## Using the engine in your own tools

The engine is published separately as [`@gitmit/core`](https://www.npmjs.com/package/@gitmit/core). It has no terminal or editor code, so it works in scripts, web apps and editor extensions.

```bash
npm install @gitmit/core
```

```ts
import { analyze, createProvider, generate, planSplit } from "@gitmit/core";

// Rules only: type, scope, noise filtering and a size-bounded summary. No network.
const analysis = analyze(diff);
console.log(analysis.type, analysis.scope);

// Suggestions from a provider. Secret scanning and validation are built in.
const { suggestions } = await generate(diff, {
  provider: createProvider("openai", { apiKey: process.env.OPENAI_API_KEY }),
  types: ["feat", "fix", "chore"],
  ticket: { id: "PROJ-123", position: "suffix" },
});
console.log(suggestions[0].message);

// A split plan: which hunks belong in which commit.
const { plan, diff: units } = await planSplit(diff, { provider: createProvider("rules") });
```

`diff` is the output of `git diff --staged`. For `planSplit`, add `--binary` so binary files can be re-applied.

---

## Troubleshooting

**"No staged changes."** Stage files first with `git add`. gitmit only describes what's staged.

**"OPENAI_API_KEY is not set."** You chose `--provider openai` (or set it in config) but no key was found. Add it to `~/.config/gitmit/.env`, or use `--provider rules` to work offline.

**"invalid API key (HTTP 401)" or "unknown model (HTTP 404)".** Check the key, or set a model your account can use with `OPENAI_MODEL` or `ANTHROPIC_MODEL`.

**"Possible secrets found in the staged changes."** Unstage the file named in the message, or re-run with `--redact` if you're sure it's safe to send a redacted version.

**"Could not load the commitlint config."** Your commitlint config extends a preset that isn't installed. Run your package manager's install in the repository, or set `"commitlint": false` in the gitmit config.

**"A ticket ID is required, but the branch has none."** Your config sets `ticket.required`. Rename the branch to include the ID, e.g. `git branch -m feat/PROJ-123-short-name`.

**"Cannot split during a merge."** Finish or abort the merge (or rebase or cherry-pick) first.

**"cannot reach http://localhost:11434; is Ollama running?"** Start Ollama with `ollama serve`. For a missing model, run `ollama pull <model>`.

**The hook does nothing.** It only runs for a plain `git commit` without `-m` or `-F`. Check that it's installed with `gitmit hook install`, and look for a `# gitmit: no suggestion (...)` comment in the editor explaining why.

**"My commits aren't on GitHub."** gitmit commits locally, like `git commit`. Run `git push`, or use `gitmit --push` (or `"push": true` in your config).

**"git push failed. Your commits were kept."** Usually the remote has commits you don't have yet. Run `git pull --rebase`, then `git push`.

**"Your gitmit sign-in has expired or was revoked."** Run `gitmit login` again. Sessions are signed out when you remove them on the account page.

**"No API key is saved in your gitmit account."** Add one at [gitmit-frontend.vercel.app/account](https://gitmit-frontend.vercel.app/account).

**Not sure what settings apply?** Run `gitmit config`.

---

## Development

gitmit is a TypeScript monorepo managed with pnpm (through Corepack, which ships with Node.js).

```
gitmit/
├── packages/
│   ├── core/      @gitmit/core: parsing, classification, providers, secrets, splitting
│   ├── cli/       @gitmit/cli: the gitmit command, config, commitlint, hooks
│   └── vscode/    the VS Code extension
├── fixtures/      real diffs with expected type and scope
└── scripts/       developer tools (try.mjs)
```

```bash
corepack enable          # once, makes `pnpm` available
pnpm install
pnpm build               # build both packages
pnpm test                # run the test suite
pnpm typecheck
```

### Testing

The test suite runs everything without network access:

- **Fixtures:** each folder in `fixtures/` holds an `input.diff` and an `expected.json` with the expected type, scope and dropped noise files. Every fixture runs through every provider.
- **Providers:** OpenAI and Anthropic are exercised through their real SDKs against a simulated network.
- **Secrets:** tests confirm a planted secret never appears in a request body.
- **The CLI:** runs in throwaway git repositories, including real `git commit` runs through the hook.
- **Splitting:** tested against renames, binary files, CRLF line endings, permission changes, missing final newlines and random groupings, and checked to reproduce the staged state exactly.

### Trying the engine on real repositories

```bash
pnpm build
node scripts/try.mjs ~/code/some-repo --history 50    # compare guesses with past commit messages
node scripts/try.mjs ~/code/some-repo --commit HEAD --generate --summary
```

`--history` scores gitmit's type and scope guesses against a repository's own Conventional Commits history, which is the quickest way to find rules worth improving. Diffs where gitmit guesses wrong make good new fixtures.

### Contributing

Issues and pull requests are welcome at [github.com/sammy440/gitmit](https://github.com/sammy440/gitmit). For larger changes, please open an issue first to discuss the approach.

---

## Roadmap

Built:

- Core engine: parsing, noise filtering, type and scope rules, bounded summaries
- AI providers (OpenAI, Anthropic, Ollama, offline rules) and the secret scanner
- The CLI, interactive picker and git hook
- Team configuration, commitlint integration and ticket IDs
- Commit splitting
- A web demo and docs site: [gitmit-frontend.vercel.app](https://gitmit-frontend.vercel.app)
- A VS Code extension: generate messages and split commits from the Source Control panel (`packages/vscode`), on the Marketplace and Open VSX
- gitmit accounts: sign in with GitHub and use one saved key everywhere
- Pull request titles and descriptions (`gitmit pr`)

Next:

- `gitmit release`: a changelog, the next version and a tag from your commits
- Shell completions, Windows polish, and a provider benchmark

---

## License

[MIT](LICENSE)
