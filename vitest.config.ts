import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@gitmit/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@gitmit/cli": fileURLToPath(new URL("./packages/cli/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Many tests drive real git (commits, hooks, splits); give them room on slow or busy machines.
    testTimeout: 20_000,
  },
});
