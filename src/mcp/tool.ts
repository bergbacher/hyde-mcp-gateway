// The gate every tool shares. Every tool takes `app`, a name registered in
// apps.json (D38); a name the registry does not hold is refused at every tool
// with "unknown app <name>; registered: …"; then an app outside the caller's
// scope (src/mcp/auth.ts, D39) is refused with "client <client> is not
// authorized for app <app>", before any backend is touched. A registered app
// in scope that lacks what a tool reads is refused at that tool with
// "<app> is not configured: <what is missing>" (D37); the other apps are
// unaffected. Tool groups import from here, never from the server module.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { appNames, unknownApp, type App, type Registry } from "../registry.ts";
import { allowed, unauthorized, type Principal } from "./auth.ts";

/** The `app` parameter: any string, checked against the registry by `forApp`, so the refusal names the registry. */
export function appSchema(registry: Registry) {
  return z.string().describe(`The app to read, one of: ${appNames(registry).join(", ")}`);
}

/** Where a tool group registers its tools: the server, through `createServer`, which records their names. */
export type Registrar = Pick<McpServer, "registerTool">;

/** What every tool checks `app` against: the registry, then the caller's scope. */
export interface Gate {
  registry: Registry;
  principal: Principal;
}

/**
 * Wraps a tool handler. Before it runs, and so before any backend is touched:
 * a name the registry does not hold is a tool error, then an app outside the
 * caller's scope is refused as unauthorized (D39).
 */
export function forApp<A extends { app: string }>(
  { registry, principal }: Gate,
  handler: (args: A) => Promise<CallToolResult> | CallToolResult,
): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    if (!registry.apps.has(args.app)) return error(unknownApp(args.app, registry));
    if (!allowed(principal, args.app)) return error(unauthorized(principal, args.app));
    return handler(args);
  };
}

/** The tool error for an app that lacks what the tool reads (D37). */
export function notConfigured(app: App, missing: string[]): CallToolResult {
  return error(`${app} is not configured: ${missing.join("; ")}`);
}

export function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

export function error(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
