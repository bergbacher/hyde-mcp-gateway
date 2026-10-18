// Log field schemas (D23): each app declares `prisma/hyde-json.json` in its own
// repo; `pnpm schemas` copies them from `main` into `schemas/`. The server
// refuses to start without both, since an absent schema would hide every field.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSchema, type LogSchema } from "hyde-json";
import { APPS, type App } from "./config.ts";

/** Where each app declares its schema. */
export const SCHEMA_SOURCES: Readonly<Record<App, { repo: string; path: string; ref: string }>> = {
  shop: { repo: "example-org/shop", path: "prisma/hyde-json.json", ref: "main" },
  crm: { repo: "example-org/crm", path: "prisma/hyde-json.json", ref: "main" },
};

export const SCHEMA_DIR = fileURLToPath(new URL("../schemas/", import.meta.url));

export type Schemas = Readonly<Record<App, LogSchema>>;

export function schemaFile(app: App, dir: string = SCHEMA_DIR): string {
  return join(dir, `${app}.hyde-json.json`);
}

/** Validates one app's schema; its `app` must name the app it is filed under. */
export function parseAppSchema(app: App, json: unknown): LogSchema {
  const schema = parseSchema(json);
  if (schema.app !== app) throw new Error(`log schema: "app" is "${schema.app}", expected "${app}"`);
  return schema;
}

/** Reads and validates every app's schema. Throws naming each missing or invalid file. */
export function loadSchemas(dir: string = SCHEMA_DIR): Schemas {
  const problems: string[] = [];
  const schemas: Partial<Record<App, LogSchema>> = {};
  for (const app of APPS) {
    const file = schemaFile(app, dir);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
      problems.push(missing ? `${app}: ${file} is missing` : `${app}: ${file}: ${(e as Error).message}`);
      continue;
    }
    try {
      schemas[app] = parseAppSchema(app, JSON.parse(raw));
    } catch (e) {
      problems.push(`${app}: ${file}: ${(e as Error).message}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Log schemas not loaded (run \`pnpm schemas\`):\n  ${problems.join("\n  ")}`);
  }
  return Object.freeze(schemas as Record<App, LogSchema>);
}
