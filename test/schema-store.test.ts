// The schema store (D58) against a fake GitHub contents API: startup fetch,
// refresh, failure fallback, developer mode without a token.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logSources } from "../src/config.ts";
import type { Databases } from "../src/db/pool.ts";
import { createLoki } from "../src/loki.ts";
import { DEFAULT_REFRESH_SECONDS, readSchemaStoreConfig, SchemaStore, type SchemaStoreOptions } from "../src/schema-store.ts";
import { redactedSchemaFile, schemaFile } from "../src/schemas.ts";
import { connectInMemory, REGISTRY, REGISTRY_WITH_THIRD, textOf } from "./helpers.ts";

const FIXTURES = new URL("./fixtures/schemas/", import.meta.url);
const shopLogs = readFileSync(new URL("shop.hyde-json.json", FIXTURES), "utf8");
const crmLogs = readFileSync(new URL("crm.hyde-json.json", FIXTURES), "utf8");
const SHOP_LOG = "example-org/shop:prisma/hyde-json.json";
const SHOP_REDACTED = "example-org/shop:prisma/redacted/redacted-schema.md";
const CRM_LOG = "example-org/crm:prisma/hyde-json.json";
const CRM_REDACTED = "example-org/crm:prisma/redacted/redacted-schema.md";

/**
 * A fake GitHub contents API: `files` maps "<repo>:<path>" to the body,
 * anything else answers 404; `down` makes every request fail as a network
 * error would. Both can change between refreshes.
 */
function github(files: Record<string, string>) {
  const state = { files, down: false, requests: [] as { url: URL; headers: Headers }[] };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    state.requests.push({ url, headers: new Headers(init?.headers) });
    if (state.down) throw new TypeError("fetch failed");
    const [, , owner, repo, , ...path] = url.pathname.split("/");
    const body = state.files[`${owner}/${repo}:${path.join("/")}`];
    return body === undefined ? new Response("Not Found", { status: 404, statusText: "Not Found" }) : new Response(body);
  }) as typeof globalThis.fetch;
  return { state, fetch };
}

