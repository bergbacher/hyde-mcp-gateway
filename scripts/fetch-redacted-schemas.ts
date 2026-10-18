// `pnpm fetch:redacted-schemas [--app shop]... [--strict]`: downloads each
// app's generated `prisma/redacted/redacted-schema.md` from its repo's `main`
// into `schemas/<app>.redacted-schema.md`, which the server reads at startup
// for `describe_schema` and `query_sql`. An app that fails is a warning, not
// an error, unless `--strict` or nothing was written (D37); see
// scripts/fetch-schemas.ts.

import { main, REDACTED_SCHEMAS } from "./fetch-schemas.ts";

await main(REDACTED_SCHEMAS);
