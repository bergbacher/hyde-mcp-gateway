import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseSchema, redactLine, type LogSchema } from "hyde-json";
import { logSources, readLokiConfig } from "../src/config.ts";
import { createLoki } from "../src/loki.ts";
import type { Principal } from "../src/mcp/auth.ts";
import { ERROR_SCAN_LIMIT, countQuery, edgeFields, edgeQuery, logQuery, toEdgeLine } from "../src/mcp/logs.ts";
import { createServer } from "../src/mcp/server.ts";
import { loadEdgeSchema, type Schemas } from "../src/schemas.ts";
import { REGISTRY } from "./helpers.ts";

const RECORDED = readFileSync(new URL("./fixtures/loki/query_range.crm.json", import.meta.url), "utf8");
/** An Edge Services access-log line as Loki returned it for shop (2026-10-18); client IP and host replaced by example values. */
const EDGE_LINE = readFileSync(new URL("./fixtures/loki/edge.shop.line.json", import.meta.url), "utf8").trim();
/** The committed schemas/edge.hyde-json.json. */
const EDGE_SCHEMA = loadEdgeSchema();
const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const URL_BASE = "https://loki.test";
const TOKEN = "read-only-logs-token";

const SOURCES = logSources(REGISTRY);
const CRM = SOURCES.get("crm")!;
const SHOP = SOURCES.get("shop")!;

const crmSchema = parseSchema({
    app: "crm",
    passIds: true,
    fields: {
      action: "visible", level: "visible", error: "visible", timestamp: "visible", service: "visible",
      message: "text", "message.workspaceId": "visible", "message.email": "hidden", "message.err": "visible",
    },
});
const schemas: Schemas = new Map([
  ["crm", crmSchema],
  ["shop", parseSchema({ app: "shop", fields: { action: "visible", level: "visible", message: "text" } })],
]);

/** Raw values the recorded response carries that must never reach a client. */
const SECRETS = ["jane.doe@example.com", "john.roe@example.org", "+49 171 2345678", "sk_live_9fQ2xLmP4vR8tZ1wY6nB3cD7"];

type Respond = (url: URL) => Response | Promise<Response>;

function vector(n: number) {
  return Response.json({ status: "success", data: { resultType: "vector", result: n ? [{ metric: {}, value: [NOW / 1000, String(n)] }] : [] } });
}

const recorded: Respond = (url) =>
  url.pathname.endsWith("/query_range") ? new Response(RECORDED, { headers: { "content-type": "application/json" } }) : vector(42);

/** An MCP client on a server whose Loki is a fake fetch; `requests` records every call. */
async function connect(
  respond: Respond = recorded,
  logSchemas: Schemas = schemas,
  principal: Principal = { client: "claude-code", apps: "*" },
  edgeSchema: LogSchema | null = EDGE_SCHEMA,
) {
  const requests: { url: URL; headers: Headers }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, headers: new Headers(init?.headers) });
    return respond(url);
  }) as typeof globalThis.fetch;
  const loki = createLoki({ url: URL_BASE, token: TOKEN, fetch });
  const server = createServer(principal, { registry: REGISTRY, logs: { schemas: logSchemas, edgeSchema: edgeSchema ?? undefined, loki, sources: SOURCES, now: () => NOW } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]!.text;
    return { isError: result.isError === true, text, json: () => JSON.parse(text) };
  }
  return { client, call, requests };
}

describe("LogQL", () => {
  it("unwraps the envelope twice and filters by service, level and action", () => {
    expect(logQuery(CRM, { level: "error", action: "send-mail" })).toBe(
      '{resource_name="example-crm-prod"} | json | line_format "{{.message}}" | json'
        + ' | service="crm" | level="error" | action="send-mail"',
    );
    expect(logQuery(SHOP)).toBe(
      '{resource_name="example-shop-prod"} | json | line_format "{{.message}}" | json | service="shop"',
    );
    expect(countQuery("Q", 1.5)).toBe("sum(count_over_time(Q [90m]))");
  });
});

