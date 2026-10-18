# hyde-mcp-gateway

Agents read the production logs and databases of shop and crm without seeing personal data. The database side is hyde-db; the log side applies the same principle, a declared field allowlist per app, inside this server. Product records: [`LEDGER.md`](LEDGER.md).

## Run locally

```sh
pnpm install
pnpm schemas                  # required: schemas/<app>.hyde-json.json; needs GITHUB_TOKEN or a `gh` login with read access to both app repos
pnpm fetch:redacted-schemas   # optional: schemas/<app>.redacted-schema.md for describe_schema
HYDE_TOKEN_CLAUDE_CODE=$(openssl rand -hex 32) \
COCKPIT_LOGS_URL=https://<id>.logs.cockpit.fr-par.scw.cloud \
COCKPIT_LOGS_READ_TOKEN=<read_only_logs token> \
pnpm dev
```

The server refuses to start until `schemas/` holds both apps' log field schemas (see [Log field schemas](#log-field-schemas) and [`schemas/`](schemas/README.md)). Redacted schemas are optional, and so are database URLs outside production.

The server listens on `PORT` (default 8080). `/health` needs no token; `/mcp` needs `Authorization: Bearer <token>`, where every `HYDE_TOKEN_<CLIENT>` variable is one client's token. `.mcp.json` registers the local server for Claude Code with the token from `HYDE_TOKEN_CLAUDE_CODE`.

## Tools

`app` is `"shop"` or `"crm"` on every tool.

