import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSchema } from "hyde-json";
import { query } from "../scripts/registry.ts";
import { readConfig } from "../src/config.ts";
import type { Databases } from "../src/db/pool.ts";
import { createLoki } from "../src/loki.ts";
import { buildLogSources } from "../src/sources/index.ts";
import { appNames, appVariables, envPrefix, EXAMPLE_REGISTRY_FILE, loadRegistry, parseRegistry } from "../src/registry.ts";
import { connectInMemory, REGISTRY, REGISTRY_WITH_THIRD, registryJsonWithThirdApp, textOf, THIRD_APP } from "./helpers.ts";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const TOKEN = { HYDE_TOKEN_X: "a".repeat(32), HYDE_TOKEN_X_APPS: "*" };

/** THIRD_APP with `patch` applied at a dotted path; `undefined` deletes the key. */
function third(path: string, value: unknown) {
  const entry = structuredClone(THIRD_APP) as Record<string, unknown>;
  const keys = path.split(".");
  let at = entry;
  for (const key of keys.slice(0, -1)) at = at[key] as Record<string, unknown>;
  if (value === undefined) delete at[keys.at(-1)!];
  else at[keys.at(-1)!] = value;
  return { apps: { third: entry } };
}

describe("apps.json", () => {
  it("the committed example registry is valid and registers its apps in order", () => {
    expect(appNames(loadRegistry(EXAMPLE_REGISTRY_FILE))).toEqual(["shop", "crm"]);
    expect(REGISTRY.apps.size).toBeGreaterThan(0);
    for (const [name, entry] of REGISTRY.apps) expect(entry.name).toBe(name);
  });

  it("takes an optional edge source (D46): shop declares one, crm none", () => {
    expect(REGISTRY.apps.get("shop")?.edge).toEqual({ stream: '{resource_name="shop-prod-es"}' });
    expect(REGISTRY.apps.get("crm")?.edge).toBeUndefined();
    expect(parseRegistry(third("edge", { stream: '{resource_name="help-desk-es"}' })).apps.get("third")?.edge?.stream)
      .toBe('{resource_name="help-desk-es"}');
  });

  it("accepts a third app", () => {
    expect(appNames(REGISTRY_WITH_THIRD).at(-1)).toBe("help-desk");
    expect(REGISTRY_WITH_THIRD.apps.get("help-desk")?.database.port).toBe(3306);
  });

  it.each([
    ["a name with upper case", { apps: { Third: THIRD_APP } }, /Third.*app name must match/],
    ["a name with _", { apps: { third_app: THIRD_APP } }, /app name must match/],
    ["a name starting with a digit", { apps: { "1app": THIRD_APP } }, /app name must match/],
    ["a missing repo", third("repo", undefined), /third\.repo/],
    ["a missing database.certName", third("database.certName", undefined), /third\.database\.certName/],
    ["a missing caSource.ref", third("database.caSource.ref", undefined), /third\.database\.caSource\.ref/],
    ["a stream with a pipeline", third("loki.stream", '{a="b"} | json'), /third\.loki\.stream: must be a LogQL stream selector/],
    ["a port that is a string", third("database.port", "3306"), /third\.database\.port/],
    ["an IP as host", third("database.host", "203.0.113.1"), /third\.database\.host: must be a DNS name/],
    ["an absolute path", third("logSchemaPath", "/etc/passwd"), /third\.logSchemaPath/],
    ["an unknown key", third("lokiStream", "x"), /third.*lokiStream/],
    ["the reserved name edge", { apps: { edge: THIRD_APP } }, /edge: app name edge is reserved/],
    ["an edge stream with a pipeline", third("edge", { stream: '{a="b"} | json' }), /third\.edge\.stream: must be a LogQL stream selector/],
    ["an edge with an unknown key", third("edge", { stream: '{a="b"}', schema: "x" }), /third\.edge.*schema/],
    ["no app", { apps: {} }, /registers no app/],
    ["no apps key", {}, /apps/],
  ])("refuses %s, naming the path", (_, json, message) => {
    expect(() => parseRegistry(json)).toThrow(/apps\.json is not a valid app registry/);
    expect(() => parseRegistry(json)).toThrow(message);
  });

  it("loadRegistry names a file that is missing or not JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyde-registry-"));
    try {
      expect(() => loadRegistry(join(dir, "apps.json"))).toThrow(/apps\.json is missing: copy apps\.example\.json to apps\.json/);
      writeFileSync(join(dir, "bad.json"), "{");
      expect(() => loadRegistry(join(dir, "bad.json"))).toThrow(/is not JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("env prefix", () => {
  it("is HYDE_APP_ plus the name upper-cased, - → _", () => {
    expect(envPrefix("shop")).toBe("HYDE_APP_SHOP_");
    expect(envPrefix("help-desk")).toBe("HYDE_APP_HELP_DESK_");
    expect(appVariables("help-desk")).toEqual({
      redactedUrl: "HYDE_APP_HELP_DESK_REDACTED_URL",
      databaseCa: "HYDE_APP_HELP_DESK_DATABASE_CA",
      lokiStream: "HYDE_APP_HELP_DESK_LOKI_STREAM",
      certName: "HYDE_APP_HELP_DESK_CERT_NAME",
    });
  });

  it("readConfig reads each app's URL and CA under its prefix, the cert name from apps.json unless overridden", () => {
    const url = "mysql://r:x@rw-x.rdb.example.test:3306/redacted?ssl=true";
    const env = { ...TOKEN, NODE_ENV: "production", HYDE_APP_HELP_DESK_REDACTED_URL: url, HYDE_APP_HELP_DESK_DATABASE_CA: PEM };
    const c = readConfig(REGISTRY_WITH_THIRD, env);
    expect([...c.databases.keys()]).toEqual(["help-desk"]);
    expect(c.databases.get("help-desk")?.tls).toEqual({ ca: PEM, servername: THIRD_APP.database.certName });
    const overridden = readConfig(REGISTRY_WITH_THIRD, { ...env, HYDE_APP_HELP_DESK_CERT_NAME: "other-name" });
    expect(overridden.databases.get("help-desk")?.tls?.servername).toBe("other-name");
    // Without the registry entry the same variables are ignored.
    expect(readConfig(REGISTRY, env).databases.size).toBe(0);
  });

  it("the old per-app variables are not read", () => {
    const env = { ...TOKEN, SHOP_REDACTED_URL: "mysql://r:x@localhost/redacted", CRM_REDACTED_URL: "mysql://r:x@localhost/redacted" };
    expect(readConfig(REGISTRY, env).databases.size).toBe(0);
    const sources = buildLogSources({ registry: REGISTRY, schemas: new Map(), env: { LOKI_STREAM_SHOP: '{a="b"}' } });
    expect(sources.streams("shop").app).toBe(REGISTRY.apps.get("shop")!.loki.stream);
  });

  it("the log sources take the stream from apps.json and the stream override from the prefix", () => {
    const build = (env: NodeJS.ProcessEnv) => buildLogSources({ registry: REGISTRY_WITH_THIRD, schemas: new Map(), env });
    expect(build({}).streams("help-desk")).toEqual({ app: THIRD_APP.loki.stream });
    expect(build({ HYDE_APP_HELP_DESK_LOKI_STREAM: '{resource_name="x"}' }).streams("help-desk")).toEqual({ app: '{resource_name="x"}' });
    expect(() => build({ HYDE_APP_HELP_DESK_LOKI_STREAM: "{a} | x" }))
      .toThrow(/HYDE_APP_HELP_DESK_LOKI_STREAM is not a LogQL stream selector/);
  });
});

describe("tools against the registry", () => {
  const untouchable: Databases = { has: () => true, connect: () => Promise.reject(new Error("reached the database")), close: async () => {} };
  const silentLoki = () => {
    const requests: string[] = [];
    const loki = createLoki({
      url: "https://loki.test",
      token: "t",
      fetch: (async (input: string | URL | Request) => {
        requests.push(String(input));
        const url = new URL(String(input));
        return url.pathname.endsWith("/query_range")
          ? Response.json({ status: "success", data: { resultType: "streams", result: [] } })
          : Response.json({ status: "success", data: { resultType: "vector", result: [] } });
      }) as typeof fetch,
    });
    return { loki, requests };
  };
  const calls: [string, Record<string, unknown>][] = [
    ["ping", {}],
    ["query_logs", {}],
    ["count_errors", {}],
    ["describe_schema", {}],
    ["query_sql", { sql: "SELECT 1" }],
  ];

  it.each(calls)("%s refuses a name not in the registry, naming the registry", async (name, args) => {
    const { loki, requests } = silentLoki();
    const schemas = new Map([...REGISTRY.apps.keys()].map((app) => [app, parseSchema({ app, fields: {} })]));
    const client = await connectInMemory({
      logs: { loki, sources: buildLogSources({ registry: REGISTRY, schemas, env: {} }) },
      sql: { databases: untouchable, schemas: new Map([...REGISTRY.apps.keys()].map((app) => [app, "# x\n"])) },
    });
    const result = await client.callTool({ name, arguments: { app: "other", ...args } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(`unknown app other; registered: ${appNames(REGISTRY).join(", ")}`);
    expect(requests).toHaveLength(0);
    await client.close();
  });

  it("a third app in apps.json is accepted by every tool with no code change", async () => {
    const { loki, requests } = silentLoki();
    const app = "help-desk";
    const schemas = new Map([[app, parseSchema({ app, fields: { action: "visible" } })]]);
    const sources = buildLogSources({ registry: REGISTRY_WITH_THIRD, schemas, env: {} });
    const client = await connectInMemory({
      registry: REGISTRY_WITH_THIRD,
      logs: { loki, sources },
      sql: { databases: { ...untouchable, has: (a) => a === app }, schemas: new Map([[app, "# help-desk redacted schema\n"]]) },
    });
    const ping = JSON.parse(textOf(await client.callTool({ name: "ping", arguments: { app } })));
    expect(ping).toEqual({ app, client: "test", apps: appNames(REGISTRY_WITH_THIRD), scope: "*" });
    expect((await client.callTool({ name: "query_logs", arguments: { app } })).isError).toBeFalsy();
    expect((await client.callTool({ name: "count_errors", arguments: { app } })).isError).toBeFalsy();
    const logql = new URL(requests[0]!).searchParams.get("query")!;
    expect(logql.startsWith(`${THIRD_APP.loki.stream} | json`)).toBe(true);
    expect(logql).toContain('service="help-desk"');
    expect(textOf(await client.callTool({ name: "describe_schema", arguments: { app } }))).toBe("# help-desk redacted schema\n");
    // Reaches the (untouchable) database: the registry and readiness let it through.
    const sql = await client.callTool({ name: "query_sql", arguments: { app, sql: "SELECT 1" } });
    expect(textOf(sql)).toBe("reached the database");
    await client.close();
  });

  it("a registered app without its secrets is refused as not configured, naming its prefixed variable (D37)", async () => {
    const client = await connectInMemory({
      registry: REGISTRY_WITH_THIRD,
      sql: { databases: { ...untouchable, has: () => false }, schemas: new Map([["help-desk", "# x\n"]]) },
    });
    const result = await client.callTool({ name: "describe_schema", arguments: { app: "help-desk" } });
    expect(textOf(result)).toBe("help-desk is not configured: HYDE_APP_HELP_DESK_REDACTED_URL is not set");
    await client.close();
  });
});

describe("scripts/registry.ts (the wizard's view of apps.json)", () => {
  it("prints names, fields and variable names; refuses an unknown app or field", () => {
    expect(query(REGISTRY_WITH_THIRD, ["names"])).toEqual(appNames(REGISTRY_WITH_THIRD));
    expect(query(REGISTRY_WITH_THIRD, ["get", "help-desk", "repo", "database.port", "database.caSource.ref"]))
      .toEqual(["example-org/help-desk", "3306", "main"]);
    expect(query(REGISTRY_WITH_THIRD, ["env", "help-desk", "redactedUrl"])).toEqual(["HYDE_APP_HELP_DESK_REDACTED_URL"]);
    expect(() => query(REGISTRY, ["get", "other", "repo"])).toThrow(/unknown app other; registered:/);
    expect(() => query(REGISTRY_WITH_THIRD, ["get", "help-desk", "database"])).toThrow(/no field database/);
    expect(() => query(REGISTRY_WITH_THIRD, ["get", "help-desk", "constructor"])).toThrow(/no field constructor/);
    expect(() => query(REGISTRY, ["drop"])).toThrow(/unknown command/);
  });

  it("validates the file it reads", () => {
    expect(() => parseRegistry({ apps: { ...registryJsonWithThirdApp().apps, Bad: THIRD_APP } })).toThrow(/Bad/);
  });
});
