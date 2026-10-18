// The SQL tools: `describe_schema` and `query_sql` read the app's redacted
// database (D2), whose privileges are the boundary, and its redacted schema.
// Whether an app has both is asked of its SQL readiness (sqlReadiness, built
// once at boot, src/boot.ts), which reads the schema store's live map per
// call (D58); an app that lacks either is refused before the database is
// asked (D37).

import { z } from "zod";
import { guardStatement } from "../db/guard.ts";
import { DEFAULT_LIMIT, MAX_LIMIT, type Databases, type QueryResult } from "../db/pool.ts";
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
}

/** Per app: ready for `describe_schema` and `query_sql`, or what it lacks as their error names it. */
export interface SqlReadiness {
  open(app: App): SqlHandle | { missing: string[] };
  /** What `app` lacks; empty when ready. */
  missing(app: App): string[];
}

/** The SQL readiness of every app: a question to the database module plus the redacted schemas. */
export function sqlReadiness({ databases, schemas }: SqlInputs): SqlReadiness {
  const missing = (app: App) => [
    ...(schemas.has(app) ? [] : ["redacted schema is missing"]),
    ...(databases.has(app) ? [] : [`${appVariables(app).redactedUrl} is not set`]),
  ];
  return {
    missing,
    open(app) {
      const lacks = missing(app);
      if (lacks.length > 0) return { missing: lacks };
      return { schema: schemas.get(app)!, query: (sql, limit) => databases.query(app, sql, limit) };
    },
  };
}

export function registerSqlTools(server: Registrar, gate: Gate, sql: SqlReadiness) {
  server.registerTool(
    "describe_schema",
    {
      description:
        "Returns the app's redacted schema: the views query_sql can read and their visible columns. Hidden columns and base tables are not readable.",
      inputSchema: { app: appSchema(gate.registry) },
      annotations: { readOnlyHint: true },
    },
    forApp(gate, ({ app }) => {
      const ready = sql.open(app);
      if ("missing" in ready) return notConfigured(app, ready.missing);
      return text(ready.schema);
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
