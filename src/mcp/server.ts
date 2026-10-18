// The MCP surface, composed. `ping` exercises auth and routing end to end,
// lists the registered apps and the caller's scope, and is always registered.
// The tool groups are registered when the server is given what they read: the
// log tools (./logs.ts) with `logs` (a Loki client and each app's log
// sources), `describe_schema` and `query_sql` (./sql.ts) with `sql` (the
// app's redacted database and schema). Every tool passes the same gate
// (./tool.ts), the registry and then the caller's scope; each group then
// refuses an app that lacks what it reads.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appNames, type Registry } from "../registry.ts";
import { scopeOf, type Principal } from "./auth.ts";
import { registerLogTools, type LogsOptions } from "./logs.ts";
import { registerSqlTools, type SqlOptions } from "./sql.ts";
import { appSchema, forApp, text, type Gate } from "./tool.ts";

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

export function createServer(principal: Principal, options: ServerOptions): McpServer {
  const server = new McpServer({ name: "hyde-mcp-gateway", version: "0.0.0" });
  const { registry } = options;
  const gate: Gate = { registry, principal };

  server.registerTool(
    "ping",
    {
      description:
        "Returns the selected app, the calling client, the registered apps and the apps this client may read (scope, \"*\" for all). " +
        "Proves authentication and routing.",
      inputSchema: { app: appSchema(gate.registry) },
      annotations: { readOnlyHint: true },
    },
    forApp(gate, ({ app }) =>
      text(JSON.stringify({ app, client: principal.client, apps: appNames(registry), scope: scopeOf(principal) }))),
  );

  if (options.logs) registerLogTools(server, gate, options.logs);
  if (options.sql) registerSqlTools(server, gate, options.sql);

  return server;
}
