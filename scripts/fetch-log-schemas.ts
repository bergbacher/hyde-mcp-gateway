// `pnpm schemas [--app <name>]... [--strict]`: downloads each app's log field
// schema (apps.json `logSchemaPath`) from its repo's `main` into `schemas/<app>.hyde-json.json`
// (D23), validated before it is written. An app that fails is a warning, not
// an error, unless `--strict` or nothing was written (D37); see
// scripts/fetch-schemas.ts.

import { LOG_SCHEMAS, main } from "./fetch-schemas.ts";

await main(LOG_SCHEMAS);
