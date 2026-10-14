# Changelog

## 0.2.0

- **Sign in with GitHub** to use the API key saved in your gitmit account: save it once at gitmit-frontend.vercel.app/account and use it in VS Code, the CLI and on the website. Uses VS Code's built-in GitHub sign-in.
- Your changes are still read, filtered and secret-scanned locally; only the final summary is relayed.
- Shorter messages for small changes: no body when the header says it all.

## 0.1.0

First release.

- Generate commit messages from staged changes, from the Source Control panel or the command palette.
- Split staged changes into focused commits in a review panel: edit messages, move changes between commits, create them all safely.
- Follows the project's gitmit config, commitlint rules and branch ticket IDs, like the `gitmit` CLI.
- OpenAI, Anthropic, Ollama and offline rules. Keys are kept in VS Code's secret storage.
- Secret scan before any remote AI call, with abort or redact.
