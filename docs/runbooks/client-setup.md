# Client setup

How a client reaches the production server: Claude Code's `.mcp.json` (D9), issuing and rotating a client token (D16), and a first analysis that checks no personal data comes through. the agent runner's configuration lives in the agent repo (D10).

`<endpoint>` is the container's host name. `pnpm infra:apply` prints it as `endpoint=` (README, Deploy); it is not a secret. The token is.

## 1. Claude Code

The repo's [`.mcp.json`](../../.mcp.json) registers the server for every Claude Code session opened in this repo:

```json
{
  "mcpServers": {
    "hyde-mcp-gateway": {
      "type": "http",
      "url": "${HYDE_URL:-https://<endpoint>/mcp}",
      "headers": { "Authorization": "Bearer ${HYDE_TOKEN_CLAUDE_CODE}" }
    }
  }
}
```

Claude Code expands `${VAR}` and `${VAR:-default}` in `url` and `headers` when it starts. Without `HYDE_URL` it connects to production. Once the first deploy has printed the endpoint, replace `<endpoint>` with it and commit.

To use the server from another project, copy the same block into that project's `.mcp.json` with the endpoint filled in.

### The token comes from a secret store

`HYDE_TOKEN_CLAUDE_CODE` holds the token that the `apply.env` line of the same name put on the container. Keep it in a secret store and export it from there. Never write the value into `.mcp.json`, an `.env` file or any other file in a repo, and never paste it into a Claude Code prompt.

macOS Keychain. Store the token once; `-w` without a value prompts for it, so it stays out of shell history:

```sh
security add-generic-password -a "$USER" -s hyde-mcp-gateway-claude-code -w
```

Export it in your shell profile (outside the repo). The profile holds the lookup, not the value:

```sh
# zsh / bash
export HYDE_TOKEN_CLAUDE_CODE="$(security find-generic-password -s hyde-mcp-gateway-claude-code -w)"
```

```fish
# fish
set -gx HYDE_TOKEN_CLAUDE_CODE (security find-generic-password -s hyde-mcp-gateway-claude-code -w)
```

Or scope it to one session instead of every shell:

```sh
HYDE_TOKEN_CLAUDE_CODE="$(security find-generic-password -s hyde-mcp-gateway-claude-code -w)" claude
```

With 1Password CLI, read it the same way: `op read "op://<vault>/hyde-mcp-gateway/claude-code"`.

### Check the connection

Start `claude` in the repo. The first time, it asks whether to trust the project's MCP server; accept. `/mcp` should show `hyde-mcp-gateway` as connected with five tools: `ping`, `query_logs`, `count_errors`, `describe_schema` and `query_sql`. Ask it to call `ping` with `app: "crm"`. The answer `{"app":"crm","client":"claude-code","apps":["shop","crm"]}` confirms the token and the client name, and lists the apps registered in `apps.json`.

If `/mcp` shows the server as failed, check these:

- `HYDE_TOKEN_CLAUDE_CODE` is empty in the shell that started `claude`: the server answers 401.
- `<endpoint>` has not been filled in yet.
- The container scales to zero, so the first request after idle can take several seconds. Retry once before you investigate further.

### Local variant

Against a server on your machine (README, Run locally), point the same entry at it with `HYDE_URL`. The local server reads its client token from `HYDE_TOKEN_CLAUDE_CODE` too, so one throwaway value serves both sides:

```sh
export HYDE_TOKEN_CLAUDE_CODE=$(openssl rand -hex 32)
pnpm dev &        # plus the other variables README, Run locally lists
HYDE_URL=http://localhost:8080/mcp claude
```

That throwaway token is a different value from the production one and never goes into `apply.env`.

## 2. Issue or rotate a client token

The operator who holds `apply.env` (gitignored, on their machine only) does this. Every client has its own token, `HYDE_TOKEN_<CLIENT>`. The suffix, lowercased with `_` as `-`, is the client name that `ping` reports.

### New client

1. Declare `HYDE_TOKEN_<CLIENT>` in `infra/base.yaml` under `variables:` as required and `secret: true`, like the existing ones. Open a PR for this; it holds no value.
2. Continue with step 1 below, adding the line instead of replacing it.

### Rotate (or issue)

Run from the repo root, with the `scw` key for the apps' Scaleway project in scope (README, Deploy). The examples rotate Claude Code's token; for another client, replace `CLAUDE_CODE` and the Keychain service name.

1. Keep the old token for the check in step 5. Then generate the new one without printing it:

   ```sh
   old="$(security find-generic-password -s hyde-mcp-gateway-claude-code -w)"
   new="$(openssl rand -hex 32)"
   ```

2. Replace (or add) the client's line in `apply.env`:

   ```sh
   sed -i '' "s/^HYDE_TOKEN_CLAUDE_CODE=.*/HYDE_TOKEN_CLAUDE_CODE=$new/" apply.env   # macOS sed
   grep -c '^HYDE_TOKEN_CLAUDE_CODE=' apply.env                                     # must print 1
   ```

3. Apply, then compare:

   ```sh
   pnpm infra:apply
   pnpm infra:diff
   ```

   Without `HYDE_IMAGE_TAG`, `apply` keeps the running image, rolls the container to a new revision with the new secret and returns once that revision is ready. `diff` compares secret names, never values, so a rotation shows no drift. For a new client, `diff` must list the new name live; for a removed one, it must no longer list the old name.

4. Hand the token over out of band, never through an issue, PR, commit, Slack channel or agent prompt:
   - Claude Code (your own): put it straight into the Keychain item: `security add-generic-password -U -a "$USER" -s hyde-mcp-gateway-claude-code -w "$new"`. Then restart `claude` from a shell that exported the new value.
   - Another client: put it into that client's secret store yourself, or hand it to its owner through a password manager share or in person.

