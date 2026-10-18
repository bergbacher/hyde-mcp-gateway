// The boot step: registry (apps.json, D38), the schema files present and the
// environment become the server's per-app readiness, built once (D37). For
// each tool group (`logs`, `edge` when apps.json declares it, `sql`) an app is
// either ready, with its handles, or missing, naming what is absent: log
// readiness is the log-sources module's (src/sources/, D51), SQL readiness the
// database module's plus the redacted schema (src/mcp/sql.ts). The tools ask
// it; the startup report is read from it. Nothing listens here: the entry
// point (src/mcp/main.ts) boots, listens and prints the report.
//
// Throws, and so refuses to start, on an invalid registry, client token or
// scope, database URL, Loki configuration, stream override, or a present log
// schema that is invalid, and when no app has a log schema or the committed
// edge schema is missing or invalid (src/schemas.ts).

import { readConfig, readLokiConfig, type Config } from "./config.ts";
import { createDatabases } from "./db/pool.ts";
import { createLoki } from "./loki.ts";
import { scopeOf } from "./mcp/auth.ts";
import { createServer, type ServerOptions } from "./mcp/server.ts";
import { sqlReadiness } from "./mcp/sql.ts";
import { appNames, loadRegistry, type App, type Registry } from "./registry.ts";
import { loadEdgeSchema, loadRedactedSchemas, loadSchemas, SCHEMA_DIR } from "./schemas.ts";
import { buildLogSources } from "./sources/index.ts";

export interface BootInputs {
  /** Defaults to apps.json. */
  registry?: Registry;
  /** Defaults to schemas/. */
  schemaDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** The startup report: one info line, then a warn line per app that is not fully configured. */
export interface StartupReport {
  info: {
    level: "info";
    message: string;
    /** client → the apps it may read, or "*" (D39). */
    clients: Record<string, string[] | "*">;
    /** The tools the server registers, in order. */
    tools: string[];
    /** app → the tool groups it answers: "logs", "edge", "sql". */
    apps: Record<App, string[]>;
    schemas: { logs: Record<App, number>; redacted: App[] };
    /** app → source → the stream selector it reads. */
    sources: Record<App, Record<string, string>>;
  };
  warnings: { level: "warn"; message: string; app: App; missing: Record<string, string[]> }[];
}

export interface Booted {
  config: Config;
  /** What `createServer` serves: the registry and each tool group's per-app readiness. */
  options: ServerOptions;
  report: StartupReport;
}

export function boot({ registry = loadRegistry(), schemaDir = SCHEMA_DIR, env = process.env }: BootInputs = {}): Booted {
  const config = readConfig(registry, env);
  const lokiConfig = readLokiConfig(env);
  const logSchemas = loadSchemas(registry, schemaDir);
  const redactedSchemas = loadRedactedSchemas(registry, schemaDir);
  const logs = {
    sources: buildLogSources({ registry, schemas: logSchemas, edgeSchema: loadEdgeSchema(schemaDir), env }),
    loki: createLoki({ url: lokiConfig.url, token: lokiConfig.token }),
  };
  const sql = sqlReadiness({ databases: createDatabases(config.databases), schemas: redactedSchemas });
  const options: ServerOptions = { registry, logs, sql };

  // Per app and tool group, what is missing; an empty list means it answers.
  const missing = appNames(registry).map((app) => ({ app, groups: { ...logs.sources.groups(app), sql: sql.missing(app) } }));
  // The tools a server built from these options registers; no principal is needed to list them.
  const { tools } = createServer({ client: "boot", apps: new Set() }, options);

  const report: StartupReport = {
    info: {
      level: "info",
      message: `hyde-mcp-gateway listening on :${config.port}`,
      clients: Object.fromEntries([...config.clients.values()].map((p) => [p.client, scopeOf(p)])),
      tools,
      apps: Object.fromEntries(missing.map(({ app, groups }) => [
        app,
        Object.entries(groups).filter(([, lacks]) => lacks.length === 0).map(([group]) => group),
      ])),
      schemas: {
        logs: Object.fromEntries([...logSchemas].map(([app, s]) => [app, Object.keys(s.fields).length])),
        redacted: [...redactedSchemas.keys()],
      },
      sources: Object.fromEntries(appNames(registry).map((app) => [app, logs.sources.streams(app)])),
    },
    warnings: missing.flatMap(({ app, groups }) => {
      const lacks = Object.values(groups).flat();
      if (lacks.length === 0) return [];
      return [{ level: "warn" as const, message: `${app} is not fully configured: ${lacks.join("; ")}`, app, missing: groups }];
    }),
  };
  return { config, options, report };
}
