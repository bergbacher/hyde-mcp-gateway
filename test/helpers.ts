import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type ServerOptions } from "../src/mcp/server.ts";

/** An MCP client connected in memory to a server built from `options`. */
export async function connectInMemory(options: ServerOptions) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer("test", options).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

export function textOf(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0]!.text;
}
