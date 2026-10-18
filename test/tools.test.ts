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
    expect(textOf(missing)).toMatch(/crm\.redacted-schema\.md/);
    await client.close();
  });
});

describe("query_sql", () => {
  it("refuses a write or two statements before reaching the database", async () => {
    const client = await connectInMemory({ sql: { databases: untouchable, schemas: {} } });
    for (const sql of ["UPDATE users SET status = 'x'", "SELECT 1; SELECT 2"]) {
      const result = await client.callTool({ name: "query_sql", arguments: { app: "crm", sql } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Refused before reaching the database/);
    }
    await client.close();
  });

  it("reports an app without a database as a tool error", async () => {
    const none: Databases = { ...untouchable, has: () => false };
    const client = await connectInMemory({ sql: { databases: none, schemas: {} } });
    const result = await client.callTool({ name: "query_sql", arguments: { app: "shop", sql: "SELECT 1" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/SHOP_REDACTED_URL/);
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
