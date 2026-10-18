import { readConfig, readLokiConfig } from "../config.ts";
import { createDatabases } from "../db/pool.ts";
import { createLoki } from "../loki.ts";
import { appNames, loadRegistry } from "../registry.ts";
import { loadEdgeSchema, loadRedactedSchemas, loadSchemas } from "../schemas.ts";
import { scopeOf } from "./auth.ts";
import { createApp, createVerifier } from "./http.ts";
import { logsMissing } from "./logs.ts";
import { sqlMissing, toolNames, type ServerOptions } from "./server.ts";

// The apps every tool accepts (apps.json, D38). An invalid registry stops the start.
const registry = loadRegistry();
const config = readConfig(registry);
const lokiConfig = readLokiConfig(registry);
// The apps whose files are present (D37). Refuses to start only when no log
// schema exists or a present one is invalid; an app without its schema is
// refused at the log tools, since an absent schema would hide every field.
const logSchemas = loadSchemas(registry);
// The committed edge schema (D46); missing or invalid stops the start.
const edgeSchema = loadEdgeSchema();
// An app without its redacted-schema.md is refused at describe_schema and query_sql.
const redactedSchemas = loadRedactedSchemas(registry);

const options: ServerOptions = {
  registry,
  logs: {
    schemas: logSchemas,
    edgeSchema,
    loki: createLoki({ url: lokiConfig.url, token: lokiConfig.token }),
    sources: lokiConfig.sources,
  },
  sql: { databases: createDatabases(config.databases), schemas: redactedSchemas },
};

/** Per app and tool group, what is missing; an empty list means configured. */
const missing = appNames(registry).map((app) => ({
  app,
  groups: { logs: logsMissing(app, options.logs), sql: sqlMissing(app, options.sql) },
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
    // app → the tool groups it answers: "logs", "sql".
    apps: Object.fromEntries(missing.map(({ app, groups }) => [
      app,
      Object.entries(groups).filter(([, lacks]) => lacks.length === 0).map(([group]) => group),
    ])),
    schemas: {
      logs: Object.fromEntries([...logSchemas].map(([app, s]) => [app, Object.keys(s.fields).length])),
      redacted: [...redactedSchemas.keys()],
    },
    streams: Object.fromEntries([...lokiConfig.sources].map(([app, s]) => [app, s.stream])),
    edgeStreams: Object.fromEntries([...lokiConfig.sources].flatMap(([app, s]) => (s.edgeStream ? [[app, s.edgeStream]] : []))),
  }));
  for (const { app, groups } of missing) {
    const lacks = [...groups.logs, ...groups.sql];
    if (lacks.length === 0) continue;
    console.warn(JSON.stringify({ level: "warn", message: `${app} is not fully configured: ${lacks.join("; ")}`, app, missing: groups }));
  }
});
