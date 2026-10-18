# hyde-mcp-gateway

Agents read the production logs and databases of shop and crm without seeing personal data. The database side is hyde-db; the log side applies the same principle, a declared field allowlist per app, inside this server. Product records: [`LEDGER.md`](LEDGER.md).

## Run locally

```sh
pnpm install
pnpm schemas   # needs GITHUB_TOKEN or a `gh` login with read access to both app repos
HYDE_TOKEN_CLAUDE_CODE=$(openssl rand -hex 32) pnpm dev
```

The server refuses to start until `schemas/` holds both apps' log field schemas (see [Log field schemas](#log-field-schemas)).

The server listens on `PORT` (default 8080). `/health` needs no token; `/mcp` needs `Authorization: Bearer <token>`, where every `HYDE_TOKEN_<CLIENT>` variable is one client's token (at least 32 characters). `.mcp.json` registers the local server for Claude Code with the token from `HYDE_TOKEN_CLAUDE_CODE`.

Tools so far: `ping(app)`. `app` is `"shop"` or `"crm"` on every tool.

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

`schemas/` is gitignored except its README: the app repos own the files. At startup, `loadSchemas()` in [`src/schemas.ts`](src/schemas.ts) reads both, checks that each file's `app` matches its name, and throws when one is missing, so the server never runs without them. `createApp` does not need schemas, so tests run without them.

A field an app starts logging without declaring it shows up as `[hidden]` until the app's schema declares it and `pnpm schemas` has run again.
