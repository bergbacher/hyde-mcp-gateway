import { readConfig, readLokiConfig } from "../config.ts";
import { createLoki } from "../loki.ts";
import { loadSchemas } from "../schemas.ts";
import { createApp } from "./http.ts";

const config = readConfig();
const lokiConfig = readLokiConfig();
// Refuses to start without both log schemas: an absent schema hides every field (D12).
const schemas = loadSchemas();
const loki = createLoki({ url: lokiConfig.url, token: lokiConfig.token });
createApp(config, { logs: { schemas, loki, streams: lokiConfig.streams } }).listen(config.port, () => {
  console.log(JSON.stringify({
    level: "info",
    message: `hyde-mcp-gateway listening on :${config.port}`,
    clients: [...config.clients.values()],
    schemas: Object.fromEntries(Object.entries(schemas).map(([app, s]) => [app, Object.keys(s.fields).length])),
    streams: lokiConfig.streams,
  }));
});
