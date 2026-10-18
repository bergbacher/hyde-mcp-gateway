# Runbook: redacted_reader on the crm and shop databases

hyde-mcp-gateway reads each app's database as `redacted_reader`, an account that can `SELECT` from the views in database `redacted` and nothing else (LEDGER D2, D18). hyde-db generates the views from each app's `@hyde` annotations as two scripts in the app repo: `prisma/redacted/redacted-views.sql` (apply) and `prisma/redacted/redacted-views-drop.sql` (drop). Only an admin of each RDB instance can run them (D19), so a human runs them through a wizard:

| Script | What it does |
|---|---|
| `scripts/wizard/fetch-redacted-sql.sh` | Fetches both scripts and the instance CA (`lib/database-ca.ts`, as `ca.pem`) of each app from GitHub into `.redacted-sql/` (gitignored). |
| `scripts/wizard/redacted-reader.sh` | For crm, then shop: admin connection → drop and apply the views → set the reader's password and unlock it → verify as the reader → write `CRM_REDACTED_URL` / `SHOP_REDACTED_URL` to `apply.env` (gitignored). |

Every step says what it runs and waits for a yes. Every step is idempotent, so after a failure fix the cause and run the wizard again from the start. `--dry-run` asks nothing, runs nothing, writes nothing, and prints every statement with passwords masked.

## What you need

- For each instance, an admin account and its password. Per hyde-db it needs `CREATE USER`, `CREATE`, `DROP`, `CREATE VIEW` and `SELECT` on database `redacted`, `SELECT` on the source tables, `GRANT OPTION` on the views, `SELECT` on `mysql.*` and `CREATE TEMPORARY TABLES` on the source database. If one is missing, the apply script refuses before it changes anything and prints the `GRANT` to paste.
- MySQL's command-line client 8.x (`brew install mysql-client`), not MariaDB's: the wizard uses `--ssl-mode`.
- `gh`, logged in with read access to `example-org/crm` and `example-org/shop`, and `openssl`.

| App | Host | Port | Source database |
|---|---|---|---|
| crm | `rw-0001.example.invalid` | 3307 | `crm-prod` |
| shop | `rw-0000.example.invalid` | 3306 | `shop` |

The wizard offers these as defaults. Use the host name, never the IP: TLS verification needs the name. The wizard refuses an address.

## First run

1. Fetch the scripts from each app's `main`:

   ```sh
   bash scripts/wizard/fetch-redacted-sql.sh
   ```

   crm's `lib/database-ca.ts` reaches `main` only with its Scaleway migration. Until then, take the CA from that branch: `CRM_CA_REF=production bash scripts/wizard/fetch-redacted-sql.sh`. Before the annotation PRs are merged, `--ref feat/hyde-db-annotations` fetches the scripts from their branch.

2. Optional: read what will run.

   ```sh
   bash scripts/wizard/redacted-reader.sh --dry-run .redacted-sql/crm/redacted-views.sql .redacted-sql/shop/redacted-views.sql
   ```

3. Run it:

   ```sh
   bash scripts/wizard/redacted-reader.sh .redacted-sql/crm/redacted-views.sql .redacted-sql/shop/redacted-views.sql
   ```

   Per app it asks for host, port, source database and admin user, then for the admin password, hidden. Then:

   - **Drop and apply.** The drop script revokes the reader's grants and drops `redacted`. The apply script recreates it, creates `redacted_reader` locked and without a password when it is missing, and grants `SELECT` on each view. A refusal prints `hyde-db: <problem> Fix: <statement>`. Paste the fix as the admin, then run the wizard again.
   - **Password and unlock.** `ALTER USER 'redacted_reader'@'%' IDENTIFIED BY '…' REQUIRE SSL ACCOUNT UNLOCK`, then a check that `mysql.user` shows the account unlocked and requiring TLS. The apply and drop scripts never change the password, the lock state or the TLS requirement, so these survive every re-apply.
   - **Verify.** As the reader, over TLS: the session has a cipher, `SELECT 1 FROM redacted.<first view> LIMIT 1` succeeds, and `SELECT 1 FROM <source database>.<first table> LIMIT 1` is refused with `ERROR 1142`. This step cannot be skipped.
   - **Connection string.** It writes `mysql://redacted_reader:<password>@<host>:<port>/redacted?ssl=true` to `apply.env`. `ssl=true` matches the apps' runtime strings, so the runtime verifies the server against the app's instance CA (`lib/database-ca.ts`), as the apps' `lib/database-connection.ts` does.

4. Report back which stages ran and the verify output, with names only and no values. Keep `apply.env`: hyde-mcp-gateway's deployment takes the two strings from there.

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

**Each app's migration runbook must gain this step.** crm and shop document their migrations themselves, and each must name drop → migrate → apply. That edit is made later, in the app repos, not here. Until it is, re-run the wizard after every deploy that carries a migration. The last acceptance criterion of #8 stays open until both app runbooks name the step.

## Rotate the reader password

1. Fetch the scripts if `.redacted-sql/` is gone, and run the wizard. Per app, answer yes at "Rotate instead, with a new password?". `ROTATE=1` answers yes for both apps. You can skip the drop-and-apply stage.
2. The wizard sets the new password and verifies with it. Only after that does it write the new string to `apply.env`.
3. Deploy hyde-mcp-gateway with the new `apply.env` values. The old password stops working when the `ALTER USER` runs, so the running server fails for that app until the deploy.

If the wizard stops between the password stage and the write, the new password is lost. Run it again and rotate again.

## When something fails

| Symptom | Cause and fix |
|---|---|
| `SSL connection error` or a certificate error at the first connect | The `ca.pem` does not match the instance. Fetch again, with `CRM_CA_REF` for crm (see First run). As a last resort, `MYSQL_SSL_MODE=REQUIRED` keeps the connection encrypted but skips verifying the server. Say so when you report back. |
| `hyde-db: … Fix: …` during apply or drop | Paste the printed fix as the admin, then run the wizard again. All refusals are listed in hyde-db, "What the MySQL apply script refuses". |
| `ALTER USER failed` | `redacted_reader` does not exist yet. Run the drop-and-apply stage first. |
| Reader login fails with 1045 | The password in `apply.env` is not the one set. This happens when the password stage was skipped on a first run. Run the wizard again and answer yes at the password stage. |
| The table is not refused with 1142 | The reader has grants beyond the views. Run the wizard again: every apply first revokes all of the reader's privileges. |
