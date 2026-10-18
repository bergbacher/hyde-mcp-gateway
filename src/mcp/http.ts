// HTTP front: `/health` without a token, `/mcp` with one (D16). Each request
// gets its own stateless Streamable HTTP transport, so no session state lives
// in the container and scale-to-zero costs nothing.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "../config.ts";
import { authenticate } from "./auth.ts";
import { createServer, type ServerOptions } from "./server.ts";

export function createApp(config: Config, options: ServerOptions = {}) {
  return createHttpServer(async (req, res) => {
    try {
      await route(req, res, config, options);
    } catch (e) {
      console.error(JSON.stringify({ level: "error", message: e instanceof Error ? e.message : String(e) }));
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    }
  });
}

async function route(req: IncomingMessage, res: ServerResponse, config: Config, options: ServerOptions) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/health") return json(res, 200, { ok: true });
  if (url.pathname !== "/mcp") return json(res, 404, { error: "not found" });

  const client = authenticate(req.headers.authorization, config.clients);
  if (!client) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="hyde-mcp-gateway"');
    return json(res, 401, { error: "unauthorized" });
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createServer(client, options);
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, await body(req));
}

async function body(req: IncomingMessage): Promise<unknown> {
  if (req.method !== "POST") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}
