// Writes schema.json (for $schema autocomplete in .gitmitrc.json) from the config schema.
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { ConfigSchema } from "../dist/index.js";

const schema = {
  ...z.toJSONSchema(ConfigSchema, { io: "input" }),
  title: "gitmit configuration",
  $id: "https://unpkg.com/@gitmit/cli/schema.json",
};
writeFileSync(new URL("../schema.json", import.meta.url), `${JSON.stringify(schema, null, 2)}\n`);
