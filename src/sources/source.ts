// What one log source is (D51): an implementation that owns its stream, its
// schema, its LogQL, how a Loki entry becomes a returned line, how count_errors
// groups its lines, its action grammar and its error wording. The log tools
// (src/mcp/logs.ts) know only LogReader; a new source is one SourceKind
// implementation (like app.ts, edge.ts) listed in KINDS (index.ts), plus one
// registry field.

import type { Json, LogSchema } from "hyde-json";
import type { LokiEntry } from "../loki.ts";
import type { AppEntry } from "../registry.ts";
import type { Schemas } from "../schemas.ts";

/** The levels the tools filter by. */
export type Level = "error" | "info";

/** What query_logs and count_errors narrow a source's lines by. */
export interface LogFilter {
  level?: Level;
  /** Unchecked: the reader refuses an action outside its source's grammar. */
  action?: string;
}

/** One returned line: the redacted payload and the action and level read or derived from it. */
export interface LogLine {
  timestamp: string;
  action: Json;
  level: Json;
  payload: Json;
}

/** How one app's source is selected and read. Every line it returns has passed through hyde-json's redactLine (D52). */
export interface LogReader {
  /** The LogQL for `filter`, or the tool error for an action outside this source's grammar. */
  query(filter: LogFilter): { logql: string } | { refused: string };
  line(entry: LokiEntry): LogLine;
  /** count_errors' group of a line: its key and the row fields that make it up. */
  group(entry: LokiEntry): { key: string; row: Record<string, Json> };
}

/** What a source is built from at startup. */
export interface SourceInputs {
  /** The app log schemas present (D37). */
  schemas: Schemas;
  /** The committed edge schema (D46). */
  edgeSchema?: LogSchema;
  env: NodeJS.ProcessEnv;
}

/** One app's source, built once: the stream it reads (null when apps.json declares none) and its reader, or what it lacks. */
export type BuiltSource =
  | { stream: string | null; reader: LogReader; missing?: undefined }
  | { stream: string | null; reader?: undefined; missing: string[] };

/** One kind of log source; `build` makes its reader for one app. */
export interface SourceKind<Name extends string = string> {
  /** The value of the tools' `source` parameter. */
  name: Name;
  /** The name the startup line lists an app under when this source answers. */
  group: string;
  /** For the tools' descriptions. */
  describe: { source: string; queryLogs?: string; countErrors?: string; action: string };
  /** Throws naming the environment variable when an override is invalid. */
  build(entry: AppEntry, inputs: SourceInputs): BuiltSource;
}

/** A LogQL string literal. Values are already restricted to a safe alphabet; this escapes regardless. */
export function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** A Loki entry's nanosecond timestamp as ISO 8601. */
export function timestampOf(entry: LokiEntry): string {
  return new Date(Number(BigInt(entry.ns) / 1_000_000n)).toISOString();
}

/** A JSON object, not an array or null. */
export function isObject(value: Json): value is { [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
