import { readConfig, readLokiConfig } from "../config.ts";
import { createDatabases } from "../db/pool.ts";
import { createLoki } from "../loki.ts";
import { loadRedactedSchemas, loadSchemas } from "../schemas.ts";
import { createApp } from "./http.ts";
import { toolNames, type ServerOptions } from "./server.ts";

const config = readConfig();
const lokiConfig = readLokiConfig();
// Refuses to start without both log schemas: an absent schema hides every field (D12).
const logSchemas = loadSchemas();
// Optional: an app without its redacted-schema.md answers describe_schema with an error.
const redactedSchemas = loadRedactedSchemas();

const options: ServerOptions = {
  logs: { schemas: logSchemas, loki: createLoki({ url: lokiConfig.url, token: lokiConfig.token }), streams: lokiConfig.streams },
  sql: { databases: createDatabases(config.databases), schemas: redactedSchemas },
};

createApp(config, options).listen(config.port, () => {
  console.log(JSON.stringify({
    level: "info",
    message: `hyde-mcp-gateway listening on :${config.port}`,
    clients: [...config.clients.values()],
    tools: toolNames(options),
    databases: Object.keys(config.databases),
    schemas: {
      logs: Object.fromEntries(Object.entries(logSchemas).map(([app, s]) => [app, Object.keys(s.fields).length])),
      redacted: Object.keys(redactedSchemas),
    },
    streams: lokiConfig.streams,
  }));
});