describe("query_logs", () => {
  it("redacts every line of a recorded Loki response", async () => {
    const { call } = await connect();
    const result = await call("query_logs", { app: "crm", hours: 24 });
    expect(result.isError).toBe(false);
    for (const secret of SECRETS) expect(result.text).not.toContain(secret);

    const body = result.json();
    expect(body).toMatchObject({ matched: 42, returned: 3 });
    // Each returned payload is exactly what hyde-json makes of the raw line.
    const raw = JSON.parse(RECORDED).data.result.flatMap((s: { values: [string, string][] }) => s.values)
      .sort((a: [string], b: [string]) => (BigInt(b[0]) > BigInt(a[0]) ? 1 : -1));
    expect(body.lines).toHaveLength(raw.length);
    body.lines.forEach((line: { payload: unknown }, i: number) => {
      expect(line.payload).toEqual((redactLine(raw[i][1], crmSchema).line as { message: unknown }).message);
    });

    expect(body.lines.map((l: { timestamp: string }) => l.timestamp)).toEqual([
      "2026-10-18T11:50:00.000Z", "2026-10-18T11:45:00.000Z", "2026-10-18T11:40:00.000Z",
    ]);
    expect(body.lines[0]).toEqual({
      timestamp: "2026-10-18T11:50:00.000Z", action: "invite-member", level: "info",
      payload: { workspaceId: "ws_7f3a", email: "[hidden]", note: "[hidden]" },
    });
    expect(body.lines[1].payload).toBe("retry failed for [email], token [token]");
    expect(body.lines[2].payload.err).toEqual({
      name: "SmtpError",
      message: "550 mailbox [email] unavailable",
      stack: "SmtpError: 550 mailbox [email] unavailable\n    at deliver (/app/lib/mail.ts:41:11)\n    at async sendInvite (/app/lib/invite.ts:88:3)",
    });
  });

  it("sends the built query, the window in ns, the limit and the token", async () => {
    const { call, requests } = await connect();
    await call("query_logs", { app: "crm", hours: 2, level: "error", action: "send-mail", limit: 10 });
    const range = requests.find((r) => r.url.pathname === "/loki/api/v1/query_range")!;
    const instant = requests.find((r) => r.url.pathname === "/loki/api/v1/query")!;
    const query = logQuery(CRM, { level: "error", action: "send-mail" });
    const end = BigInt(NOW) * 1_000_000n;
    expect(Object.fromEntries(range.url.searchParams)).toEqual({
      query, start: String(end - 2n * 3_600_000_000_000n), end: String(end), limit: "10", direction: "backward",
    });
    expect(Object.fromEntries(instant.url.searchParams)).toEqual({ query: countQuery(query, 2), time: String(end) });
    for (const r of requests) expect(r.headers.get("x-token")).toBe(TOKEN);
  });

  it("returns at most `limit` lines and defaults to 24 hours and 100 lines", async () => {
    const { call, requests } = await connect();
    const body = (await call("query_logs", { app: "crm", limit: 2 })).json();
    expect(body).toMatchObject({ matched: 42, returned: 2 });
    await call("query_logs", { app: "crm" });
    const last = requests.findLast((r) => r.url.pathname.endsWith("/query_range"))!;
    expect(last.url.searchParams.get("limit")).toBe("100");
    const span = BigInt(last.url.searchParams.get("end")!) - BigInt(last.url.searchParams.get("start")!);
    expect(span).toBe(24n * 3_600_000_000_000n);
  });

  it.each([
    [{ hours: 1000 }, /at most 168/],
    [{ hours: 0 }, /positive/],
    [{ limit: 501 }, /at most 500/],
    [{ limit: 0 }, /limit/],
    [{ level: "warn" }, /level/],
    [{ action: 'x"} | drop' }, /action must be an action name/],
    [{ app: "other" }, /app/],
  ])("refuses %j before asking Loki", async (args, message) => {
    const { call, requests } = await connect();
    const result = await call("query_logs", { app: "crm", ...args });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(message);
    expect(requests).toHaveLength(0);
  });
});

