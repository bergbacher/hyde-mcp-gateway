// The boot step: registry (apps.json, D38), the schema store (D58) and the
// environment become the server's per-app readiness, built once (D37). For
// each tool group (`logs`, `edge` when apps.json declares it, `sql`) an app is
// either ready, with its handles, or missing, naming what is absent: log
// readiness is the log-sources module's (src/sources/, D51), SQL readiness the
// database module's plus the redacted schema (src/mcp/sql.ts). The readiness
// objects are built once but read the schema store's live maps per call, so a
// schema refresh changes what the tools answer without a restart; the startup
// report is a snapshot of the first load. The token verifier (GitHub tokens,
// D59, then the static tokens) is built here too. Nothing listens here: the
// entry point (src/mcp/main.ts) boots, listens and prints the report.
//
// For each app ready for SQL, boot runs the stale-view check once (D48,
// src/db/views.ts) and waits for it: the info line names every app whose
// views differ from its redacted schema, or could not be checked, and a warn
// line per such app carries the same notice. A failed check does not stop the
// start.
//
// Throws, and so refuses to start, on an invalid registry, client token or
// scope, database URL, Loki configuration, stream override or schema refresh
// interval, and when the committed edge schema is missing or invalid
// (src/schemas.ts). An app whose schema files are missing or invalid does not
// stop the start: it is not configured until a refresh loads them (D58).

import { readConfig, readLokiConfig, type Config } from "./config.ts";
import { createDatabases, type Databases } from "./db/pool.ts";
import { staleNotice } from "./db/views.ts";
import { createLoki } from "./loki.ts";
import { scopeOf } from "./mcp/auth.ts";
import { createVerifier, type AppOptions } from "./mcp/http.ts";
import { toolsOf } from "./mcp/server.ts";
import { sqlReadiness } from "./mcp/sql.ts";
import { appNames, loadRegistry, type App, type Registry } from "./registry.ts";
import { readSchemaStoreConfig, SchemaStore, type SchemaStoreOptions } from "./schema-store.ts";
import { loadEdgeSchema, SCHEMA_DIR } from "./schemas.ts";
import { buildLogSources } from "./sources/index.ts";

export interface BootInputs {
  /** Defaults to apps.json. */
  registry?: Registry;
  /** Where the committed edge schema is read, and the app schemas without a read token; defaults to schemas/. */
  schemaDir?: string;
  env?: NodeJS.ProcessEnv;
  /** The schema store's GitHub fetch and log lines, for tests. */
  schemaStore?: Pick<SchemaStoreOptions, "fetch" | "log" | "warn">;
  /** The GitHub verifier's fetch and clock, for tests. */
  github?: AppOptions["github"];
  /** Builds the redacted databases from each app's database config; defaults to a pool per app (src/db/pool.ts). For tests. */
  databases?: (configs: Config["databases"]) => Databases;
}

/** The startup report: one info line, then a warn line per app that is not fully configured and per app with stale views. */
export interface StartupReport {
  info: {
    level: "info";
    message: string;
    /** Who checks a token: GitHub for GitHub-shaped tokens (D59), the static tokens otherwise. */
    verifiers: string[];
    githubScopeTtlSeconds: number;
    /** static client → the apps it may read, or "*" (D39). */
    clients: Record<string, string[] | "*">;
    /** The tools the server registers, in order. */
    tools: string[];
    /** app → the tool groups it answered at startup: "logs", "edge", "sql". A refresh can change it. */
    apps: Record<App, string[]>;
    schemas: { source: "github" | "local"; refreshSeconds: number; logs: Record<App, number>; redacted: App[] };
    /** app → source → the stream selector it reads. */
    sources: Record<App, Record<string, string>>;
    /** app → the stale-view notice at startup (D48), for each SQL-ready app whose views differ or could not be checked. */
    staleViews: Record<App, string>;
  };
  warnings: { level: "warn"; message: string; app?: App; missing?: Record<string, string[]>; detail?: string }[];
}

export interface Booted {
  config: Config;
  /** What `createApp` serves: the registry, each tool group's per-app readiness and the token verifier. */
  options: Required<Pick<AppOptions, "registry" | "logs" | "sql" | "verifier">>;
  /** The schema store, started: it refreshes on its own schedule until `stop()`. */
  schemas: SchemaStore;
  report: StartupReport;
}

export async function boot({
  registry = loadRegistry(),
  schemaDir = SCHEMA_DIR,
  env = process.env,
  schemaStore = {},
  github,
  databases = createDatabases,
}: BootInputs = {}): Promise<Booted> {
  const config = readConfig(registry, env);
  const lokiConfig = readLokiConfig(env);
  const edgeSchema = loadEdgeSchema(schemaDir);
  const schemas = new SchemaStore({ registry, dir: schemaDir, ...readSchemaStoreConfig(env), ...schemaStore });
  await schemas.start();
  const logs = {
    sources: buildLogSources({ registry, schemas: schemas.logSchemas, edgeSchema, env }),
    loki: createLoki({ url: lokiConfig.url, token: lokiConfig.token }),
  };
  const sql = sqlReadiness({ databases: databases(config.databases), schemas: schemas.redactedSchemas });
  const verifier = createVerifier(config, registry, github);
  const options = { registry, logs, sql, verifier };

  // Per app and tool group, what is missing at startup; an empty list means it answers.
  const missing = appNames(registry).map((app) => ({ app, groups: { ...logs.sources.groups(app), sql: sql.missing(app) } }));
  // The stale-view check per SQL-ready app, in parallel; the readiness keeps each result.
  const stale = (await Promise.all(missing
    .filter(({ groups }) => groups.sql.length === 0)
    .map(async ({ app }) => {
      const check = await sql.checkViews(app);
      const notice = staleNotice(check);
      return notice ? [{ app, notice, detail: check.ok ? undefined : check.detail }] : [];
    }))).flat();

  const report: StartupReport = {
    info: {
      level: "info",
      message: `hyde-mcp-gateway listening on :${config.port}`,
      verifiers: [...verifier.kinds],
      githubScopeTtlSeconds: config.githubScopeTtlSeconds,
      clients: Object.fromEntries([...config.clients.values()].map((p) => [p.client, scopeOf(p)])),
      tools: toolsOf(options),
      apps: Object.fromEntries(missing.map(({ app, groups }) => [
        app,
        Object.entries(groups).filter(([, lacks]) => lacks.length === 0).map(([group]) => group),
      ])),
      schemas: {
        source: schemas.mode,
        refreshSeconds: schemas.refreshSeconds,
        logs: Object.fromEntries([...schemas.logSchemas].map(([app, s]) => [app, Object.keys(s.fields).length])),
        redacted: [...schemas.redactedSchemas.keys()],
      },
      sources: Object.fromEntries(appNames(registry).map((app) => [app, logs.sources.streams(app)])),
      staleViews: Object.fromEntries(stale.map(({ app, notice }) => [app, notice])),
    },
    warnings: [
      ...(schemas.mode === "local"
        ? [{ level: "warn" as const, message: "APP_REPOS_READ_TOKEN is not set: reading schemas/ (developer mode)" }]
        : []),
      ...missing.flatMap(({ app, groups }) => {
        const lacks = Object.values(groups).flat();
        if (lacks.length === 0) return [];
        return [{ level: "warn" as const, message: `${app} is not fully configured: ${lacks.join("; ")}`, app, missing: groups }];
      }),
      ...stale.map(({ app, notice, detail }) => ({ level: "warn" as const, message: `${app}: ${notice}`, app, ...(detail ? { detail } : {}) })),
    ],
  };
  return { config, options, schemas, report };
}
