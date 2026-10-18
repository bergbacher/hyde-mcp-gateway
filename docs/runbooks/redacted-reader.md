# Runbook: redacted_reader on each app's database

hyde-mcp-gateway reads each app's database as `redacted_reader`, an account that can `SELECT` from the views in database `redacted` and nothing else (LEDGER D2, D18). hyde-db generates the views from each app's `@hyde` annotations as two scripts in the app repo: `prisma/redacted/redacted-views.sql` (apply) and `prisma/redacted/redacted-views-drop.sql` (drop). Only an admin of each RDB instance can run them (D19), so a human runs them through a wizard:

| Script | What it does |
|---|---|
| `scripts/wizard/fetch-redacted-sql.sh` | Fetches both scripts (from the entry's `repo` and `redactedSqlPath`) and the instance CA (from `database.caSource`, as `ca.pem`) of each app in `apps.json` (or only the apps named by `--app`) from GitHub into `.redacted-sql/` (gitignored). |
| `scripts/wizard/redacted-reader.sh` | For each app in `apps.json` order (or only the apps named by `--app`): admin connection → drop and apply the views → set the reader's password and unlock it → verify as the reader → write `HYDE_APP_<NAME>_REDACTED_URL` to `apply.env` (gitignored). |

Every step says what it runs and waits for a yes. Every step is idempotent, so after a failure fix the cause and run the wizard again from the start. `--dry-run` asks nothing, runs nothing, writes nothing, and prints every statement with passwords masked.

Both scripts read the apps from `apps.json` (LEDGER D38) and take `--app <name>` (repeatable) to handle only those apps (LEDGER D37); without it they handle every registered app. The other apps are not fetched, not touched and need no files, and their `HYDE_APP_<NAME>_REDACTED_URL` in `apply.env` stays as it is. hyde-mcp-gateway answers an app without a URL or redacted schema as not configured, so one app can go live before another. The reader wizard's SQL paths are optional: one per selected app, in the order the apps are selected (`--app` order, else `apps.json` order), defaulting to `.redacted-sql/<app>/redacted-views.sql`. Both need `node` to read `apps.json`.

## What you need

- For each instance, an admin account and its password. Per hyde-db it needs `CREATE USER`, `CREATE`, `DROP`, `CREATE VIEW` and `SELECT` on database `redacted`, `SELECT` on the source tables, `GRANT OPTION` on the views, `SELECT` on `mysql.*` and `CREATE TEMPORARY TABLES` on the source database. If one is missing, the apply script refuses before it changes anything and prints the `GRANT` to paste.
- MySQL's command-line client 8.x (`brew install mysql-client`), not MariaDB's: the wizard uses `--ssl-mode`.
- `gh`, logged in with read access to the selected apps' repos (each entry's `repo` and `database.caSource.repo`), and `openssl`.

Each app's host, port and source database are its `database` entry in `apps.json` (your operator file; [`apps.example.json`](../../apps.example.json) shows the shape). The wizard offers them as defaults. Use the host name, never the IP: TLS verification needs the name. The wizard refuses an address.

## First run

1. Fetch the scripts from each app's `main`:

   ```sh
   bash scripts/wizard/fetch-redacted-sql.sh
   ```

   One app only, for example shop while crm waits:

   ```sh
   bash scripts/wizard/fetch-redacted-sql.sh --app shop
   ```

   The CA always comes from the entry's `database.caSource`, ref included, so an app whose CA file is not on `main` yet names the branch that carries it (the example's `crm` names `production`); change the ref in `apps.json` once it is merged. `--ref` applies to the hyde-db scripts only: before an app's annotation PR is merged, `--ref <branch>` fetches them from that branch. `--dry-run` prints what would be fetched.

2. Optional: read what will run.

   ```sh
   bash scripts/wizard/redacted-reader.sh --dry-run .redacted-sql/shop/redacted-views.sql .redacted-sql/crm/redacted-views.sql
   bash scripts/wizard/redacted-reader.sh --dry-run --app shop   # shop only, default path
   ```

