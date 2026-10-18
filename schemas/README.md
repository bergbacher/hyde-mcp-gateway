# schemas/

Per-app documents the server reads at startup, fetched from each app repo's `main` and never committed: the app repos own them (D23), and everything here but this README is gitignored. One file per app and kind, named `<app>.<kind>`:

| File | Source in the app repo | Fetched by | Read by | At startup |
|---|---|---|---|---|
| `<app>.hyde-json.json` | `prisma/hyde-json.json` (log field schema) | `pnpm schemas` (`scripts/fetch-log-schemas.ts`) | `query_logs`, `count_errors` | A missing file makes the log tools answer that app as not configured (D37). The server refuses to start while none exists or a present one is invalid. |
| `<app>.redacted-schema.md` | `prisma/redacted/redacted-schema.md` (hyde-db) | `pnpm fetch:redacted-schemas` (`scripts/fetch-redacted-schemas.ts`) | `describe_schema`, `query_sql` | A missing file makes both tools answer that app as not configured (D37); the server still starts. |

`<app>` is `shop` (`example-org/shop`) or `crm` (`example-org/crm`). Both scripts take `--app <app>` (repeatable) to fetch only those apps, write every app that fetches and validates, warn for the others, and fail only when nothing was written or, with `--strict`, when any requested app failed. Both need `GITHUB_TOKEN`, `GH_TOKEN` or a `gh` login. Both loaders live in [`src/schemas.ts`](../src/schemas.ts).
