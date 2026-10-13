# gitmit

Generate clean, Conventional Commits messages from your staged changes. Works offline, keeps secrets on your machine, and respects your team's rules.

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
gitmit hook install        Fill in a suggestion whenever you run `git commit`
gitmit hook uninstall      Remove the hook
```

## Project settings

Add `.gitmitrc.json` to the repository root:

```json
{
  "types": ["feat", "fix", "docs", "refactor", "test", "chore"],
  "scopeFromPaths": { "apps/web/**": "web", "apps/api/**": "api" },
  "subjectMaxLength": 72,
  "bodyStyle": "bullets"
}
```

MIT licensed. Source and roadmap: https://github.com/sammy440/gitmit
