// The app's own log lines (D12, D31): Scaleway wraps each stdout line in
// `{resource_instance, message, stream}`; the app line inside carries
// `service`, `level`, `action` and the payload under `message`. The stream is
// the registry's `loki.stream`, overridable by `HYDE_APP_<NAME>_LOKI_STREAM`;
// lines are redacted by the app's own schema, which must declare `action` and
// `level` visible since both are read from the redacted line. The schema is
// the schema store's (D58), looked up per call: the app is not configured
// until a refresh loads its schema, and a changed schema applies at once.

import { redactLine, type LogSchema } from "hyde-json";
import type { LokiEntry } from "../loki.ts";
import { appVariables, STREAM_SELECTOR } from "../registry.ts";
import { isObject, quote, timestampOf, type LogFilter, type LogLine, type LogReader, type SourceKind } from "./source.ts";

/** An app line's `action`. */
export const APP_ACTION = /^[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,99}$/;

/** The app-line source kind. */
export const appSource: SourceKind<"app"> = {
  name: "app",
  group: "logs",
  describe: {
    source: "the app's own log lines, default",
    action: 'an action name, e.g. "cron-task-reevaluate"',
  },
  build(entry, { schemas, env }) {
    const key = appVariables(entry.name).lokiStream;
    const override = env[key]?.trim();
    if (override && !STREAM_SELECTOR.test(override)) throw new Error(`${key} is not a LogQL stream selector ({label="value", …})`);
    const stream = override || entry.loki.stream;
    // The last schema seen and its reader: a new reader only after a refresh replaced the schema.
    let last: { schema: LogSchema; reader: LogReader } | undefined;
    return {
      stream,
      current() {
        const schema = schemas.get(entry.name);
        if (!schema) return { missing: ["log schema is missing"] };
        if (last?.schema !== schema) last = { schema, reader: appReader(stream, entry.loki.service, schema) };
        return { reader: last.reader };
      },
    };
  },
};

function appReader(stream: string, service: string, schema: LogSchema): LogReader {
  return {
    query(filter: LogFilter) {
      if (filter.level === "waf") return { refused: 'level "waf" exists for source edge only' };
      if (filter.action !== undefined && !APP_ACTION.test(filter.action)) {
        return { refused: "action must be an action name (letters, digits, _ . : / -)" };
      }
      // The first `| json` opens the envelope, `line_format` makes the app line
      // the log line, the second `| json` extracts its fields.
      const stages = [stream, "json", 'line_format "{{.message}}"', "json", `service=${quote(service)}`];
      if (filter.level) stages.push(`level=${quote(filter.level)}`);
      if (filter.action) stages.push(`action=${quote(filter.action)}`);
      return { logql: stages.join(" | ") };
    },
    line: (entry) => toLine(entry, schema),
    group(entry) {
      const { action } = toLine(entry, schema);
      const key = typeof action === "string" ? action : "[none]";
      return { key, row: { action: key } };
    },
  };
}

/** `action` and `level` are read from the redacted line, so the schema governs them too; `payload` is its `message`. */
function toLine(entry: LokiEntry, schema: LogSchema): LogLine {
  const timestamp = timestampOf(entry);
  const { format, line } = redactLine(entry.line, schema);
  if (format === "text" || !isObject(line)) return { timestamp, action: null, level: null, payload: line };
  return { timestamp, action: line.action ?? null, level: line.level ?? null, payload: line.message ?? null };
}
