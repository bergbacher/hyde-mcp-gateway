// The entry point: boot (src/boot.ts: config, schema store, readiness, token
// verifier), listen, print the startup report.

import { boot } from "../boot.ts";
import { createApp } from "./http.ts";

const { config, options, report } = await boot();

createApp(config, options).listen(config.port, () => {
  console.log(JSON.stringify(report.info));
  for (const warning of report.warnings) console.warn(JSON.stringify(warning));
});
