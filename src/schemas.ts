// The per-app documents in `schemas/`, fetched from each app repo's `main` and
// read once at startup (schemas/README.md):
// - Log field schemas (D23), `<app>.hyde-json.json` via `pnpm schemas`.
// - Redacted schemas (hyde-db), `<app>.redacted-schema.md` via
//   `pnpm fetch:redacted-schemas`, served by `describe_schema`.
// An app whose file is missing is left out, and its tools answer that it is
// not configured (D37). The server refuses to start only when no log schema
// exists or a present one is invalid.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSchema, type LogSchema } from "hyde-json";
import { APPS, type App } from "./config.ts";

/** Where each app declares its log field schema. */
export const SCHEMA_SOURCES: Readonly<Record<App, { repo: string; path: string; ref: string }>> = {
  shop: { repo: "example-org/shop", path: "prisma/hyde-json.json", ref: "main" },
  crm: { repo: "example-org/crm", path: "prisma/hyde-json.json", ref: "main" },
};

export const SCHEMA_DIR = fileURLToPath(new URL("../schemas/", import.meta.url));

/** The log schemas present; an app without one is left out (D37). */
export type Schemas = Readonly<Partial<Record<App, LogSchema>>>;

export function schemaFile(app: App, dir: string = SCHEMA_DIR): string {
  return join(dir, `${app}.hyde-json.json`);
}

export function redactedSchemaFile(app: App, dir: string = SCHEMA_DIR): string {
  return join(dir, `${app}.redacted-schema.md`);
}

/** Validates one app's log schema; its `app` must name the app it is filed under. */
export function parseAppSchema(app: App, json: unknown): LogSchema {
  const schema = parseSchema(json);
  if (schema.app !== app) throw new Error(`log schema: "app" is "${schema.app}", expected "${app}"`);
  return schema;
}

/**
 * Reads and validates the log schema of every app whose file exists. Throws
 * naming each invalid file, or when no app has one.
 */
export function loadSchemas(dir: string = SCHEMA_DIR): Schemas {
  const problems: string[] = [];
  const schemas: Partial<Record<App, LogSchema>> = {};
  for (const app of APPS) {
    const file = schemaFile(app, dir);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`${app}: ${file}: ${(e as Error).message}`);
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
  if (Object.keys(schemas).length === 0) {
    throw new Error(
      `No log schema in ${dir} (run \`pnpm schemas\`):\n  ${APPS.map((app) => `${app}: ${schemaFile(app, dir)} is missing`).join("\n  ")}`,
    );
  }
  return Object.freeze(schemas);
}

/** Each app's `redacted-schema.md`; an app whose file is missing is left out. */
export function loadRedactedSchemas(dir: string = SCHEMA_DIR): Partial<Record<App, string>> {
  const schemas: Partial<Record<App, string>> = {};
  for (const app of APPS) {
    try {
      schemas[app] = readFileSync(redactedSchemaFile(app, dir), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return schemas;
}
