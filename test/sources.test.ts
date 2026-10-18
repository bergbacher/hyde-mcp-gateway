import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSchema } from "hyde-json";
import { buildLogSources, type LogReader } from "../src/sources/index.ts";
import { loadEdgeSchema } from "../src/schemas.ts";
import { REGISTRY } from "./helpers.ts";

/** An Edge Services access-log line as Loki returned it for shop (2026-10-18); client IP and host replaced by example values. */
const EDGE_LINE = readFileSync(new URL("./fixtures/loki/edge.shop.line.json", import.meta.url), "utf8").trim();
/** The committed schemas/edge.hyde-json.json. */
const EDGE_SCHEMA = loadEdgeSchema();

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const crmSchema = parseSchema({ app: "crm", fields: { action: "visible", level: "visible", message: "text" } });
const SOURCES = buildLogSources({ registry: REGISTRY, schemas: new Map([["crm", crmSchema]]), edgeSchema: EDGE_SCHEMA, env: {} });

function readerOf(app: string, source: "app" | "edge"): LogReader {
  const reader = SOURCES.reader(app, source);
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
    expect(SOURCES.reader("shop", "app")).toEqual({ missing: ["schemas/shop.hyde-json.json is missing"] });
    expect(SOURCES.missing("shop", "app")).toEqual(["schemas/shop.hyde-json.json is missing"]);
    expect(SOURCES.missing("crm", "app")).toEqual([]);
  });

  it("reads the stream from apps.json unless HYDE_APP_<NAME>_LOKI_STREAM overrides it; refuses an invalid override", () => {
    expect(SOURCES.streams("crm")).toEqual({ app: REGISTRY.apps.get("crm")!.loki.stream });
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
    expect(SOURCES.reader("crm", "edge")).toEqual({ missing: ["no edge stream in apps.json"] });
    const noSchema = buildLogSources({ registry: REGISTRY, schemas: new Map(), env: {} });
    expect(noSchema.missing("shop", "edge")).toEqual(["schemas/edge.hyde-json.json is missing"]);
    expect(noSchema.missing("crm", "edge")).toEqual(["no edge stream in apps.json", "schemas/edge.hyde-json.json is missing"]);
    expect(SOURCES.missing("shop", "edge")).toEqual([]);
  });

  it("does not need the app's own log schema", () => {
    expect(SOURCES.missing("shop", "app")).not.toEqual([]);
    expect("query" in SOURCES.reader("shop", "edge")).toBe(true);
  });

  it("builds the LogQL: one json stage, error = origin 5xx or not passed by the WAF, action = method and path", () => {
    const query = (filter: Parameters<LogReader["query"]>[0]) => readerOf("shop", "edge").query(filter);
    expect(query({})).toEqual({ logql: '{resource_name="shop-prod-es"} | json | __error__=""' });
    expect(query({ level: "error" })).toEqual({
      logql: '{resource_name="shop-prod-es"} | json | waf_action != "pass" or http_response_code_origin >= 500 | __error__=""',
    });
    expect(query({ level: "info" })).toEqual({
      logql: '{resource_name="shop-prod-es"} | json | waf_action = "pass" and http_response_code_origin < 500 | __error__=""',
    });
    expect(query({ action: "GET /api/sync/outbox.json" })).toEqual({
      logql: '{resource_name="shop-prod-es"} | json | http_request_method="GET"'
        + ' | http_client_request_url=~"(https?://[^/?#]+)?/api/sync/outbox\\\\.json([?#].*)?" | __error__=""',
    });
    expect(SOURCES.streams("shop")).toEqual({ app: REGISTRY.apps.get("shop")!.loki.stream, edge: SHOP_EDGE });
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
    ["WAF block", { waf_action: "block", http_response_code_client: 403 }, "error", 200],
  ])("maps %s to level %s", (_, patch, level, status) => {
    const reader = readerOf("shop", "edge");
    expect(reader.line(edgeEntry(patch))).toMatchObject({ level, action: "GET /api/sync/outbox/pending" });
    expect(reader.group(edgeEntry(patch))).toEqual({
      key: `${status} GET /api/sync/outbox/pending`, row: { status, action: "GET /api/sync/outbox/pending" },
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
    expect(readerOf("shop", "edge").group(notJson)).toEqual({ key: "- [none]", row: { status: null, action: "[none]" } });
  });
});

describe("startup view", () => {
  it("lists per app the sources apps.json declares, under their group, with what each lacks", () => {
    expect(SOURCES.groups("shop")).toEqual({ logs: ["schemas/shop.hyde-json.json is missing"], edge: [] });
    expect(SOURCES.groups("crm")).toEqual({ logs: [] });
  });
});
