import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { boot, type BootInputs, type Booted } from "../src/boot.ts";
import { edgeSchemaFile, redactedSchemaFile, schemaFile } from "../src/schemas.ts";
import { connectInMemory, REGISTRY, textOf } from "./helpers.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/schemas/", import.meta.url));
const dirs: string[] = [];
const booted: Booted[] = [];

/** A temp schemas/ with the committed edge schema plus each app's log schema and redacted schema as listed. */
function schemasWith(files: { logs?: ("shop" | "crm")[]; redacted?: ("shop" | "crm")[]; edge?: false }): string {
  const dir = mkdtempSync(join(tmpdir(), "hyde-boot-"));
  dirs.push(dir);
  if (files.edge !== false) copyFileSync(edgeSchemaFile(), edgeSchemaFile(dir));
  for (const app of files.logs ?? []) copyFileSync(schemaFile(app, FIXTURES), schemaFile(app, dir));
  for (const app of files.redacted ?? []) writeFileSync(redactedSchemaFile(app, dir), `# ${app} redacted schema\n`);
  return dir;
}

afterEach(() => {
  for (const b of booted.splice(0)) b.schemas.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// No APP_REPOS_READ_TOKEN: the schema store reads the temp schemas/ (developer mode).
const ENV = {
  PORT: "8080",
  HYDE_TOKEN_AGENT: "a".repeat(32),
  HYDE_TOKEN_AGENT_APPS: "*",
  COCKPIT_LOGS_URL: "https://loki.invalid",
  COCKPIT_LOGS_READ_TOKEN: "t",
  HYDE_APP_SHOP_REDACTED_URL: "mysql://reader:x@localhost:3306/redacted",
};

const DEVELOPER_MODE = { level: "warn", message: "APP_REPOS_READ_TOKEN is not set: reading schemas/ (developer mode)" };

/** Boots on `schemaDir` with the store's log lines silenced; the store is stopped after the test. */
async function bootOn(schemaDir: string, inputs: BootInputs = {}): Promise<Booted> {
  const b = await boot({ registry: REGISTRY, env: ENV, schemaDir, schemaStore: { log: () => {}, warn: () => {} }, ...inputs });
  booted.push(b);
  return b;
}

describe("boot", () => {
  it("reports and serves a fully configured app (shop) and a half-configured one (crm: no database URL)", async () => {
    const { config, options, report } = await bootOn(schemasWith({ logs: ["shop", "crm"], redacted: ["shop", "crm"] }));

    expect(config.port).toBe(8080);
    expect(report.info).toEqual({
      level: "info",
      message: "hyde-mcp-gateway listening on :8080",
      verifiers: ["github", "static"],
      githubScopeTtlSeconds: 300,
      clients: { agent: "*" },
      tools: ["ping", "query_logs", "count_errors", "describe_schema", "query_sql"],
      apps: { shop: ["logs", "edge", "sql"], crm: ["logs"] },
      schemas: { source: "local", refreshSeconds: 600, logs: { shop: expect.any(Number), crm: expect.any(Number) }, redacted: ["shop", "crm"] },
      sources: {
        shop: { app: '{resource_name="example-shop-prod"}', edge: '{resource_name="shop-prod-es"}' },
        crm: { app: '{resource_name="example-crm-prod"}' },
      },
    });
    expect(report.warnings).toEqual([DEVELOPER_MODE, {
      level: "warn",
      message: "crm is not fully configured: HYDE_APP_CRM_REDACTED_URL is not set",
      app: "crm",
      missing: { logs: [], sql: ["HYDE_APP_CRM_REDACTED_URL is not set"] },
    }]);

    const client = await connectInMemory(options);
    const call = async (name: string, args: Record<string, unknown>) => textOf(await client.callTool({ name, arguments: args }));
    expect(await call("describe_schema", { app: "shop" })).toBe("# shop redacted schema\n");
    // Ready: the statement guard answers, not readiness.
    expect(await call("query_sql", { app: "shop", sql: "UPDATE x SET y = 1" })).toMatch(/^Refused before reaching the database/);
    for (const name of ["describe_schema", "query_sql"]) {
      expect(await call(name, { app: "crm", sql: "SELECT 1" })).toBe("crm is not configured: HYDE_APP_CRM_REDACTED_URL is not set");
    }
    expect(await call("count_errors", { app: "crm", source: "edge" })).toBe("crm is not configured: no edge stream in apps.json");
    await client.close();
  });

  it("refuses at the tools what an app lacks, and warns once per incomplete app", async () => {
    const { options, report } = await bootOn(schemasWith({ logs: ["shop"] }));

    expect(report.info.apps).toEqual({ shop: ["logs", "edge"], crm: [] });
    expect(report.warnings.map((w) => w.message)).toEqual([
      DEVELOPER_MODE.message,
      "shop is not fully configured: redacted schema is missing",
      "crm is not fully configured: log schema is missing; redacted schema is missing; HYDE_APP_CRM_REDACTED_URL is not set",
    ]);

    const client = await connectInMemory(options);
    const call = async (name: string, app: string) => textOf(await client.callTool({ name, arguments: { app, sql: "SELECT 1" } }));
    expect(await call("query_logs", "crm")).toBe("crm is not configured: log schema is missing");
    expect(await call("describe_schema", "shop")).toBe("shop is not configured: redacted schema is missing");
    expect(await call("query_sql", "crm"))
      .toBe("crm is not configured: redacted schema is missing; HYDE_APP_CRM_REDACTED_URL is not set");
    await client.close();
  });

  it("boots with an invalid app schema file; the readiness built at boot follows the schema store's refresh (D58)", async () => {
    const schemaDir = schemasWith({ logs: ["shop"], redacted: ["shop"] });
    writeFileSync(schemaFile("crm", schemaDir), "{ not json");
    const warned: string[] = [];
    const { options, report, schemas } = await bootOn(schemaDir, { schemaStore: { log: () => {}, warn: (line) => warned.push(line) } });
    expect(warned.join("\n")).toMatch(/crm: schemas not refreshed: .*crm\.hyde-json\.json: the file is not JSON/);
    expect(report.info.apps.crm).toEqual([]);

    const client = await connectInMemory(options);
    const call = async (name: string, app: string) => textOf(await client.callTool({ name, arguments: { app, sql: "SELECT 1" } }));
    expect(await call("count_errors", "crm")).toBe("crm is not configured: log schema is missing");
    expect(await call("describe_schema", "crm")).toBe("crm is not configured: redacted schema is missing; HYDE_APP_CRM_REDACTED_URL is not set");

    // The app repo fixes its files; the next refresh reaches the tools without a restart.
    copyFileSync(schemaFile("crm", FIXTURES), schemaFile("crm", schemaDir));
    writeFileSync(redactedSchemaFile("crm", schemaDir), "# crm redacted schema\n");
    await schemas.refresh();
    expect(options.logs.sources.missing("crm", "app")).toEqual([]);
    expect(options.sql.missing("crm")).toEqual(["HYDE_APP_CRM_REDACTED_URL is not set"]);
    expect(await call("count_errors", "crm")).not.toMatch(/not configured/);
    expect(await call("describe_schema", "crm")).toBe("crm is not configured: HYDE_APP_CRM_REDACTED_URL is not set");
    await client.close();
  });

  it("refuses to boot without the committed edge schema, naming the file", async () => {
    await expect(bootOn(schemasWith({ logs: ["shop"], edge: false }))).rejects.toThrow(/Edge log schema .*edge\.hyde-json\.json not loaded/);
  });
});
