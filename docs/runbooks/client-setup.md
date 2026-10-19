# Client setup

How a client reaches the production gateway: a person with their GitHub login (D59), a service account with a static token (D16), and a first analysis that checks no personal data comes through.

The gateway's URL is `https://connextparb09d6769-hyde-mcp-gateway.functions.fnc.fr-par.scw.cloud/mcp`. It is not a secret; the token is.

## 1. A person: GitHub token

The credential is the GitHub token of the logged-in `gh`. The gateway asks GitHub who the token is and which app repositories it can read; those apps are its scope. There is nothing to issue, nothing to store and nothing to rotate: read access to an app's repository is read access to its logs and database through the gateway. A token that reads no app repository is accepted with an empty scope, so every tool refuses it.

### The wizard

Runs on macOS without a clone of this repository:

```sh
curl -fsSLO https://raw.githubusercontent.com/bergbacher/hyde-mcp-gateway/main/scripts/wizard/client-setup.sh
bash client-setup.sh
```

It needs `gh`, Claude Code and `node` (for the bridge below); a missing one stops it with the install command. Then:

1. `gh auth status`; if not logged in, `gh auth login` in the browser.
2. One authenticated `ping` to the gateway. 401 means the token is not accepted (GitHub rejected it; `gh auth refresh`). 503 means the gateway could not reach GitHub; the token is fine, try again in a minute. Success names the registered apps and those in scope. An empty scope means: ask for read access to the app repositories; the gateway needs no change.
3. Registers `hyde-mcp-gateway` in Claude Code at user scope, so every project sees it.
4. Writes the same entry to Claude Desktop's `~/Library/Application Support/Claude/claude_desktop_config.json` when Desktop is installed. Desktop reads the file at start: quit it and open it again, then check by hand that its tools include `ping`.
5. Starts the registered entry as the clients do, calls `ping` through it and prints the scope.

Re-running is safe: each client ends up with one entry.

### The bridge

Claude Code cannot run a command to fill an HTTP header, and Claude Desktop sends no custom header at all, so both run the gateway through a stdio bridge:

```sh
export AUTH_HEADER="Bearer $(gh auth token)"
exec npx -y mcp-remote "<url>" --transport http-only --header "Authorization:\$"'{AUTH_HEADER}'
```