const stores: SchemaStore[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function store(options: Partial<SchemaStoreOptions> = {}) {
  const out: string[] = [];
  const warnings: string[] = [];
  const s = new SchemaStore({ registry: REGISTRY, log: (l) => out.push(l), warn: (l) => warnings.push(l), ...options });
  stores.push(s);
  return { store: s, out, warnings, warned: () => warnings.map((w) => JSON.parse(w) as { level: string; message: string; app: string; reasons: string[] }) };
}

const allFiles = () => ({ [SHOP_LOG]: shopLogs, [SHOP_REDACTED]: "# shop\n", [CRM_LOG]: crmLogs, [CRM_REDACTED]: "# crm\n" });

describe("readSchemaStoreConfig", () => {
  it("reads the token and the interval, default 600 seconds", () => {
    expect(readSchemaStoreConfig({})).toEqual({ refreshSeconds: DEFAULT_REFRESH_SECONDS });
    expect(DEFAULT_REFRESH_SECONDS).toBe(600);
    expect(readSchemaStoreConfig({ APP_REPOS_READ_TOKEN: " t ", HYDE_SCHEMA_REFRESH_SECONDS: "60" })).toEqual({ token: "t", refreshSeconds: 60 });
    expect(readSchemaStoreConfig({ APP_REPOS_READ_TOKEN: "" })).toEqual({ refreshSeconds: 600 });
    for (const bad of ["0", "-5", "1.5", "ten"]) {
      expect(() => readSchemaStoreConfig({ HYDE_SCHEMA_REFRESH_SECONDS: bad })).toThrow(/HYDE_SCHEMA_REFRESH_SECONDS is not a positive whole number/);
    }
  });
});

describe("SchemaStore with a token (GitHub)", () => {
  it("fetches both files of every registered app at startup, from the default branch, with the token", async () => {
    const gh = github(allFiles());
    const { store: s, out, warnings } = store({ token: "read-token", fetch: gh.fetch });
    await s.start();
    expect(s.mode).toBe("github");
    expect(s.get("shop")?.log?.fields["message.to"]).toBe("hidden");
    expect(s.get("shop")?.redacted).toBe("# shop\n");
    expect(s.get("crm")?.log?.app).toBe("crm");
    expect([...s.logSchemas.keys()]).toEqual(["shop", "crm"]);
    expect([...s.redactedSchemas.keys()].sort()).toEqual(["crm", "shop"]);
    expect(gh.state.requests.map((r) => `${r.url.pathname}${r.url.search}`).sort()).toEqual([
      "/repos/example-org/crm/contents/prisma/hyde-json.json",
      "/repos/example-org/crm/contents/prisma/redacted/redacted-schema.md",
      "/repos/example-org/shop/contents/prisma/hyde-json.json",
      "/repos/example-org/shop/contents/prisma/redacted/redacted-schema.md",
    ]);
    for (const { headers } of gh.state.requests) expect(headers.get("authorization")).toBe("Bearer read-token");
    expect(out.map((l) => JSON.parse(l).message)).toEqual(expect.arrayContaining(["shop: schemas loaded (log, redacted)", "crm: schemas loaded (log, redacted)"]));
    expect(warnings).toEqual([]);
  });

  it("reads the apps of the registry it is given: a third app needs no code", async () => {
    const third = "example-org/help-desk";
    const gh = github({ ...allFiles(), [`${third}:config/hyde-json.json`]: JSON.stringify({ app: "help-desk", fields: { action: "visible" } }) });
    const { store: s } = store({ registry: REGISTRY_WITH_THIRD, token: "t", fetch: gh.fetch });
    await s.start();
    expect(s.get("help-desk")).toEqual({ log: expect.objectContaining({ app: "help-desk" }) });
  });

  it("picks up a changed file at the next refresh, on the interval", async () => {
    vi.useFakeTimers();
    const gh = github(allFiles());
    const { store: s, out } = store({ token: "t", fetch: gh.fetch, refreshSeconds: 60 });
    await s.start();
    expect(s.get("shop")?.log?.fields["message.to"]).toBe("hidden");
    gh.state.files = { ...allFiles(), [SHOP_LOG]: JSON.stringify({ app: "shop", fields: { action: "visible", "message.to": "visible" } }) };
    await vi.advanceTimersByTimeAsync(59_000);
    expect(s.get("shop")?.log?.fields["message.to"]).toBe("hidden");
    out.length = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    await s.refresh();
    expect(s.get("shop")?.log?.fields["message.to"]).toBe("visible");
    // Only the file that changed is reported.
    expect(out.map((l) => JSON.parse(l).message)).toEqual(["shop: schemas loaded (log)"]);
  });

  it("keeps the last good files when the repo is unreachable or a file turns invalid, with one warn line per app naming it", async () => {
    const gh = github(allFiles());
    const { store: s, warned } = store({ token: "t", fetch: gh.fetch });
    await s.start();
    gh.state.down = true;
    await s.refresh();
    expect(s.get("shop")).toEqual({ log: expect.objectContaining({ app: "shop" }), redacted: "# shop\n" });
    expect(s.get("crm")?.log?.app).toBe("crm");
    expect(warned().map((w) => w.app).sort()).toEqual(["crm", "shop"]);
    const shop = warned().find((w) => w.app === "shop")!;
    expect(shop.level).toBe("warn");
    expect(shop.message).toMatch(/^shop: schemas not refreshed: .*example-org\/shop@default:prisma\/hyde-json\.json: fetch failed.*; keeping the last good log, redacted$/);
    expect(shop.reasons).toHaveLength(2);

    gh.state.down = false;
    gh.state.files = { ...allFiles(), [SHOP_LOG]: "{ not json", [SHOP_REDACTED]: "" };
    const before = warned().length;
    await s.refresh();
    const [invalid, ...rest] = warned().slice(before);
    expect(rest).toEqual([]);
    expect(invalid!.app).toBe("shop");
    expect(invalid!.reasons.sort()).toEqual([
      "example-org/shop@default:prisma/hyde-json.json: the file is not JSON",
      "example-org/shop@default:prisma/redacted/redacted-schema.md: the file is empty",
    ]);
    expect(s.get("shop")?.log?.fields["message.to"]).toBe("hidden");
    expect(s.get("shop")?.redacted).toBe("# shop\n");
  });

  it("leaves an app out when it has no good file at startup; its tools answer not configured", async () => {
    const gh = github({ [SHOP_LOG]: shopLogs, [SHOP_REDACTED]: "# shop\n", [CRM_LOG]: JSON.stringify({ app: "shop", fields: {} }) });
    const { store: s, warned } = store({ token: "t", fetch: gh.fetch });
    await s.start();
    expect(s.get("crm")).toBeUndefined();
    expect(s.logSchemas.has("crm")).toBe(false);
    const [crm] = warned();
    expect(crm!.app).toBe("crm");
    expect(crm!.message).toMatch(/"app" is "shop", expected "crm"/);
    expect(crm!.message).toMatch(/redacted-schema\.md not found/);
    expect(crm!.message).not.toMatch(/keeping/);

    const client = await connectInMemory({
      logs: { schemas: s.logSchemas, loki: createLoki({ url: "https://loki.invalid", token: "t", fetch: () => Promise.reject(new Error("reached Loki")) }), sources: logSources(REGISTRY) },
      sql: { databases: untouchable, schemas: s.redactedSchemas },
    });
    const logs = await client.callTool({ name: "query_logs", arguments: { app: "crm" } });
    expect(logs.isError).toBe(true);
    expect(textOf(logs)).toBe("crm is not configured: log schema is missing");
    expect(textOf(await client.callTool({ name: "describe_schema", arguments: { app: "crm" } }))).toBe("crm is not configured: redacted schema is missing");
    expect(textOf(await client.callTool({ name: "describe_schema", arguments: { app: "shop" } }))).toBe("# shop\n");
    await client.close();
  });

  it("changes what query_logs returns after a refresh, without a restart", async () => {
    const gh = github(allFiles());
    const { store: s } = store({ token: "t", fetch: gh.fetch });
    await s.start();
    const line = JSON.stringify({ action: "send-mail", level: "info", service: "shop", message: { to: "jane.doe@example.com", memberId: "m_1" } });
    const loki = createLoki({
      url: "https://loki.test",
      token: "t",
      fetch: (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/query_range")) {
          return Response.json({ status: "success", data: { resultType: "streams", result: [{ stream: {}, values: [["1792324200000000000", line]] }] } });
        }
        return Response.json({ status: "success", data: { resultType: "vector", result: [{ metric: {}, value: [0, "1"] }] } });
      }) as typeof globalThis.fetch,
    });
    const client = await connectInMemory({ logs: { schemas: s.logSchemas, loki, sources: logSources(REGISTRY) } });
    const read = async () => JSON.stringify(JSON.parse(textOf(await client.callTool({ name: "query_logs", arguments: { app: "shop" } }))));
    expect(await read()).not.toContain("jane.doe@example.com");
    gh.state.files = { ...allFiles(), [SHOP_LOG]: JSON.stringify({ app: "shop", fields: { action: "visible", level: "visible", "message.to": "visible" } }) };
    await s.refresh();
    expect(await read()).toContain("jane.doe@example.com");
    await client.close();
  });
});

