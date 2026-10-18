import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fetchSchemas, LOG_SCHEMAS, parseArgs, REDACTED_SCHEMAS } from "../scripts/fetch-schemas.ts";
import type { Registry } from "../src/registry.ts";
import { redactedSchemaFile, schemaFile } from "../src/schemas.ts";
import { REGISTRY, REGISTRY_WITH_THIRD } from "./helpers.ts";

const FIXTURES = new URL("./fixtures/schemas/", import.meta.url);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake GitHub contents API: `files` maps "<repo>:<path>" to the body; anything else answers 404. */
function github(files: Record<string, string>) {
  const requests: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const [, , owner, repo, , ...path] = url.pathname.split("/");
    requests.push(url.toString());
    const body = files[`${owner}/${repo}:${path.join("/")}`];
    return body === undefined ? new Response("Not Found", { status: 404, statusText: "Not Found" }) : new Response(body);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

function run(kind: typeof LOG_SCHEMAS, argv: string[], files: Record<string, string>, registry: Registry = REGISTRY) {
  const dir = mkdtempSync(join(tmpdir(), "hyde-fetch-"));
  dirs.push(dir);
  const out: string[] = [];
  const { fetch, requests } = github(files);
  const result = fetchSchemas(kind, { ...parseArgs(argv, registry), registry, dir, auth: "t", fetch, log: (l) => out.push(l), warn: (l) => out.push(l) });
  return result.then((r) => ({ ...r, dir, out: out.join("\n"), requests }));
}

const shopLogs = readFileSync(new URL("shop.hyde-json.json", FIXTURES), "utf8");
const crmLogs = readFileSync(new URL("crm.hyde-json.json", FIXTURES), "utf8");

describe("parseArgs", () => {
  it("defaults to every registered app, takes repeatable --app and --strict, refuses the rest", () => {
    expect(parseArgs([], REGISTRY)).toEqual({ apps: ["shop", "crm"], strict: false });
    expect(parseArgs(["--app", "shop"], REGISTRY)).toEqual({ apps: ["shop"], strict: false });
    expect(parseArgs(["--app", "crm", "--app=shop", "--strict"], REGISTRY)).toEqual({ apps: ["crm", "shop"], strict: true });
    expect(() => parseArgs(["--app", "other"], REGISTRY)).toThrow(/--app needs one of shop, crm, got other/);
    expect(() => parseArgs(["--app"], REGISTRY)).toThrow(/--app needs/);
    expect(() => parseArgs(["shop"], REGISTRY)).toThrow(/Unknown argument shop/);
  });

  it("knows the apps of the registry it is given", () => {
    expect(parseArgs([], REGISTRY_WITH_THIRD).apps).toEqual(["shop", "crm", "help-desk"]);
    expect(parseArgs(["--app", "help-desk"], REGISTRY_WITH_THIRD).apps).toEqual(["help-desk"]);
    expect(() => parseArgs(["--app", "help-desk"], REGISTRY)).toThrow(/got help-desk/);
  });
});

describe("pnpm schemas (D37)", () => {
  it("writes the apps that fetch and validate, warns for the others, exits 0", async () => {
    const r = await run(LOG_SCHEMAS, [], { "example-org/shop:prisma/hyde-json.json": shopLogs });
    expect(r.written).toEqual(["shop"]);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(schemaFile("shop", r.dir), "utf8")).toBe(shopLogs.endsWith("\n") ? shopLogs : `${shopLogs}\n`);
    expect(existsSync(schemaFile("crm", r.dir))).toBe(false);
    expect(r.out).toMatch(/warning: crm not written: example-org\/crm@main:prisma\/hyde-json\.json not found/);
  });

  it("fails with --strict when an app is missing, still writing the others", async () => {
    const r = await run(LOG_SCHEMAS, ["--strict"], { "example-org/shop:prisma/hyde-json.json": shopLogs });
    expect(r.exitCode).toBe(1);
    expect(existsSync(schemaFile("shop", r.dir))).toBe(true);
  });

  it("fails when nothing could be written", async () => {
    const r = await run(LOG_SCHEMAS, [], {});
    expect(r.exitCode).toBe(1);
    expect(r.out).toMatch(/pnpm schemas: nothing written/);
  });

  it("--app limits the run to that app and fails only on it", async () => {
    const ok = await run(LOG_SCHEMAS, ["--app", "shop", "--strict"], { "example-org/shop:prisma/hyde-json.json": shopLogs });
    expect(ok).toMatchObject({ written: ["shop"], failed: [], exitCode: 0 });
    expect(ok.requests).toHaveLength(1);
    const bad = await run(LOG_SCHEMAS, ["--app", "crm"], { "example-org/shop:prisma/hyde-json.json": shopLogs });
    expect(bad.exitCode).toBe(1);
  });

  it("does not write an invalid file or one filed under the other app", async () => {
    const r = await run(LOG_SCHEMAS, [], {
      "example-org/shop:prisma/hyde-json.json": "{ not json",
      "example-org/crm:prisma/hyde-json.json": shopLogs,
    });
    expect(r).toMatchObject({ written: [], exitCode: 1 });
    expect(r.out).toMatch(/shop not written: .*is not JSON/);
    expect(r.out).toMatch(/crm not written: .*"app" is "shop", expected "crm"/);
    const both = await run(LOG_SCHEMAS, [], {
      "example-org/shop:prisma/hyde-json.json": shopLogs,
      "example-org/crm:prisma/hyde-json.json": crmLogs,
    });
    expect(both).toMatchObject({ written: ["shop", "crm"], failed: [], exitCode: 0 });
  });
});

