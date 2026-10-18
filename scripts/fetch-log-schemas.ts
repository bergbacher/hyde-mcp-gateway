// `pnpm schemas [--app shop]... [--strict]`: downloads each app's log field
// schema from its repo's `main` branch into `schemas/<app>.hyde-json.json`
// (D23), validated before it is written. An app that fails is a warning, not
// an error, unless `--strict` or nothing was written (D37); see
// scripts/fetch-schemas.ts.

import { LOG_SCHEMAS, main } from "./fetch-schemas.ts";

await main(LOG_SCHEMAS);