3. Run it:

   ```sh
   bash scripts/wizard/redacted-reader.sh .redacted-sql/shop/redacted-views.sql .redacted-sql/crm/redacted-views.sql
   bash scripts/wizard/redacted-reader.sh --app shop .redacted-sql/shop/redacted-views.sql   # shop only
   ```

   Per app it asks for host, port, source database and admin user, then for the admin password, hidden. Then:

   - **Drop and apply.** The drop script revokes the reader's grants and drops `redacted`. The apply script recreates it, creates `redacted_reader` locked and without a password when it is missing, and grants `SELECT` on each view. A refusal prints `hyde-db: <problem> Fix: <statement>`. Paste the fix as the admin, then run the wizard again.
   - **Password and unlock.** `ALTER USER 'redacted_reader'@'%' IDENTIFIED BY '…' REQUIRE SSL ACCOUNT UNLOCK`, then a check that `mysql.user` shows the account unlocked and requiring TLS. The apply and drop scripts never change the password, the lock state or the TLS requirement, so these survive every re-apply.
   - **Verify.** As the reader, over TLS: the session has a cipher, `SELECT 1 FROM redacted.<first view> LIMIT 1` succeeds, and `SELECT 1 FROM <source database>.<first table> LIMIT 1` is refused with `ERROR 1142`. This step cannot be skipped.
   - **Connection string.** It writes `HYDE_APP_<NAME>_REDACTED_URL=mysql://redacted_reader:<password>@<host>:<port>/redacted?ssl=true` to `apply.env`. `ssl=true` matches the apps' runtime strings, so the runtime verifies the server against the app's instance CA (`lib/database-ca.ts`), as the apps' `lib/database-connection.ts` does.

4. Report back which stages ran and the verify output, with names only and no values. Keep `apply.env`: hyde-mcp-gateway's deployment takes the strings from there.

### Secrets

- Statements go to `mysql` on stdin. The admin and reader credentials sit in mode-600 option files in a private temporary directory that is removed on exit. No password appears in a process list, in shell history or on screen.
- The reader password is generated: 40 random characters plus `Aa1-`, with no quote, backslash, `@` or `:`. It is stored only in `apply.env`, which is created with mode 600.
- The admin password is never stored.

## Re-apply after a migration: drop → migrate → apply

The views name columns. A migration that drops or changes one would break a view, and a new model has no view until the next apply. hyde-db's deploy order therefore is:

1. **Drop**, before the migration, as an admin. `-p` prompts for the password:

   ```sh
   mysql -h <host> -P <port> -u <admin> -p --ssl-mode=VERIFY_CA --ssl-ca=.redacted-sql/<app>/ca.pem -D <source database> < .redacted-sql/<app>/redacted-views-drop.sql
   ```

2. **Migrate**: the app's deploy runs its migrate job as usual.
3. **Apply** the scripts generated for the new schema. Once the migration's PR is on `main`, fetch again (`fetch-redacted-sql.sh`) and run the wizard. Its apply stage drops again, which is harmless, and applies. At the password stage keep the existing password: answer no to "Rotate instead". Verify runs again. The connection string does not change.

Between steps 1 and 3 the reader can read nothing, and hyde-mcp-gateway's database tools fail for that app.

**Each app's migration runbook must gain this step.** The apps document their migrations themselves, and each must name drop → migrate → apply. That edit is made in the app repos, not here. Until it is, re-run the wizard after every deploy that carries a migration.

## Rotate the reader password

1. Fetch the scripts if `.redacted-sql/` is gone, and run the wizard. Per app, answer yes at "Rotate instead, with a new password?". `ROTATE=1` answers yes for every selected app; `--app` rotates one app only. You can skip the drop-and-apply stage.
2. The wizard sets the new password and verifies with it. Only after that does it write the new string to `apply.env`.
3. Deploy hyde-mcp-gateway with the new `apply.env` values. The old password stops working when the `ALTER USER` runs, so the running server fails for that app until the deploy.

If the wizard stops between the password stage and the write, the new password is lost. Run it again and rotate again.

## When something fails

| Symptom | Cause and fix |
|---|---|
| `SSL connection error` or a certificate error at the first connect | The `ca.pem` does not match the instance. Check the app's `database.caSource` in `apps.json` and fetch again (see First run). As a last resort, `MYSQL_SSL_MODE=REQUIRED` keeps the connection encrypted but skips verifying the server. Say so when you report back. |
| `hyde-db: … Fix: …` during apply or drop | Paste the printed fix as the admin, then run the wizard again. All refusals are listed in hyde-db's README, "What the MySQL apply script refuses". |
| `ALTER USER failed` | `redacted_reader` does not exist yet. Run the drop-and-apply stage first. |
| Reader login fails with 1045 | The password in `apply.env` is not the one set. This happens when the password stage was skipped on a first run. Run the wizard again and answer yes at the password stage. |
| The table is not refused with 1142 | The reader has grants beyond the views. Run the wizard again: every apply first revokes all of the reader's privileges. |
