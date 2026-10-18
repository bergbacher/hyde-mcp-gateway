// The app's Scaleway Edge Services access log (D46): plain JSON lines without
// the app envelope, from the stream the registry names under `edge.stream`
// (no environment override, D53), redacted by the committed
// `schemas/edge.hyde-json.json`. The lines have no `action` and their `level`
// is always info, so both are derived, and so is the origin `status`, from the
// REDACTED line (D52): the schema declares method, both statuses and the WAF
// verdict visible and the URL text, so the derivation loses nothing and no
// raw value leaves except through redactLine. `action` is `<METHOD> <path>`,
// the path of the scrubbed URL without query or fragment. The three levels
// partition the lines: `error` when the origin or the client side answered
// 5xx, `waf` when the WAF marked the request `block` (a would-block in
// log_only mode, a real block otherwise) without a 5xx, `info` the rest. WAF
// hits are kept apart from errors: in log_only mode the WAF marks many
// requests the origin answered 200.

import { redactLine, type Json, type LogSchema } from "hyde-json";
import type { LokiEntry } from "../loki.ts";
import { EDGE_SCHEMA } from "../schemas.ts";
import { isObject, quote, timestampOf, type Level, type LogFilter, type LogLine, type LogReader, type Readiness, type SourceKind } from "./source.ts";

/** An edge line's `action`: `<METHOD> <path>`, the path without query. */
export const EDGE_ACTION = /^([A-Z]{3,7}) (\/[A-Za-z0-9_.~%:@+\/-]{0,200})$/;

/** The Edge Services access-log source kind. */
export const edgeSource: SourceKind<"edge"> = {
  name: "edge",
  group: "edge",
  describe: {
    source: "its Edge Services access log",
    queryLogs: "`source: \"edge\"` reads the app's Edge Services access log instead: `action` is `<METHOD> <path>`, " +
      "`level` error means the origin or client status is 5xx, `waf` that the WAF marked the request block (would-block in log_only mode), " +
      "and the client IP and query strings are redacted.",
    countErrors: "`source: \"edge\"` counts the Edge Services access log's errors (origin or client status 5xx; WAF hits are not errors, " +
      "see query_logs level \"waf\") by origin status and `<METHOD> <path>`.",
    action: '<METHOD> <path> for source edge, e.g. "GET /api/sync"',
    level: 'for source edge also "waf" (requests the WAF marked block)',
  },
  build(entry, { edgeSchema }) {
    const stream = entry.edge?.stream ?? null;
    const missing = [
      ...(stream ? [] : ["no edge stream in apps.json"]),
      ...(edgeSchema ? [] : [`schemas/${EDGE_SCHEMA}.hyde-json.json is missing`]),
    ];
    // Registry and edge schema are fixed at startup, so the answer is too.
    const readiness: Readiness = !stream || !edgeSchema ? { missing } : { reader: edgeReader(stream, edgeSchema) };
    return { stream, current: () => readiness };
  },
};

function edgeReader(stream: string, schema: LogSchema): LogReader {
  return {
    query: (filter) => edgeQuery(stream, filter),
    line: (entry) => toEdgeLine(entry, schema).line,
    group(entry) {
      const { action, status, level } = toEdgeLine(entry, schema);
      // Loki selected errors already; a WAF hit or an aborted request never counts, whatever Loki returned.
      if (level !== "error") return null;
      const row = { status, action: action ?? "[none]" };
      return { key: `${status ?? "-"} ${row.action}`, row };
    },
  };
}

/**
 * `<edge stream> | json [| <level>] [| http_request_method="…" | http_client_request_url=~"…"] | __error__=""`.
 * `level` maps onto the access-log fields (D46), the three levels partition
 * the lines: `error` is an origin or client status of 500 and up; `waf` is
 * `waf_action` `block` without a 5xx; `info` the rest (a `-` or missing
 * `waf_action`, a status 0 for an aborted request). `__error__=""` drops a
 * line whose status is not a number instead of failing the count query. The
 * action matches the URL with or without scheme and host, with any query or
 * fragment.
 */
function edgeQuery(stream: string, filter: LogFilter): { logql: string } | { refused: string } {
  const stages = [stream, "json"];
  const below500 = ["http_response_code_origin < 500", "http_response_code_client < 500"];
  if (filter.level === "error") stages.push("http_response_code_origin >= 500 or http_response_code_client >= 500");
  if (filter.level === "waf") stages.push('waf_action = "block"', ...below500);
  if (filter.level === "info") stages.push('waf_action != "block"', ...below500);
  if (filter.action !== undefined) {
    const match = EDGE_ACTION.exec(filter.action);
    if (!match) return { refused: 'action must be <METHOD> <path> for source edge, e.g. "GET /api/sync"' };
    const [, method, path] = match;
    stages.push(`http_request_method=${quote(method!)}`);
    stages.push(`http_client_request_url=~${quote(`(https?://[^/?#]+)?${escapeRegex(path!)}([?#].*)?`)}`);
  }
  stages.push('__error__=""');
  return { logql: stages.join(" | ") };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One entry, redacted by the edge schema; `payload` is the whole redacted line, `status` its origin status. */
function toEdgeLine(entry: LokiEntry, schema: LogSchema): { line: LogLine; action: string | null; level: Level | null; status: number | null } {
  const { line } = redactLine(entry.line, schema);
  const { action, level, status } = edgeFields(line);
  return { line: { timestamp: timestampOf(entry), action, level, payload: line }, action, level, status };
}

/**
 * What the server derives from a redacted edge line: `action`
 * `<METHOD> <path>` from the URL the schema scrubbed as text; `level` by the
 * mapping of edgeQuery; `status` the origin status. Each is null when the line
 * does not carry it.
 */
function edgeFields(line: Json): { action: string | null; level: Level | null; status: number | null } {
  if (!isObject(line)) return { action: null, level: null, status: null };
  const method = typeof line.http_request_method === "string" && /^[A-Z]{1,10}$/.test(line.http_request_method)
    ? line.http_request_method : null;
  const path = pathOf(line.http_client_request_url);
  const status = statusOf(line.http_response_code_origin);
  const client = statusOf(line.http_response_code_client);
  const level = (status ?? 0) >= 500 || (client ?? 0) >= 500 ? "error" : line.waf_action === "block" ? "waf" : "info";
  return { action: method && path ? `${method} ${path}` : null, level, status };
}

function statusOf(value: Json | undefined): number | null {
  return typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)) ? Number(value) : null;
}

/** The path of a URL, with or without scheme and host, without query or fragment; null when it has none. */
function pathOf(url: Json | undefined): string | null {
  if (typeof url !== "string") return null;
  const path = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*)?([^?#]*)/.exec(url)![1]!;
  if (path === "") return url.includes("://") ? "/" : null;
  return path.startsWith("/") ? path : null;
}
