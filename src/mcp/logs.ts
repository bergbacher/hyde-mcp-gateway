// The log tools (D12, D14). They know one interface, the reader of an
// (app, source) from the log sources module (src/sources/, D51); what a
// source reads, how its LogQL is built and how its lines are redacted and
// grouped lives there. The LogQL is built server side from validated
// parameters, never taken from the client, and every returned line has passed
// through hyde-json (D52); Loki's stream labels, which hold raw extracted
// values, are never read. An (app, source) that lacks something is refused
// before Loki is asked (D37, D53).

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Json } from "hyde-json";
import { z } from "zod";
import { LokiError, nsOf, type Loki } from "../loki.ts";
import { KINDS, LEVELS, SOURCES, type LogFilter, type LogReader, type LogSources, type Source } from "../sources/index.ts";
import { appSchema, error, forApp, notConfigured, text, type Gate, type Registrar } from "./tool.ts";

export const MAX_HOURS = 168;
export const MAX_LIMIT = 500;
/** How far in the future `until` may lie, for clock skew between client and server. */
export const MAX_UNTIL_SKEW_MS = 60_000;
/** An ISO 8601 date-time with a time zone: `Z` or an offset. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i;
const UNTIL_FORMAT = 'until must be an ISO 8601 timestamp with a time zone, e.g. "2026-10-18T12:00:00Z"';
/** Error lines count_errors reads at most; Loki's default `max_entries_limit_per_query`. */
export const ERROR_SCAN_LIMIT = 5000;

export interface LogsOptions {
  /** Per (app, source): a reader or what is missing (src/sources/index.ts buildLogSources). */
  sources: LogSources;
  loki: Loki;
  /** Clock in ms, for tests. */
  now?: () => number;
}

/** `sum(count_over_time(<query> [<minutes>m]))`: the lines that matched, not only those returned. */
export function countQuery(query: string, hours: number): string {
  return `sum(count_over_time(${query} [${Math.ceil(hours * 60)}m]))`;
}

const source = z.enum(SOURCES).default(SOURCES[0])
  .describe(`Which log to read: ${KINDS.map((k) => `"${k.name}" (${k.describe.source})`).join(" or ")}`);

const hours = z.number().positive("hours must be positive")
  .max(MAX_HOURS, `hours must be at most ${MAX_HOURS} (7 days)`)
  .default(24)
  .describe(`How far back to read, in hours, counted back from \`until\` (default 24, at most ${MAX_HOURS})`);

const until = z.string().optional()
  .describe('End of the window, an ISO 8601 timestamp with a time zone, e.g. "2026-10-18T12:00:00Z" (default now, at most a minute ahead)');

const notes = (key: "queryLogs" | "countErrors") => KINDS.flatMap((k) => (k.describe[key] ? [` ${k.describe[key]}`] : [])).join("");

export function registerLogTools(server: Registrar, gate: Gate, { sources, loki, now = Date.now }: LogsOptions) {
  /**
   * The window of `h` hours ending at `until` (default now), in ns for Loki and
   * as ISO strings for the response, or the tool error refusing `until`.
   * `hours` is capped by its schema, so the window never exceeds MAX_HOURS.
   */
  function window(h: number, until: string | undefined):
    { start: bigint; end: bigint; from: string; until: string } | { refused: CallToolResult } {
    const current = now();
    let end = current;
    if (until !== undefined) {
      end = ISO_TIMESTAMP.test(until) ? Date.parse(until) : NaN;
      if (Number.isNaN(end)) return { refused: error(UNTIL_FORMAT) };
      if (end > current + MAX_UNTIL_SKEW_MS) return { refused: error("until must not be more than a minute in the future") };
    }
    const begin = end - h * 3_600_000;
    return { start: nsOf(begin), end: nsOf(end), from: new Date(begin).toISOString(), until: new Date(end).toISOString() };
  }

  /** The reader of `app`'s `src` and its LogQL for `filter`, or the tool error that refuses them before Loki is asked. */
  function open(app: string, src: Source, filter: LogFilter): { reader: LogReader; query: { logql: string } } | { refused: CallToolResult } {
    const reader = sources.reader(app, src);
    if ("missing" in reader) return { refused: notConfigured(app, reader.missing) };
    const query = reader.query(filter);
    if ("refused" in query) return { refused: error(query.refused) };
    return { reader, query };
  }

  server.registerTool(
    "query_logs",
    {
      description:
        "Reads the app's production log lines of the `hours` before `until` (default now), newest first, optionally only one level or action. " +
        "Every line is redacted by the app's log field schema: undeclared and hidden fields read `[hidden]`, free text is scrubbed. " +
        "Returns the window (`from`, `until`), how many lines matched and how many were returned." + notes("queryLogs"),
      inputSchema: {
        app: appSchema(gate.registry),
        hours,
        until,
        level: z.enum(LEVELS).optional()
          .describe(`Only lines of this level: "error" or "info"${KINDS.map((k) => (k.describe.level ? `; ${k.describe.level}` : "")).join("")}`),
        action: z.string().optional()
          .describe(`Only lines of this action: ${KINDS.map((k) => k.describe.action).join(", or ")}`),
        limit: z.number().int().min(1).max(MAX_LIMIT, `limit must be at most ${MAX_LIMIT}`).default(100)
          .describe(`Most lines to return (default 100, at most ${MAX_LIMIT})`),
        source,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    forApp(gate, async ({ app, hours: h, until: u, level, action, limit, source: src }) => {
      const win = window(h, u);
      if ("refused" in win) return win.refused;
      const opened = open(app, src, { level, action });
      if ("refused" in opened) return opened.refused;
      const { reader, query } = opened;
      return guard(async () => {
        const { start, end, from, until } = win;
        const [entries, matched] = await Promise.all([
          loki.queryRange(query.logql, { start, end, limit }),
          loki.instant(countQuery(query.logql, h), end),
        ]);
        const lines = entries.map((e) => reader.line(e));
        return { from, until, matched: Math.max(matched, lines.length), returned: lines.length, lines };
      });
    }),
  );

  server.registerTool(
    "count_errors",
    {
      description:
        "Counts the app's error lines of the `hours` before `until` (default now) by action, most frequent first. " +
        `Reads at most ${ERROR_SCAN_LIMIT} error lines; \`partial: true\` says the counts stop there. Returns the window (\`from\`, \`until\`).` +
        notes("countErrors"),
      inputSchema: { app: appSchema(gate.registry), hours, until, source },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    forApp(gate, async ({ app, hours: h, until: u, source: src }) => {
      const win = window(h, u);
      if ("refused" in win) return win.refused;
      const { start, end, from, until } = win;
      const opened = open(app, src, { level: "error" });
      if ("refused" in opened) return opened.refused;
      const { reader, query } = opened;
      return guard(async () => {
        const entries = await loki.queryRange(query.logql, { start, end, limit: ERROR_SCAN_LIMIT });
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
        return { from, until, rows, total, partial: entries.length >= ERROR_SCAN_LIMIT };
      });
    }),
  );
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
