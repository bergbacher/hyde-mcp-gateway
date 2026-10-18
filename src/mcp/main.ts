import { APPS, readConfig, readLokiConfig } from "../config.ts";
import { createDatabases } from "../db/pool.ts";
import { createLoki } from "../loki.ts";
import { loadRedactedSchemas, loadSchemas } from "../schemas.ts";
import { createApp } from "./http.ts";
import { logsMissing } from "./logs.ts";
import { sqlMissing, toolNames, type ServerOptions } from "./server.ts";

const config = readConfig();
const lokiConfig = readLokiConfig();
// The apps whose files are present (D37). Refuses to start only when no log
// schema exists or a present one is invalid; an app without its schema is
// refused at the log tools, since an absent schema would hide every field.
const logSchemas = loadSchemas();
// An app without its redacted-schema.md is refused at describe_schema and query_sql.
const redactedSchemas = loadRedactedSchemas();

const options: ServerOptions = {
  logs: { schemas: logSchemas, loki: createLoki({ url: lokiConfig.url, token: lokiConfig.token }), streams: lokiConfig.streams },
  sql: { databases: createDatabases(config.databases), schemas: redactedSchemas },
};

/** Per app and tool group, what is missing; an empty list means configured. */
const missing = APPS.map((app) => ({
  app,
  groups: { logs: logsMissing(app, options.logs?.schemas), sql: sqlMissing(app, options.sql) },
}));

createApp(config, options).listen(config.port, () => {
  console.log(JSON.stringify({
    level: "info",
    message: `hyde-mcp-gateway listening on :${config.port}`,
    clients: [...config.clients.values()],
    tools: toolNames(options),
    // app → the tool groups it answers: "logs", "sql".
    apps: Object.fromEntries(missing.map(({ app, groups }) => [
      app,
      Object.entries(groups).filter(([, lacks]) => lacks.length === 0).map(([group]) => group),
    ])),
    schemas: {
      logs: Object.fromEntries(Object.entries(logSchemas).map(([app, s]) => [app, Object.keys(s.fields).length])),
      redacted: Object.keys(redactedSchemas),
    },
    streams: lokiConfig.streams,
  }));
  for (const { app, groups } of missing) {
    const lacks = [...groups.logs, ...groups.sql];
    if (lacks.length === 0) continue;
    console.warn(JSON.stringify({ level: "warn", message: `${app} is not fully configured: ${lacks.join("; ")}`, app, missing: groups }));
  }
});
