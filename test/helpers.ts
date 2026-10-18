import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Principal } from "../src/mcp/auth.ts";
import { createServer, type ServerOptions } from "../src/mcp/server.ts";
import { loadRegistry, parseRegistry, REGISTRY_FILE, type Registry } from "../src/registry.ts";

/** The committed apps.json. */
export const REGISTRY: Registry = loadRegistry();

/** A third app's entry, as a new team would add it: no code change, one apps.json entry. */
export const THIRD_APP = {
  repo: "example-org/help-desk",
  logSchemaPath: "config/hyde-json.json",
  redactedSchemaPath: "db/redacted/redacted-schema.md",
  redactedSqlPath: "db/redacted",
  loki: { stream: '{resource_name="example-help-desk-prod"}', service: "help-desk" },
  database: {
    host: "rw-0002.example.invalid",
    port: 3306,
    sourceDatabase: "helpdesk",
    certName: "00000000-0000-4000-8000-000000000001",
    caSource: { repo: "example-org/help-desk", path: "lib/database-ca.ts", ref: "main" },
  },
};

/** The committed apps.json as JSON, plus `help-desk` (THIRD_APP). */
export function registryJsonWithThirdApp(): { apps: Record<string, unknown> } {
  const json = JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as { apps: Record<string, unknown> };
  return { apps: { ...json.apps, "help-desk": THIRD_APP } };
}

export const REGISTRY_WITH_THIRD: Registry = parseRegistry(registryJsonWithThirdApp());

/** A caller allowed every app. */
export const ALL_APPS: Principal = { client: "test", apps: "*" };

/**
 * An MCP client connected in memory to a server built from `options`; the
 * registry defaults to apps.json, the caller to ALL_APPS.
 */
export async function connectInMemory(
  options: Omit<ServerOptions, "registry"> & { registry?: Registry; principal?: Principal },
) {
  const { principal = ALL_APPS, ...rest } = options;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(principal, { registry: REGISTRY, ...rest }).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

export function textOf(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0]!.text;
}
