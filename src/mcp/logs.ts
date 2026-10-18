// The log tools (D12, D14). They know one interface, the reader of an
// (app, source) from the log sources module (src/sources/, D51); what a
// source reads, how its LogQL is built and how its lines are redacted and
// grouped lives there. The LogQL is built server side from validated
// parameters, never taken from the client, and every returned line has passed
// through hyde-json (D52); Loki's stream labels, which hold raw extracted
// values, are never read. An (app, source) that lacks something is refused
// before Loki is asked (D37, D53).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Json } from "hyde-json";
import { z } from "zod";
import { LokiError, nsOf, type Loki } from "../loki.ts";
import { KINDS, SOURCES, type LogSources } from "../sources/index.ts";
import { appSchema, error, forApp, notConfigured, text, type Gate } from "./server.ts";

export const MAX_HOURS = 168;
export const MAX_LIMIT = 500;
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
  .describe(`How far back to read, in hours (default 24, at most ${MAX_HOURS})`);

const notes = (key: "queryLogs" | "countErrors") => KINDS.flatMap((k) => (k.describe[key] ? [` ${k.describe[key]}`] : [])).join("");

export function registerLogTools(server: McpServer, gate: Gate, { sources, loki, now = Date.now }: LogsOptions) {
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
        "Returns how many lines matched and how many were returned." + notes("queryLogs"),
      inputSchema: {
        app: appSchema(gate.registry),
        hours,
        level: z.enum(["error", "info"]).optional().describe('Only lines of this level: "error" or "info"'),
        action: z.string().optional()
          .describe(`Only lines of this action: ${KINDS.map((k) => k.describe.action).join(", or ")}`),
        limit: z.number().int().min(1).max(MAX_LIMIT, `limit must be at most ${MAX_LIMIT}`).default(100)
          .describe(`Most lines to return (default 100, at most ${MAX_LIMIT})`),
        source,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    forApp(gate, async ({ app, hours: h, level, action, limit, source: src }) => {
      const reader = sources.reader(app, src);
      if ("missing" in reader) return notConfigured(app, reader.missing);
      const query = reader.query({ level, action });
      if ("refused" in query) return error(query.refused);
      return guard(async () => {
        const { start, end } = window(h);
        const [entries, matched] = await Promise.all([
          loki.queryRange(query.logql, { start, end, limit }),
          loki.instant(countQuery(query.logql, h), end),
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
        `Reads at most ${ERROR_SCAN_LIMIT} error lines; \`partial: true\` says the counts stop there.` + notes("countErrors"),
      inputSchema: { app: appSchema(gate.registry), hours, source },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    forApp(gate, async ({ app, hours: h, source: src }) => {
      const reader = sources.reader(app, src);
      if ("missing" in reader) return notConfigured(app, reader.missing);
      const query = reader.query({ level: "error" });
      if ("refused" in query) return error(query.refused);
      return guard(async () => {
        const entries = await loki.queryRange(query.logql, { ...window(h), limit: ERROR_SCAN_LIMIT });
        const groups = new Map<string, { row: Record<string, Json>; count: number }>();
        for (const entry of entries) {
          const { key, row } = reader.group(entry);
          const group = groups.get(key) ?? groups.set(key, { row, count: 0 }).get(key)!;
          group.count += 1;
        }
        const rows = [...groups].sort(([ka, a], [kb, b]) => b.count - a.count || ka.localeCompare(kb))
          .map(([, { row, count }]) => ({ ...row, count }));
        return { rows, total: entries.length, partial: entries.length >= ERROR_SCAN_LIMIT };
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
