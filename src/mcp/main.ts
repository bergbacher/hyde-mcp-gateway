import { readConfig, readLokiConfig } from "../config.ts";
import { createDatabases } from "../db/pool.ts";
import { createLoki } from "../loki.ts";
import { appNames, loadRegistry } from "../registry.ts";
import { loadEdgeSchema, loadRedactedSchemas, loadSchemas } from "../schemas.ts";
import { buildLogSources } from "../sources/index.ts";
import { scopeOf } from "./auth.ts";
import { createApp } from "./http.ts";
import { toolNames, type ServerOptions } from "./server.ts";
import { sqlMissing } from "./sql.ts";

// The apps every tool accepts (apps.json, D38). An invalid registry stops the start.
const registry = loadRegistry();
const config = readConfig(registry);
const lokiConfig = readLokiConfig();
// The apps whose files are present (D37). Refuses to start only when no log
// schema exists or a present one is invalid; an app without its schema is
// refused at the log tools, since an absent schema would hide every field.
const logSchemas = loadSchemas(registry);
// Per (app, source) a reader or what is missing (D51), from the registry, the
// log schemas, the committed edge schema (D46; missing or invalid stops the
// start) and the stream overrides in the environment.
const logSources = buildLogSources({ registry, schemas: logSchemas, edgeSchema: loadEdgeSchema(), env: process.env });
// An app without its redacted-schema.md is refused at describe_schema and query_sql.
const redactedSchemas = loadRedactedSchemas(registry);

const options: ServerOptions = {
  registry,
  logs: { sources: logSources, loki: createLoki({ url: lokiConfig.url, token: lokiConfig.token }) },
  sql: { databases: createDatabases(config.databases), schemas: redactedSchemas },
};

/** Per app and tool group ("logs", "edge" when apps.json declares it, "sql"), what is missing; an empty list means configured. */
const missing = appNames(registry).map((app) => ({
  app,
  groups: { ...logSources.groups(app), sql: sqlMissing(app, options.sql) },
}));

createApp(config, options).listen(config.port, () => {
  console.log(JSON.stringify({
    level: "info",
    message: `hyde-mcp-gateway listening on :${config.port}`,
    // client → the apps it may read, or "*" (D39).
    clients: Object.fromEntries([...config.clients.values()].map((p) => [p.client, scopeOf(p)])),
    tools: toolNames(options),
    // app → the tool groups it answers: "logs", "edge", "sql".
    apps: Object.fromEntries(missing.map(({ app, groups }) => [
      app,
      Object.entries(groups).filter(([, lacks]) => lacks.length === 0).map(([group]) => group),
    ])),
    schemas: {
      logs: Object.fromEntries([...logSchemas].map(([app, s]) => [app, Object.keys(s.fields).length])),
      redacted: [...redactedSchemas.keys()],
    },
    // app → source → the stream selector it reads.
    sources: Object.fromEntries(appNames(registry).map((app) => [app, logSources.streams(app)])),
  }));
  for (const { app, groups } of missing) {
    const lacks = Object.values(groups).flat();
    if (lacks.length === 0) continue;
    console.warn(JSON.stringify({ level: "warn", message: `${app} is not fully configured: ${lacks.join("; ")}`, app, missing: groups }));
  }
});
