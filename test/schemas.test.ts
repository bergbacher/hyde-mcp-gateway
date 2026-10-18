import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadSchemas, schemaFile } from "../src/schemas.ts";

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
    const schemas = loadSchemas(FIXTURES);
    expect(schemas.crm.app).toBe("crm");
    expect(schemas.crm.fields["message.workspaceId"]).toBe("visible");
    expect(schemas.shop.fields["message.to"]).toBe("hidden");
    expect(schemas.shop.passIds).toBe(true);
  });

  it("throws naming the missing file", () => {
    const dir = dirWith("crm");
    expect(() => loadSchemas(dir)).toThrow(/shop: .*shop\.hyde-json\.json is missing/);
    expect(() => loadSchemas(dir)).toThrow(/pnpm schemas/);
  });

  it("throws naming both when neither exists", () => {
    const dir = dirWith();
    expect(() => loadSchemas(dir)).toThrow(/shop: .* is missing\n.*crm: .* is missing/);
  });

  it("throws on a file that is not JSON or not a valid schema", () => {
    const dir = dirWith("crm", "shop");
    writeFileSync(schemaFile("shop", dir), "{ not json");
    expect(() => loadSchemas(dir)).toThrow(/shop: .*JSON/);
    writeFileSync(schemaFile("shop", dir), JSON.stringify({ app: "shop", fields: { "message.x": "shown" } }));
    expect(() => loadSchemas(dir)).toThrow(/shop: .*"shown" is not one of/);
  });

  it("throws when a schema is filed under the wrong app", () => {
    const dir = dirWith("crm");
    copyFileSync(schemaFile("crm", FIXTURES), schemaFile("shop", dir));
    expect(() => loadSchemas(dir)).toThrow(/shop: .*"app" is "crm", expected "shop"/);
  });
});
