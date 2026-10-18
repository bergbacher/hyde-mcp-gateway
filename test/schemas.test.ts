import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { edgeSchemaFile, loadEdgeSchema, parseLogSchemaText, parseRedactedSchemaText, schemaFile } from "../src/schemas.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/schemas/", import.meta.url));
const dirs: string[] = [];

/** An empty temp dir. */
function emptyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hyde-schemas-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fixture = (app: "crm" | "shop") => readFileSync(schemaFile(app, FIXTURES), "utf8");

describe("parseLogSchemaText", () => {
  it("validates an app's log schema", () => {
    const crm = parseLogSchemaText("crm", fixture("crm"));
    expect(crm.app).toBe("crm");
    expect(crm.fields["message.workspaceId"]).toBe("visible");
    const shop = parseLogSchemaText("shop", fixture("shop"));
    expect(shop.fields["message.to"]).toBe("hidden");
    expect(shop.passIds).toBe(true);
  });

  it("throws on text that is not JSON or not a valid schema", () => {
    expect(() => parseLogSchemaText("shop", "{ not json")).toThrow(/not JSON/);
    expect(() => parseLogSchemaText("shop", JSON.stringify({ app: "shop", fields: { "message.x": "shown" } }))).toThrow(/"shown" is not one of/);
  });

  it("throws when a schema is filed under the wrong app", () => {
    expect(() => parseLogSchemaText("shop", fixture("crm"))).toThrow(/"app" is "crm", expected "shop"/);
  });
});

describe("parseRedactedSchemaText", () => {
  it("takes any non-empty text, refuses an empty file", () => {
    expect(parseRedactedSchemaText("# shop\n")).toBe("# shop\n");
    expect(() => parseRedactedSchemaText(" \n")).toThrow(/empty/);
  });
});

describe("loadEdgeSchema (D46)", () => {
  it("loads the committed edge schema: client IP and Scaleway ids hidden, the URL text, the rest visible", () => {
    const schema = loadEdgeSchema();
    expect(schema.app).toBe("edge");
    expect(schema.fields.http_request_client_ip).toBe("hidden");
    expect(schema.fields.pipeline_id).toBe("hidden");
    expect(schema.fields.project_id).toBe("hidden");
    expect(schema.fields.http_client_request_url).toBe("text");
    const others = Object.entries(schema.fields)
      .filter(([path]) => !["http_request_client_ip", "pipeline_id", "project_id", "http_client_request_url"].includes(path));
    for (const [path, rule] of others) expect([path, rule]).toEqual([path, "visible"]);
    expect(schema.passIds || schema.passNumbers).toBe(false);
  });

  it("throws naming the file when it is missing or filed under another name", () => {
    const dir = emptyDir();
    expect(() => loadEdgeSchema(dir)).toThrow(/edge\.hyde-json\.json not loaded/);
    writeFileSync(edgeSchemaFile(dir), JSON.stringify({ app: "shop", fields: {} }));
    expect(() => loadEdgeSchema(dir)).toThrow(/"app" is "shop", expected "edge"/);
  });
});
