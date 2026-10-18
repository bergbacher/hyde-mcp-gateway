import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config.ts";
import { authenticate } from "../src/mcp/auth.ts";
import { REGISTRY } from "./helpers.ts";

describe("config", () => {
  it("maps HYDE_TOKEN_* to client names", () => {
    const c = readConfig(REGISTRY, { HYDE_TOKEN_CLAUDE_CODE: "a".repeat(32), HYDE_TOKEN_AGENT: "b".repeat(32) });
    expect([...c.clients.values()].sort()).toEqual(["agent", "claude-code"]);
  });
  it("refuses no token, short token, duplicate token", () => {
    expect(() => readConfig(REGISTRY, {})).toThrow(/No client token/);
    expect(() => readConfig(REGISTRY, { HYDE_TOKEN_X: "short" })).toThrow(/shorter/);
    expect(() => readConfig(REGISTRY, { HYDE_TOKEN_X: "a".repeat(32), HYDE_TOKEN_Y: "a".repeat(32) })).toThrow(/repeats/);
  });
  it("authenticate returns the client or undefined", () => {
    const clients = new Map([["a".repeat(32), "agent"]]);
    expect(authenticate(`Bearer ${"a".repeat(32)}`, clients)).toBe("agent");
    expect(authenticate(`Bearer ${"a".repeat(31)}z`, clients)).toBeUndefined();
    expect(authenticate("Basic abc", clients)).toBeUndefined();
    expect(authenticate(undefined, clients)).toBeUndefined();
  });
});
