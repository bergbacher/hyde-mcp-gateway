// The MCP surface. Every tool takes `app` (D17); `ping` exercises auth and
// routing end to end and is always registered. The other tools are registered
// when the server is given what they read: the log tools with `logs` (schemas
// and a Loki client), `describe_schema` and `query_sql` with `sql` (the app's
// redacted database (D2), whose privileges are the boundary).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { APPS, type App } from "../config.ts";
import { guardStatement } from "../db/guard.ts";
import type { Databases } from "../db/pool.ts";
import { clampLimit, DEFAULT_LIMIT, MAX_LIMIT, runQuery } from "../engine/query.ts";
import { registerLogTools, type LogsOptions } from "./logs.ts";

export const appSchema = z.enum(APPS).describe('The app to read: "shop" or "crm"');

export interface SqlOptions {
  databases: Databases;
  /** Each app's redacted-schema.md, loaded at startup; a missing app is left out. */
  schemas: Partial<Record<App, string>>;
}

export interface ServerOptions {
  /** Schemas, Loki client and stream selectors for `query_logs` and `count_errors`. */
  logs?: LogsOptions;
  /** Redacted databases and schemas for `describe_schema` and `query_sql`. */
  sql?: SqlOptions;
}

/** The tools `createServer` registers for `options`, in registration order. */
export function toolNames(options: ServerOptions = {}): string[] {
  return [
    "ping",
    ...(options.logs ? ["query_logs", "count_errors"] : []),
    ...(options.sql ? ["describe_schema", "query_sql"] : []),
  ];
}

export function createServer(client: string, options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: "hyde-mcp-gateway", version: "0.0.0" });

  server.registerTool(
    "ping",
    {
      description: "Returns the selected app and the calling client. Proves authentication and routing.",
      inputSchema: { app: appSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ app }) => text(JSON.stringify({ app, client })),
  );

  if (options.logs) registerLogTools(server, options.logs);
  if (options.sql) registerSqlTools(server, options.sql);

  return server;
}

function registerSqlTools(server: McpServer, sql: SqlOptions) {
  server.registerTool(
    "describe_schema",
    {
      description:
        "Returns the app's redacted schema: the views query_sql can read and their visible columns. Hidden columns and base tables are not readable.",
      inputSchema: { app: appSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ app }) => {
      const schema = sql.schemas[app];
      if (schema === undefined) return error(`No redacted schema loaded for ${app} (schemas/${app}.redacted-schema.md).`);
      return text(schema);
    },
  );

  server.registerTool(
    "query_sql",
    {
      description:
        `Runs one SELECT (or WITH ... SELECT) over the app's redacted views and returns {columns, rows, truncated}. ` +
        `Rows are capped at \`limit\` (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}) and 1 MB; the statement times out after 15 s. ` +
        `Database errors, such as "Unknown column" for a hidden column, are returned unchanged. Call describe_schema first.`,
      inputSchema: {
        app: appSchema,
        sql: z.string().describe("A single SELECT statement"),
        limit: z.number().int().optional().describe(`Row cap, default ${DEFAULT_LIMIT}, clamped to 1..${MAX_LIMIT}`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ app, sql: statement, limit }) => {
      const guarded = guardStatement(statement);
      if (!guarded.ok) return error(guarded.reason);
      if (!sql.databases.has(app)) return error(`No database configured for ${app} (${app.toUpperCase()}_REDACTED_URL).`);
      try {
        const conn = await sql.databases.connect(app);
        const result = await runQuery(conn, guarded.sql, { limit: clampLimit(limit) });
        return text(JSON.stringify(result));
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

export function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

export function error(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
