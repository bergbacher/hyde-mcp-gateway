// The MCP surface. Every tool takes `app` (D17); `ping` exercises auth and
// routing end to end. The log tools are registered when the server is given
// the schemas and a Loki client.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { APPS } from "../config.ts";
import { registerLogTools, type LogsOptions } from "./logs.ts";

export const appSchema = z.enum(APPS).describe('The app to read: "shop" or "crm"');

export interface ServerOptions {
  /** Schemas, Loki client and stream selectors for `query_logs` and `count_errors`. */
  logs?: LogsOptions;
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

  return server;
}

export function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

export function error(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
