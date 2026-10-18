// The MCP surface. Every tool takes `app`, a name registered in apps.json
// (D38); a name the registry does not hold is refused at every tool with
// "unknown app <name>; registered: …". `ping` exercises auth and routing end
// to end, lists the registered apps and is always registered. The other tools
// are registered when the server is given what they read: the log tools with
// `logs` (schemas, a Loki client and each app's log source), `describe_schema`
// and `query_sql` with `sql` (the app's redacted database (D2), whose
// privileges are the boundary). A registered app that lacks what a tool reads
// is refused at that tool with "<app> is not configured: <what is missing>"
// (D37); the other apps are unaffected.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { guardStatement } from "../db/guard.ts";
import type { Databases } from "../db/pool.ts";
import { clampLimit, DEFAULT_LIMIT, MAX_LIMIT, runQuery } from "../engine/query.ts";
import { appNames, appVariables, unknownApp, type App, type Registry } from "../registry.ts";
import { registerLogTools, type LogsOptions } from "./logs.ts";

/** The `app` parameter: any string, checked against the registry by `forApp`, so the refusal names the registry. */
export function appSchema(registry: Registry) {
  return z.string().describe(`The app to read, one of: ${appNames(registry).join(", ")}`);
}

/** Wraps a tool handler: a name the registry does not hold is a tool error before the handler runs. */
export function forApp<A extends { app: string }>(
  registry: Registry,
  handler: (args: A) => Promise<CallToolResult> | CallToolResult,
): (args: A) => Promise<CallToolResult> {
  return async (args) => (registry.apps.has(args.app) ? handler(args) : error(unknownApp(args.app, registry)));
}

export interface SqlOptions {
  databases: Databases;
  /** Each app's redacted-schema.md, loaded at startup; a missing app is left out and refused (D37). */
  schemas: ReadonlyMap<App, string>;
}

export interface ServerOptions {
  /** The apps every tool accepts (apps.json). */
  registry: Registry;
  /** Schemas, Loki client and log sources for `query_logs` and `count_errors`. */
  logs?: LogsOptions;
  /** Redacted databases and schemas for `describe_schema` and `query_sql`. */
  sql?: SqlOptions;
}

/** The tools `createServer` registers for `options`, in registration order. */
export function toolNames(options: Omit<ServerOptions, "registry">): string[] {
  return [
    "ping",
    ...(options.logs ? ["query_logs", "count_errors"] : []),
    ...(options.sql ? ["describe_schema", "query_sql"] : []),
  ];
}

export function createServer(client: string, options: ServerOptions): McpServer {
  const server = new McpServer({ name: "hyde-mcp-gateway", version: "0.0.0" });
  const { registry } = options;

  server.registerTool(
    "ping",
    {
      description: "Returns the selected app, the calling client and the registered apps. Proves authentication and routing.",
      inputSchema: { app: appSchema(registry) },
      annotations: { readOnlyHint: true },
    },
    forApp(registry, ({ app }) => text(JSON.stringify({ app, client, apps: appNames(registry) }))),
  );

  if (options.logs) registerLogTools(server, registry, options.logs);
  if (options.sql) registerSqlTools(server, registry, options.sql);

  return server;
}

/** What `app` lacks for `describe_schema` and `query_sql`, as their error names it; empty when ready. */
export function sqlMissing(app: App, sql: SqlOptions | undefined): string[] {
  return [
    ...(sql?.schemas.has(app) ? [] : [`schemas/${app}.redacted-schema.md is missing`]),
    ...(sql?.databases.has(app) ? [] : [`${appVariables(app).redactedUrl} is not set`]),
  ];
}

/** The tool error for an app that lacks what the tool reads (D37). */
export function notConfigured(app: App, missing: string[]): CallToolResult {
  return error(`${app} is not configured: ${missing.join("; ")}`);
}

function registerSqlTools(server: McpServer, registry: Registry, sql: SqlOptions) {
  server.registerTool(
    "describe_schema",
    {
      description:
        "Returns the app's redacted schema: the views query_sql can read and their visible columns. Hidden columns and base tables are not readable.",
      inputSchema: { app: appSchema(registry) },
      annotations: { readOnlyHint: true },
    },
    forApp(registry, ({ app }) => {
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
        app: appSchema(registry),
        sql: z.string().describe("A single SELECT statement"),
        limit: z.number().int().optional().describe(`Row cap, default ${DEFAULT_LIMIT}, clamped to 1..${MAX_LIMIT}`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    forApp(registry, async ({ app, sql: statement, limit }) => {
      const missing = sqlMissing(app, sql);
      if (missing.length > 0) return notConfigured(app, missing);
      const guarded = guardStatement(statement);
      if (!guarded.ok) return error(guarded.reason);
      try {
        const conn = await sql.databases.connect(app);
        const result = await runQuery(conn, guarded.sql, { limit: clampLimit(limit) });
        return text(JSON.stringify(result));
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }),
  );
}

export function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

export function error(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
