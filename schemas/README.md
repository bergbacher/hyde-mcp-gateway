# schemas/

The server reads each registered app's log field schema and redacted schema from the app's repository at runtime (D58): with `APP_REPOS_READ_TOKEN` set, the schema store ([`src/schema-store.ts`](../src/schema-store.ts)) fetches both files of every app in `apps.json` (your operator file; [`apps.example.json`](../apps.example.json) shows the shape) from its repo's default branch at startup and every `HYDE_SCHEMA_REFRESH_SECONDS` (default 600), and this directory is not read. The app repos own the files (D23); none is committed or built into the image.

This directory holds them only for local runs without the token (developer mode), where the store reads them here instead, on the same schedule. Everything here but this README and `edge.hyde-json.json` is gitignored and kept out of the Docker build context. One file per app and kind, named `<app>.<kind>`:

| File | Source in the app repo | Written by | Read by | When missing |
|---|---|---|---|---|
| `<app>.hyde-json.json` | the entry's `logSchemaPath`, e.g. `prisma/hyde-json.json` (log field schema) | `pnpm schemas` (`scripts/fetch-log-schemas.ts`) | `query_logs`, `count_errors` | The log tools answer that app as not configured (D37); the server still starts. |
| `<app>.redacted-schema.md` | the entry's `redactedSchemaPath`, e.g. `prisma/redacted/redacted-schema.md` (hyde-db) | `pnpm fetch:redacted-schemas` (`scripts/fetch-redacted-schemas.ts`) | `describe_schema`, `query_sql` | Both tools answer that app as not configured (D37); the server still starts. |

A file that is present but invalid is a `warn` line naming it, and the last good one stays loaded; at startup there is none, so the app is not configured.

`edge.hyde-json.json` is the exception: the log field schema of Scaleway Edge Services access logs, read by `query_logs` and `count_errors` with `source: "edge"` (D46). No app writes those lines, so hyde-mcp-gateway owns and commits it and the image carries it; `loadEdgeSchema` ([`src/schemas.ts`](../src/schemas.ts)) refuses to start the server when it is missing or invalid, and `edge` is therefore not a valid app name.

`<app>` is an app's name in `apps.json`, for example `shop` (`example-org/shop`) or `crm` (`example-org/crm`) in the example registry. Both scripts take `--app <app>` (repeatable) to fetch only those apps, write every app that fetches and validates, warn for the others, and fail only when nothing was written or, with `--strict`, when any requested app failed. Both need `GITHUB_TOKEN`, `GH_TOKEN` or a `gh` login.
