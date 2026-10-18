import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSchema, scrubText } from "hyde-json";
import { buildLogSources, type LogReader } from "../src/sources/index.ts";
import { loadEdgeSchema } from "../src/schemas.ts";
import { REGISTRY } from "./helpers.ts";

/** An Edge Services access-log line as Loki returned it for shop (2026-10-18); client IP and host replaced by example values. */
const EDGE_LINE = readFileSync(new URL("./fixtures/loki/edge.shop.line.json", import.meta.url), "utf8").trim();
/** The committed schemas/edge.hyde-json.json. */
const EDGE_SCHEMA = loadEdgeSchema();

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const crmSchema = parseSchema({ app: "crm", fields: { action: "visible", level: "visible", message: "text" } });
const BUILT = buildLogSources({ registry: REGISTRY, schemas: new Map([["crm", crmSchema]]), edgeSchema: EDGE_SCHEMA, env: {} });

function readerOf(app: string, source: "app" | "edge"): LogReader {
  const reader = BUILT.reader(app, source);
  if ("missing" in reader) throw new Error(`not configured: ${reader.missing.join("; ")}`);
  return reader;
}

describe("app source", () => {
  it("unwraps the envelope twice and filters by service, level and action", () => {
    expect(readerOf("crm", "app").query({ level: "error", action: "send-mail" })).toEqual({
      logql: '{resource_name="example-crm-prod"} | json | line_format "{{.message}}" | json'
        + ' | service="crm" | level="error" | action="send-mail"',
    });
    expect(readerOf("crm", "app").query({})).toEqual({
      logql: '{resource_name="example-crm-prod"} | json | line_format "{{.message}}" | json | service="crm"',
    });
  });

  it("refuses an action outside its grammar", () => {
    for (const action of ['x"} | drop', "GET /api/sync"]) {
      expect(readerOf("crm", "app").query({ action })).toEqual({ refused: "action must be an action name (letters, digits, _ . : / -)" });
    }
  });

  it("redacts a line by the app's schema and reads action and level from the redacted line", () => {
    const raw = JSON.stringify({ action: "send-mail", level: "error", service: "crm", message: "failed for jane.doe@example.com" });
    const entry = { ns: String(BigInt(NOW) * 1_000_000n), line: raw };
    expect(readerOf("crm", "app").line(entry)).toEqual({
      timestamp: "2026-10-18T12:00:00.000Z", action: "send-mail", level: "error", payload: "failed for [email]",
    });
    expect(readerOf("crm", "app").group(entry)).toEqual({ key: "send-mail", row: { action: "send-mail" } });
    expect(readerOf("crm", "app").line({ ...entry, line: "plain text from jane.doe@example.com" }))
      .toMatchObject({ action: null, level: null, payload: "plain text from [email]" });
  });

  it("is missing without the app's schema (D37)", () => {
    expect(BUILT.reader("shop", "app")).toEqual({ missing: ["log schema is missing"] });
    expect(BUILT.missing("shop", "app")).toEqual(["log schema is missing"]);
    expect(BUILT.missing("crm", "app")).toEqual([]);
  });

  it("follows the live schema map: a schema a refresh loads or replaces applies at once (D58)", () => {
    const schemas = new Map<string, ReturnType<typeof parseSchema>>();
    const live = buildLogSources({ registry: REGISTRY, schemas, env: {} });
    expect(live.missing("crm", "app")).toEqual(["log schema is missing"]);
    schemas.set("crm", crmSchema);
    const entry = { ns: String(BigInt(NOW) * 1_000_000n), line: JSON.stringify({ action: "a", level: "info", message: "m" }) };
    const before = live.reader("crm", "app");
    if ("missing" in before) throw new Error("crm should be configured");
    expect(before.line(entry)).toMatchObject({ action: "a", payload: "m" });
    expect(live.reader("crm", "app")).toBe(before);
    schemas.set("crm", parseSchema({ app: "crm", fields: { action: "visible", level: "visible" } }));
    const after = live.reader("crm", "app");
    if ("missing" in after) throw new Error("crm should be configured");
    expect(after.line(entry)).toMatchObject({ action: "a", payload: "[hidden]" });
    expect(live.groups("crm")).toEqual({ logs: [] });
  });

  it("refuses level waf, which exists for source edge only", () => {
    expect(readerOf("crm", "app").query({ level: "waf" })).toEqual({ refused: 'level "waf" exists for source edge only' });
  });

  it("reads the stream from apps.json unless HYDE_APP_<NAME>_LOKI_STREAM overrides it; refuses an invalid override", () => {
    expect(BUILT.streams("crm")).toEqual({ app: REGISTRY.apps.get("crm")!.loki.stream });
    const custom = buildLogSources({ registry: REGISTRY, schemas: new Map(), env: { HYDE_APP_CRM_LOKI_STREAM: '{resource_name="x-crm"}' } });
    expect(custom.streams("crm")).toEqual({ app: '{resource_name="x-crm"}' });
    expect(() => buildLogSources({ registry: REGISTRY, schemas: new Map(), env: { HYDE_APP_SHOP_LOKI_STREAM: '{a="b"} | json' } }))
      .toThrow(/HYDE_APP_SHOP_LOKI_STREAM is not a LogQL stream selector/);
    // The variables before the HYDE_ prefix are not read.
    const old = buildLogSources({ registry: REGISTRY, schemas: new Map(), env: { LOKI_STREAM_SHOP: '{a="b"}' } });
    expect(old.streams("shop").app).toBe(REGISTRY.apps.get("shop")!.loki.stream);
  });
});

