import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/mcp/http.ts";
import { readConfig } from "../src/config.ts";
import type { TokenVerifier } from "../src/mcp/auth.ts";
import { REGISTRY } from "./helpers.ts";

const TOKEN = "t".repeat(40);
const SCOPED = "s".repeat(40);
const APPS = [...REGISTRY.apps.keys()];
const config = readConfig(REGISTRY, {
  HYDE_TOKEN_CLAUDE_CODE: TOKEN, HYDE_TOKEN_CLAUDE_CODE_APPS: "*",
  HYDE_TOKEN_AGENT: SCOPED, HYDE_TOKEN_AGENT_APPS: "shop",
});

async function listen(server: ReturnType<typeof createApp>) {
  await new Promise<void>((r) => server.listen(0, r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

async function connect(base: string, token?: string) {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  });
  await client.connect(transport);
  return client;
}

async function ping(client: Client, app: string) {
  const result = await client.callTool({ name: "ping", arguments: { app } });
  const text = (result.content as { text: string }[])[0]!.text;
  return { isError: result.isError === true, text };
}

describe("http with static tokens", () => {
  const app = createApp(config, { registry: REGISTRY });
  let base: string;
  beforeAll(async () => { base = await listen(app); });
  afterAll(() => new Promise<void>((r) => app.close(() => r())));

  it("health needs no token", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });
  it("no token → 401", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
    await expect(connect(base)).rejects.toThrow(/unauthorized/);
  });
  it("wrong token → 401", async () => {
    await expect(connect(base, "x".repeat(40))).rejects.toThrow(/unauthorized/);
  });
  it("a * token lists ping and is allowed every app; ping routes app, client and scope", async () => {
    const client = await connect(base, TOKEN);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["ping"]);
    for (const name of APPS) {
      const result = await ping(client, name);
      expect(JSON.parse(result.text)).toEqual({ app: name, client: "claude-code", apps: APPS, scope: "*" });
    }
    await client.close();
  });
  it("a scoped token is allowed its app and refused the others as unauthorized", async () => {
    const client = await connect(base, SCOPED);
    expect(JSON.parse((await ping(client, "shop")).text)).toEqual({ app: "shop", client: "agent", apps: APPS, scope: ["shop"] });
    expect(await ping(client, "crm")).toEqual({ isError: true, text: "client agent is not authorized for app crm" });
    await client.close();
  });
  it("unknown app → tool error, not a crash", async () => {
    const client = await connect(base, TOKEN);
    const result = await ping(client, "other");
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^unknown app other; registered: /);
    await client.close();
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});

describe("http with an injected verifier", () => {
  const headers: (string | undefined)[] = [];
  const verifier: TokenVerifier = {
    async verify(header) {
      headers.push(header);
      return header === "Bearer from-the-store" ? { client: "stored", apps: new Set(["crm"]) } : undefined;
    },
  };
  const app = createApp(config, { registry: REGISTRY, verifier });
  let base: string;
  beforeAll(async () => { base = await listen(app); });
  afterAll(() => new Promise<void>((r) => app.close(() => r())));

  it("replaces the static tokens: the tools see only its principal", async () => {
    await expect(connect(base, TOKEN)).rejects.toThrow(/unauthorized/);
    const client = await connect(base, "from-the-store");
    expect(JSON.parse((await ping(client, "crm")).text)).toMatchObject({ client: "stored", scope: ["crm"] });
    expect((await ping(client, "shop")).text).toBe("client stored is not authorized for app shop");
    await client.close();
    expect(headers).toContain(`Bearer ${TOKEN}`);
  });
});
