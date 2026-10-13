// Bundles the extension and everything it uses (gitmit, the AI SDKs, commitlint) into dist/extension.js.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  format: "cjs",
  platform: "node",
  target: "node20",
  // typescript (3.5 MB) is only loaded by commitlint for commitlint.config.ts files; leaving it out
  // keeps the extension small. JSON, YAML and JavaScript commitlint configs work as usual.
  external: ["vscode", "typescript"],
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
  // Some bundled code reads import.meta.url; give it this file's URL in CommonJS.
  define: { "import.meta.url": "__gitmitImportMetaUrl" },
  banner: { js: 'const __gitmitImportMetaUrl = require("url").pathToFileURL(__filename).href;' },
};

// gitmit.config.ts files `import { defineConfig } from "@gitmit/cli"`; the config loader
// resolves that import to dist/index.js next to the bundle.
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.js", "exports.defineConfig = (config) => config;\n");

// jiti (which loads gitmit.config.ts) requires its transpiler at runtime as "../dist/babel.cjs",
// relative to the bundle. It only uses Node built-ins, so ship it next to the bundle.
const require = createRequire(import.meta.url);
const jitiDir = dirname(require.resolve("jiti/package.json", { paths: [dirname(require.resolve("@gitmit/cli/package.json"))] }));
copyFileSync(join(jitiDir, "dist", "babel.cjs"), "dist/babel.cjs");

// commitlint's config validator requires "./commitlint.schema.json" at runtime, relative to the bundle.
const loadDir = dirname(require.resolve("@commitlint/load/package.json", { paths: [dirname(require.resolve("@gitmit/cli/package.json"))] }));
const validatorDir = dirname(require.resolve("@commitlint/config-validator/package.json", { paths: [loadDir] }));
copyFileSync(join(validatorDir, "lib", "commitlint.schema.json"), "dist/commitlint.schema.json");

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
