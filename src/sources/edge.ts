// The app's Scaleway Edge Services access log (D46): plain JSON lines without
// the app envelope, from the stream the registry names under `edge.stream`
// (no environment override, D53), redacted by the committed
// `schemas/edge.hyde-json.json`. The lines have no `action` and their `level`
// is always info, so both are derived, and so is the origin `status`, from the
// REDACTED line (D52): the schema declares method, origin status and WAF
// verdict visible and the URL text, so the derivation loses nothing and no
// raw value leaves except through redactLine. `action` is `<METHOD> <path>`,
// the path of the scrubbed URL without query or fragment; a line is an error
// when the origin answered 5xx or the WAF did not pass it.

import { redactLine, type Json, type LogSchema } from "hyde-json";
import type { LokiEntry } from "../loki.ts";
import { EDGE_SCHEMA } from "../schemas.ts";
import { isObject, quote, timestampOf, type Level, type LogFilter, type LogLine, type LogReader, type SourceKind } from "./source.ts";

/** An edge line's `action`: `<METHOD> <path>`, the path without query. */
export const EDGE_ACTION = /^([A-Z]{3,7}) (\/[A-Za-z0-9_.~%:@+\/-]{0,200})$/;

/** The Edge Services access-log source kind. */
export const edgeSource: SourceKind<"edge"> = {
  name: "edge",
  group: "edge",
  describe: {
    source: "its Edge Services access log",
    queryLogs: "`source: \"edge\"` reads the app's Edge Services access log instead: `action` is `<METHOD> <path>`, " +
      "`level` error means the origin answered 5xx or the WAF did not pass the request, and the client IP and query strings are redacted.",
    countErrors: "`source: \"edge\"` counts the Edge Services access log's errors (origin 5xx or not passed by the WAF) by origin status and `<METHOD> <path>`.",
    action: '<METHOD> <path> for source edge, e.g. "GET /api/sync"',
  },
  build(entry, { edgeSchema }) {
    const stream = entry.edge?.stream ?? null;
    const missing = [
      ...(stream ? [] : ["no edge stream in apps.json"]),
      ...(edgeSchema ? [] : [`schemas/${EDGE_SCHEMA}.hyde-json.json is missing`]),
    ];
    if (!stream || !edgeSchema) return { stream, missing };
    return { stream, reader: edgeReader(stream, edgeSchema) };
  },
};

function edgeReader(stream: string, schema: LogSchema): LogReader {
  return {
    query: (filter) => edgeQuery(stream, filter),
    line: (entry) => toEdgeLine(entry, schema).line,
    group(entry) {
      const { action, status } = toEdgeLine(entry, schema);
      const row = { status, action: action ?? "[none]" };
      return { key: `${status ?? "-"} ${row.action}`, row };
    },
  };
}

/**
 * `<edge stream> | json [| <level>] [| http_request_method="…" | http_client_request_url=~"…"] | __error__=""`.
 * `waf_action` comes first so that `or` decides on it before converting the
 * status to a number; `__error__=""` drops a line whose status is not a number
 * instead of failing the count query. The action matches the URL with or
 * without scheme and host, with any query or fragment.
 */
function edgeQuery(stream: string, filter: LogFilter): { logql: string } | { refused: string } {
  const stages = [stream, "json"];
  if (filter.level === "error") stages.push('waf_action != "pass" or http_response_code_origin >= 500');
  if (filter.level === "info") stages.push('waf_action = "pass" and http_response_code_origin < 500');
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
function toEdgeLine(entry: LokiEntry, schema: LogSchema): { line: LogLine; action: string | null; status: number | null } {
  const { line } = redactLine(entry.line, schema);
  const { action, level, status } = edgeFields(line);
  return { line: { timestamp: timestampOf(entry), action, level, payload: line }, action, status };
}

/**
 * What the server derives from a redacted edge line: `action`
 * `<METHOD> <path>` from the URL the schema scrubbed as text; `level` by the
 * error mapping of edgeQuery; `status` the origin status. Each is null when
 * the line does not carry it.
 */
function edgeFields(line: Json): { action: string | null; level: Level | null; status: number | null } {
  if (!isObject(line)) return { action: null, level: null, status: null };
  const method = typeof line.http_request_method === "string" && /^[A-Z]{1,10}$/.test(line.http_request_method)
    ? line.http_request_method : null;
  const path = pathOf(line.http_client_request_url);
  const origin = line.http_response_code_origin;
  const status = typeof origin === "number" || (typeof origin === "string" && /^\d+$/.test(origin)) ? Number(origin) : null;
  const level = line.waf_action !== "pass" || (status !== null && status >= 500) ? "error" : "info";
  return { action: method && path ? `${method} ${path}` : null, level, status };
}

/** The path of a URL, with or without scheme and host, without query or fragment; null when it has none. */
function pathOf(url: Json | undefined): string | null {
  if (typeof url !== "string") return null;
  const path = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*)?([^?#]*)/.exec(url)![1]!;
  if (path === "") return url.includes("://") ? "/" : null;
  return path.startsWith("/") ? path : null;
}
