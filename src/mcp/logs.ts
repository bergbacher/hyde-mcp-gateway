// The log tools (D12, D14). The LogQL is built here from validated parameters
// and the app's registry entry (stream selector and `service`, D38), never
// taken from the client, so the token scope and the service filter cannot be
// bypassed. Every line Loki returns passes through hyde-json with the app's
// schema before it leaves the server; Loki's stream labels, which hold raw
// extracted values, are never read. An app without a log schema is refused
// before Loki is asked (D37).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { redactLine, type Json, type LogSchema } from "hyde-json";
import { z } from "zod";
import type { LogSource } from "../config.ts";
import { LokiError, nsOf, type Loki, type LokiEntry } from "../loki.ts";
import type { App, Registry } from "../registry.ts";
import type { Schemas } from "../schemas.ts";
import { appSchema, error, forApp, notConfigured, text } from "./server.ts";

export const MAX_HOURS = 168;
export const MAX_LIMIT = 500;
/** Error lines count_errors reads at most; Loki's default `max_entries_limit_per_query`. */
export const ERROR_SCAN_LIMIT = 5000;

export interface LogsOptions {
  /** The log schemas present; an app left out is refused (D37). */
  schemas: Schemas;
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

/** `sum(count_over_time(<query> [<minutes>m]))`: the lines that matched, not only those returned. */
export function countQuery(query: string, hours: number): string {
  return `sum(count_over_time(${query} [${Math.ceil(hours * 60)}m]))`;
}

/** A LogQL string literal. Values are already restricted to a safe alphabet; this escapes regardless. */
function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const hours = z.number().positive("hours must be positive")
  .max(MAX_HOURS, `hours must be at most ${MAX_HOURS} (7 days)`)
  .default(24)
  .describe(`How far back to read, in hours (default 24, at most ${MAX_HOURS})`);

/** What `app` lacks for the log tools, as their error names it; empty when ready. */
export function logsMissing(app: App, logs: Pick<LogsOptions, "schemas" | "sources"> | undefined): string[] {
  return [
    ...(logs?.schemas.has(app) ? [] : [`schemas/${app}.hyde-json.json is missing`]),
    ...(logs?.sources.has(app) ? [] : ["no Loki stream"]),
  ];
}

export interface LogLine {
  timestamp: string;
  action: Json;
  level: Json;
  payload: Json;
}

export function registerLogTools(server: McpServer, registry: Registry, options: LogsOptions) {
  const { schemas, loki, sources, now = Date.now } = options;
  function window(h: number) {
    const end = now();
    return { start: nsOf(end - h * 3_600_000), end: nsOf(end) };
  }

  server.registerTool(
    "query_logs",
    {
      description:
        "Reads the app's production log lines of the last `hours`, newest first, optionally only one level or action. " +
        "Every line is redacted by the app's log field schema: undeclared and hidden fields read `[hidden]`, free text is scrubbed. " +
        "Returns how many lines matched and how many were returned.",
      inputSchema: {
        app: appSchema(registry),
        hours,
        level: z.enum(["error", "info"]).optional().describe('Only lines of this level: "error" or "info"'),
        action: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,99}$/, "action must be an action name (letters, digits, _ . : / -)")
          .optional().describe('Only lines of this action, e.g. "cron-task-reevaluate"'),
        limit: z.number().int().min(1).max(MAX_LIMIT, `limit must be at most ${MAX_LIMIT}`).default(100)
          .describe(`Most lines to return (default 100, at most ${MAX_LIMIT})`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    forApp(registry, async ({ app, hours: h, level, action, limit }) => {
      const schema = schemas.get(app);
      const source = sources.get(app);
      if (!schema || !source) return notConfigured(app, logsMissing(app, options));
      return guard(async () => {
        const query = logQuery(source, { level, action });
        const { start, end } = window(h);
        const [entries, matched] = await Promise.all([
          loki.queryRange(query, { start, end, limit }),
          loki.instant(countQuery(query, h), end),
        ]);
        const lines = entries.map((e) => toLine(e, schema));
        return { matched: Math.max(matched, lines.length), returned: lines.length, lines };
      });
    }),
  );

  server.registerTool(
    "count_errors",
    {
      description:
        "Counts the app's error lines of the last `hours` by action, most frequent first. " +
        `Reads at most ${ERROR_SCAN_LIMIT} error lines; \`partial: true\` says the counts stop there.`,
      inputSchema: { app: appSchema(registry), hours },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    forApp(registry, async ({ app, hours: h }) => {
      const schema = schemas.get(app);
      const source = sources.get(app);
      if (!schema || !source) return notConfigured(app, logsMissing(app, options));
      return guard(async () => {
        const entries = await loki.queryRange(logQuery(source, { level: "error" }), {
          ...window(h), limit: ERROR_SCAN_LIMIT,
      });
      const counts = new Map<string, number>();
      for (const entry of entries) {
        const { action } = toLine(entry, schema);
        const key = typeof action === "string" ? action : "[none]";
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const rows = [...counts].map(([action, count]) => ({ action, count }))
        .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action));
      return { rows, total: entries.length, partial: entries.length >= ERROR_SCAN_LIMIT };
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
