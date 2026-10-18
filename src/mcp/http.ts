// HTTP front: `/health` without a token, `/mcp` with one (D16). The token is
// checked by a `TokenVerifier` (D39): GitHub-shaped tokens against GitHub
// (D59), every other one against the static tokens from the config, unless a
// verifier is injected; the server gets the resulting principal. A token that
// cannot be checked right now is a 503 with a one-line JSON error. Each request gets its
// own stateless Streamable HTTP transport, so no session state lives in the
// container and scale-to-zero costs nothing.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "../config.ts";
import type { Registry } from "../registry.ts";
import { CompositeVerifier, StaticTokenVerifier, VerificationUnavailableError, type TokenVerifier } from "./auth.ts";
import { GitHubTokenVerifier, type GitHubVerifierOptions } from "./github-auth.ts";
import { createServer, type ServerOptions } from "./server.ts";

export interface AppOptions extends ServerOptions {
  /** Verifies the bearer token; defaults to `createVerifier`. */
  verifier?: TokenVerifier;
  /** The GitHub verifier's fetch and clock, for tests. */
  github?: Pick<GitHubVerifierOptions, "fetch" | "now">;
}

/** GitHub tokens against GitHub, every other token against `config.clients`. */
export function createVerifier(config: Config, registry: Registry, github: AppOptions["github"] = {}): CompositeVerifier {
  return new CompositeVerifier(
    new GitHubTokenVerifier({ registry, ttlSeconds: config.githubScopeTtlSeconds, ...github }),
    new StaticTokenVerifier(config.clients),
  );
}

export function createApp(config: Config, options: AppOptions) {
  const { verifier: given, github, ...serverOptions } = options;
  const verifier = given ?? createVerifier(config, serverOptions.registry, github);
  return createHttpServer(async (req, res) => {
    try {
      await route(req, res, verifier, serverOptions);
    } catch (e) {
      console.error(JSON.stringify({ level: "error", message: e instanceof Error ? e.message : String(e) }));
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    }
  });
}

async function route(req: IncomingMessage, res: ServerResponse, verifier: TokenVerifier, options: ServerOptions) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/health") return json(res, 200, { ok: true });
  if (url.pathname !== "/mcp") return json(res, 404, { error: "not found" });

  let principal;
  try {
    principal = await verifier.verify(req.headers.authorization);
  } catch (e) {
    if (!(e instanceof VerificationUnavailableError)) throw e;
    console.warn(JSON.stringify({ level: "warn", message: `token verification unavailable: ${e.message}` }));
    res.setHeader("Retry-After", "30");
    return json(res, 503, { error: `token verification unavailable: ${e.message}` });
  }
  if (!principal) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="hyde-mcp-gateway"');
    return json(res, 401, { error: "unauthorized" });
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const { server } = createServer(principal, options);
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
