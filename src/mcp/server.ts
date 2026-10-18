// The MCP surface, composed. `ping` exercises auth and routing end to end,
// lists the registered apps and the caller's scope, and is always registered.
// The tool groups are registered when the server is given their readiness
// (built once at boot, src/boot.ts): the log tools (./logs.ts) with `logs` (a
// Loki client and each app's log sources), `describe_schema` and `query_sql`
// (./sql.ts) with `sql` (each app's redacted database and schema). Every tool
// passes the same gate (./tool.ts), the registry and then the caller's scope;
// each group then asks its readiness and refuses an app that lacks what it
// reads. `createServer` reports the tools it registered.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appNames, type Registry } from "../registry.ts";
import { scopeOf, type Principal } from "./auth.ts";
import { registerLogTools, type LogsOptions } from "./logs.ts";
import { registerSqlTools, type SqlReadiness } from "./sql.ts";
import { appSchema, forApp, text, type Gate, type Registrar } from "./tool.ts";

export interface ServerOptions {
  /** The apps every tool accepts (apps.json). */
  registry: Registry;
  /** Loki client and each app's log sources (log readiness) for `query_logs` and `count_errors`. */
  logs?: LogsOptions;
  /** Each app's SQL readiness (redacted database and schema) for `describe_schema` and `query_sql`. */
  sql?: SqlReadiness;
}

/** The MCP server for `principal`, and the names of the tools it registered, in order. */
export function createServer(principal: Principal, options: ServerOptions): { server: McpServer; tools: string[] } {
  const server = new McpServer({ name: "hyde-mcp-gateway", version: "0.0.0" });
  const tools = register(server, principal, options);
  return { server, tools };
}

/** The names of the tools a server built from `options` registers, in order, without building one. */
export function toolsOf(options: ServerOptions): string[] {
  return register({ registerTool: () => undefined as never }, { client: "", apps: new Set() }, options);
}

/** Registers every tool `options` enables on `target` and returns their names in order. */
function register(target: Registrar, principal: Principal, options: ServerOptions): string[] {
  const tools: string[] = [];
  const registrar: Registrar = {
    registerTool: (name, config, callback) => {
      tools.push(name);
      return target.registerTool(name, config, callback);
    },
  };
  const { registry } = options;
  const gate: Gate = { registry, principal };

  registrar.registerTool(
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

  if (options.logs) registerLogTools(registrar, gate, options.logs);
  if (options.sql) registerSqlTools(registrar, gate, options.sql);

  return tools;
}
