import { readConfig } from "../config.ts";
import { loadSchemas } from "../schemas.ts";
import { createApp } from "./http.ts";

const config = readConfig();
// Refuses to start without both log schemas: an absent schema hides every field (D12).
const schemas = loadSchemas();
createApp(config).listen(config.port, () => {
  console.log(JSON.stringify({
    level: "info",
    message: `hyde-mcp-gateway listening on :${config.port}`,
    clients: [...config.clients.values()],
    schemas: Object.fromEntries(Object.entries(schemas).map(([app, s]) => [app, Object.keys(s.fields).length])),
  }));
});