describe("count_errors", () => {
  it("counts error lines by redacted action", async () => {
    const { call, requests } = await connect();
    const body = (await call("count_errors", { app: "crm", hours: 24 })).json();
    // The fake answers the recorded response whatever the filter; counting is by the line's own action.
    expect(body).toEqual({
      rows: [{ action: "send-mail", count: 2 }, { action: "invite-member", count: 1 }],
      total: 3,
      partial: false,
    });
    const range = requests[0]!.url.searchParams;
    expect(range.get("query")).toBe(logQuery(CRM, { level: "error" }));
    expect(range.get("limit")).toBe(String(ERROR_SCAN_LIMIT));
  });

  it("returns {action, count} rows for shop and says partial when Loki capped the read", async () => {
    const values = Array.from({ length: ERROR_SCAN_LIMIT }, (_, i) => [
      String(BigInt(NOW - i) * 1_000_000n),
      JSON.stringify({ action: i % 3 ? "member-sync" : "mail-send", level: "error", error: true, message: "x", service: "shop" }),
    ]);
    const { call } = await connect(() => Response.json({ status: "success", data: { resultType: "streams", result: [{ stream: {}, values }] } }));
    const body = (await call("count_errors", { app: "shop" })).json();
    expect(body.rows).toEqual([{ action: "member-sync", count: 3333 }, { action: "mail-send", count: 1667 }]);
    expect(body.partial).toBe(true);
  });

  it("refuses hours over the maximum", async () => {
    const { call } = await connect();
    const result = await call("count_errors", { app: "shop", hours: 169 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/at most 168/);
  });
});

describe("Loki failures", () => {
  it.each([
    ["unreachable", () => { throw new TypeError("fetch failed"); }, /^Loki is unreachable$/],
    ["HTTP 502", () => new Response("upstream down", { status: 502, statusText: "Bad Gateway" }), /^Loki answered HTTP 502 Bad Gateway$/],
    ["HTTP 401", () => new Response("no", { status: 401 }), /^Loki answered HTTP 401/],
    ["not JSON", () => new Response("<html>"), /^Loki answered with a body that is not JSON$/],
    ["wrong shape", () => Response.json({ status: "success", data: { resultType: "matrix", result: [] } }), /^Loki answered in an unexpected shape$/],
  ])("%s → a tool error naming Loki, no stack", async (_, respond, message) => {
    const { call } = await connect(respond as Respond);
    for (const tool of ["query_logs", "count_errors"]) {
      const result = await call(tool, { app: "crm" });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(message);
      expect(result.text).not.toMatch(/\bat \S+ \(|upstream down|<html>/);
      expect(result.text).not.toContain(TOKEN);
    }
  });

  it("times out", async () => {
    const fetch = ((_: unknown, init?: RequestInit) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof globalThis.fetch;
    const loki = createLoki({ url: URL_BASE, token: TOKEN, fetch, timeoutMs: 10 });
    await expect(loki.instant("q", 0n)).rejects.toThrow(/^Loki did not answer within 0.01s$/);
  });
});

describe("an app without a log schema (D37)", () => {
  it("is refused by both log tools before Loki is asked; the other app still answers", async () => {
    const { call, requests } = await connect(recorded, new Map([["crm", crmSchema]]));
    for (const tool of ["query_logs", "count_errors"]) {
      const result = await call(tool, { app: "shop" });
      expect(result.isError).toBe(true);
      expect(result.text).toBe("shop is not configured: schemas/shop.hyde-json.json is missing");
    }
    expect(requests).toHaveLength(0);
    expect((await call("count_errors", { app: "crm" })).isError).toBe(false);
  });
});

describe("app scope (D39)", () => {
  const shopOnly: Principal = { client: "claude-code", apps: new Set(["shop"]) };

  it("refuses an app outside the token's scope at both log tools, naming client and app, before Loki is asked", async () => {
    const { call, requests } = await connect(recorded, schemas, shopOnly);
    for (const tool of ["query_logs", "count_errors"]) {
      const result = await call(tool, { app: "crm", hours: 24 });
      expect(result.isError).toBe(true);
      expect(result.text).toBe("client claude-code is not authorized for app crm");
    }
    expect(requests).toHaveLength(0);
  });

  it("allows an app in scope", async () => {
    const { call, requests } = await connect(recorded, schemas, shopOnly);
    expect((await call("count_errors", { app: "shop" })).isError).toBe(false);
    expect(requests.length).toBeGreaterThan(0);
  });

  it("allows every registered app with *", async () => {
    const { call, requests } = await connect(recorded, schemas, { client: "agent", apps: "*" });
    for (const app of REGISTRY.apps.keys()) expect((await call("query_logs", { app })).isError).toBe(false);
    expect(requests.length).toBe(2 * REGISTRY.apps.size);
  });

  it("checks the registry first, then the scope, then readiness", async () => {
    const { call, requests } = await connect(recorded, new Map(), shopOnly);
    expect((await call("query_logs", { app: "other" })).text).toMatch(/^unknown app other; registered: /);
    expect((await call("query_logs", { app: "crm" })).text).toBe("client claude-code is not authorized for app crm");
    expect((await call("query_logs", { app: "shop" })).text).toMatch(/^shop is not configured: /);
    expect(requests).toHaveLength(0);
  });
});

describe("edge source (D46)", () => {
  const SHOP_EDGE = '{resource_name="shop-prod-es"}';

  /** The recorded edge line with `patch` applied. */
  function edgeLine(patch: Record<string, unknown> = {}): string {
    return JSON.stringify({ ...JSON.parse(EDGE_LINE), ...patch });
  }

  function streams(lines: string[]): Respond {
    const values = lines.map((line, i) => [String(BigInt(NOW - i * 1000) * 1_000_000n), line]);
    return (url) => url.pathname.endsWith("/query_range")
      ? Response.json({ status: "success", data: { resultType: "streams", result: [{ stream: { resource_type: "edge_content_delivery_service" }, values }] } })
      : vector(values.length);
  }

  it("pins the redaction of the recorded line: no client IP, no query string, no Scaleway ids", () => {
    const { format, envelope, line } = redactLine(EDGE_LINE, EDGE_SCHEMA);
    expect(format).toBe("json");
    expect(envelope).toBeUndefined();
    expect(line).toEqual({
      cache_hit_request: 0,
      file: "access.log",
      http_client_country_code: "FR",
      http_client_request_url: "https://shop.example.invalid/api/sync/outbox/pending?[query]",
      http_client_version: "http/2",
      http_request_client_ip: "[hidden]",
      http_request_datetime: "2026-10-18 18:33:22",
      http_request_method: "GET",
      http_request_ssl_version: "TLSv1.3",
      http_response_code_client: 200,
      http_response_code_origin: 200,
      http_response_content_type: "application/json",
      level: "info",
      pipeline_id: "[hidden]",
      pipeline_name: "shop-prod-es",
      project_id: "[hidden]",
      waf_action: "pass",
      waf_mode: "log_only",
      waf_rule_id: "-",
    });
    const text = JSON.stringify(line);
    expect(text).not.toContain("203.0.113.10");
    expect(text).not.toContain("token=abc");
    expect(toEdgeLine({ ns: String(BigInt(NOW) * 1_000_000n), line: EDGE_LINE }, EDGE_SCHEMA)).toEqual({
      timestamp: "2026-10-18T12:00:00.000Z", action: "GET /api/sync/outbox/pending", level: "info", payload: line,
    });
  });

  it("builds the LogQL: one json stage, error = origin 5xx or not passed by the WAF, action = method and path", () => {
    expect(edgeQuery(SHOP_EDGE)).toBe('{resource_name="shop-prod-es"} | json | __error__=""');
    expect(edgeQuery(SHOP_EDGE, { level: "error" })).toBe(
      '{resource_name="shop-prod-es"} | json | waf_action != "pass" or http_response_code_origin >= 500 | __error__=""',
    );
    expect(edgeQuery(SHOP_EDGE, { level: "info" })).toBe(
      '{resource_name="shop-prod-es"} | json | waf_action = "pass" and http_response_code_origin < 500 | __error__=""',
    );
    expect(edgeQuery(SHOP_EDGE, { action: "GET /api/sync/outbox.json" })).toBe(
      '{resource_name="shop-prod-es"} | json | http_request_method="GET"'
        + ' | http_client_request_url=~"(https?://[^/?#]+)?/api/sync/outbox\\\\.json([?#].*)?" | __error__=""',
    );
  });

  it.each([
    ["origin 200, WAF pass", {}, "info", 200],
    ["origin 502", { http_response_code_origin: 502, http_response_code_client: 502 }, "error", 502],
    ["origin 500 as a string", { http_response_code_origin: "500" }, "error", 500],
    ["origin 404", { http_response_code_origin: 404 }, "info", 404],
    ["WAF block", { waf_action: "block", http_response_code_client: 403 }, "error", 200],
  ])("maps %s to level %s", (_, patch, level, status) => {
    expect(edgeFields(edgeLine(patch))).toMatchObject({ level, status, action: "GET /api/sync/outbox/pending" });
  });

  it("derives the path without query or fragment, scrubbed as free text", () => {
    const action = (url: unknown, method: unknown = "POST") =>
      edgeFields(edgeLine({ http_client_request_url: url, http_request_method: method })).action;
    expect(action("https://shop.example.invalid/api/a?x=1#frag")).toBe("POST /api/a");
    expect(action("/api/a?x=1")).toBe("POST /api/a");
    expect(action("https://shop.example.invalid")).toBe("POST /");
    expect(action("https://shop.example.invalid/api/members/jane.doe@example.com")).toBe("POST /api/members/[email]");
    expect(action(42)).toBeNull();
    expect(action("/api/a", "get it")).toBeNull();
    expect(edgeFields("not json")).toEqual({ action: null, level: null, status: null });
  });

  it("query_logs reads the edge stream and returns redacted lines with method, path, status, country and WAF fields", async () => {
    const { call, requests } = await connect(streams([EDGE_LINE]));
    const result = await call("query_logs", { app: "shop", hours: 24, source: "edge" });
    expect(result.isError).toBe(false);
    expect(result.text).not.toContain("203.0.113.10");
    expect(result.text).not.toContain("token=abc");
    const body = result.json();
    expect(body).toMatchObject({ matched: 1, returned: 1 });
    expect(body.lines[0]).toMatchObject({
      action: "GET /api/sync/outbox/pending",
      level: "info",
      payload: {
        http_request_method: "GET", http_response_code_origin: 200, http_response_code_client: 200,
        http_client_country_code: "FR", waf_action: "pass", waf_mode: "log_only", http_request_client_ip: "[hidden]",
      },
    });
    const range = requests.find((r) => r.url.pathname.endsWith("/query_range"))!;
    expect(range.url.searchParams.get("query")).toBe(edgeQuery(SHOP_EDGE));
  });

  it("query_logs passes level and action into the edge LogQL", async () => {
    const { call, requests } = await connect(streams([]));
    const result = await call("query_logs", { app: "shop", source: "edge", level: "error", action: "GET /api/sync" });
    expect(result.isError).toBe(false);
    const range = requests.find((r) => r.url.pathname.endsWith("/query_range"))!;
    expect(range.url.searchParams.get("query")).toBe(edgeQuery(SHOP_EDGE, { level: "error", action: "GET /api/sync" }));
  });

  it("refuses an action of the other source's form before asking Loki", async () => {
    const { call, requests } = await connect(streams([]));
    const edge = await call("query_logs", { app: "shop", source: "edge", action: "send-mail" });
    expect(edge).toMatchObject({ isError: true, text: 'action must be <METHOD> <path> for source edge, e.g. "GET /api/sync"' });
    const app = await call("query_logs", { app: "shop", action: "GET /api/sync" });
    expect(app).toMatchObject({ isError: true, text: "action must be an action name (letters, digits, _ . : / -)" });
    expect((await call("query_logs", { app: "shop", source: "cdn" })).isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("count_errors groups edge errors by origin status and method and path, without the query", async () => {
    const { call, requests } = await connect(streams([
      edgeLine({ http_response_code_origin: 502, http_client_request_url: "https://shop.example.invalid/api/sync?token=a" }),
      edgeLine({ http_response_code_origin: 502, http_client_request_url: "https://shop.example.invalid/api/sync?token=b" }),
      edgeLine({ http_response_code_origin: 503, http_request_method: "POST", http_client_request_url: "https://shop.example.invalid/api/sync" }),
      edgeLine({ waf_action: "block", http_response_code_client: 403 }),
    ]));
    const result = await call("count_errors", { app: "shop", hours: 168, source: "edge" });
    expect(result.isError).toBe(false);
    expect(result.json()).toEqual({
      rows: [
        { status: 502, action: "GET /api/sync", count: 2 },
        { status: 200, action: "GET /api/sync/outbox/pending", count: 1 },
        { status: 503, action: "POST /api/sync", count: 1 },
      ],
      total: 4,
      partial: false,
    });
    expect(result.text).not.toContain("token=");
    const range = requests[0]!.url.searchParams;
    expect(range.get("query")).toBe(edgeQuery(SHOP_EDGE, { level: "error" }));
    expect(range.get("limit")).toBe(String(ERROR_SCAN_LIMIT));
  });

  it("an app without an edge source is refused at both tools before Loki is asked", async () => {
    const { call, requests } = await connect();
    for (const tool of ["query_logs", "count_errors"]) {
      const result = await call(tool, { app: "crm", source: "edge" });
      expect(result).toMatchObject({ isError: true, text: "crm has no edge source" });
    }
    expect(requests).toHaveLength(0);
  });

  it("does not need the app's own log schema, and is not configured without the edge schema", async () => {
    const withoutAppSchemas = await connect(streams([EDGE_LINE]), new Map());
    expect((await withoutAppSchemas.call("count_errors", { app: "shop", source: "edge" })).isError).toBe(false);
    const withoutEdgeSchema = await connect(streams([EDGE_LINE]), schemas, undefined, null);
    const result = await withoutEdgeSchema.call("query_logs", { app: "shop", source: "edge" });
    expect(result).toMatchObject({ isError: true, text: "shop is not configured: schemas/edge.hyde-json.json is missing" });
    expect(withoutEdgeSchema.requests).toHaveLength(0);
  });
});

describe("tools", () => {
  it("are listed when the server has logs", async () => {
    const { client } = await connect();
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["ping", "query_logs", "count_errors"]);
  });
});

describe("readLokiConfig", () => {
  const env = { COCKPIT_LOGS_URL: "https://abc.logs.cockpit.fr-par.scw.cloud/", COCKPIT_LOGS_READ_TOKEN: "t" };
  it("reads URL and token, takes each app's stream and service from apps.json, takes overrides", () => {
    expect(readLokiConfig(REGISTRY, env)).toEqual({ url: "https://abc.logs.cockpit.fr-par.scw.cloud", token: "t", sources: SOURCES });
    const custom = readLokiConfig(REGISTRY, { ...env, HYDE_APP_CRM_LOKI_STREAM: '{resource_name="x-crm"}' });
    expect(custom.sources.get("shop")).toEqual(SHOP);
    expect(custom.sources.get("crm")).toEqual({ stream: '{resource_name="x-crm"}', service: CRM.service });
  });
  it("names every problem", () => {
    expect(() => readLokiConfig(REGISTRY, {})).toThrow(/COCKPIT_LOGS_URL is not set; COCKPIT_LOGS_READ_TOKEN is not set/);
    expect(() => readLokiConfig(REGISTRY, { ...env, COCKPIT_LOGS_URL: "ftp://x" })).toThrow(/not an http\(s\) URL/);
    expect(() => readLokiConfig(REGISTRY, { ...env, HYDE_APP_SHOP_LOKI_STREAM: '{a="b"} | json' }))
      .toThrow(/HYDE_APP_SHOP_LOKI_STREAM is not a LogQL stream selector/);
  });
});