describe("edge source (D46)", () => {
  const SHOP_EDGE = '{resource_name="shop-prod-es"}';

  it("is missing for an app without edge in apps.json, and without the edge schema (D53)", () => {
    expect(BUILT.reader("crm", "edge")).toEqual({ missing: ["no edge stream in apps.json"] });
    const noSchema = buildLogSources({ registry: REGISTRY, schemas: new Map(), env: {} });
    expect(noSchema.missing("shop", "edge")).toEqual(["schemas/edge.hyde-json.json is missing"]);
    expect(noSchema.missing("crm", "edge")).toEqual(["no edge stream in apps.json", "schemas/edge.hyde-json.json is missing"]);
    expect(BUILT.missing("shop", "edge")).toEqual([]);
  });

  it("does not need the app's own log schema", () => {
    expect(BUILT.missing("shop", "app")).not.toEqual([]);
    expect("query" in BUILT.reader("shop", "edge")).toBe(true);
  });

  it("builds the LogQL: one json stage, error = origin or client 5xx, waf = WAF block without 5xx, action = method and path", () => {
    const query = (filter: Parameters<LogReader["query"]>[0]) => readerOf("shop", "edge").query(filter);
    expect(query({})).toEqual({ logql: '{resource_name="shop-prod-es"} | json | __error__=""' });
    expect(query({ level: "error" })).toEqual({
      logql: '{resource_name="shop-prod-es"} | json | http_response_code_origin >= 500 or http_response_code_client >= 500 | __error__=""',
    });
    expect(query({ level: "waf" })).toEqual({
      logql: '{resource_name="shop-prod-es"} | json | waf_action = "block"'
        + ' | http_response_code_origin < 500 | http_response_code_client < 500 | __error__=""',
    });
    expect(query({ level: "info" })).toEqual({
      logql: '{resource_name="shop-prod-es"} | json | waf_action != "block"'
        + ' | http_response_code_origin < 500 | http_response_code_client < 500 | __error__=""',
    });
    expect(query({ action: "GET /api/sync/outbox.json" })).toEqual({
      logql: '{resource_name="shop-prod-es"} | json | http_request_method="GET"'
        + ' | http_client_request_url=~"(https?://[^/?#]+)?/api/sync/outbox\\\\.json([?#].*)?" | __error__=""',
    });
    expect(BUILT.streams("shop")).toEqual({ app: REGISTRY.apps.get("shop")!.loki.stream, edge: SHOP_EDGE });
  });

  it("refuses an action outside its grammar", () => {
    expect(readerOf("shop", "edge").query({ action: "send-mail" }))
      .toEqual({ refused: 'action must be <METHOD> <path> for source edge, e.g. "GET /api/sync"' });
  });

  /** The recorded edge line with `patch` applied, as a Loki entry. */
  function edgeEntry(patch: Record<string, unknown> = {}) {
    return { ns: String(BigInt(NOW) * 1_000_000n), line: JSON.stringify({ ...JSON.parse(EDGE_LINE), ...patch }) };
  }

  it("returns the recorded line redacted, with action and level derived from the redacted line as before (D52)", () => {
    const line = readerOf("shop", "edge").line({ ns: String(BigInt(NOW) * 1_000_000n), line: EDGE_LINE });
    expect(line).toEqual({
      timestamp: "2026-10-18T12:00:00.000Z",
      action: "GET /api/sync/outbox/pending",
      level: "info",
      payload: {
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
      },
    });
    const text = JSON.stringify(line);
    expect(text).not.toContain("203.0.113.10");
    expect(text).not.toContain("token=abc");
  });

  it.each([
    ["origin 200, WAF pass", {}, "info", 200],
    ["origin 502", { http_response_code_origin: 502, http_response_code_client: 502 }, "error", 502],
    ["origin 500 as a string", { http_response_code_origin: "500" }, "error", 500],
    ["origin 404", { http_response_code_origin: 404 }, "info", 404],
    ["client 504 with origin 0", { http_response_code_origin: 0, http_response_code_client: 504 }, "error", 0],
    ["client aborted (status 0)", { http_response_code_origin: 0, http_response_code_client: 0 }, "info", 0],
    ["WAF block in log_only with origin 200", { waf_action: "block" }, "waf", 200],
    ["WAF block with origin 502", { waf_action: "block", http_response_code_origin: 502 }, "error", 502],
    ["waf_action -", { waf_action: "-" }, "info", 200],
    ["waf_action missing", { waf_action: undefined }, "info", 200],
  ])("maps %s to level %s", (_, patch, level, status) => {
    const reader = readerOf("shop", "edge");
    expect(reader.line(edgeEntry(patch))).toMatchObject({ level, action: "GET /api/sync/outbox/pending" });
    // count_errors counts errors only: a WAF hit or an aborted request is not grouped.
    expect(reader.group(edgeEntry(patch))).toEqual(level === "error"
      ? { key: `${status} GET /api/sync/outbox/pending`, row: { status, action: "GET /api/sync/outbox/pending" } }
      : null);
  });

  it("derives from the redacted line what the raw-line derivation it replaces derived (D52)", () => {
    // The derivation before D52, verbatim in substance: parse the raw line, cut the path, scrub only the path.
    function fromRaw(raw: string) {
      const line = JSON.parse(raw) as Record<string, unknown>;
      const method = typeof line.http_request_method === "string" && /^[A-Z]{1,10}$/.test(line.http_request_method)
        ? line.http_request_method : null;
      let path: string | null = null;
      if (typeof line.http_client_request_url === "string") {
        const url = line.http_client_request_url;
        const p = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*)?([^?#]*)/.exec(url)![1]!;
        path = p === "" ? (url.includes("://") ? "/" : null) : p.startsWith("/") ? p : null;
      }
      const statusOf = (value: unknown) =>
        typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)) ? Number(value) : null;
      const status = statusOf(line.http_response_code_origin);
      const client = statusOf(line.http_response_code_client);
      const level = (status ?? 0) >= 500 || (client ?? 0) >= 500 ? "error" : line.waf_action === "block" ? "waf" : "info";
      return { action: method && path ? `${method} ${scrubText(path)}` : null, level, status };
    }
    const reader = readerOf("shop", "edge");
    const urls = [
      "https://shop.example.invalid/api/sync/outbox/pending?token=abc",
      "https://shop.example.invalid/api/a?x=1#frag",
      "https://user@shop.example.invalid/api/a",
      "/api/a?email=jane.doe@example.com",
      "https://shop.example.invalid",
      "https://shop.example.invalid/api/members/jane.doe@example.com/0171 2345678",
      "https://shop.example.invalid/w/ws7f3a9b2c4d5e6f7a8b9c0d1e2f3/x",
      "https://shop.example.invalid/de/DE89 3704 0044 0532 0130 00",
      "relative/path",
    ];
    const patches = [
      {}, { http_response_code_origin: 502 }, { http_response_code_origin: "500" }, { waf_action: "block" },
      { http_response_code_origin: 0, http_response_code_client: 504 }, { waf_action: "-" },
    ];
    for (const url of urls) {
      for (const patch of patches) {
        const entry = edgeEntry({ ...patch, http_client_request_url: url });
        const expected = fromRaw(entry.line);
        expect(reader.line(entry), url).toMatchObject({ action: expected.action, level: expected.level });
        expect(reader.group(entry)?.row ?? null, url)
          .toEqual(expected.level === "error" ? { status: expected.status, action: expected.action ?? "[none]" } : null);
      }
    }
  });

  it("relies on the edge schema declaring method, both statuses and WAF verdict visible and the URL text", () => {
    expect(EDGE_SCHEMA.fields).toMatchObject({
      http_request_method: "visible",
      http_response_code_origin: "visible",
      http_response_code_client: "visible",
      waf_action: "visible",
      http_client_request_url: "text",
    });
  });

  it("derives the path without query or fragment, scrubbed as free text", () => {
    const action = (url: unknown, method: unknown = "POST") =>
      readerOf("shop", "edge").line(edgeEntry({ http_client_request_url: url, http_request_method: method })).action;
    expect(action("https://shop.example.invalid/api/a?x=1#frag")).toBe("POST /api/a");
    expect(action("/api/a?x=1")).toBe("POST /api/a");
    expect(action("https://shop.example.invalid")).toBe("POST /");
    expect(action("https://shop.example.invalid/api/members/jane.doe@example.com")).toBe("POST /api/members/[email]");
    expect(action(42)).toBeNull();
    expect(action("/api/a", "get it")).toBeNull();
    const notJson = { ns: String(BigInt(NOW) * 1_000_000n), line: "not json from jane.doe@example.com" };
    expect(readerOf("shop", "edge").line(notJson)).toMatchObject({ action: null, level: null, payload: "not json from [email]" });
    expect(readerOf("shop", "edge").group(notJson)).toBeNull();
  });
});

describe("startup view", () => {
  it("lists per app the sources apps.json declares, under their group, with what each lacks", () => {
    expect(BUILT.groups("shop")).toEqual({ logs: ["log schema is missing"], edge: [] });
    expect(BUILT.groups("crm")).toEqual({ logs: [] });
  });
});
