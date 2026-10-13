# gitmit

Generate clean, Conventional Commits messages from your staged changes. Works offline, keeps secrets on your machine, and respects your team's rules.

**[Website and live demo](https://gitmit-frontend.vercel.app)** · [Documentation](https://gitmit-frontend.vercel.app/docs)

```
npm install -g @gitmit/cli
git add -A
gitmit
```

gitmit shows three suggestions. Pick one to commit, edit it first, or ask for new ones.

## AI providers

gitmit works without any setup using offline rules. For better messages, add an API key to `~/.config/gitmit/.env` (on Windows, `%APPDATA%\gitmit\.env`):

```
OPENAI_API_KEY=sk-...
# or
ANTHROPIC_API_KEY=sk-ant-...
```

Keys can also come from environment variables. Local models work through Ollama with `--provider ollama`.

Before anything is sent to a remote provider, gitmit scans the changes for API keys, tokens, private keys and files like `.env`. If it finds one, it stops and sends nothing unless you choose to send a redacted version.

## Usage

```
gitmit                     Suggest messages for staged changes and commit
gitmit --dry-run           Show suggestions without committing
gitmit --yes               Commit the top suggestion without asking
gitmit --provider <name>   openai, anthropic, ollama or rules (offline)
gitmit --model <name>      Model for the provider
gitmit --redact            Redact secrets instead of stopping
gitmit --push              Push after committing (gitmit commits locally, like git commit)
gitmit split               Split staged changes into several focused commits
gitmit init                Create a starter .gitmitrc.json
gitmit config              Show the settings in effect
gitmit hook install        Fill in a suggestion whenever you run `git commit`
gitmit hook uninstall      Remove the hook
```

## Splitting messy changes

`gitmit split` turns one big set of staged changes into several focused commits. It groups the changes by intent (with an AI provider) or by area and kind of change (offline), writes a message for each, and lets you move changes between commits or edit messages before anything happens.

It only touches the staging area, never your files. The plan is rehearsed in a temporary index first, and if anything fails, such as a commit hook, your original commit and staged changes are restored exactly. Use `--dry-run` to see the plan, or `--yes` to apply it without asking.

## Team settings

Run `gitmit init` to create `.gitmitrc.json`, or use `gitmit.config.ts`:

```ts
import { defineConfig } from "@gitmit/cli";

export default defineConfig({
  types: ["feat", "fix", "docs", "refactor", "test", "chore"],
  scopeFromPaths: { "apps/web/**": "web", "apps/api/**": "api" },
  ticket: { position: "suffix" }, // PROJ-123 from feat/PROJ-123-login
  subjectMaxLength: 72,
  bodyStyle: "bullets",
});
```

- **commitlint:** if the repository has a commitlint config, gitmit follows it and lints every suggestion before showing it. Set `commitlint: false` to opt out.
- **Personal defaults** go in `~/.config/gitmit/config.json`; project settings override them.
- **`gitmit config`** shows the settings in effect and where each came from.

MIT licensed. Website: https://gitmit-frontend.vercel.app · Source: https://github.com/sammy440/gitmit