| Tool | Returns |
| --- | --- |
| `ping(app)` | `{app, client}`: proves auth and routing. |
| `query_logs(app, hours=24, level?, action?, limit=100)` | `{matched, returned, lines: [{timestamp, action, level, payload}]}`, newest first. `hours` ≤ 168, `limit` ≤ 500, `level` is `"error"` or `"info"`. See [Log tools](#log-tools). |
| `count_errors(app, hours=24)` | `{rows: [{action, count}], total, partial}`: error lines by action, most frequent first. Reads at most 5000 lines; `partial: true` says the counts stop there. |
| `describe_schema(app)` | The app's `redacted-schema.md` (hyde-db): the views and visible columns `query_sql` can read. Loaded at startup from `schemas/<app>.redacted-schema.md`. |
| `query_sql(app, sql, limit?)` | `{columns, rows, truncated}` for one `SELECT` (or `WITH ... SELECT`) over the app's redacted views. See [SQL tools](#sql-tools). |

`createServer(client, options)` always registers `ping`, the log tools when `options.logs` is given (log schemas, Loki client, stream selectors), and `describe_schema` and `query_sql` when `options.sql` is given (databases, redacted schemas). `createApp(config, options = {})` passes `options` through, so the HTTP tests run with `ping` alone; [`src/mcp/main.ts`](src/mcp/main.ts) builds both.

## Environment

| Variable | |
| --- | --- |
| `HYDE_TOKEN_<CLIENT>` | One client's bearer token, at least 32 characters; the client name is the suffix. At least one. |
| `PORT` | Listen port, default 8080. |
| `COCKPIT_LOGS_URL` | The Cockpit logs data source, `https://<id>.logs.cockpit.fr-par.scw.cloud`. Required. |
| `COCKPIT_LOGS_READ_TOKEN` | Cockpit token with the `read_only_logs` scope (D20), sent as `X-Token`. Required. |
| `LOKI_STREAM_SHOP`, `LOKI_STREAM_CRM` | LogQL stream selector of the app's container. Default `{resource_name="example-<app>-prod"}`. |
| `CRM_REDACTED_URL`, `SHOP_REDACTED_URL` | The redacted reader's connection string, `mysql://<user>:<password>@<host>:3306/redacted?ssl=true`. The only parameter is `ssl`; the database is always `redacted`. |
| `CRM_DATABASE_CA`, `SHOP_DATABASE_CA` | The RDB instance's CA certificate, PEM text (`scw rdb instance get-certificate`). Required with `ssl=true`. |
| `CRM_DATABASE_CERT_NAME`, `SHOP_DATABASE_CERT_NAME` | The name the instance certificate carries, the bare instance id. Required with `ssl=true`. |
| `NODE_ENV` | `production` requires both apps' URLs with `ssl=true`, CA and certificate name, or the server does not start. |

## Log tools

The server builds the LogQL; clients pass only parameters, so neither the token's scope nor the app filter can be widened. For `query_logs("crm", 24, "error", "send-mail")`:

```logql
{resource_name="example-crm-prod"} | json | line_format "{{.message}}" | json | service="crm" | level="error" | action="send-mail"
```

Scaleway wraps each stdout line in `{resource_instance, message, stream}`: the first `| json` opens the envelope, `line_format` makes the app line the log line, and the second `| json` extracts its fields (crm docs/operations.md). `service` is what each app's `log()` writes (`crm`, `shop`), so a broad stream selector still returns only that app's lines. `matched` comes from `sum(count_over_time(<query> [<hours>]))`.

Every line Loki returns goes through `redactLine` with the app's schema before it leaves the server. `action` and `level` are read from the redacted line, so an app's schema must declare them `visible`; `payload` is the redacted `message` field (or the scrubbed text of a line that is not JSON). Loki's stream labels, which hold raw extracted values, are never read. When Loki is unreachable or answers non-2xx, the tool error names Loki and the status, nothing else.

## SQL tools

`query_sql` connects as the redacted reader to database `redacted`, whose privileges are the boundary: hidden columns and base tables are refused by MySQL, and its error text ("Unknown column ...") comes back unchanged as a tool error. Before reaching the database the server refuses anything but a single `SELECT`: no second statement, no semicolon but one trailing, none inside a comment, no executable comment (`/*! */`). A run is bounded by a 15 s statement timeout, a row cap (`limit`, default 200, clamped to 1–1000) and a 1 MB result cap; `truncated` says a cap cut the result. Binary values come back as hex, `BIGINT` and `DECIMAL` as strings, dates as MySQL's text.

TLS follows the apps' runtime: the server certificate is verified against the instance CA, and its identity is checked against `<APP>_DATABASE_CERT_NAME` rather than the host, since the instance certificate names neither the endpoint host nor its address. Without `ssl=true` (outside production) the connection is plain, for a local MySQL. Outside production an app without a URL answers `query_sql` with an error.

## hyde-json

[`packages/hyde-json`](packages/hyde-json) redacts one raw log line by a declared field schema (D12, D13, D23). Each app declares its schema in its own repo; this server enforces it.

```ts
import { parseSchema, redactLine } from "hyde-json";

const schema = parseSchema({
  app: "crm",
  passIds: false,     // true: undeclared `id` / `…Id` fields pass
  passNumbers: false, // true: undeclared numbers pass
  fields: { level: "visible", "message.memberId": "visible", "message.email": "hidden", "message.err": "text" },
});
redactLine(raw, schema); // → { envelope?, format: "json" | "text", line }
```

- Paths are dotted and relative to the app line, so payload fields sit under `message.`; array elements share their array's path.
- `visible` passes, `hidden` and every undeclared field become `[hidden]`, `text` is scrubbed: emails, IBANs, phone numbers, URL query strings and long opaque tokens become `[email]`, `[iban]`, `[phone]`, `?[query]`, `[token]`.
- A serialized error (`{name, message, stack}`) at a `visible` or `text` path keeps `name`, scrubs `message`, and keeps every `at …` stack frame whole; only the non-frame lines of the stack are scrubbed.
- Scaleway's envelope (`resource_instance`, `message`, `stream`) is unwrapped first; a line that is not a JSON object is scrubbed whole as text.

## Log field schemas

Each app declares its log field schema as `prisma/hyde-json.json` in its own repo (crm, shop), next to its Prisma schema (D23). `pnpm schemas` downloads both from the repos' `main` branch through the GitHub API into `schemas/<app>.hyde-json.json`, validates them with `parseSchema`, and exits non-zero without writing anything when one is missing or invalid. Auth is `GITHUB_TOKEN`, else the token of a logged-in `gh`. The container build, once it exists, runs `pnpm schemas` before packaging the server.

`schemas/` is gitignored except its README: the app repos own the files. At startup, `loadSchemas()` in [`src/schemas.ts`](src/schemas.ts) reads both, checks that each file's `app` matches its name, and throws when one is missing, so the server never runs without them. `createApp` does not need schemas: without its `logs` option it registers no log tools, so tests run without them; the log tests inject schemas and a Loki client with a fake `fetch`.

A field an app starts logging without declaring it shows up as `[hidden]` until the app's schema declares it and `pnpm schemas` has run again.

## Tests

```sh
pnpm typecheck
pnpm test
```

### Integration test

`test/query.integration.test.ts` runs `query_sql` against a local MySQL and is skipped unless `HYDE_TEST_MYSQL_URL` is set. With Homebrew `mysql@8.4`:

```sh
brew install mysql@8.4 && brew services start mysql@8.4
# database `redacted` with one view over a base table, and the reader that may read `redacted` only
$(brew --prefix mysql@8.4)/bin/mysql -uroot < test/fixtures/redacted.sql
HYDE_TEST_MYSQL_URL='mysql://redacted_reader:local-reader-password@127.0.0.1:3306/redacted' pnpm test
```

To also run the TLS cases against the server's auto-generated certificate:

```sh
HYDE_TEST_MYSQL_URL='mysql://redacted_reader:local-reader-password@127.0.0.1:3306/redacted' \
HYDE_TEST_MYSQL_CA_FILE="$(brew --prefix)/var/mysql/ca.pem" \
HYDE_TEST_MYSQL_CERT_NAME="$(openssl x509 -in "$(brew --prefix)/var/mysql/server-cert.pem" -noout -subject -nameopt multiline | sed -n 's/ *commonName *= //p')" \
pnpm test
```
