# schemas/

Per-app documents the server reads at startup, fetched from the `main` of each repo [`apps.json`](../apps.json) registers and never committed: the app repos own them (D23), and everything here but this README and `edge.hyde-json.json` is gitignored. One file per app and kind, named `<app>.<kind>`:

| File | Source in the app repo | Fetched by | Read by | At startup |
|---|---|---|---|---|
| `<app>.hyde-json.json` | the entry's `logSchemaPath`, e.g. `prisma/hyde-json.json` (log field schema) | `pnpm schemas` (`scripts/fetch-log-schemas.ts`) | `query_logs`, `count_errors` | A missing file makes the log tools answer that app as not configured (D37). The server refuses to start while none exists or a present one is invalid. |
| `<app>.redacted-schema.md` | the entry's `redactedSchemaPath`, e.g. `prisma/redacted/redacted-schema.md` (hyde-db) | `pnpm fetch:redacted-schemas` (`scripts/fetch-redacted-schemas.ts`) | `describe_schema`, `query_sql` | A missing file makes both tools answer that app as not configured (D37); the server still starts. |

`edge.hyde-json.json` is the exception: the log field schema of Scaleway Edge Services access logs, read by `query_logs` and `count_errors` with `source: "edge"` (D46). No app writes those lines, so hyde-mcp-gateway owns and commits it; `loadEdgeSchema` refuses to start the server when it is missing or invalid, and `edge` is therefore not a valid app name.

`<app>` is an app's name in `apps.json`, today `shop` (`example-org/shop`) or `crm` (`example-org/crm`). Both scripts take `--app <app>` (repeatable) to fetch only those apps, write every app that fetches and validates, warn for the others, and fail only when nothing was written or, with `--strict`, when any requested app failed. Both need `GITHUB_TOKEN`, `GH_TOKEN` or a `gh` login. Both loaders live in [`src/schemas.ts`](../src/schemas.ts).
