import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadSchemas, schemaFile } from "../src/schemas.ts";
import { REGISTRY } from "./helpers.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/schemas/", import.meta.url));
const dirs: string[] = [];

/** A temp dir holding the fixture schemas of `apps`. */
function dirWith(...apps: ("crm" | "shop")[]): string {
  const dir = mkdtempSync(join(tmpdir(), "hyde-schemas-"));
  dirs.push(dir);
  for (const app of apps) copyFileSync(schemaFile(app, FIXTURES), schemaFile(app, dir));
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadSchemas", () => {
  it("loads and validates both apps' schemas", () => {
    const schemas = loadSchemas(REGISTRY, FIXTURES);
    expect(schemas.get("crm")?.app).toBe("crm");
    expect(schemas.get("crm")?.fields["message.workspaceId"]).toBe("visible");
    expect(schemas.get("shop")?.fields["message.to"]).toBe("hidden");
    expect(schemas.get("shop")?.passIds).toBe(true);
  });

  it("returns the apps whose file exists and leaves the others out (D37)", () => {
    const schemas = loadSchemas(REGISTRY, dirWith("shop"));
    expect([...schemas.keys()]).toEqual(["shop"]);
    expect(schemas.get("shop")?.app).toBe("shop");
    expect(schemas.get("crm")).toBeUndefined();
  });

  it("throws naming both when neither exists", () => {
    const dir = dirWith();
    expect(() => loadSchemas(REGISTRY, dir)).toThrow(/No log schema/);
    expect(() => loadSchemas(REGISTRY, dir)).toThrow(/shop: .*shop\.hyde-json\.json is missing\n.*crm: .* is missing/);
    expect(() => loadSchemas(REGISTRY, dir)).toThrow(/pnpm schemas/);
  });

  it("throws on a present file that is not JSON or not a valid schema, even when the other app is fine", () => {
    const dir = dirWith("crm", "shop");
    writeFileSync(schemaFile("shop", dir), "{ not json");
    expect(() => loadSchemas(REGISTRY, dir)).toThrow(/shop: .*JSON/);
    writeFileSync(schemaFile("shop", dir), JSON.stringify({ app: "shop", fields: { "message.x": "shown" } }));
    expect(() => loadSchemas(REGISTRY, dir)).toThrow(/shop: .*"shown" is not one of/);
  });

  it("throws when a schema is filed under the wrong app", () => {
    const dir = dirWith("crm");
    copyFileSync(schemaFile("crm", FIXTURES), schemaFile("shop", dir));
    expect(() => loadSchemas(REGISTRY, dir)).toThrow(/shop: .*"app" is "crm", expected "shop"/);
  });
});