`gh auth token` runs when the client starts; mcp-remote reads the header from its environment (the literal `${AUTH_HEADER}`, spelled so that Claude Code's own `${VAR}` expansion of a config never sees it). The token is in no file and in no process argument. The wizard writes the directories of `node` and `gh` into the bridge's `PATH`, since Desktop starts it without a shell profile.

The repository's [`.mcp.json`](../../.mcp.json) holds the same bridge for a Claude Code session opened in this repository, with `${HYDE_URL:-<production url>}` as the URL and without the `PATH` line, since `claude` runs from a shell that has `node` and `gh`. `npx` fetches mcp-remote from the npm registry on the first start. Against a server on your machine (README, Run locally): `HYDE_URL=http://localhost:8080/mcp claude`. The local server checks a GitHub token against GitHub as production does, so your login works there as well.

### Check the connection

`/mcp` in Claude Code shows `hyde-mcp-gateway` connected with five tools: `ping`, `query_logs`, `count_errors`, `describe_schema` and `query_sql`. Ask it to call `ping` with an app you may read. The answer `{"app":"crm","client":"gh:<login>","apps":["shop","crm"],"scope":["crm"]}` names you, lists the apps registered in `apps.json` and the apps this token may read.

- `client gh:<login> is not authorized for app <app>`: your token cannot read that app's repository. Ask the app's team for read access; the gateway's scope follows within five minutes (`HYDE_GITHUB_SCOPE_TTL_SECONDS`), or at once with a new token. Do not ask for a gateway change.
- The server shows as failed: run the wizard again; its token check tells a rejected token from GitHub being unreachable. The container scales to zero, so the first request after idle can take several seconds; retry once.

### A fine-grained PAT instead of `gh`

A token that is not the `gh` login, for example a fine-grained PAT with `Contents: read` on the app repositories, goes into a secret store and replaces `gh auth token` in the bridge: `AUTH_HEADER="Bearer $(security find-generic-password -s hyde-mcp-gateway -w)"` for the macOS Keychain (`security add-generic-password -a "$USER" -s hyde-mcp-gateway -w` stores it, prompting for the value), or `op read "op://<vault>/hyde-mcp-gateway/token"` with 1Password CLI. Never write the value into `.mcp.json`, an `.env` file or a prompt.

## 2. A service account: static token

An agent runner (D5, D10) or any client that is not a person gets a static token. The operator who holds `apply.env` (gitignored, on their machine only) does this. Every client has its own token, `HYDE_TOKEN_<CLIENT>`. The suffix, lowercased with `_` as `-`, is the client name that `ping` reports.

### App scope

Every token has an app scope, `HYDE_TOKEN_<CLIENT>_APPS` (D39): the apps that client may read, as comma-separated `apps.json` names, or `*` for every registered app, today and later.

```sh
HYDE_TOKEN_AGENT_APPS=shop,crm
HYDE_TOKEN_CLAUDE_CODE_APPS=*
```

- There is no implicit all-access. The server refuses to start, naming the variable, when a token has no `_APPS` line, when it names an app `apps.json` does not hold, or when an `_APPS` line has no token.
- A tool call for an app outside the scope is a tool error, `client <client> is not authorized for app <app>`, before any log or database read. The scope is per app, not per tool.
- The scope is not secret (`secret: false` in `infra/base.yaml`). Prefer listing apps over `*`: `*` also grants every app added to `apps.json` later.
- Changing a scope: edit the `_APPS` line in `apply.env`, `pnpm infra:apply`, then `ping` an app in the new scope.

### New client

1. Declare `HYDE_TOKEN_<CLIENT>` in `infra/base.yaml` under `variables:` as required and `secret: true`, and `HYDE_TOKEN_<CLIENT>_APPS` as required and `secret: false`, like the existing ones. Open a PR for this; it holds no value.
2. Add `HYDE_TOKEN_<CLIENT>_APPS=<apps>` to `apply.env` ([App scope](#app-scope)).
3. Continue with step 1 below, adding the token line instead of replacing it.

### Rotate (or issue)

Run from the repo root, with the `scw` key for your Scaleway project in scope (README, Deploy). The examples rotate the agent runner's token; for another client, replace `AGENT`.

1. Keep the old token for the check in step 5 (from the client's secret store). Then generate the new one without printing it:

   ```sh
   old="$(op read "op://<vault>/hyde-mcp-gateway/agent")"
   new="$(openssl rand -hex 32)"
   ```

2. Replace (or add) the client's line in `apply.env`:

   ```sh
   sed -i '' "s/^HYDE_TOKEN_AGENT=.*/HYDE_TOKEN_AGENT=$new/" apply.env   # macOS sed
   grep -c '^HYDE_TOKEN_AGENT=' apply.env                               # must print 1
   ```

3. Apply, then compare:

   ```sh
   pnpm infra:apply
   pnpm infra:diff
   ```

   Without `HYDE_IMAGE_TAG`, `apply` keeps the running image, rolls the container to a new revision with the new secret and returns once that revision is ready. `diff` compares secret names, never values, so a rotation shows no drift. For a new client, `diff` must list the new name live; for a removed one, it must no longer list the old name.

4. Hand the token over out of band, never through an issue, PR, commit, Slack channel or agent prompt:
   - Put it into the client's secret store yourself, or hand it to its owner through a password manager share or in person.

5. Check that the old token is refused and the new one is accepted:

   ```sh
   probe() {
     curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://connextparb09d6769-hyde-mcp-gateway.functions.fnc.fr-par.scw.cloud/mcp" \
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

Delete its two `variables:` entries (token and `_APPS`) in `infra/base.yaml` and its two lines in `apply.env`, run `pnpm infra:apply`, then `pnpm infra:diff`. If `diff` still lists the name live, remove that secret in the console. Probe the removed token as in step 5; it must get 401.

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
