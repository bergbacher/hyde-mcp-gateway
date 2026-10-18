import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_STREAMS } from "../src/config.ts";
import type { Databases } from "../src/db/pool.ts";
import { createLoki } from "../src/loki.ts";
import { toolNames, type ServerOptions } from "../src/mcp/server.ts";
import { loadRedactedSchemas, loadSchemas } from "../src/schemas.ts";
import { connectInMemory, textOf } from "./helpers.ts";

/** A database that fails the test if anything reaches it. */
const untouchable: Databases = {
  has: () => true,
  connect: () => Promise.reject(new Error("reached the database")),
  close: async () => {},
};

describe("describe_schema", () => {
  it("returns the app's redacted schema loaded from schemas/", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hyde-schemas-"));
    writeFileSync(join(dir, "shop.redacted-schema.md"), "# shop redacted schema\n");
    const schemas = loadRedactedSchemas(dir);
    expect(schemas).toEqual({ shop: "# shop redacted schema\n" });

    const client = await connectInMemory({ sql: { databases: untouchable, schemas } });
    expect(textOf(await client.callTool({ name: "describe_schema", arguments: { app: "shop" } }))).toBe("# shop redacted schema\n");
    const missing = await client.callTool({ name: "describe_schema", arguments: { app: "crm" } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe("crm is not configured: schemas/crm.redacted-schema.md is missing");
    await client.close();
  });
});

describe("query_sql", () => {
  it("refuses a write or two statements before reaching the database", async () => {
    const client = await connectInMemory({ sql: { databases: untouchable, schemas: { crm: "# crm\n" } } });
    for (const sql of ["UPDATE users SET status = 'x'", "SELECT 1; SELECT 2"]) {
      const result = await client.callTool({ name: "query_sql", arguments: { app: "crm", sql } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Refused before reaching the database/);
    }
    await client.close();
  });

  it("refuses an app without a database URL or redacted schema at both tools, before the database (D37)", async () => {
    const shopOnly: Databases = { ...untouchable, has: (app) => app === "shop" };
    const client = await connectInMemory({ sql: { databases: shopOnly, schemas: { crm: "# crm\n" } } });
    const call = (name: string, app: string) => client.callTool({ name, arguments: { app, sql: "SELECT 1" } });
    for (const name of ["describe_schema", "query_sql"]) {
      const crm = await call(name, "crm");
      expect(crm.isError).toBe(true);
      expect(textOf(crm)).toBe("crm is not configured: CRM_REDACTED_URL is not set");
      const shop = await call(name, "shop");
      expect(shop.isError).toBe(true);
      expect(textOf(shop)).toBe("shop is not configured: schemas/shop.redacted-schema.md is missing");
    }
    const none = await connectInMemory({ sql: { databases: { ...untouchable, has: () => false }, schemas: {} } });
    const both = await none.callTool({ name: "query_sql", arguments: { app: "shop", sql: "UPDATE x SET y = 1" } });
    expect(textOf(both)).toBe("shop is not configured: schemas/shop.redacted-schema.md is missing; SHOP_REDACTED_URL is not set");
    await none.close();
    await client.close();
  });
});

describe("registration", () => {
  const sql = { databases: untouchable, schemas: {} };
  const logs = {
    schemas: loadSchemas(fileURLToPath(new URL("./fixtures/schemas/", import.meta.url))),
    loki: createLoki({ url: "https://loki.invalid", token: "t", fetch: () => Promise.reject(new Error("reached Loki")) }),
    streams: DEFAULT_STREAMS,
  };
  const cases: [string, ServerOptions, string[]][] = [
    ["no options", {}, ["ping"]],
    ["sql", { sql }, ["ping", "describe_schema", "query_sql"]],
    ["logs and sql", { logs, sql }, ["ping", "query_logs", "count_errors", "describe_schema", "query_sql"]],
  ];
  it.each(cases)("%s: ping plus the tools whose options are given", async (_, options, names) => {
    const client = await connectInMemory(options);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(names);
    expect(toolNames(options)).toEqual(names);
    await client.close();
  });
});
