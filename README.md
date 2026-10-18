# hyde-mcp-gateway

An MCP server through which AI agents read the production logs and databases of your organisation's apps without seeing personal data. The database side is hyde-db, which limits a reader to annotated columns by database privileges; the log side applies the same principle, a declared field allowlist per app (`hyde-json`), inside this server. The apps are configuration: `apps.json` registers them (LEDGER D38); [`apps.example.json`](apps.example.json) registers two example apps, `shop` and `crm`, which the examples below use. It runs on Scaleway (Serverless Containers, Cockpit Loki, managed MySQL). Product records: [`LEDGER.md`](LEDGER.md).

## Operator files

Three files configure one deployment. They name your apps, your Scaleway account and your secrets, so they are local, gitignored and never committed; back them up outside git (a password manager or an encrypted store):

| File | Holds | Start from |
| --- | --- | --- |
| `apps.json` | The app registry: per app its repo, schema paths, Loki stream selectors, database endpoint, certificate name and CA source ([Adding an app](#adding-an-app)). No secret. | `cp apps.example.json apps.json` |
| `infra/environments/production.yaml` | Your Scaleway organisation and project ids, registry endpoint, and the container's name, namespace and image ([Deploy](#deploy)). No secret. | `cp infra/environments/production.example.yaml infra/environments/production.yaml` |
| `apply.env` | Every runtime secret and value of the container ([apply.env](#applyenv)). | written by hand and by the reader wizard |

The server, the fetch scripts, the wizard, `infra/` and the `Dockerfile` read `apps.json` and stop with a message pointing at the example when it is missing; `infra/` does the same for `production.yaml`. The deploy workflow cannot see local files: it writes `apps.json` and `production.yaml` from the repository secrets `HYDE_APPS_JSON` and `HYDE_PRODUCTION_YAML` and masks every value in them ([Deploy workflow](#deploy-workflow)). The tests read only the committed examples.

## Run locally

```sh
pnpm install
pnpm schemas                  # schemas/<app>.hyde-json.json for the log tools; needs GITHUB_TOKEN or a `gh` login with read access to the app repos
pnpm fetch:redacted-schemas   # schemas/<app>.redacted-schema.md for describe_schema and query_sql
HYDE_TOKEN_CLAUDE_CODE=$(openssl rand -hex 32) \
HYDE_TOKEN_CLAUDE_CODE_APPS='*' \
COCKPIT_LOGS_URL=https://<id>.logs.cockpit.fr-par.scw.cloud \
COCKPIT_LOGS_READ_TOKEN=<read_only_logs token> \
pnpm dev
```

Both fetch scripts take `--app <name>` (repeatable, any app in `apps.json`) to fetch only those apps, and `--strict` to fail when any requested app is missing. The server refuses to start only when `schemas/` holds no log field schema at all, or a present one is invalid (see [Log field schemas](#log-field-schemas) and [`schemas/`](schemas/README.md)).

### Per-app readiness

The server starts with every app in `apps.json` and computes, per app, what it can answer from the registry, the environment and the schema files present (LEDGER D37). An app answers the log tools when `schemas/<app>.hyde-json.json` exists, and `describe_schema` and `query_sql` when `schemas/<app>.redacted-schema.md` exists and `HYDE_APP_<NAME>_REDACTED_URL` is set. Otherwise each of those tools returns the tool error `<app> is not configured: <what is missing>`, for example `crm is not configured: schemas/crm.hyde-json.json is missing`, before it reads anything, so an app without its schema can leak nothing. A name `apps.json` does not hold is refused at every tool with `unknown app <name>; registered: shop, crm`. A registered app outside the caller's token scope (`HYDE_TOKEN_<CLIENT>_APPS`, D39) is refused next, with `client <client> is not authorized for app <app>`, before readiness is checked and before any backend is touched; so a scoped client learns nothing about the configuration of apps it may not read. The startup line lists under `apps` what each app answers (`logs`, `sql`) and a `warn` line follows for every app that is not fully configured. So shop can go live while crm waits: `pnpm schemas --app shop`, `pnpm fetch:redacted-schemas --app shop`, the reader wizard with `--app shop`, and only `HYDE_APP_SHOP_*` database variables. The image needs at least one app with both schema files.

The server listens on `PORT` (default 8080). `/health` needs no token; `/mcp` needs `Authorization: Bearer <token>`, where every `HYDE_TOKEN_<CLIENT>` variable is one client's token (at least 32 characters) and `HYDE_TOKEN_<CLIENT>_APPS` its app scope. Verification sits behind `TokenVerifier` in [`src/mcp/auth.ts`](src/mcp/auth.ts); the static tokens are its only implementation today. `.mcp.json` registers the production server for Claude Code with the token from `HYDE_TOKEN_CLAUDE_CODE`; `HYDE_URL=http://localhost:8080/mcp` points it at the local one.

Client setup, issuing and rotating client tokens, and a first analysis: [`docs/runbooks/client-setup.md`](docs/runbooks/client-setup.md).

## Adding an app

An app is one `apps.json` entry, its secrets in `apply.env`, and a re-apply. No code changes (LEDGER D38).

1. **Registry entry.** Add the app under `apps` in `apps.json`, then update the repository secret `HYDE_APPS_JSON` with the file. The name matches `^[a-z][a-z0-9-]*$` and is not `edge` (reserved for the edge schema); upper-cased with `-` → `_` it is the infix of the app's variables (`help-desk` → `HYDE_APP_HELP_DESK_`). Every field but `edge` is required, and the server, the scripts and `infra/` refuse an invalid file naming each problem:

   | Field | Holds |
   | --- | --- |
   | `repo` | The app's GitHub repo, `<owner>/<repo>`. |
   | `logSchemaPath` | Its log field schema in that repo, e.g. `prisma/hyde-json.json` ([Log field schemas](#log-field-schemas)). |
   | `redactedSchemaPath` | hyde-db's `redacted-schema.md` in that repo. |
   | `redactedSqlPath` | The directory holding hyde-db's `redacted-views.sql` and `redacted-views-drop.sql`. |
   | `loki.stream` | The LogQL stream selector of the app's container, `{resource_name="<container resource name>"}`. |
   | `loki.service` | The `service` field the app's `log()` writes. |
   | `edge.stream` | Optional: the LogQL stream selector of the app's Scaleway Edge Services pipeline, `{resource_name="<pipeline name>"}` (shop: `{resource_name="shop-prod-es"}`). Without `edge`, `source: "edge"` on the log tools answers `<app> has no edge source` ([Edge access logs](#edge-access-logs)). |
   | `database.host`, `database.port` | The RDB endpoint's DNS name (not an address) and port. |
   | `database.sourceDatabase` | The database the hyde-db views read from. |
   | `database.certName` | The name the instance certificate carries, checked instead of the host (the bare instance id, or the endpoint host when the certificate names it). |
   | `database.caSource` | `{repo, path, ref}` of the file holding the instance CA's PEM block, e.g. the app's `lib/database-ca.ts`. |

2. **Schemas.** `pnpm schemas --app <name>` and `pnpm fetch:redacted-schemas --app <name>` fetch its two schema files; the deploy workflow fetches every registered app's. `APP_REPOS_READ_TOKEN` needs Contents: read on the new repo.
3. **Reader.** `bash scripts/wizard/fetch-redacted-sql.sh --app <name>`, then `bash scripts/wizard/redacted-reader.sh --app <name>` ([runbook](docs/runbooks/redacted-reader.md)). It writes `HYDE_APP_<NAME>_REDACTED_URL` to `apply.env`.
4. **Secrets.** Put the instance CA in `HYDE_APP_<NAME>_DATABASE_CA` in `apply.env` (the `ca.pem` the fetch script wrote). `infra/` derives both variables from `apps.json`; nothing is listed by hand.
5. **Re-apply.** `pnpm infra:apply`, then `pnpm infra:diff`. The next deploy builds an image with the new app's schemas.

An app with only some of this answers the tools it is ready for and is refused at the others ([Per-app readiness](#per-app-readiness)).

## Tools

`app` is the name of an app in `apps.json` on every tool; any other name is a tool error naming the registered apps, and an app outside the caller's scope is a tool error naming the client and the app.

| Tool | Returns |
| --- | --- |
| `ping(app)` | `{app, client, apps, scope}`: proves auth and routing; `apps` lists the registered apps, `scope` the apps this client may read or `"*"`. |
| `query_logs(app, hours=24, level?, action?, limit=100, source="app")` | `{matched, returned, lines: [{timestamp, action, level, payload}]}`, newest first. `hours` ≤ 168, `limit` ≤ 500, `level` is `"error"` or `"info"`. `source: "edge"` reads the app's Edge Services access log; `action` is then `<METHOD> <path>` and `level` may also be `"waf"` (requests the WAF marked block). See [Log tools](#log-tools) and [Edge access logs](#edge-access-logs). |
| `count_errors(app, hours=24, source="app")` | `{rows: [{action, count}], total, partial}`: error lines by action, most frequent first. Reads at most 5000 lines; `partial: true` says the counts stop there. With `source: "edge"` the rows are `{status, action, count}`: origin status and `<METHOD> <path>`; only 5xx lines count, WAF hits do not. |
| `describe_schema(app)` | The app's `redacted-schema.md` (hyde-db): the views and visible columns `query_sql` can read. Loaded at startup from `schemas/<app>.redacted-schema.md`. |
| `query_sql(app, sql, limit?)` | `{columns, rows, truncated}` for one `SELECT` (or `WITH ... SELECT`) over the app's redacted views. See [SQL tools](#sql-tools). |

`createServer(principal, options)` takes the caller (`{client, apps}`, from the `TokenVerifier`) and the registry (`options.registry`, from `loadRegistry()` in [`src/registry.ts`](src/registry.ts)), always registers `ping`, the log tools when `options.logs` is given (log schemas, the edge schema, Loki client, each app's log source), and `describe_schema` and `query_sql` when `options.sql` is given (databases, redacted schemas). `createApp(config, options)` verifies the token with `options.verifier` (default: the static tokens in `config`) and passes the rest of `options` through, so the HTTP tests run with `ping` alone; [`src/mcp/main.ts`](src/mcp/main.ts) builds both.

## Environment

| Variable | |
| --- | --- |
| `HYDE_TOKEN_<CLIENT>` | One client's bearer token, at least 32 characters; the client name is the suffix. At least one. |
| `HYDE_TOKEN_<CLIENT>_APPS` | Required with each token: the apps that client may read, comma-separated `apps.json` names (`shop,crm`), or `*` for every registered app (D39). The server refuses to start, naming the variable, when a token lacks it, when it names an app `apps.json` does not hold, or when it is set without its token. |
| `PORT` | Listen port, default 8080. |
| `COCKPIT_LOGS_URL` | The Cockpit logs data source, `https://<id>.logs.cockpit.fr-par.scw.cloud`. Required. |
| `COCKPIT_LOGS_READ_TOKEN` | Cockpit token with the `read_only_logs` scope (D20), sent as `X-Token`. Required. |
| `HYDE_APP_<NAME>_REDACTED_URL` | The app's redacted reader connection string, `mysql://<user>:<password>@<host>:<port>/redacted?ssl=true`. The only parameter is `ssl`; the database is always `redacted`. Unset, the app is not configured for SQL (D37). |
| `HYDE_APP_<NAME>_DATABASE_CA` | The app's RDB instance CA certificate, PEM text (`scw rdb instance get-certificate`). Required with `ssl=true`. |
| `HYDE_APP_<NAME>_CERT_NAME` | Optional: overrides `database.certName` from `apps.json`, the name the instance certificate must carry. |
| `HYDE_APP_<NAME>_LOKI_STREAM` | Optional: overrides `loki.stream` from `apps.json`, the LogQL stream selector of the app's container. |
| `NODE_ENV` | `production` requires, for every app whose URL is set, `ssl=true` and its CA, or the server does not start. |

`<NAME>` is the app's name in `apps.json` upper-cased, `-` → `_`: `HYDE_APP_SHOP_REDACTED_URL`. A variable of an app `apps.json` does not register is ignored. The two overrides are for local runs and incidents; in production change `apps.json`, which `infra/` does not declare them for.

## Log tools

The server builds the LogQL; clients pass only parameters, so neither the token's scope nor the app filter can be widened. For `query_logs("crm", 24, "error", "send-mail")`:

```logql
{resource_name="example-crm-prod"} | json | line_format "{{.message}}" | json | service="crm" | level="error" | action="send-mail"
```

The stream selector and `service` value are the app's `loki` entry in `apps.json`. Scaleway wraps each stdout line in `{resource_instance, message, stream}`: the first `| json` opens the envelope, `line_format` makes the app line the log line, and the second `| json` extracts its fields. `service` is what each app's `log()` writes (`crm`, `shop` in the example), so a broad stream selector still returns only that app's lines. `matched` comes from `sum(count_over_time(<query> [<hours>]))`.

Every line Loki returns goes through `redactLine` with the app's schema before it leaves the server. `action` and `level` are read from the redacted line, so an app's schema must declare them `visible`; `payload` is the redacted `message` field (or the scrubbed text of a line that is not JSON). Loki's stream labels, which hold raw extracted values, are never read. When Loki is unreachable or answers non-2xx, the tool error names Loki and the status, nothing else.

### Edge access logs

`source: "edge"` (D46) reads an app's Scaleway Edge Services access log from the stream its `apps.json` entry names under `edge.stream`. Edge lines are plain JSON records without the app envelope (`http_request_method`, `http_client_request_url`, `http_response_code_client`, `http_response_code_origin`, `http_client_country_code`, `waf_action`, `waf_mode`, …), so one `| json` extracts them. For `query_logs("shop", 24, level: "error", action: "GET /api/sync", source: "edge")`:

```logql
{resource_name="shop-prod-es"} | json | http_response_code_origin >= 500 or http_response_code_client >= 500 | http_request_method="GET" | http_client_request_url=~"(https?://[^/?#]+)?/api/sync([?#].*)?" | __error__=""
```

- `level`: the lines' own `level` is always `info`, so the server derives one of three, which partition the lines:
  - `error`: the origin or the client status is 500 or above.
  - `waf`: `waf_action` is `block` and neither status is 5xx. In `log_only` mode this is a request the WAF would have blocked; the origin still answered it. WAF hits are kept apart from errors because a `log_only` WAF marks many requests the origin served normally (in one deployment about 4% of requests over 7 days).
  - `info`: the rest, including a `waf_action` of `-` or none and a status 0 (the client aborted).

  `__error__=""` drops a line whose status is not a number rather than failing the count.
- `action`: an edge line has none, so the server derives `<METHOD> <path>` from the raw line: the URL path without query or fragment, scrubbed as free text so personal data in a path cannot get around the schema. The `action` filter takes the same form.
- Redaction: every line goes through `redactLine` with [`schemas/edge.hyde-json.json`](schemas/edge.hyde-json.json), committed here because no app writes these lines: the client IP and Scaleway's `pipeline_id` and `project_id` are hidden, the URL is `text` (its query string becomes `?[query]`), every other field is visible. `payload` is the whole redacted line. The server does not start without the file.
- `count_errors` counts `level` `error` lines only, grouped by origin status and `<METHOD> <path>`. For WAF hits use `query_logs` with `level: "waf"`.
- An app without `edge` in `apps.json` answers `<app> has no edge source` at both tools, before Loki is asked. The app's own log schema is not needed for its edge source.

## SQL tools

`query_sql` connects as the redacted reader to database `redacted`, whose privileges are the boundary: hidden columns and base tables are refused by MySQL, and its error text ("Unknown column ...") comes back unchanged as a tool error. Before reaching the database the server refuses anything but a single `SELECT`: no second statement, no semicolon but one trailing, none inside a comment, no executable comment (`/*! */`). A run is bounded by a 15 s statement timeout, a row cap (`limit`, default 200, clamped to 1–1000) and a 1 MB result cap; `truncated` says a cap cut the result. Binary values come back as hex, `BIGINT` and `DECIMAL` as strings, dates as MySQL's text.

TLS follows the apps' runtime: the server certificate is verified against the instance CA, and its identity is checked against the app's `database.certName` in `apps.json` (or `HYDE_APP_<NAME>_CERT_NAME`) rather than the host, since an instance certificate need not name the endpoint host and never its address. Without `ssl=true` (outside production) the connection is plain, for a local MySQL. An app without a URL or without its redacted schema answers `describe_schema` and `query_sql` that it is not configured ([Per-app readiness](#per-app-readiness)).

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

Each app declares its log field schema in its own repo at the `logSchemaPath` its `apps.json` entry names, for example `prisma/hyde-json.json` next to the app's Prisma schema (D23). `pnpm schemas` downloads them from the repos' `main` branch through the GitHub API into `schemas/<app>.hyde-json.json` and validates each with `parseSchema`. It writes every app whose schema fetches and validates and warns for each other app; it exits non-zero only when it wrote nothing, or with `--strict` when any requested app failed. `--app <app>` (repeatable) limits it to those apps. Auth is `GITHUB_TOKEN`, else `GH_TOKEN`, else the token of a logged-in `gh`. `pnpm fetch:redacted-schemas` works the same way for each entry's `redactedSchemaPath`.

`schemas/` is gitignored except its README and `edge.hyde-json.json` ([Edge access logs](#edge-access-logs)): the app repos own the other files. At startup, `loadSchemas(registry)` in [`src/schemas.ts`](src/schemas.ts) reads those present for the registered apps, checks that each file's `app` matches its name, and throws when one is invalid or none exists. An app left out is refused at the log tools ([Per-app readiness](#per-app-readiness)), so no line is ever returned unredacted. `createApp` does not need schemas: without its `logs` option it registers no log tools, so tests run without them; the log tests inject schemas and a Loki client with a fake `fetch`.

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

The server reads each app's database as `redacted_reader`, which can read only hyde-db's views. An admin creates the account and applies the views with `scripts/wizard/redacted-reader.sh`, which takes host, port and source database from `apps.json` and writes `HYDE_APP_<NAME>_REDACTED_URL` to `apply.env` for each app. First run, re-apply after a migration and rotation: [`docs/runbooks/redacted-reader.md`](docs/runbooks/redacted-reader.md).

## Deploy

The server runs as a Scaleway Serverless Container, `hyde-mcp-gateway` by default, in the apps' project and container namespace, region `fr-par` (D15). `infra/base.yaml` (committed: shape, probes, variables) and `infra/environments/production.yaml` (your operator file: ids, registry, namespace, name, image) declare it; `scripts/infra/apply.ts` reconciles it.

```sh
pnpm infra:diff     # read the container back; fails on any drift or if it is absent
pnpm infra:apply    # write it, values from apply.env
```

Every run first checks that the `scw` credential in scope reads the configured namespace as the organisation and project `production.yaml` names, and refuses otherwise: organisation-level `SCW_*` secrets of a different Scaleway organisation authenticate fine.

### apply.env

Gitignored, never committed, never in GitHub. `pnpm infra:apply` loads it with `node --env-file`. `apply` refuses, listing every missing required name, before it writes anything.

The global keys are listed in `infra/base.yaml`. Each app's two keys are derived from `apps.json` when `infra/` is loaded, never listed by hand: `HYDE_APP_<NAME>_REDACTED_URL` and `HYDE_APP_<NAME>_DATABASE_CA`, both secret and optional. The container gets the apps whose keys `apply.env` holds; an app with one of its two keys needs the other, and `apply` refuses otherwise. `apply` prints the apps it configured (`apps=`). `diff` expects both keys of every app that has one live, so a half-configured app is drift. `test/infra/committed.test.ts` keeps this table in step with the declared variables.

| Key | Kind | Holds |
| --- | --- | --- |
| `COCKPIT_LOGS_URL` | plain | The Cockpit logs (Loki) data source URL, `https://<id>.logs.cockpit.fr-par.scw.cloud` |
| `COCKPIT_LOGS_READ_TOKEN` | secret | Cockpit token, scope `read_only_logs` (D20) |
| `HYDE_TOKEN_CLAUDE_CODE` | secret | Claude Code's bearer token, `openssl rand -hex 32` |
| `HYDE_TOKEN_CLAUDE_CODE_APPS` | plain | The apps Claude Code may read: comma-separated `apps.json` names, or `*` (D39) |
| `HYDE_TOKEN_AGENT` | secret | The agent runner's bearer token (D5), `openssl rand -hex 32` |
| `HYDE_TOKEN_AGENT_APPS` | plain | The apps the agent runner may read, same form |
| `HYDE_APP_SHOP_REDACTED_URL` | secret, per app | shop's redacted reader, `mysql://<user>:<password>@<host>:<port>/redacted?ssl=true` (hyde-db) |
| `HYDE_APP_SHOP_DATABASE_CA` | secret, per app | shop's RDB instance CA, PEM text |
| `HYDE_APP_CRM_REDACTED_URL` | secret, per app | crm's redacted reader, same form |
| `HYDE_APP_CRM_DATABASE_CA` | secret, per app | crm's RDB instance CA, PEM text |
| `HYDE_IMAGE_TAG` | | optional: image tag to run. Required to create the container; omitted, an update keeps the live image |
| `SCW_ACCESS_KEY`, `SCW_SECRET_KEY` | | optional: the `scw` key, if your profile does not hold it |

A PEM value spans lines: write it in double quotes with its real line breaks, which `node --env-file` keeps:

```sh
HYDE_APP_CRM_DATABASE_CA="-----BEGIN CERTIFICATE-----
MIID...
-----END CERTIFICATE-----"
```

Secret values land in `secret-environment-variables`, which `scw` returns only as a digest; plain ones in `environment-variables`. `diff` compares names, never values, so a rotation is never drift. A failing `scw` command is printed with every secret argument redacted. The image runs with `NODE_ENV=production`, in which the server refuses to start when an app's URL is set without `ssl=true` or its CA.

### Deploy workflow

`.github/workflows/deploy.yml` runs on every push to `main`: fetch `schemas/` (`pnpm schemas`, `pnpm fetch:redacted-schemas`), verify the credential's target, build `Dockerfile`, push `<registryEndpoint>/hyde-mcp-gateway:<sha>`, `apply production --keep-secrets`, `diff production --strict`, then check over HTTPS that `/health` answers 200 and `/mcp` without a token answers 401. `--keep-secrets` sends no runtime variable, secret or plain, so the container keeps the values set from `apply.env`, and it refuses to create the container. It runs only while the repository variable `HYDE_DEPLOY_ENABLED` is `true`.

A manual run with `build_only` (`gh workflow run deploy.yml -f build_only=true`) runs whatever that variable says, and only fetches `schemas/`, verifies the credential's target, builds and pushes `<sha>` and `manual-<sha>` (it never moves `latest`). It runs no apply, diff or smoke check and writes the command for the local apply, `HYDE_IMAGE_TAG=<sha> pnpm infra:apply`, to the job summary (D44).

The workflow reads five repository secrets, none of them a runtime value of the server:

| Secret | Used for |
| --- | --- |
| `SCW_ACCESS_KEY`, `SCW_SECRET_KEY` | The deploy IAM application's key: registry push, `apply`, `diff` |
| `HYDE_APPS_JSON`, `HYDE_PRODUCTION_YAML` | The operator files `apps.json` and `infra/environments/production.yaml`, verbatim ([Operator files](#operator-files)). The first step writes them and masks every value they hold in the log |
| `APP_REPOS_READ_TOKEN` | Build time only: read `main` of the private app repos `apps.json` registers, for `schemas/`. A fine-grained PAT or GitHub App token with Contents: read on each; the workflow's own `GITHUB_TOKEN` cannot read other private repos. The step passes it as `GITHUB_TOKEN` (`pnpm schemas`) and `GH_TOKEN` (`gh`, used by `pnpm fetch:redacted-schemas`) |

`schemas/` is gitignored but its README and the edge schema. The `Dockerfile` copies it with the rest of the tree, warns for every app missing `schemas/<app>.hyde-json.json` or `schemas/<app>.redacted-schema.md`, and stops the build when no app has both (D37).

### First deploy

Gather first (a human, once):

- **Each app's instance CA**, from the file its `apps.json` entry names under `database.caSource` (on another branch than `main` if the app has not merged it yet). `scripts/wizard/fetch-redacted-sql.sh` writes it as `.redacted-sql/<app>/ca.pem`; `scw rdb instance get-certificate <instance-id> region=fr-par` reads it too. It goes into `HYDE_APP_<NAME>_DATABASE_CA`. The certificate names are already in `apps.json`.
- **The Loki URL**, into `COCKPIT_LOGS_URL`:
  ```sh
  scw cockpit data-source list region=fr-par -o json | jq -r '.[] | select(.type == "logs") | .url'
  ```
- **The app-repo read token**: a fine-grained PAT or GitHub App token with Contents: read on every app repo `apps.json` registers.

Then:

1. In the apps' Scaleway organisation, create an IAM application `hyde-mcp-gateway-deploy` with a policy granting `ContainersFullAccess` and `ContainerRegistryFullAccess`, and one API key for it.
2. Set that key as repository secrets `SCW_ACCESS_KEY` and `SCW_SECRET_KEY`. Repository secrets override the organisation-level pair; without them the workflow fails at the organisation check.
3. Set the app-repo read token as repository secret `APP_REPOS_READ_TOKEN`, and the contents of `apps.json` and `infra/environments/production.yaml` as `HYDE_APPS_JSON` and `HYDE_PRODUCTION_YAML` (`gh secret set HYDE_APPS_JSON < apps.json`). Without them the workflow fails at the first step or the schema fetch.
4. Write `apps.json` and `infra/environments/production.yaml` from their examples ([Operator files](#operator-files)), and `apply.env` with every required key above and both keys of each app to configure.
5. Push the first image. No Docker needed on your machine: run the workflow in build-only mode on `main` and wait for it to finish:
   ```sh
   gh workflow run deploy.yml --ref main -f build_only=true
   gh run watch "$(gh run list --workflow deploy.yml --limit 1 --json databaseId -q '.[0].databaseId')"
   ```
   Its job summary prints the exact command for the next step, with the commit it built.
6. Create the container from that image, with the `scw` key in your shell and `<sha>` from the summary:
   ```sh
   HYDE_IMAGE_TAG=<sha> pnpm infra:apply     # prints containerId= and endpoint=
   pnpm infra:diff
   ```
   **Alternative, with Docker locally** instead of steps 5 and 6: fetch the schemas, push the image and create the container yourself, with a `gh` login (or `GITHUB_TOKEN`) that can read both app repos:
   ```sh
   pnpm schemas                  # schemas/<app>.hyde-json.json
   pnpm fetch:redacted-schemas   # schemas/<app>.redacted-schema.md
   tag=$(git rev-parse HEAD)
   echo "$SCW_SECRET_KEY" | docker login rg.fr-par.scw.cloud -u nologin --password-stdin
   image=$(node scripts/infra/apply.ts target production | sed -n 's/^image=//p')
   docker build --platform linux/amd64 -t "$image:$tag" .
   docker push "$image:$tag"
   HYDE_IMAGE_TAG=$tag pnpm infra:apply      # prints containerId= and endpoint=
   pnpm infra:diff
   ```
7. Set the repository variable `HYDE_DEPLOY_ENABLED` to `true`. From then on every push to `main` deploys.
8. Point the clients at `<endpoint>/mcp` with their tokens.

### Rotate a client token

1. Generate a new value: `openssl rand -hex 32`, and replace that client's line in `apply.env`.
2. `pnpm infra:apply`. Without `HYDE_IMAGE_TAG` the running image stays; the container rolls to a new revision with the new token and `apply` returns once it is ready. From then on the old token gets 401.
3. Give the client its new token (the agent runner's secret store; `HYDE_TOKEN_CLAUDE_CODE` in your environment for Claude Code).

A new client is a new `HYDE_TOKEN_<CLIENT>` and `HYDE_TOKEN_<CLIENT>_APPS` pair in `infra/base.yaml` `variables:` and in `apply.env`, then `pnpm infra:apply`. Changing a client's apps is an edit of its `_APPS` line in `apply.env` and `pnpm infra:apply`. Removing one: delete both pairs, run `pnpm infra:apply`, then `pnpm infra:diff`; if it still lists the old name live, remove that secret in the console.
