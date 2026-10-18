// The per-app documents in `schemas/`, fetched from each registered app's repo
// (apps.json, D38) and read once at startup (schemas/README.md):
// - Log field schemas (D23), `<app>.hyde-json.json` via `pnpm schemas`.
// - Redacted schemas (hyde-db), `<app>.redacted-schema.md` via
//   `pnpm fetch:redacted-schemas`, served by `describe_schema`.
// - The edge schema (D46), `edge.hyde-json.json`, is the one file here that is
//   committed: hyde-mcp-gateway owns it, since no app writes Edge Services access
//   logs. It must be present and valid, or the server does not start.
// An app whose file is missing is left out, and its tools answer that it is
// not configured (D37). The server refuses to start only when no log schema
// exists or a present one is invalid.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSchema, type LogSchema } from "hyde-json";
import { appNames, type App, type Registry } from "./registry.ts";

export const SCHEMA_DIR = fileURLToPath(new URL("../schemas/", import.meta.url));

/** The log schemas present; an app without one is left out (D37). */
export type Schemas = ReadonlyMap<App, LogSchema>;

export function schemaFile(app: App, dir: string = SCHEMA_DIR): string {
  return join(dir, `${app}.hyde-json.json`);
}

export function redactedSchemaFile(app: App, dir: string = SCHEMA_DIR): string {
  return join(dir, `${app}.redacted-schema.md`);
}

export const EDGE_SCHEMA = "edge";

export function edgeSchemaFile(dir: string = SCHEMA_DIR): string {
  return join(dir, `${EDGE_SCHEMA}.hyde-json.json`);
}

/** Reads and validates the committed edge schema. Throws naming the file when it is missing or invalid. */
export function loadEdgeSchema(dir: string = SCHEMA_DIR): LogSchema {
  const file = edgeSchemaFile(dir);
  try {
    return parseAppSchema(EDGE_SCHEMA, JSON.parse(readFileSync(file, "utf8")));
  } catch (e) {
    throw new Error(`Edge log schema ${file} not loaded: ${(e as Error).message}`);
  }
}

/** Validates one app's log schema; its `app` must name the app it is filed under. */
export function parseAppSchema(app: App, json: unknown): LogSchema {
  const schema = parseSchema(json);
  if (schema.app !== app) throw new Error(`log schema: "app" is "${schema.app}", expected "${app}"`);
  return schema;
}

/**
 * Reads and validates the log schema of every registered app whose file
 * exists. Throws naming each invalid file, or when no app has one.
 */
export function loadSchemas(registry: Registry, dir: string = SCHEMA_DIR): Schemas {
  const problems: string[] = [];
  const schemas = new Map<App, LogSchema>();
  for (const app of appNames(registry)) {
    const file = schemaFile(app, dir);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`${app}: ${file}: ${(e as Error).message}`);
      continue;
    }
    try {
      schemas.set(app, parseAppSchema(app, JSON.parse(raw)));
    } catch (e) {
      problems.push(`${app}: ${file}: ${(e as Error).message}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Log schemas not loaded (run \`pnpm schemas\`):\n  ${problems.join("\n  ")}`);
  }
  if (schemas.size === 0) {
    throw new Error(
      `No log schema in ${dir} (run \`pnpm schemas\`):\n  ${appNames(registry).map((app) => `${app}: ${schemaFile(app, dir)} is missing`).join("\n  ")}`,
    );
  }
  return schemas;
}

/** Each registered app's `redacted-schema.md`; an app whose file is missing is left out. */
export function loadRedactedSchemas(registry: Registry, dir: string = SCHEMA_DIR): ReadonlyMap<App, string> {
  const schemas = new Map<App, string>();
  for (const app of appNames(registry)) {
    try {
      schemas.set(app, readFileSync(redactedSchemaFile(app, dir), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return schemas;
}
