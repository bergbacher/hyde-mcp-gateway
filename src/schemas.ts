// The schema documents the server reads (schemas/README.md):
// - Each registered app's log field schema (D23) and redacted schema
//   (hyde-db), owned by the app repo (apps.json, D38). The schema store
//   (src/schema-store.ts, D58) fetches them at runtime and validates them
//   here; without a read token it reads `schemas/<app>.hyde-json.json` and
//   `schemas/<app>.redacted-schema.md`, written by `pnpm schemas` and
//   `pnpm fetch:redacted-schemas`. An app without one is refused at its tools
//   (D37).
// - The edge schema (D46), `schemas/edge.hyde-json.json`, the one file here
//   that is committed: hyde-mcp-gateway owns it, since no app writes Edge
//   Services access logs. It must be present and valid, or the server does not
//   start.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSchema, type LogSchema } from "hyde-json";
import type { App } from "./registry.ts";

export const SCHEMA_DIR = fileURLToPath(new URL("../schemas/", import.meta.url));

/** The log schemas loaded; an app without one is left out (D37). */
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

/** Validates the text of one app's log schema file. Throws naming what is wrong. */
export function parseLogSchemaText(app: App, text: string): LogSchema {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("the file is not JSON");
  }
  return parseAppSchema(app, json);
}

/** Validates the text of one app's redacted-schema.md: any non-empty text. */
export function parseRedactedSchemaText(text: string): string {
  if (text.trim() === "") throw new Error("the file is empty");
  return text;
}
