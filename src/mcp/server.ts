// The MCP surface. Every tool takes `app` (D17); `ping` exercises auth and
// routing end to end and is the only tool until the logs and SQL tickets land.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { APPS } from "../config.ts";

export const appSchema = z.enum(APPS).describe('The app to read: "shop" or "crm"');

export function createServer(client: string): McpServer {
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

  return server;
}

export function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

export function error(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
