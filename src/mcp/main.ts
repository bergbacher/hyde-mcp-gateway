import { readConfig, readLokiConfig } from "../config.ts";
import { createDatabases } from "../db/pool.ts";
import { createLoki } from "../loki.ts";
import { appNames, loadRegistry } from "../registry.ts";
import { readSchemaStoreConfig, SchemaStore } from "../schema-store.ts";
import { loadEdgeSchema } from "../schemas.ts";
import { buildLogSources } from "../sources/index.ts";
import { scopeOf } from "./auth.ts";
import { createApp, createVerifier } from "./http.ts";
import { toolNames, type ServerOptions } from "./server.ts";
import { sqlMissing } from "./sql.ts";

// The apps every tool accepts (apps.json, D38). An invalid registry stops the start.
const registry = loadRegistry();
const config = readConfig(registry);
const lokiConfig = readLokiConfig();
// Each app's log schema and redacted schema, fetched from its repo at startup
// and refreshed on a schedule (D58); local schemas/ files without a token.
// An app whose file is not loaded is refused at the tools that read it (D37);
// no app failing stops the start.
const schemaConfig = readSchemaStoreConfig();
const schemas = new SchemaStore({ registry, ...schemaConfig });
if (schemas.mode === "local") {
  console.warn(JSON.stringify({ level: "warn", message: "APP_REPOS_READ_TOKEN is not set: reading schemas/ (developer mode)" }));
}
await schemas.start();
// Per (app, source) a reader or what is missing (D51), from the registry, the
// schema store's live log schemas (a refresh reaches the readers), the
// committed edge schema (D46; missing or invalid stops the start) and the
// stream overrides in the environment.
const logSources = buildLogSources({ registry, schemas: schemas.logSchemas, edgeSchema: loadEdgeSchema(), env: process.env });

const options: ServerOptions = {
  registry,
  logs: { sources: logSources, loki: createLoki({ url: lokiConfig.url, token: lokiConfig.token }) },
  sql: { databases: createDatabases(config.databases), schemas: schemas.redactedSchemas },
};

/** Per app and tool group ("logs", "edge" when apps.json declares it, "sql"), what is missing at startup; an empty list means configured. A refresh can change it. */
const missing = appNames(registry).map((app) => ({
  app,
  groups: { ...logSources.groups(app), sql: sqlMissing(app, options.sql) },
}));

const verifier = createVerifier(config, registry);

createApp(config, { ...options, verifier }).listen(config.port, () => {
  console.log(JSON.stringify({
    level: "info",
    message: `hyde-mcp-gateway listening on :${config.port}`,
    // Who checks a token: GitHub for GitHub-shaped tokens (D59), the static tokens otherwise.
    verifiers: verifier.kinds,
    githubScopeTtlSeconds: config.githubScopeTtlSeconds,
    // static client → the apps it may read, or "*" (D39).
    clients: Object.fromEntries([...config.clients.values()].map((p) => [p.client, scopeOf(p)])),
    tools: toolNames(options),
    // app → the tool groups it answers: "logs", "edge", "sql".
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
    // app → source → the stream selector it reads.
    sources: Object.fromEntries(appNames(registry).map((app) => [app, logSources.streams(app)])),
  }));
  for (const { app, groups } of missing) {
    const lacks = Object.values(groups).flat();
    if (lacks.length === 0) continue;
    console.warn(JSON.stringify({ level: "warn", message: `${app} is not fully configured: ${lacks.join("; ")}`, app, missing: groups }));
  }
});
