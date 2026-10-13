# @gitmit/core

The engine behind [gitmit](https://www.npmjs.com/package/@gitmit/cli): turns a git diff into Conventional Commits suggestions. It has no terminal or editor code, so it works in a CLI, a web page or an editor extension.

```ts
import { analyze, generate, createProvider } from "@gitmit/core";

const analysis = analyze(diff); // type, scope, noise filtering, size-bounded summary
const { suggestions } = await generate(diff, {
  provider: createProvider("openai", { apiKey: process.env.OPENAI_API_KEY }),
});
console.log(suggestions[0].message);
```

Providers: `openai`, `anthropic`, `ollama`, and `rules` (offline, no network). Remote providers only receive input that passed the secret scanner.

MIT licensed. Source: https://github.com/sammy440/gitmit
