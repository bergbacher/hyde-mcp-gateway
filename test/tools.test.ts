import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Databases } from "../src/db/pool.ts";
import { createLoki } from "../src/loki.ts";
import { toolNames, type ServerOptions } from "../src/mcp/server.ts";
import { loadRedactedSchemas, loadSchemas } from "../src/schemas.ts";
import { buildLogSources } from "../src/sources/index.ts";
import { answering, connectInMemory, REGISTRY, textOf, untouchable } from "./helpers.ts";

describe("describe_schema", () => {
  it("returns the app's redacted schema loaded from schemas/", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hyde-schemas-"));
    writeFileSync(join(dir, "shop.redacted-schema.md"), "# shop redacted schema\n");
    const schemas = loadRedactedSchemas(REGISTRY, dir);
    expect(schemas).toEqual(new Map([["shop", "# shop redacted schema\n"]]));

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
    const client = await connectInMemory({ sql: { databases: untouchable, schemas: new Map([["crm", "# crm\n"]]) } });
    for (const sql of ["UPDATE users SET status = 'x'", "SELECT 1; SELECT 2"]) {
      const result = await client.callTool({ name: "query_sql", arguments: { app: "crm", sql } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Refused before reaching the database/);
    }
    await client.close();
  });

  it("refuses an app without a database URL or redacted schema at both tools, before the database (D37)", async () => {
    const shopOnly: Databases = { ...untouchable, has: (app) => app === "shop" };
    const client = await connectInMemory({ sql: { databases: shopOnly, schemas: new Map([["crm", "# crm\n"]]) } });
    const call = (name: string, app: string) => client.callTool({ name, arguments: { app, sql: "SELECT 1" } });
    for (const name of ["describe_schema", "query_sql"]) {
      const crm = await call(name, "crm");
      expect(crm.isError).toBe(true);
      expect(textOf(crm)).toBe("crm is not configured: HYDE_APP_CRM_REDACTED_URL is not set");
      const shop = await call(name, "shop");
      expect(shop.isError).toBe(true);
      expect(textOf(shop)).toBe("shop is not configured: schemas/shop.redacted-schema.md is missing");
    }
    const none = await connectInMemory({ sql: { databases: { ...untouchable, has: () => false }, schemas: new Map() } });
    const both = await none.callTool({ name: "query_sql", arguments: { app: "shop", sql: "UPDATE x SET y = 1" } });
    expect(textOf(both)).toBe("shop is not configured: schemas/shop.redacted-schema.md is missing; HYDE_APP_SHOP_REDACTED_URL is not set");
    await none.close();
    await client.close();
  });

  it("returns a database error verbatim as a tool error", async () => {
    const mysqlError = "Unknown column 'email' in 'field list'";
    const databases = answering(() => Promise.reject(Object.assign(new Error(mysqlError), { code: "ER_BAD_FIELD_ERROR" })));
    const client = await connectInMemory({ sql: { databases, schemas: new Map([["crm", "# crm\n"]]) } });
    const result = await client.callTool({ name: "query_sql", arguments: { app: "crm", sql: "SELECT email FROM users" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(mysqlError);
    await client.close();
  });

});

describe("app scope at the SQL tools (D39)", () => {
  /** A database that records every query and answers each with one row. */
  function counting() {
    const queries: { app: string; sql: string; limit: number | undefined }[] = [];
    const databases = answering(async (app, sql, limit) => {
      queries.push({ app, sql, limit });
      return { columns: ["1"], rows: [[1]], truncated: false };
    });
    return { databases, queries };
  }
  const schemas = new Map([["shop", "# shop\n"], ["crm", "# crm\n"]]);
  const shopOnly = { client: "agent", apps: new Set(["shop"]) };

  it("refuses an app outside the scope at describe_schema and query_sql without touching the database", async () => {
    const { databases, queries } = counting();
    const client = await connectInMemory({ sql: { databases, schemas }, principal: shopOnly });
    for (const name of ["describe_schema", "query_sql"]) {
      const result = await client.callTool({ name, arguments: { app: "crm", sql: "SELECT 1" } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("client agent is not authorized for app crm");
    }
    expect(queries).toEqual([]);
    await client.close();
  });

  it("allows an app in scope", async () => {
    const { databases, queries } = counting();
    const client = await connectInMemory({ sql: { databases, schemas }, principal: shopOnly });
    expect(textOf(await client.callTool({ name: "describe_schema", arguments: { app: "shop" } }))).toBe("# shop\n");
    const result = await client.callTool({ name: "query_sql", arguments: { app: "shop", sql: "SELECT 1;" } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({ columns: ["1"], rows: [[1]], truncated: false });
    // The guarded statement, trailing semicolon cut.
    expect(queries).toEqual([{ app: "shop", sql: "SELECT 1", limit: undefined }]);
    await client.close();
  });

  it("allows every registered app with *", async () => {
    const { databases, queries } = counting();
    const client = await connectInMemory({ sql: { databases, schemas }, principal: { client: "agent", apps: "*" } });
    for (const app of REGISTRY.apps.keys()) await client.callTool({ name: "query_sql", arguments: { app, sql: "SELECT 1" } });
    expect(queries.map((q) => q.app)).toEqual([...REGISTRY.apps.keys()]);
    await client.close();
  });

  it("ping reports the scope, and refuses an app outside it", async () => {
    const client = await connectInMemory({ principal: shopOnly });
    expect(JSON.parse(textOf(await client.callTool({ name: "ping", arguments: { app: "shop" } })))).toEqual({
      app: "shop", client: "agent", apps: [...REGISTRY.apps.keys()], scope: ["shop"],
    });
    const refused = await client.callTool({ name: "ping", arguments: { app: "crm" } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe("client agent is not authorized for app crm");
    await client.close();
  });
});

describe("registration", () => {
  const sql = { databases: untouchable, schemas: new Map() };
  const logs = {
    sources: buildLogSources({
      registry: REGISTRY, schemas: loadSchemas(REGISTRY, fileURLToPath(new URL("./fixtures/schemas/", import.meta.url))), env: {},
    }),
    loki: createLoki({ url: "https://loki.invalid", token: "t", fetch: () => Promise.reject(new Error("reached Loki")) }),
  };
  const cases: [string, Omit<ServerOptions, "registry">, string[]][] = [
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