describe("SchemaStore without a token (developer mode)", () => {
  function dirWith(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "hyde-store-"));
    dirs.push(dir);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  }

  it("reads schemas/ instead of GitHub", async () => {
    const gh = github(allFiles());
    const dir = dirWith({ "shop.hyde-json.json": shopLogs, "shop.redacted-schema.md": "# local shop\n" });
    const { store: s, warnings } = store({ dir, fetch: gh.fetch });
    await s.start();
    expect(s.mode).toBe("local");
    expect(gh.state.requests).toEqual([]);
    expect(s.get("shop")).toEqual({ log: expect.objectContaining({ app: "shop" }), redacted: "# local shop\n" });
    // A missing local file is not configured, not a warning.
    expect(s.get("crm")).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("picks up a rewritten file at refresh and warns naming a file that turned invalid, keeping the last good", async () => {
    const dir = dirWith({ "crm.hyde-json.json": crmLogs });
    const { store: s, warned } = store({ dir });
    await s.start();
    expect(s.get("crm")?.log?.app).toBe("crm");
    writeFileSync(redactedSchemaFile("crm", dir), "# crm\n");
    await s.refresh();
    expect(s.get("crm")?.redacted).toBe("# crm\n");
    writeFileSync(schemaFile("crm", dir), "{ not json");
    await s.refresh();
    expect(s.get("crm")?.log?.app).toBe("crm");
    expect(warned()[0]!.message).toContain(`${schemaFile("crm", dir)}: the file is not JSON`);
  });

  it("with neither GitHub nor a local file, every app is not configured and the store still starts", async () => {
    const { store: s } = store({ dir: dirWith({}) });
    await expect(s.start()).resolves.toBeUndefined();
    expect(s.get("shop")).toBeUndefined();
    expect(s.logSchemas.size + s.redactedSchemas.size).toBe(0);
  });
});

/** A database that fails the test if anything reaches it. */
const untouchable: Databases = {
  has: () => true,
  connect: () => Promise.reject(new Error("reached the database")),
  close: async () => {},
};
