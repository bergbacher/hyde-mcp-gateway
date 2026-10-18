import { readConfig } from "../config.ts";
import { createApp } from "./http.ts";

const config = readConfig();
createApp(config).listen(config.port, () => {
  console.log(JSON.stringify({ level: "info", message: `hyde-mcp-gateway listening on :${config.port}`, clients: [...config.clients.values()] }));
});
