# Changelog

## 0.1.0

First release.

- Generate commit messages from staged changes, from the Source Control panel or the command palette.
- Split staged changes into focused commits in a review panel: edit messages, move changes between commits, create them all safely.
- Follows the project's gitmit config, commitlint rules and branch ticket IDs, like the `gitmit` CLI.
- OpenAI, Anthropic, Ollama and offline rules. Keys are kept in VS Code's secret storage.
- Secret scan before any remote AI call, with abort or redact.
