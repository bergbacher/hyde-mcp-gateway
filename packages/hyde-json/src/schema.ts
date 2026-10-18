// A log field schema, declared per app (D23). Every known field path of the
// app line is `visible`, `hidden` or `text`. Paths are dotted and relative to
// the app line, so payload fields sit under `message.`; array elements share
// their array's path (no index segment).

export const FIELD_RULES = ["visible", "hidden", "text"] as const;
export type FieldRule = (typeof FIELD_RULES)[number];

export interface LogSchema {
  app: string;
  fields: Readonly<Record<string, FieldRule>>;
  /** Undeclared fields holding a number pass. */
  passNumbers: boolean;
  /** Undeclared fields named `id` or `…Id` holding a number or string pass. */
  passIds: boolean;
}

const KEYS = new Set(["app", "fields", "passNumbers", "passIds"]);
const PATH = /^[^.\s]+(\.[^.\s]+)*$/;

/** Validates a schema read from JSON. Throws naming every problem. */
export function parseSchema(json: unknown): LogSchema {
  if (!isRecord(json)) throw new Error("log schema: not an object");
  const problems: string[] = [];
  for (const key of Object.keys(json)) if (!KEYS.has(key)) problems.push(`unknown key "${key}"`);
  if (typeof json.app !== "string" || json.app === "") problems.push(`"app" must be a non-empty string`);
  for (const flag of ["passNumbers", "passIds"] as const) {
    if (json[flag] !== undefined && typeof json[flag] !== "boolean") problems.push(`"${flag}" must be a boolean`);
  }
  const fields: Record<string, FieldRule> = Object.create(null);
  if (!isRecord(json.fields)) problems.push(`"fields" must be an object of path → rule`);
  else {
    for (const [path, rule] of Object.entries(json.fields)) {
      if (!PATH.test(path)) problems.push(`field "${path}": not a dotted path`);
      if (isRule(rule)) fields[path] = rule;
      else problems.push(`field "${path}": ${JSON.stringify(rule)} is not one of ${FIELD_RULES.join(", ")}`);
    }
    for (const path of Object.keys(fields)) {
      for (const parent of parentsOf(path)) {
        if (fields[parent] === "hidden") problems.push(`field "${path}": lies under hidden "${parent}"`);
      }
    }
  }
  if (problems.length > 0) throw new Error(`log schema: ${problems.join("; ")}`);
  return {
    app: json.app as string,
    fields: Object.freeze(fields),
    passNumbers: json.passNumbers === true,
    passIds: json.passIds === true,
  };
}

/** `a.b.c` → `a`, `a.b` */
export function parentsOf(path: string): string[] {
  const parents: string[] = [];
  for (let i = path.indexOf("."); i !== -1; i = path.indexOf(".", i + 1)) parents.push(path.slice(0, i));
  return parents;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRule(value: unknown): value is FieldRule {
  return (FIELD_RULES as readonly unknown[]).includes(value);
}
