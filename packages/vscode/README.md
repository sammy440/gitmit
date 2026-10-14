# gitmit for VS Code

**Convention-compliant commit messages from your staged changes, right in the Source Control panel.** gitmit follows your team's commitlint rules, keeps secrets on your machine, works offline, and can split a messy set of changes into focused commits.

[Website and live demo](https://gitmit-frontend.vercel.app) · [Documentation](https://gitmit-frontend.vercel.app/docs) · [CLI on npm](https://www.npmjs.com/package/@gitmit/cli) · [Source](https://github.com/sammy440/gitmit)

## Features

### ✨ Generate a commit message

Stage your changes and click the **✨ sparkle** button at the top of the Source Control panel (or run **gitmit: Generate Commit Message**). Pick one of three suggestions and it goes into the commit message box, where you can still edit it.

- **Rules first, AI second.** The commit type (`feat`, `fix`, `docs`, ...) and scope come from deterministic rules. When the rules are sure (only docs changed, a version bump), the AI can't override them.
- **Nothing staged?** gitmit offers to stage everything for you.

### 🌳 Split into focused commits

Staged a fix, a dependency bump and some docs at once? Click the **🌳 tree** button (or run **gitmit: Split into Focused Commits**). gitmit proposes one commit per logical change and opens a panel where you can:

- read each commit's message and the changes in it,
- edit any message,
- move a change to another commit, or into a new one (messages are rewritten),
- create all the commits with one click.

Splitting only touches the staging area, never your files. The plan is rehearsed before anything changes, and if something fails (for example a pre-commit hook), your original commit and staged changes are restored exactly.

### 📏 Your team's rules

gitmit reads the same configuration as the `gitmit` command line tool:

- **Project config:** `gitmit.config.ts`, `.gitmitrc.json`, or a `"gitmit"` key in `package.json`.
- **commitlint:** if your repository has a commitlint config, gitmit adopts its types, scopes and length limits, and checks every suggestion against it before you see it.
- **Ticket IDs:** on a branch like `feat/PROJ-123-login`, gitmit can add `PROJ-123` to every message.

See the [configuration docs](https://gitmit-frontend.vercel.app/docs/configuration).

### 🔒 Secrets stay on your machine

Before anything is sent to a remote AI, gitmit scans the staged changes for API keys, tokens, private keys and files like `.env`. If it finds something, nothing is sent: you see what was found and can unstage it, or choose to send a version with the secrets replaced by markers.

## Getting started

1. Install the extension.
2. Optional: give gitmit an AI key, either way works:
   - **Sign in with GitHub** (**gitmit: Sign In with GitHub**) to use the key saved in your [gitmit account](https://gitmit-frontend.vercel.app/account). Save it once there and it works here, in the CLI and on the website.
   - Or run **gitmit: Set API Key** and paste an OpenAI or Anthropic key.

   Without either, gitmit writes messages offline from rules alone.
3. Stage some changes and click ✨ in the Source Control panel.

## AI providers

| Provider | Setup |
|---|---|
| **Your gitmit account** | Run **gitmit: Sign In with GitHub**. Uses the key saved at [gitmit-frontend.vercel.app/account](https://gitmit-frontend.vercel.app/account). Your changes are scanned and summarized locally; only the summary goes through gitmit's server. |
| **OpenAI** | Run **gitmit: Set API Key** and choose OpenAI. |
| **Anthropic** | Run **gitmit: Set API Key** and choose Anthropic. |
| **Ollama** (local models) | Set `gitmit.provider` to `ollama`. Nothing leaves your machine. |
| **Offline rules** | Works with no setup. No AI, no network. |

Keys are stored in VS Code's encrypted secret storage, never in settings files. gitmit also finds keys where the CLI does: the `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` environment variables, and `~/.config/gitmit/.env`.

## Commands

| Command | What it does |
|---|---|
| **gitmit: Generate Commit Message** | Suggest messages for the staged changes and fill the commit box. |
| **gitmit: Split into Focused Commits** | Propose a split, review it, and create the commits. |
| **gitmit: Set API Key** | Save an OpenAI or Anthropic key in secret storage. |
| **gitmit: Remove API Key** | Delete a saved key. |
| **gitmit: Sign In with GitHub** | Use the key saved in your gitmit account. |
| **gitmit: Sign Out** | Sign out of your gitmit account in VS Code. |
| **gitmit: Manage Account** | Open your account page: keys, devices, deletion. |
| **gitmit: Open Settings** | Open gitmit's settings. |

## Settings

| Setting | Default | Description |
|---|---|---|
| `gitmit.provider` | `auto` | `auto`, `account`, `openai`, `anthropic`, `ollama` or `rules`. `auto` uses the project config if it names a provider, otherwise a local key, otherwise your gitmit account if signed in, otherwise offline rules. |
| `gitmit.model` | (provider default) | For example `gpt-5-mini` or `claude-opus-5-5`. |
| `gitmit.ollamaHost` | `http://localhost:11434` | Ollama server URL. |
| `gitmit.showSuggestions` | `true` | Pick from several suggestions. When off, the top suggestion goes straight into the commit box. |
| `gitmit.onSecretFound` | `ask` | `ask`, `abort` or `redact`, when the staged changes look like they contain a secret. |
| `gitmit.configPath` | (auto) | A gitmit config file, relative to the repository root. |

## Troubleshooting

- **Details of any error** are in **View → Output → gitmit**.
- **"Could not load the commitlint config"**: your commitlint config extends a preset that isn't installed (run your package manager's install), or it's written in TypeScript (`commitlint.config.ts`), which the extension doesn't load. Use a `.js` or `.json` commitlint config, or set `"commitlint": false` in the gitmit config.
- **More:** see the [troubleshooting docs](https://gitmit-frontend.vercel.app/docs/troubleshooting).

## Also available

- **Command line:** `npm install -g @gitmit/cli`, then `gitmit` in any repository. Includes a git hook that fills in a suggestion whenever you run `git commit`.
- **Try it in your browser:** [gitmit-frontend.vercel.app](https://gitmit-frontend.vercel.app)

## License

MIT
