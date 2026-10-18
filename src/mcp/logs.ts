// The log tools (D12, D14). The LogQL is built here from validated parameters
// and the app's registry entry (stream selector and `service`, D38), never
// taken from the client, so the token scope and the service filter cannot be
// bypassed. Every line Loki returns passes through hyde-json with the app's
// schema before it leaves the server; Loki's stream labels, which hold raw
// extracted values, are never read. An app without a log schema is refused
// before Loki is asked (D37).
//
// `source: "edge"` reads the app's Scaleway Edge Services access logs instead
// (D46): plain JSON lines without the app envelope, redacted by hyde-mcp-gateway's
// committed edge schema. They have no `action` and their `level` is always
// info, so both are derived server side from the raw line: `action` is
// `<method> <path>` (the URL path without query or fragment, scrubbed as free
// text). A line is an `error` when the origin or the client side answered 5xx,
// `waf` when the WAF marked it `block` (a would-block in log_only mode, a real
// block otherwise), `info` otherwise. WAF hits are kept apart from errors: in
// log_only mode the WAF marks thousands of requests the origin answered 200.
// An app without an `edge` entry is refused before Loki is asked.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { redactLine, scrubText, type Json, type LogSchema } from "hyde-json";
import { z } from "zod";
import type { LogSource } from "../config.ts";
import { LokiError, nsOf, type Loki, type LokiEntry } from "../loki.ts";
import type { App } from "../registry.ts";
import { EDGE_SCHEMA, type Schemas } from "../schemas.ts";
import { appSchema, error, forApp, notConfigured, text, type Gate } from "./server.ts";

export const MAX_HOURS = 168;
export const MAX_LIMIT = 500;
/** Error lines count_errors reads at most; Loki's default `max_entries_limit_per_query`. */
export const ERROR_SCAN_LIMIT = 5000;

export const SOURCES = ["app", "edge"] as const;
export type Source = (typeof SOURCES)[number];
/** `waf` exists for the edge source only. */
export const LEVELS = ["error", "info", "waf"] as const;
export type Level = (typeof LEVELS)[number];

/** An app line's `action` filter. */
export const APP_ACTION = /^[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,99}$/;
/** An edge line's `action` filter: `<METHOD> <path>`, the path without query. */
export const EDGE_ACTION = /^([A-Z]{3,7}) (\/[A-Za-z0-9_.~%:@+\/-]{0,200})$/;

export interface LogsOptions {
  /** The log schemas, read per call (the schema store's live map, D58); an app left out is refused (D37). */
  schemas: Schemas;
  /** The committed edge schema (D46); without it `source: "edge"` is refused as not configured. */
  edgeSchema?: LogSchema;
  loki: Loki;
  /** app → stream selector and service (src/config.ts readLokiConfig) */
  sources: ReadonlyMap<App, LogSource>;
  /** Clock in ms, for tests. */
  now?: () => number;
}

export interface LogFilter {
  level?: string;
  action?: string;
}

/**
 * `<stream> | json | line_format "{{.message}}" | json | service="…" [| level="…"] [| action="…"]`.
 * Scaleway wraps each stdout line in `{resource_instance, message, stream}`: the
 * first `| json` opens the envelope, `line_format` makes the app line the log
 * line, the second `| json` extracts its fields (the apps' docs/operations.md).
 */
export function logQuery(source: LogSource, filter: LogFilter = {}): string {
  const stages = [source.stream, "json", 'line_format "{{.message}}"', "json", `service=${quote(source.service)}`];
  if (filter.level) stages.push(`level=${quote(filter.level)}`);
  if (filter.action) stages.push(`action=${quote(filter.action)}`);
  return stages.join(" | ");
}

