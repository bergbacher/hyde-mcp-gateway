import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config.ts";
import { StaticTokenVerifier, type Principal } from "../src/mcp/auth.ts";
import { REGISTRY, REGISTRY_WITH_THIRD } from "./helpers.ts";

const A = "a".repeat(32);
const B = "b".repeat(32);

describe("config", () => {
  it("maps HYDE_TOKEN_* to client names and HYDE_TOKEN_*_APPS to their scopes", () => {
    const c = readConfig(REGISTRY, {
      HYDE_TOKEN_CLAUDE_CODE: A, HYDE_TOKEN_CLAUDE_CODE_APPS: "*",
      HYDE_TOKEN_AGENT: B, HYDE_TOKEN_AGENT_APPS: " shop , crm ",
    });
    expect(c.clients).toEqual(new Map<string, Principal>([
      [A, { client: "claude-code", apps: "*" }],
      [B, { client: "agent", apps: new Set(["shop", "crm"]) }],
    ]));
  });
  it("refuses no token, short token, duplicate token", () => {
    expect(() => readConfig(REGISTRY, {})).toThrow(/No client token/);
    expect(() => readConfig(REGISTRY, { HYDE_TOKEN_X: "short", HYDE_TOKEN_X_APPS: "*" })).toThrow(/shorter/);
    expect(() => readConfig(REGISTRY, { HYDE_TOKEN_X: A, HYDE_TOKEN_X_APPS: "*", HYDE_TOKEN_Y: A, HYDE_TOKEN_Y_APPS: "*" }))
      .toThrow(/repeats/);
  });
  it("refuses to start for a token without its _APPS variable, naming it: no implicit all-access (D39)", () => {
    expect(() => readConfig(REGISTRY, { HYDE_TOKEN_AGENT: B })).toThrow(/^HYDE_TOKEN_AGENT_APPS is not set/);
    expect(() => readConfig(REGISTRY, { HYDE_TOKEN_AGENT: B, HYDE_TOKEN_AGENT_APPS: " " })).toThrow(/^HYDE_TOKEN_AGENT_APPS is not set/);
  });
  it("refuses to start for a scope naming an app apps.json does not hold", () => {
    expect(() => readConfig(REGISTRY, { HYDE_TOKEN_AGENT: B, HYDE_TOKEN_AGENT_APPS: "shop,help-desk" }))
      .toThrow("HYDE_TOKEN_AGENT_APPS names help-desk, not in apps.json; registered: shop, crm");
    // Registered, the same scope is accepted.
    const c = readConfig(REGISTRY_WITH_THIRD, { HYDE_TOKEN_AGENT: B, HYDE_TOKEN_AGENT_APPS: "shop,help-desk" });
    expect(c.clients.get(B)).toEqual({ client: "agent", apps: new Set(["shop", "help-desk"]) });
  });
  it("refuses a malformed scope and a scope without its token", () => {
    expect(() => readConfig(REGISTRY, { HYDE_TOKEN_AGENT: B, HYDE_TOKEN_AGENT_APPS: "shop,,crm" })).toThrow(/empty entry/);
    expect(() => readConfig(REGISTRY, { HYDE_TOKEN_AGENT: B, HYDE_TOKEN_AGENT_APPS: "shop,*" })).toThrow(/mixes \*/);
    expect(() => readConfig(REGISTRY, { HYDE_TOKEN_AGENT: B, HYDE_TOKEN_AGENT_APPS: "*", HYDE_TOKEN_OLD_APPS: "*" }))
      .toThrow("HYDE_TOKEN_OLD_APPS is set but HYDE_TOKEN_OLD is not");
  });
});

describe("StaticTokenVerifier", () => {
  const agent: Principal = { client: "agent", apps: new Set(["shop"]) };
  const verifier = new StaticTokenVerifier(new Map([[A, agent]]));
  it("returns the principal for a known bearer token, else undefined", async () => {
    expect(await verifier.verify(`Bearer ${A}`)).toBe(agent);
    expect(await verifier.verify(`bearer ${A}`)).toBe(agent);
    expect(await verifier.verify(`Bearer ${"a".repeat(31)}z`)).toBeUndefined();
    expect(await verifier.verify(`Bearer ${A}a`)).toBeUndefined();
    expect(await verifier.verify("Basic abc")).toBeUndefined();
    expect(await verifier.verify(undefined)).toBeUndefined();
  });
});
