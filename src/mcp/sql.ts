// The SQL tools: `describe_schema` and `query_sql` read the app's redacted
// database (D2), whose privileges are the boundary, and its redacted schema.
// Whether an app has both is asked of its SQL readiness (sqlReadiness, built
// once at boot, src/boot.ts), which reads the schema store's live map per
// call (D58); an app that lacks either is refused before the database is
// asked (D37).
//
// Stale views (D48): `describe_schema` first compares the document with the
// views the reader sees (src/db/views.ts), with a fresh query on every call,
// and puts a notice above the document when they differ or the check could
// not run; the document is returned either way. Boot runs the same check per
// ready app for its startup report (src/boot.ts). `query_sql` does not check.

import { z } from "zod";
import { guardStatement } from "../db/guard.ts";
import { DEFAULT_LIMIT, MAX_LIMIT, type Databases, type QueryResult } from "../db/pool.ts";
import { checkViews, staleNotice, type ViewCheck } from "../db/views.ts";
import { appVariables, type App } from "../registry.ts";
import { appSchema, error, forApp, notConfigured, text, type Gate, type Registrar } from "./tool.ts";

export interface SqlInputs {
  databases: Databases;
  /** Each app's redacted-schema.md: the schema store's live map (D58), read per call, so a refresh changes readiness; a missing app is left out (D37). */
  schemas: ReadonlyMap<App, string>;
}

/** An app ready for the SQL tools: its redacted schema and its redacted database. */
export interface SqlHandle {
  schema: string;
  query(sql: string, limit: number | undefined): Promise<QueryResult>;
  /** Compares the redacted schema with the views the reader sees, with a fresh query; never rejects. */
  checkViews(): Promise<ViewCheck>;
}

/** Per app: ready for `describe_schema` and `query_sql`, or what it lacks as their error names it. */
export interface SqlReadiness {
  open(app: App): SqlHandle | { missing: string[] };
  /** What `app` lacks; empty when ready. */
  missing(app: App): string[];
  /** The stale-view check of a ready app, run now; never rejects. */
  checkViews(app: App): Promise<ViewCheck>;
  /** The latest check of `app`, from boot or the last `describe_schema`; undefined before the first. */
  lastCheck(app: App): ViewCheck | undefined;
}

/** The SQL readiness of every app: a question to the database module plus the redacted schemas. */
export function sqlReadiness({ databases, schemas }: SqlInputs): SqlReadiness {
  const missing = (app: App) => [
    ...(schemas.has(app) ? [] : ["redacted schema is missing"]),
    ...(databases.has(app) ? [] : [`${appVariables(app).redactedUrl} is not set`]),
  ];
  const checks = new Map<App, ViewCheck>();
  /** Checks `schema`, by default the app's current one, against the live views and keeps the result. */
  async function check(app: App, schema = schemas.get(app) ?? ""): Promise<ViewCheck> {
    let result: ViewCheck;
    try {
      result = checkViews(schema, await databases.viewColumns(app));
    } catch (e) {
      result = { ok: false, reason: "the redacted database could not be read", detail: e instanceof Error ? e.message : String(e) };
    }
    checks.set(app, result);
    return result;
  }
  return {
    missing,
    checkViews: (app) => check(app),
    lastCheck: (app) => checks.get(app),
    open(app) {
      const lacks = missing(app);
      if (lacks.length > 0) return { missing: lacks };
      const schema = schemas.get(app)!;
      return { schema, query: (sql, limit) => databases.query(app, sql, limit), checkViews: () => check(app, schema) };
    },
  };
}

export function registerSqlTools(server: Registrar, gate: Gate, sql: SqlReadiness) {
  server.registerTool(
    "describe_schema",
    {
      description:
        "Returns the app's redacted schema: the views query_sql can read and their visible columns. Hidden columns and base tables are not readable. " +
        "A notice starting \"Stale views:\" above the schema means the live views differ from it, or could not be compared; it names the differences.",
      inputSchema: { app: appSchema(gate.registry) },
      annotations: { readOnlyHint: true },
    },
    forApp(gate, async ({ app }) => {
      const ready = sql.open(app);
      if ("missing" in ready) return notConfigured(app, ready.missing);
      const notice = staleNotice(await ready.checkViews());
      return text(notice ? `${notice}\n\n${ready.schema}` : ready.schema);
    }),
  );

  server.registerTool(
    "query_sql",
    {
      description:
        `Runs one SELECT (or WITH ... SELECT) over the app's redacted views and returns {columns, rows, truncated}. ` +
        `Rows are capped at \`limit\` (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}) and 1 MB; the statement times out after 15 s. ` +
        `Database errors, such as "Unknown column" for a hidden column, are returned unchanged. Call describe_schema first.`,
      inputSchema: {
        app: appSchema(gate.registry),
        sql: z.string().describe("A single SELECT statement"),
        limit: z.number().int().optional().describe(`Row cap, default ${DEFAULT_LIMIT}, clamped to 1..${MAX_LIMIT}`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    forApp(gate, async ({ app, sql: statement, limit }) => {
      const ready = sql.open(app);
      if ("missing" in ready) return notConfigured(app, ready.missing);
      const guarded = guardStatement(statement);
      if (!guarded.ok) return error(guarded.reason);
      try {
        return text(JSON.stringify(await ready.query(guarded.sql, limit)));
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }),
  );
}