describe("pnpm fetch:redacted-schemas (D37)", () => {
  it("writes the apps whose redacted-schema.md fetches, warns for an empty or missing one", async () => {
    const r = await run(REDACTED_SCHEMAS, [], {
      "example-org/shop:prisma/redacted/redacted-schema.md": "# shop redacted schema",
      "example-org/crm:prisma/redacted/redacted-schema.md": "  \n",
    });
    expect(r).toMatchObject({ written: ["shop"], exitCode: 0 });
    expect(readFileSync(redactedSchemaFile("shop", r.dir), "utf8")).toBe("# shop redacted schema\n");
    expect(r.out).toMatch(/crm not written: .*redacted-schema\.md: the file is empty/);
    expect(r.requests.every((u) => u.endsWith("?ref=main"))).toBe(true);
  });
});

describe("a third app in apps.json", () => {
  it("--app fetches it from the repo and paths its entry names", async () => {
    const third = REGISTRY_WITH_THIRD.apps.get("help-desk")!;
    const logs = JSON.stringify({ app: "help-desk", fields: { action: "visible" } });
    const r = await run(LOG_SCHEMAS, ["--app", "help-desk", "--strict"], { [`${third.repo}:${third.logSchemaPath}`]: logs }, REGISTRY_WITH_THIRD);
    expect(r).toMatchObject({ written: ["help-desk"], failed: [], exitCode: 0 });
    expect(r.requests).toEqual([`https://api.github.com/repos/${third.repo}/contents/${third.logSchemaPath}?ref=main`]);
    expect(readFileSync(schemaFile("help-desk", r.dir), "utf8")).toBe(`${logs}\n`);

    const redacted = await run(REDACTED_SCHEMAS, ["--app", "help-desk"], { [`${third.repo}:${third.redactedSchemaPath}`]: "# help-desk" }, REGISTRY_WITH_THIRD);
    expect(redacted).toMatchObject({ written: ["help-desk"], exitCode: 0 });
    expect(redacted.requests).toEqual([`https://api.github.com/repos/${third.repo}/contents/${third.redactedSchemaPath}?ref=main`]);
  });
});
