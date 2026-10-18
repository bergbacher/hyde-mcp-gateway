import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/mcp/http.ts";
import { readConfig } from "../src/config.ts";
import { REGISTRY } from "./helpers.ts";

const TOKEN = "t".repeat(40);
let base: string;
const app = createApp(readConfig(REGISTRY, { HYDE_TOKEN_CLAUDE_CODE: TOKEN }), { registry: REGISTRY });

beforeAll(async () => {
  await new Promise<void>((r) => app.listen(0, r));
  const address = app.address();
  if (!address || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

async function connect(token?: string) {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  });
  await client.connect(transport);
  return client;
}

describe("http", () => {
  it("health needs no token", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });
  it("no token → 401", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
    await expect(connect()).rejects.toThrow(/unauthorized/);
  });
  it("wrong token → 401", async () => {
    await expect(connect("x".repeat(40))).rejects.toThrow(/unauthorized/);
  });
  it("right token lists ping and routes app and client", async () => {
    const client = await connect(TOKEN);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["ping"]);
    const result = await client.callTool({ name: "ping", arguments: { app: "crm" } });
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual({ app: "crm", client: "claude-code", apps: [...REGISTRY.apps.keys()] });
    await client.close();
  });
  it("unknown app → tool error, not a crash", async () => {
    const client = await connect(TOKEN);
    const result = await client.callTool({ name: "ping", arguments: { app: "other" } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/^unknown app other; registered: /);
    await client.close();
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});
