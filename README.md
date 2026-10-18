# hyde-mcp-gateway

Agents read the production logs and databases of shop and crm without seeing personal data. The database side is hyde-db; the log side applies the same principle, a declared field allowlist per app, inside this server. Product records: [`LEDGER.md`](LEDGER.md).

## Run locally

```sh
pnpm install
pnpm schemas                  # schemas/<app>.hyde-json.json for the log tools; needs GITHUB_TOKEN or a `gh` login with read access to the app repos
pnpm fetch:redacted-schemas   # schemas/<app>.redacted-schema.md for describe_schema and query_sql
HYDE_TOKEN_CLAUDE_CODE=$(openssl rand -hex 32) \
COCKPIT_LOGS_URL=https://<id>.logs.cockpit.fr-par.scw.cloud \
COCKPIT_LOGS_READ_TOKEN=<read_only_logs token> \
pnpm dev
```

Both fetch scripts take `--app shop` or `--app crm` (repeatable) to fetch only those apps, and `--strict` to fail when any requested app is missing. The server refuses to start only when `schemas/` holds no log field schema at all, or a present one is invalid (see [Log field schemas](#log-field-schemas) and [`schemas/`](schemas/README.md)).

### Per-app readiness

The server starts with the apps whose files are present (LEDGER D37). An app answers the log tools when `schemas/<app>.hyde-json.json` exists, and `describe_schema` and `query_sql` when `schemas/<app>.redacted-schema.md` exists and `<APP>_REDACTED_URL` is set. Otherwise each of those tools returns the tool error `<app> is not configured: <what is missing>`, for example `crm is not configured: schemas/crm.hyde-json.json is missing`, before it reads anything, so an app without its schema can leak nothing. The startup line lists under `apps` what each app answers (`logs`, `sql`) and a `warn` line follows for every app that is not fully configured. So shop can go live while crm waits: `pnpm schemas --app shop`, `pnpm fetch:redacted-schemas --app shop`, the reader wizard with `--app shop`, and only `SHOP_*` database variables. The image needs at least one app with both schema files.

The server listens on `PORT` (default 8080). `/health` needs no token; `/mcp` needs `Authorization: Bearer <token>`, where every `HYDE_TOKEN_<CLIENT>` variable is one client's token (at least 32 characters). `.mcp.json` registers the production server for Claude Code with the token from `HYDE_TOKEN_CLAUDE_CODE`; `HYDE_URL=http://localhost:8080/mcp` points it at the local one.

Client setup, issuing and rotating client tokens, and a first analysis: [`docs/runbooks/client-setup.md`](docs/runbooks/client-setup.md).

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
| `NODE_ENV` | `production` requires, for every app whose URL is set, `ssl=true`, CA and certificate name, or the server does not start. An app without a URL is not configured for SQL (D37). |

## Log tools

The server builds the LogQL; clients pass only parameters, so neither the token's scope nor the app filter can be widened. For `query_logs("crm", 24, "error", "send-mail")`:

```logql
{resource_name="example-crm-prod"} | json | line_format "{{.message}}" | json | service="crm" | level="error" | action="send-mail"
```

Scaleway wraps each stdout line in `{resource_instance, message, stream}`: the first `| json` opens the envelope, `line_format` makes the app line the log line, and the second `| json` extracts its fields (crm docs/operations.md). `service` is what each app's `log()` writes (`crm`, `shop`), so a broad stream selector still returns only that app's lines. `matched` comes from `sum(count_over_time(<query> [<hours>]))`.

Every line Loki returns goes through `redactLine` with the app's schema before it leaves the server. `action` and `level` are read from the redacted line, so an app's schema must declare them `visible`; `payload` is the redacted `message` field (or the scrubbed text of a line that is not JSON). Loki's stream labels, which hold raw extracted values, are never read. When Loki is unreachable or answers non-2xx, the tool error names Loki and the status, nothing else.

## SQL tools

`query_sql` connects as the redacted reader to database `redacted`, whose privileges are the boundary: hidden columns and base tables are refused by MySQL, and its error text ("Unknown column ...") comes back unchanged as a tool error. Before reaching the database the server refuses anything but a single `SELECT`: no second statement, no semicolon but one trailing, none inside a comment, no executable comment (`/*! */`). A run is bounded by a 15 s statement timeout, a row cap (`limit`, default 200, clamped to 1–1000) and a 1 MB result cap; `truncated` says a cap cut the result. Binary values come back as hex, `BIGINT` and `DECIMAL` as strings, dates as MySQL's text.

TLS follows the apps' runtime: the server certificate is verified against the instance CA, and its identity is checked against `<APP>_DATABASE_CERT_NAME` rather than the host, since the instance certificate names neither the endpoint host nor its address. Without `ssl=true` (outside production) the connection is plain, for a local MySQL. An app without a URL or without its redacted schema answers `describe_schema` and `query_sql` that it is not configured ([Per-app readiness](#per-app-readiness)).

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

Each app declares its log field schema as `prisma/hyde-json.json` in its own repo (crm, shop), next to its Prisma schema (D23). `pnpm schemas` downloads them from the repos' `main` branch through the GitHub API into `schemas/<app>.hyde-json.json` and validates each with `parseSchema`. It writes every app whose schema fetches and validates and warns for each other app; it exits non-zero only when it wrote nothing, or with `--strict` when any requested app failed. `--app <app>` (repeatable) limits it to those apps. Auth is `GITHUB_TOKEN`, else `GH_TOKEN`, else the token of a logged-in `gh`. `pnpm fetch:redacted-schemas` works the same way for `prisma/redacted/redacted-schema.md`.

`schemas/` is gitignored except its README: the app repos own the files. At startup, `loadSchemas()` in [`src/schemas.ts`](src/schemas.ts) reads those present, checks that each file's `app` matches its name, and throws when one is invalid or none exists. An app left out is refused at the log tools ([Per-app readiness](#per-app-readiness)), so no line is ever returned unredacted. `createApp` does not need schemas: without its `logs` option it registers no log tools, so tests run without them; the log tests inject schemas and a Loki client with a fake `fetch`.

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

## Database reader

The server reads each app's database as `redacted_reader`, which can read only hyde-db's views. An admin creates the account and applies the views with `scripts/wizard/redacted-reader.sh`. The wizard writes `CRM_REDACTED_URL` and `SHOP_REDACTED_URL` to `apply.env`. First run, re-apply after a migration and rotation: [`docs/runbooks/redacted-reader.md`](docs/runbooks/redacted-reader.md).

Tools so far: `ping(app)`. `app` is `"shop"` or `"crm"` on every tool.

## Deploy

The server runs as the Scaleway Serverless Container `hyde-mcp-gateway` in the apps' Scaleway project, region `fr-par`, namespace `example-namespace` (D15). `infra/base.yaml` and `infra/environments/production.yaml` declare it; `scripts/infra/apply.ts` reconciles it. Both are copied from crm's `infra/` and trimmed to the container kind.

```sh
pnpm infra:diff     # read the container back; fails on any drift or if it is absent
pnpm infra:apply    # write it, values from apply.env
```

Every run first checks that the `scw` credential in scope reads the committed namespace as organisation and project `<organisation id>` and refuses otherwise. The organisation-level `SCW_*` secrets belong to a different Scaleway organisation and authenticate fine.

### apply.env

Gitignored, never committed, never in GitHub. `pnpm infra:apply` loads it with `node --env-file`. `apply` refuses, listing every missing required name, before it writes anything.

| Key | Kind | Holds |
| --- | --- | --- |
| `COCKPIT_LOGS_URL` | plain | The Cockpit logs (Loki) data source URL, `https://<id>.logs.cockpit.fr-par.scw.cloud` |
| `COCKPIT_LOGS_READ_TOKEN` | secret | Cockpit token, scope `read_only_logs` (D20) |
| `LOKI_STREAM_CRM` | plain, optional | crm's LogQL stream selector; unset, `{resource_name="example-crm-prod"}` |
| `LOKI_STREAM_SHOP` | plain, optional | shop's LogQL stream selector; unset, `{resource_name="example-shop-prod"}` |
| `CRM_REDACTED_URL` | secret | crm's redacted reader, `mysql://<user>:<password>@<host>:3306/redacted?ssl=true` (hyde-db) |
| `SHOP_REDACTED_URL` | secret | shop's redacted reader, same form (hyde-db) |
| `CRM_DATABASE_CA` | secret | crm's RDB instance CA, PEM text |
| `SHOP_DATABASE_CA` | secret | shop's RDB instance CA, PEM text |
| `CRM_DATABASE_CERT_NAME` | plain | The name crm's instance certificate carries, the bare instance id |
| `SHOP_DATABASE_CERT_NAME` | plain | The name shop's instance certificate carries, the bare instance id |
| `HYDE_TOKEN_CLAUDE_CODE` | secret | Claude Code's bearer token, `openssl rand -hex 32` |
| `HYDE_TOKEN_AGENT` | secret | the agent runner's bearer token, `openssl rand -hex 32` |
| `HYDE_IMAGE_TAG` | | optional: image tag to run. Required to create the container; omitted, an update keeps the live image |
| `SCW_ACCESS_KEY`, `SCW_SECRET_KEY` | | optional: the `scw` key, if your profile does not hold it |

A PEM value spans lines: write it in double quotes with its real line breaks, which `node --env-file` keeps:

```sh
CRM_DATABASE_CA="-----BEGIN CERTIFICATE-----
MIID...
-----END CERTIFICATE-----"
```

Secret values land in `secret-environment-variables`, which `scw` returns only as a digest; plain ones in `environment-variables`. `diff` compares names, never values, so a rotation is never drift. A failing `scw` command is printed with every secret argument redacted. The image runs with `NODE_ENV=production`, in which the server refuses to start when an app's URL is set without `ssl=true`, its CA or its certificate name. `infra/base.yaml` still declares both apps' database variables required, so `apply` asks for all of them.

### Deploy workflow

`.github/workflows/deploy.yml` runs on every push to `main`: fetch `schemas/` (`pnpm schemas`, `pnpm fetch:redacted-schemas`), verify the credential's target, build `Dockerfile`, push `rg.fr-par.scw.cloud/example-namespace/hyde-mcp-gateway:<sha>`, `apply production --keep-secrets`, `diff production --strict`, then check over HTTPS that `/health` answers 200 and `/mcp` without a token answers 401. `--keep-secrets` sends no runtime variable, secret or plain, so the container keeps the values set from `apply.env`, and it refuses to create the container. It runs only while the repository variable `HYDE_DEPLOY_ENABLED` is `true`.

The workflow reads three repository secrets, none of them a runtime value of the server:

| Secret | Used for |
| --- | --- |
| `SCW_ACCESS_KEY`, `SCW_SECRET_KEY` | The deploy IAM application's key: registry push, `apply`, `diff` |
| `APP_REPOS_READ_TOKEN` | Build time only: read `main` of the private app repos `example-org/crm` and `example-org/shop` for `schemas/`. A fine-grained PAT or GitHub App token with Contents: read on both; the workflow's own `GITHUB_TOKEN` cannot read other private repos. The step passes it as `GITHUB_TOKEN` (`pnpm schemas`) and `GH_TOKEN` (`gh`, used by `pnpm fetch:redacted-schemas`) |

`schemas/` is gitignored but its README. The `Dockerfile` copies it with the rest of the tree, warns for every app missing `schemas/<app>.hyde-json.json` or `schemas/<app>.redacted-schema.md`, and stops the build when no app has both (D37).

### First deploy

Gather first (a human, once):

- **The two instance CAs.** crm's is the PEM in `lib/database-ca.ts` on crm's `production` branch; shop's is the equivalent file in shop. Either can also be read with `scw rdb instance get-certificate <instance-id> region=fr-par`. They go into `CRM_DATABASE_CA` and `SHOP_DATABASE_CA`.
- **The two certificate names**: the bare RDB instance id of each app's database, as the instance certificate carries it, into `CRM_DATABASE_CERT_NAME` and `SHOP_DATABASE_CERT_NAME`.
- **The Loki URL**, into `COCKPIT_LOGS_URL`:
  ```sh
  scw cockpit data-source get <data-source-id> region=fr-par -o json | jq -r .url
  ```
- **The app-repo read token**: a fine-grained PAT or GitHub App token with Contents: read on `example-org/crm` and `example-org/shop`.

Then:

1. In the apps' Scaleway organisation, create an IAM application `hyde-mcp-gateway-deploy` with a policy granting `ContainersFullAccess` and `ContainerRegistryFullAccess`, and one API key for it.
2. Set that key as repository secrets `SCW_ACCESS_KEY` and `SCW_SECRET_KEY`. Repository secrets override the organisation-level pair; without them the workflow fails at the organisation check.
3. Set the app-repo read token as repository secret `APP_REPOS_READ_TOKEN`. Without it the workflow fails at the schema fetch.
4. Write `apply.env` with every required key above.
5. Fetch the schemas, push the first image and create the container, with the `scw` key in your shell and a `gh` login (or `GITHUB_TOKEN`) that can read both app repos:
   ```sh
   pnpm schemas                  # schemas/<app>.hyde-json.json
   pnpm fetch:redacted-schemas   # schemas/<app>.redacted-schema.md
   tag=$(git rev-parse HEAD)
   echo "$SCW_SECRET_KEY" | docker login rg.fr-par.scw.cloud -u nologin --password-stdin
   docker build --platform linux/amd64 -t rg.fr-par.scw.cloud/example-namespace/hyde-mcp-gateway:$tag .
   docker push rg.fr-par.scw.cloud/example-namespace/hyde-mcp-gateway:$tag
   HYDE_IMAGE_TAG=$tag pnpm infra:apply      # prints containerId= and endpoint=
   pnpm infra:diff
   ```
6. Set the repository variable `HYDE_DEPLOY_ENABLED` to `true`. From then on every push to `main` deploys.
7. Point the clients at `<endpoint>/mcp` with their tokens.

### Rotate a client token

1. Generate a new value: `openssl rand -hex 32`, and replace that client's line in `apply.env`.
2. `pnpm infra:apply`. Without `HYDE_IMAGE_TAG` the running image stays; the container rolls to a new revision with the new token and `apply` returns once it is ready. From then on the old token gets 401.
3. Give the client its new token (the agent runner's secret store; `HYDE_TOKEN_CLAUDE_CODE` in your environment for Claude Code).

A new client is a new `HYDE_TOKEN_<CLIENT>` entry in `infra/base.yaml` `variables:` and in `apply.env`, then `pnpm infra:apply`. Removing one: delete both, run `pnpm infra:apply`, then `pnpm infra:diff`; if it still lists the old name live, remove that secret in the console.