5. Check that the old token is refused and the new one is accepted:

   ```sh
   probe() {
     curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://<endpoint>/mcp" \
       -H "Authorization: Bearer $1" \
       -H 'Content-Type: application/json' \
       -H 'Accept: application/json, text/event-stream' \
       -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
   }
   probe "$old"   # expect 401
   probe "$new"   # expect 200
   unset old new
   ```

   The server checks the token before it reads the body, so a 401 means only that this token is not accepted. If the old token still gets 200, the previous revision is still draining. Wait a minute and probe again. If it still gets 200 after that, `apply` did not reach the container: run `pnpm infra:diff` and look at the container's revisions in the console.

### Remove a client

Delete its `variables:` entry in `infra/base.yaml` and its line in `apply.env`, run `pnpm infra:apply`, then `pnpm infra:diff`. If `diff` still lists the name live, remove that secret in the console. Probe the removed token as in step 5; it must get 401.

## 3. First analysis

This walkthrough is a session in Claude Code with the server connected. You ask in plain language and Claude calls the tools (`mcp__hyde-mcp-gateway__<tool>`). Below, calls are written as `tool(args)` in parameter order; the tools take named arguments. Every tool takes `app`, the name of an app in `apps.json` (today `"shop"` or `"crm"`); another name is refused with `unknown app <name>; registered: …`. Results are JSON text. The values shown are illustrative; the shape is what to check.

### Step 1: what is failing: `count_errors(app, 24)`

> Count crm's errors of the last 24 hours by action.

```json
{"rows":[{"action":"send-mail","count":2},{"action":"invite-member","count":1}],"total":3,"partial":false}
```

- `rows` holds the error lines grouped by `action`, most frequent first. `[none]` collects lines whose action is missing or not visible.
- `total` is the number of error lines read. `partial: true` means the 5000-line read cap was hit and the counts stop there; narrow `hours`.

Pick the top action for step 2.

### Step 2: what the lines say: `query_logs(app, 24, "error", action)`

> Show crm's error lines of the last 24 hours for action send-mail.

```json
{
  "matched": 2,
  "returned": 2,
  "lines": [
    {
      "timestamp": "2026-10-18T11:40:00.000Z",
      "action": "send-mail",
      "level": "error",
      "payload": {
        "workspaceId": "ws_7f3a",
        "email": "[hidden]",
        "err": {
          "name": "SmtpError",
          "message": "550 mailbox [email] unavailable",
          "stack": "SmtpError: 550 mailbox [email] unavailable\n    at deliver (/app/lib/mail.ts:41:11)\n    at async sendInvite (/app/lib/invite.ts:88:3)"
        }
      }
    }
  ]
}
```

- `matched` counts every line in the window, `returned` counts the lines sent back (default `limit` 100, at most 500). Lines come newest first.
- `payload` is the app's `message` field after redaction, or the scrubbed text of a line that is not JSON. Fields the app's log schema declares `visible` pass through: IDs, error name, stack frames (D13). Every other field reads `[hidden]`, and free text is scrubbed.

Note a visible ID in the payload (here `workspaceId`) for step 3.

### Step 3: who or what the ID is: `describe_schema(app)`, then `query_sql(app, sql)`

> Which view holds workspaces? Then look up workspace ws_7f3a.

`describe_schema("crm")` returns the app's `redacted-schema.md` (hyde-db) as Markdown text: the views in database `redacted` and their visible columns. Columns it does not list cannot be read. Find the view and the ID column that match the log field. Then:

```sql
SELECT <id column>, <status column>, <created column> FROM <view> WHERE <id column> = 'ws_7f3a'
```

```json
{"columns":["<id column>","<status column>","<created column>"],"rows":[["ws_7f3a","active","2026-03-02 09:14:00"]],"truncated":false}
```

- `rows` holds arrays in `columns` order. Dates come back in MySQL's text format, `BIGINT` and `DECIMAL` values as strings, binary values as hex.
- `truncated: true` means the row cap (`limit`, default 200, at most 1000) or the 1 MB cap cut the result.
- A column the schema hides comes back as a tool error with MySQL's text, `Unknown column '...'`. That is the boundary working, not a bug. Try it once on purpose.

### Checklist: no personal data visible

Go through every result of steps 1 to 3:

- [ ] Every field that is not an ID, status, action, level, timestamp, amount or error name reads `[hidden]`. This applies especially to fields named like `email`, `name`, `firstName`, `lastName`, `phone`, `address`, `iban` or `note`.
- [ ] Free text (`err.message`, the first line of `stack`, text payloads) shows `[email]`, `[phone]`, `[iban]`, `[token]` or `?[query]` where a value was, and no raw email address, phone number, IBAN, URL query string or token.
- [ ] No raw person names anywhere, in free text included. The scrubber does not detect names, so read for them: a first or last name in an error message or a non-JSON line is a finding.
- [ ] IDs are opaque (`ws_…`, cuid, uuid). None is an email address or a name.
- [ ] `query_sql` returns only columns that `describe_schema` lists, and a hidden column fails with `Unknown column`.
- [ ] Stack frames keep function, path, line and column. That is intended (D13) and not personal data.

If a box fails, stop the analysis. Don't copy the value anywhere: not into an issue, a PR, Slack or a follow-up prompt. Open an issue that names only the app, the tool, the action and the field path (for example `crm` / `query_logs` / `send-mail` / `payload.err.message`). The fix belongs in that app's `prisma/hyde-json.json` (logs) or its hyde-db annotations (database).