/**
 * `<edge stream> | json [| <level>] [| http_request_method="…" | http_client_request_url=~"…"] | __error__=""`.
 * Edge lines are plain JSON, so one `| json` extracts their fields. `level`
 * maps onto the access-log fields (D46), the three levels partition the lines:
 * `error` is an origin or client status of 500 and up; `waf` is `waf_action`
 * `block` without a 5xx; `info` the rest (a `-` or missing `waf_action`, a
 * status 0 for an aborted request). `__error__=""` drops a line whose status
 * is not a number instead of failing the count query. `action` is `<METHOD> <path>` (EDGE_ACTION) and matches the
 * URL with or without scheme and host, with any query or fragment.
 */
export function edgeQuery(stream: string, filter: LogFilter = {}): string {
  const stages = [stream, "json"];
  const below500 = ["http_response_code_origin < 500", "http_response_code_client < 500"];
  if (filter.level === "error") stages.push("http_response_code_origin >= 500 or http_response_code_client >= 500");
  if (filter.level === "waf") stages.push('waf_action = "block"', ...below500);
  if (filter.level === "info") stages.push('waf_action != "block"', ...below500);
  if (filter.action) {
    const match = EDGE_ACTION.exec(filter.action);
    if (!match) throw new Error(`not an edge action: ${filter.action}`);
    const [, method, path] = match;
    stages.push(`http_request_method=${quote(method!)}`);
    stages.push(`http_client_request_url=~${quote(`(https?://[^/?#]+)?${escapeRegex(path!)}([?#].*)?`)}`);
  }
  stages.push('__error__=""');
  return stages.join(" | ");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `sum(count_over_time(<query> [<minutes>m]))`: the lines that matched, not only those returned. */
export function countQuery(query: string, hours: number): string {
  return `sum(count_over_time(${query} [${Math.ceil(hours * 60)}m]))`;
}

/** A LogQL string literal. Values are already restricted to a safe alphabet; this escapes regardless. */
function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const source = z.enum(SOURCES).default("app")
  .describe('Which log to read: "app" (the app\'s own log lines, default) or "edge" (its Edge Services access log)');

const hours = z.number().positive("hours must be positive")
  .max(MAX_HOURS, `hours must be at most ${MAX_HOURS} (7 days)`)
  .default(24)
  .describe(`How far back to read, in hours (default 24, at most ${MAX_HOURS})`);

/** What `app` lacks for the log tools, as their error names it; empty when ready. */
export function logsMissing(app: App, logs: Pick<LogsOptions, "schemas" | "sources"> | undefined): string[] {
  return [
    ...(logs?.schemas.has(app) ? [] : ["log schema is missing"]),
    ...(logs?.sources.has(app) ? [] : ["no Loki stream"]),
  ];
}

export interface LogLine {
  timestamp: string;
  action: Json;
  level: Json;
  payload: Json;
}

/** The tool error for `source: "edge"` on an app whose registry entry has no `edge`. */
export function noEdgeSource(app: App): string {
  return `${app} has no edge source`;
}

/** How one source's lines are selected and read. */
interface Reader {
  query(filter: LogFilter): string;
  line(entry: LokiEntry): LogLine;
  /** count_errors' group of a line: its key and the row fields that make it up; null for a line that is not an error. */
  group(entry: LokiEntry): { key: string; row: Record<string, Json> } | null;
}

export function registerLogTools(server: McpServer, gate: Gate, options: LogsOptions) {
  const { schemas, loki, sources, now = Date.now } = options;
  function window(h: number) {
    const end = now();
    return { start: nsOf(end - h * 3_600_000), end: nsOf(end) };
  }

  /** The reader of `app`'s `src`, or the tool error that refuses it before Loki is asked. */
  function readerFor(app: App, src: Source): Reader | { refused: CallToolResult } {
    const logSource = sources.get(app);
    if (src === "edge") {
      if (!logSource?.edgeStream) return { refused: error(noEdgeSource(app)) };
      const { edgeSchema } = options;
      if (!edgeSchema) return { refused: notConfigured(app, [`schemas/${EDGE_SCHEMA}.hyde-json.json is missing`]) };
      const stream = logSource.edgeStream;
      return {
        query: (filter) => edgeQuery(stream, filter),
        line: (entry) => toEdgeLine(entry, edgeSchema),
        group: (entry) => {
          const { action, status, level } = edgeFields(entry.line);
          // Loki selected errors already; a WAF hit or an aborted request never counts, whatever Loki returned.
          if (level !== "error") return null;
          const row = { status, action: action ?? "[none]" };
          return { key: `${status ?? "-"} ${row.action}`, row };
        },
      };
    }
    const schema = schemas.get(app);
    if (!schema || !logSource) return { refused: notConfigured(app, logsMissing(app, options)) };
    return {
      query: (filter) => logQuery(logSource, filter),
      line: (entry) => toLine(entry, schema),
      group: (entry) => {
        const { action } = toLine(entry, schema);
        const key = typeof action === "string" ? action : "[none]";
        return { key, row: { action: key } };
      },
    };
  }

  server.registerTool(
    "query_logs",
    {
      description:
        "Reads the app's production log lines of the last `hours`, newest first, optionally only one level or action. " +
        "Every line is redacted by the app's log field schema: undeclared and hidden fields read `[hidden]`, free text is scrubbed. " +
        "Returns how many lines matched and how many were returned. " +
        '`source: "edge"` reads the app\'s Edge Services access log instead: `action` is `<METHOD> <path>`, ' +
        "`level` error means the origin or client status is 5xx, `waf` that the WAF marked the request block (would-block in log_only mode), " +
        "and the client IP and query strings are redacted.",
      inputSchema: {
        app: appSchema(gate.registry),
        hours,
        level: z.enum(LEVELS).optional()
          .describe('Only lines of this level: "error" or "info"; for source edge also "waf" (requests the WAF marked block)'),
        action: z.string()
          .refine((v) => APP_ACTION.test(v) || EDGE_ACTION.test(v),
            "action must be an action name (letters, digits, _ . : / -), or <METHOD> <path> for source edge")
          .optional().describe('Only lines of this action, e.g. "cron-task-reevaluate", or "GET /api/sync" for source edge'),
        limit: z.number().int().min(1).max(MAX_LIMIT, `limit must be at most ${MAX_LIMIT}`).default(100)
          .describe(`Most lines to return (default 100, at most ${MAX_LIMIT})`),
        source,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    forApp(gate, async ({ app, hours: h, level, action, limit, source: src }) => {
      const reader = readerFor(app, src);
      if ("refused" in reader) return reader.refused;
      if (level === "waf" && src !== "edge") return error('level "waf" exists for source edge only');
      if (action !== undefined && !(src === "edge" ? EDGE_ACTION : APP_ACTION).test(action)) {
        return error(src === "edge"
          ? 'action must be <METHOD> <path> for source edge, e.g. "GET /api/sync"'
          : "action must be an action name (letters, digits, _ . : / -)");
      }
      return guard(async () => {
        const query = reader.query({ level, action });
        const { start, end } = window(h);
        const [entries, matched] = await Promise.all([
          loki.queryRange(query, { start, end, limit }),
          loki.instant(countQuery(query, h), end),
        ]);
        const lines = entries.map((e) => reader.line(e));
        return { matched: Math.max(matched, lines.length), returned: lines.length, lines };
      });
    }),
  );

  server.registerTool(
    "count_errors",
    {
      description:
        "Counts the app's error lines of the last `hours` by action, most frequent first. " +
        `Reads at most ${ERROR_SCAN_LIMIT} error lines; \`partial: true\` says the counts stop there. ` +
        '`source: "edge"` counts the Edge Services access log\'s errors (origin or client status 5xx; WAF hits are not errors, see query_logs level "waf") ' +
        "by origin status and `<METHOD> <path>`.",
      inputSchema: { app: appSchema(gate.registry), hours, source },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    forApp(gate, async ({ app, hours: h, source: src }) => {
      const reader = readerFor(app, src);
      if ("refused" in reader) return reader.refused;
      return guard(async () => {
        const entries = await loki.queryRange(reader.query({ level: "error" }), {
          ...window(h), limit: ERROR_SCAN_LIMIT,
        });
        const groups = new Map<string, { row: Record<string, Json>; count: number }>();
        let total = 0;
        for (const entry of entries) {
          const grouped = reader.group(entry);
          if (!grouped) continue;
          total += 1;
          const { key, row } = grouped;
          const group = groups.get(key) ?? groups.set(key, { row, count: 0 }).get(key)!;
          group.count += 1;
        }
        const rows = [...groups].sort(([ka, a], [kb, b]) => b.count - a.count || ka.localeCompare(kb))
          .map(([, { row, count }]) => ({ ...row, count }));
        return { rows, total, partial: entries.length >= ERROR_SCAN_LIMIT };
      });
    }),
  );
}

/** One Loki entry, redacted. `action` and `level` are read from the redacted line, so the schema governs them too. */
export function toLine(entry: LokiEntry, schema: LogSchema): LogLine {
  const timestamp = new Date(Number(BigInt(entry.ns) / 1_000_000n)).toISOString();
  const { format, line } = redactLine(entry.line, schema);
  if (format === "text" || line === null || typeof line !== "object" || Array.isArray(line)) {
    return { timestamp, action: null, level: null, payload: line };
  }
  return { timestamp, action: line.action ?? null, level: line.level ?? null, payload: line.message ?? null };
}

/**
 * One edge entry, redacted by the edge schema; `payload` is the whole redacted
 * line. `action` and `level` are derived from the raw line (edgeFields).
 */
export function toEdgeLine(entry: LokiEntry, schema: LogSchema): LogLine {
  const timestamp = new Date(Number(BigInt(entry.ns) / 1_000_000n)).toISOString();
  const { line } = redactLine(entry.line, schema);
  const { action, level } = edgeFields(entry.line);
  return { timestamp, action, level, payload: line };
}

/**
 * What the server derives from a raw edge line before redaction: `action`
 * `<METHOD> <path>`, the path scrubbed as free text so that personal data in
 * it cannot pass around the schema; `level` by the error mapping of edgeQuery;
 * `status` the origin status. Each is null when the line does not carry it.
 */
export function edgeFields(raw: string): { action: string | null; level: Level | null; status: number | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { action: null, level: null, status: null };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { action: null, level: null, status: null };
  const line = parsed as Record<string, unknown>;
  const method = typeof line.http_request_method === "string" && /^[A-Z]{1,10}$/.test(line.http_request_method)
    ? line.http_request_method : null;
  const path = pathOf(line.http_client_request_url);
  const status = statusOf(line.http_response_code_origin);
  const client = statusOf(line.http_response_code_client);
  const level = (status ?? 0) >= 500 || (client ?? 0) >= 500 ? "error" : line.waf_action === "block" ? "waf" : "info";
  return { action: method && path ? `${method} ${scrubText(path)}` : null, level, status };
}

function statusOf(value: unknown): number | null {
  return typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)) ? Number(value) : null;
}

/** The path of a URL, with or without scheme and host, without query or fragment; null when it has none. */
function pathOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const path = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*)?([^?#]*)/.exec(url)![1]!;
  if (path === "") return url.includes("://") ? "/" : null;
  return path.startsWith("/") ? path : null;
}

/** Tool errors carry a message, never a stack; only Loki's are passed on verbatim. */
async function guard(run: () => Promise<unknown>) {
  try {
    return text(JSON.stringify(await run()));
  } catch (e) {
    if (e instanceof LokiError) return error(e.message);
    console.error(JSON.stringify({ level: "error", message: "log tool failed", error: e instanceof Error ? e.name : typeof e }));
    return error("Log query failed inside hyde-mcp-gateway");
  }
}
