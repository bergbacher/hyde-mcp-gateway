# hyde-mcp-gateway

Agents read the production logs and databases of shop and crm without seeing personal data. The database side is hyde-db; the log side applies the same principle, a declared field allowlist per app, inside this server. Product records: [`LEDGER.md`](LEDGER.md).

## Run locally

```sh
pnpm install
HYDE_TOKEN_CLAUDE_CODE=$(openssl rand -hex 32) pnpm dev
```

The server listens on `PORT` (default 8080). `/health` needs no token; `/mcp` needs `Authorization: Bearer <token>`, where every `HYDE_TOKEN_<CLIENT>` variable is one client's token (at least 32 characters). `.mcp.json` registers the local server for Claude Code with the token from `HYDE_TOKEN_CLAUDE_CODE`.

Tools so far: `ping(app)`. `app` is `"shop"` or `"crm"` on every tool.
