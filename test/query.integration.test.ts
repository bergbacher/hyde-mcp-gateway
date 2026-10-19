// Runs against a local MySQL prepared with test/fixtures/redacted.sql; skipped
// unless HYDE_TEST_MYSQL_URL is set. See README, "Integration test".

import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { resolveDatabase } from "../src/db/connection.ts";
import { createDatabases } from "../src/db/pool.ts";
import { sqlReadiness } from "../src/mcp/sql.ts";
import { connectInMemory, textOf } from "./helpers.ts";

const URL_ = process.env.HYDE_TEST_MYSQL_URL;
const CA_FILE = process.env.HYDE_TEST_MYSQL_CA_FILE;
const CERT_NAME = process.env.HYDE_TEST_MYSQL_CERT_NAME;

describe.skipIf(!URL_)("query_sql against MySQL", () => {
  const crm = () =>
    new Map(URL_ ? [["crm", resolveDatabase({ name: "HYDE_TEST_MYSQL_URL", url: URL_, ca: undefined, certName: undefined, production: false })]] : []);
  const databases = createDatabases(crm());
  afterAll(() => databases.close());

  async function call(sql: string, limit?: number) {
    const client = await connectInMemory({ sql: sqlReadiness({ databases, schemas: new Map([["crm", "# crm\n"]]) }) });
    const result = await client.callTool({ name: "query_sql", arguments: { app: "crm", sql, limit } });
    await client.close();
    return result;
  }

  it("returns columns and rows from a view", async () => {
    const result = await call("SELECT id, status FROM users ORDER BY id LIMIT 5");
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(textOf(result));
    expect(body.columns).toEqual(["id", "status"]);
    expect(body.rows).toHaveLength(5);
    expect(body.rows[0]).toEqual([1, "active"]);
    expect(body.truncated).toBe(false);
  });

  it("caps rows at the limit and marks the result truncated", async () => {
    const body = JSON.parse(textOf(await call("SELECT id FROM users ORDER BY id", 3)));
    expect(body.rows).toEqual([[1], [2], [3]]);
    expect(body.truncated).toBe(true);
    // A LIMIT in the query does not lift the cap.
    const explicit = JSON.parse(textOf(await call("SELECT id FROM users LIMIT 100", 4)));
    expect(explicit.rows).toHaveLength(4);
    expect(explicit.truncated).toBe(true);
  });

  it("caps the result size", async () => {
    const small = createDatabases(crm(), { timeoutMs: 15_000, maxBytes: 400 });
    const result = await small.query("crm", "SELECT id, REPEAT('x', 100) FROM users ORDER BY id", 1000);
    await small.close();
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.length).toBeLessThan(10);
    expect(result.truncated).toBe(true);
  });

  it("returns the database error for a hidden column or a base table unchanged", async () => {
    const hidden = await call("SELECT email FROM users");
    expect(hidden.isError).toBe(true);
    expect(textOf(hidden)).toBe("Unknown column 'email' in 'field list'");
    const base = await call("SELECT * FROM hyde_test_app.users");
    expect(base.isError).toBe(true);
    expect(textOf(base)).toMatch(/SELECT command denied/);
  });

  it("cancels a query running past the timeout", async () => {
    const slow = "SELECT a.id FROM users a, users b, users c, users d, users e, users f, users g, users h ORDER BY RAND() LIMIT 1";
    const hasty = createDatabases(crm(), { timeoutMs: 300, maxBytes: 1_000_000 });
    await expect(hasty.query("crm", slow, 10)).rejects.toThrow(/maximum statement execution time exceeded/);
    // The pool still serves the next query.
    expect(await hasty.query("crm", "SELECT 1 AS one", 1)).toEqual({ columns: ["one"], rows: [["1"]], truncated: false }); // BIGINT as a string
    await hasty.close();
  });

  describe("stale views (D48)", () => {
    const schema = (columns: string[]) =>
      ["# Redacted database schema", "", "## `users`", "", "| column | Prisma type | notes |", "|---|---|---|",
        ...columns.map((c) => `| \`\` \`${c}\` \`\` | String |  |`), ""].join("\n");

    async function describeSchema(document: string) {
      const client = await connectInMemory({ sql: sqlReadiness({ databases, schemas: new Map([["crm", document]]) }) });
      const result = await client.callTool({ name: "describe_schema", arguments: { app: "crm" } });
      await client.close();
      return textOf(result);
    }

    it("reads, as the reader, the views and columns of `redacted` only", async () => {
      // The base table's `email` is not visible to the reader, so it does not appear.
      expect((await databases.viewColumns("crm")).sort()).toEqual([["users", "id"], ["users", "status"]]);
    });

    it("returns the document alone when the views match it", async () => {
      expect(await describeSchema(schema(["id", "status"]))).toBe(schema(["id", "status"]));
    });

    it("names the differences for a document the views lag behind", async () => {
      const newer = `${schema(["id", "status", "plan"])}\n## \`orders\`\n\n| column | Prisma type | notes |\n|---|---|---|\n| \`\` \`id\` \`\` | Int |  |\n`;
      expect(await describeSchema(newer)).toMatch(/^Stale views: missing views `orders`; view `users` lacks `plan`\. .*Fix: drop → migrate → apply/);
    });
  });

  describe.skipIf(!CA_FILE || !CERT_NAME)("over TLS", () => {
    const tlsUrl = () => {
      const u = new URL(URL_!);
      u.hostname = "localhost";
      u.searchParams.set("ssl", "true");
      return u.toString();
    };
    const tls = (certName: string) =>
      createDatabases(new Map([[
        "crm", resolveDatabase({ name: "HYDE_TEST_MYSQL_URL", url: tlsUrl(), ca: readFileSync(CA_FILE!, "utf8"), certName, production: true }),
      ]]));

    it("connects when the certificate carries the name", async () => {
      const dbs = tls(CERT_NAME!);
      const result = await dbs.query("crm", "SELECT id FROM users ORDER BY id LIMIT 1", 1);
      expect(result.rows).toEqual([[1]]);
      await dbs.close();
    });

    it("refuses a certificate that does not carry the name", async () => {
      const dbs = tls("some-other-instance");
      await expect(dbs.query("crm", "SELECT 1", 1)).rejects.toThrow(/does not match some-other-instance/);
      await dbs.close();
    });
  });
});
