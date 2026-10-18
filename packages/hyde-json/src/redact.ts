// Turns one raw log line into a redacted one (D12, D13). Scaleway's envelope
// is unwrapped first; then each field of the app line is resolved against the
// schema: visible passes, hidden or undeclared becomes `[hidden]`, text is
// scrubbed. Objects are descended into. A serialized Error at a path declared
// visible or text keeps its name, scrubs its message and keeps its stack frames.

import { isRecord, parentsOf, type FieldRule, type LogSchema } from "./schema.ts";
import { scrubStack, scrubText } from "./scrub.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const HIDDEN = "[hidden]";

export interface RedactedLine {
  /** Scaleway envelope metadata, when the line came wrapped. */
  envelope?: { resource_instance: string; stream: string };
  /** `json`: `line` is the redacted app line. `text`: `line` is the scrubbed raw text. */
  format: "json" | "text";
  line: Json;
}

interface Context {
  schema: LogSchema;
  /** Proper prefixes of declared paths: objects there are descended into. */
  prefixes: Set<string>;
}

export function redactLine(raw: string, schema: LogSchema): RedactedLine {
  const outer = parseJson(raw);
  if (!isEnvelope(outer)) return redactApp(raw, outer, schema);
  const envelope = { resource_instance: outer.resource_instance, stream: outer.stream };
  return { envelope, ...redactApp(outer.message, parseJson(outer.message), schema) };
}

function redactApp(raw: string, parsed: unknown, schema: LogSchema): RedactedLine {
  if (!isRecord(parsed)) return { format: "text", line: scrubText(raw) };
  return { format: "json", line: walkObject(parsed, "", { schema, prefixes: prefixesOf(schema) }) };
}

function walk(value: unknown, path: string, key: string, ctx: Context): Json {
  const rule = ruleAt(ctx.schema, path);
  if (rule === "hidden") return HIDDEN;
  if (Array.isArray(value)) return value.map((v) => walk(v, path, key, ctx));
  if (isRecord(value)) {
    if (rule !== undefined && isErrorLike(value)) return walkError(value, path, ctx);
    if (rule !== undefined || ctx.prefixes.has(path)) return walkObject(value, path, ctx);
    return HIDDEN;
  }
  if (rule === "visible") return value as Json;
  if (rule === "text") return scrubLeaf(value);
  if (ctx.schema.passIds && /^(id|.+Id)$/.test(key) && (typeof value === "number" || typeof value === "string")) return value;
  if (ctx.schema.passNumbers && typeof value === "number") return value;
  return HIDDEN;
}

// Object.fromEntries defines own properties, so a `__proto__` key stays data.
function walkObject(obj: Record<string, unknown>, path: string, ctx: Context): { [key: string]: Json } {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, walk(v, path ? `${path}.${k}` : k, k, ctx)]));
}

/** Serialized Error: `name` passes, `message` is scrubbed, `stack` keeps its frames; other keys follow the schema. */
function walkError(err: Record<string, unknown>, path: string, ctx: Context): { [key: string]: Json } {
  return Object.fromEntries(
    Object.entries(err).map(([k, v]): [string, Json] => {
      if (k === "name" && typeof v === "string") return [k, v];
      if (k === "message" && typeof v === "string") return [k, scrubText(v)];
      if (k === "stack" && typeof v === "string") return [k, scrubStack(v)];
      return [k, walk(v, `${path}.${k}`, k, ctx)];
    }),
  );
}

function scrubLeaf(value: unknown): Json {
  if (typeof value === "string") return scrubText(value);
  if (typeof value === "number") {
    const scrubbed = scrubText(String(value));
    return scrubbed === String(value) ? value : scrubbed;
  }
  return value as Json;
}

function ruleAt(schema: LogSchema, path: string): FieldRule | undefined {
  return Object.hasOwn(schema.fields, path) ? schema.fields[path] : undefined;
}

function isErrorLike(value: Record<string, unknown>): boolean {
  return typeof value.stack === "string" && typeof value.message === "string";
}

function isEnvelope(value: unknown): value is { resource_instance: string; message: string; stream: string } {
  return isRecord(value) && typeof value.message === "string"
    && typeof value.resource_instance === "string" && typeof value.stream === "string";
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const prefixCache = new WeakMap<LogSchema, Set<string>>();

function prefixesOf(schema: LogSchema): Set<string> {
  let set = prefixCache.get(schema);
  if (!set) {
    set = new Set(Object.keys(schema.fields).flatMap(parentsOf));
    prefixCache.set(schema, set);
  }
  return set;
}
