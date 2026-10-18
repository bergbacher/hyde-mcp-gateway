// The SQL tools: `describe_schema` and `query_sql` read the app's redacted
// database (D2), whose privileges are the boundary, and its redacted schema.
// An app that lacks either is refused before the database is asked (D37).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { guardStatement } from "../db/guard.ts";
import { DEFAULT_LIMIT, MAX_LIMIT, type Databases } from "../db/pool.ts";
import { appVariables, type App } from "../registry.ts";
import { appSchema, error, forApp, notConfigured, text, type Gate } from "./tool.ts";

export interface SqlOptions {
  databases: Databases;
  /** Each app's redacted-schema.md, read per call (the schema store's live map, D58); a missing app is left out and refused (D37). */
  schemas: ReadonlyMap<App, string>;
}

/** What `app` lacks for `describe_schema` and `query_sql`, as their error names it; empty when ready. */
export function sqlMissing(app: App, sql: SqlOptions | undefined): string[] {
  return [
    ...(sql?.schemas.has(app) ? [] : ["redacted schema is missing"]),
    ...(sql?.databases.has(app) ? [] : [`${appVariables(app).redactedUrl} is not set`]),
  ];
}

export function registerSqlTools(server: McpServer, gate: Gate, sql: SqlOptions) {
  server.registerTool(
    "describe_schema",
    {
      description:
        "Returns the app's redacted schema: the views query_sql can read and their visible columns. Hidden columns and base tables are not readable.",
      inputSchema: { app: appSchema(gate.registry) },
      annotations: { readOnlyHint: true },
    },
    forApp(gate, ({ app }) => {
      const missing = sqlMissing(app, sql);
      if (missing.length > 0) return notConfigured(app, missing);
      return text(sql.schemas.get(app)!);
    }),
  );

  server.registerTool(
    "query_sql",
    {
      description:
        `Runs one SELECT (or WITH ... SELECT) over the app's redacted views and returns {columns, rows, truncated}. ` +
        `Rows are capped at \`limit\` (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}) and 1 MB; the statement times out after 15 s. ` +
        `Database errors, such as "Unknown column" for a hidden column, are returned unchanged. Call describe_schema first.`,
      inputSchema: {
        app: appSchema(gate.registry),
        sql: z.string().describe("A single SELECT statement"),
        limit: z.number().int().optional().describe(`Row cap, default ${DEFAULT_LIMIT}, clamped to 1..${MAX_LIMIT}`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    forApp(gate, async ({ app, sql: statement, limit }) => {
      const missing = sqlMissing(app, sql);
      if (missing.length > 0) return notConfigured(app, missing);
      const guarded = guardStatement(statement);
      if (!guarded.ok) return error(guarded.reason);
      try {
        return text(JSON.stringify(await sql.databases.query(app, guarded.sql, limit)));
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }),
  );
}
