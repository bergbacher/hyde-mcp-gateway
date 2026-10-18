import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/mcp/http.ts";
import { readConfig } from "../src/config.ts";
import type { Databases } from "../src/db/pool.ts";
import type { Loki } from "../src/loki.ts";
import type { TokenVerifier } from "../src/mcp/auth.ts";
import { readFileSync } from "node:fs";
import { parseSchema } from "hyde-json";
import type { Schemas } from "../src/schemas.ts";
import { buildLogSources } from "../src/sources/index.ts";
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

function fixtureSchemas(): Schemas {
  const dir = new URL("./fixtures/schemas/", import.meta.url);
  return new Map(["shop", "crm"].map((app) => [app, parseSchema(JSON.parse(readFileSync(fileURLToPath(new URL(`${app}.hyde-json.json`, dir)), "utf8")))]));
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

describe("http with GitHub tokens (D59)", () => {
  // Fake GitHub: token → login, the repositories it can read, or a fixed status for /user.
  const GH_SHOP = `ghp_${"a".repeat(36)}`;
  const GH_NONE = `github_pat_${"b".repeat(40)}`;
  const GH_REVOKED = `gho_${"c".repeat(36)}`;
  const GH_DOWN = `ghu_${"d".repeat(36)}`;
  const accounts: Record<string, { login: string; repos: string[] } | number> = {
    [GH_SHOP]: { login: "octocat", repos: ["example-org/shop"] },
    [GH_NONE]: { login: "hubot", repos: [] },
    [GH_REVOKED]: 401,
    [GH_DOWN]: 502,
  };
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const github: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = init?.headers as Record<string, string>;
    requests.push({ url, headers });
    const account = accounts[headers.Authorization!.replace(/^Bearer /, "")];
    if (account === undefined) return new Response("", { status: 401 });
    if (typeof account === "number") return new Response("", { status: account });
    if (url === "https://api.github.com/user") return Response.json({ login: account.login });
    const repo = url.replace("https://api.github.com/repos/", "");
    return account.repos.includes(repo) ? Response.json({ full_name: repo }) : new Response("", { status: 404 });
  };
  let clock = 0;

  // Backends that count every touch.
  const touched: string[] = [];
  const loki: Loki = {
    async queryRange() { touched.push("loki"); return []; },
    async instant() { touched.push("loki"); return 0; },
  };
  const databases: Databases = {
    has: () => true,
    query: (app) => { touched.push(`db:${app}`); return Promise.reject(new Error("reached the database")); },
    close: async () => {},
  };
  const app = createApp(config, {
    registry: REGISTRY,
    logs: {
      sources: buildLogSources({ registry: REGISTRY, schemas: fixtureSchemas(), env: {} }),
      loki,
    },
    sql: { databases, schemas: new Map([["shop", "# shop\n"], ["crm", "# crm\n"]]) },
    github: { fetch: github, now: () => clock },
  });
  let base: string;
  beforeAll(async () => { base = await listen(app); });
  afterAll(() => new Promise<void>((r) => app.close(() => r())));

  it("asks GitHub as the token: /user, then each registered app's repository", async () => {
    requests.length = 0;
    clock += 1_000_000;
    const client = await connect(base, GH_SHOP);
    await client.close();
    expect(requests.map((r) => r.url).sort()).toEqual([
      "https://api.github.com/repos/example-org/crm",
      "https://api.github.com/repos/example-org/shop",
      "https://api.github.com/user",
    ]);
    for (const { headers } of requests) {
      expect(headers).toMatchObject({
        Authorization: `Bearer ${GH_SHOP}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      });
    }
  });

  it("a token that reads shop's repository but not crm's: shop answered with scope [shop], crm refused, no backend touched for crm", async () => {
    touched.length = 0;
    const client = await connect(base, GH_SHOP);
    expect(JSON.parse((await ping(client, "shop")).text)).toEqual({ app: "shop", client: "gh:octocat", apps: APPS, scope: ["shop"] });
    expect(await ping(client, "crm")).toEqual({ isError: true, text: "client gh:octocat is not authorized for app crm" });
    for (const name of ["query_logs", "count_errors", "describe_schema", "query_sql"]) {
      const result = await client.callTool({ name, arguments: { app: "crm", hours: 1, sql: "SELECT 1" } });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0]!.text).toBe("client gh:octocat is not authorized for app crm");
    }
    expect(touched).toEqual([]);
    await client.callTool({ name: "count_errors", arguments: { app: "shop", hours: 1 } });
    await client.callTool({ name: "query_sql", arguments: { app: "shop", sql: "SELECT 1" } });
    expect(touched).toEqual(["loki", "db:shop"]);
    await client.close();
  });

  it("a token that reads no app's repository is a principal with an empty scope: every app refused", async () => {
    const client = await connect(base, GH_NONE);
    for (const name of APPS) {
      expect(await ping(client, name)).toEqual({ isError: true, text: `client gh:hubot is not authorized for app ${name}` });
    }
    await client.close();
  });

  it("a revoked token → 401", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${GH_REVOKED}` } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    await expect(connect(base, GH_REVOKED)).rejects.toThrow(/unauthorized/);
  });

  it("within the TTL GitHub is not asked again; after it, it is", async () => {
    clock += 1_000_000;
    requests.length = 0;
    const first = await connect(base, GH_SHOP);
    await ping(first, "shop");
    await first.close();
    const asked = requests.length;
    expect(asked).toBe(3);
    clock += 299_000;
    const second = await connect(base, GH_SHOP);
    expect(JSON.parse((await ping(second, "shop")).text)).toMatchObject({ client: "gh:octocat", scope: ["shop"] });
    await second.close();
    expect(requests.length).toBe(asked);
    clock += 2_000;
    const third = await connect(base, GH_SHOP);
    await third.close();
    expect(requests.length).toBe(asked + 3);
  });

  it("GitHub 5xx → 503 with a one-line JSON error, no stack, no token; not cached", async () => {
    requests.length = 0;
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${GH_DOWN}` } });
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "token verification unavailable: GitHub answered HTTP 502" });
      expect(text).not.toMatch(/ghu_|at .*\.ts/);
    }
    expect(requests.filter((r) => r.url.endsWith("/user"))).toHaveLength(2);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("static tokens are unchanged and never reach GitHub", async () => {
    requests.length = 0;
    const client = await connect(base, SCOPED);
    expect(JSON.parse((await ping(client, "shop")).text)).toEqual({ app: "shop", client: "agent", apps: APPS, scope: ["shop"] });
    expect(await ping(client, "crm")).toEqual({ isError: true, text: "client agent is not authorized for app crm" });
    await client.close();
    await expect(connect(base, "x".repeat(40))).rejects.toThrow(/unauthorized/);
    expect(requests).toEqual([]);
  });
});
