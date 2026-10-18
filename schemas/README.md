# schemas/

Per-app documents the server reads at startup, fetched from each app repo's `main` and never committed: the app repos own them (D23), and everything here but this README is gitignored. One file per app and kind, named `<app>.<kind>`:

| File | Source in the app repo | Fetched by | Read by | At startup |
|---|---|---|---|---|
| `<app>.hyde-json.json` | `prisma/hyde-json.json` (log field schema) | `pnpm schemas` (`scripts/fetch-log-schemas.ts`) | `query_logs`, `count_errors` | Required: the server refuses to start while one is missing or invalid. |
| `<app>.redacted-schema.md` | `prisma/redacted/redacted-schema.md` (hyde-db) | `pnpm fetch:redacted-schemas` (`scripts/fetch-redacted-schemas.ts`) | `describe_schema` | Optional: a missing file makes `describe_schema` answer that app with an error; the server still starts. |

`<app>` is `shop` (`example-org/shop`) or `crm` (`example-org/crm`). `pnpm schemas` needs `GITHUB_TOKEN` or a `gh` login; `pnpm fetch:redacted-schemas` needs an authenticated `gh`. Both loaders live in [`src/schemas.ts`](../src/schemas.ts).
