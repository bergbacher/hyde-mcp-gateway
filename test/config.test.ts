import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config.ts";
import { CompositeVerifier, StaticTokenVerifier, VerificationUnavailableError, type Principal } from "../src/mcp/auth.ts";
import { GitHubTokenVerifier } from "../src/mcp/github-auth.ts";
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

describe("config for GitHub tokens (D59)", () => {
  const base = { HYDE_TOKEN_AGENT: B, HYDE_TOKEN_AGENT_APPS: "*" };
  it("caches a GitHub token's scope 300 s unless HYDE_GITHUB_SCOPE_TTL_SECONDS says otherwise", () => {
    expect(readConfig(REGISTRY, base).githubScopeTtlSeconds).toBe(300);
    expect(readConfig(REGISTRY, { ...base, HYDE_GITHUB_SCOPE_TTL_SECONDS: "60" }).githubScopeTtlSeconds).toBe(60);
    expect(readConfig(REGISTRY, { ...base, HYDE_GITHUB_SCOPE_TTL_SECONDS: "0" }).githubScopeTtlSeconds).toBe(0);
    for (const bad of ["-1", "1.5", "5m"]) {
      expect(() => readConfig(REGISTRY, { ...base, HYDE_GITHUB_SCOPE_TTL_SECONDS: bad })).toThrow(/^HYDE_GITHUB_SCOPE_TTL_SECONDS is not/);
    }
  });
  it("refuses a static token shaped like a GitHub token: it would be sent to GitHub, never matched", () => {
    expect(() => readConfig(REGISTRY, { HYDE_TOKEN_AGENT: `ghp_${"a".repeat(36)}`, HYDE_TOKEN_AGENT_APPS: "*" }))
      .toThrow(/^HYDE_TOKEN_AGENT starts like a GitHub token/);
  });
});

describe("GitHubTokenVerifier", () => {
  const TOKEN = `ghs_${"e".repeat(36)}`;
  function verifier(answer: (url: string) => Response | Promise<Response>) {
    return new GitHubTokenVerifier({ registry: REGISTRY, fetch: async (input) => answer(String(input)) });
  }
  const login = () => Response.json({ login: "octocat" });
  it("ignores a header that is not a GitHub bearer token without asking GitHub", async () => {
    const v = verifier(() => { throw new Error("asked GitHub"); });
    expect(await v.verify(undefined)).toBeUndefined();
    expect(await v.verify(`Bearer ${A}`)).toBeUndefined();
  });
  it("a token GitHub knows but /user refuses (an installation token, SSO) is not accepted", async () => {
    expect(await verifier(() => new Response("", { status: 403 })).verify(`Bearer ${TOKEN}`)).toBeUndefined();
  });
  it("a repository hidden by 403 is not readable; one answering 401 refuses the token", async () => {
    const hidden = verifier((url) => url.endsWith("/user") ? login() : url.endsWith("/shop") ? Response.json({}) : new Response("", { status: 403 }));
    expect(await hidden.verify(`Bearer ${TOKEN}`)).toEqual({ client: "gh:octocat", apps: new Set(["shop"]) });
    const revoked = verifier((url) => url.endsWith("/user") ? login() : new Response("", { status: 401 }));
    expect(await revoked.verify(`Bearer ${TOKEN}`)).toBeUndefined();
  });
  it("rate limits, 5xx, network failures and a /user without login are unavailable, not refusals", async () => {
    const cases: [() => Response | Promise<Response>, string][] = [
      [() => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }), "GitHub rate limit reached"],
      [() => new Response("", { status: 429 }), "GitHub rate limit reached"],
      [() => new Response("", { status: 500 }), "GitHub answered HTTP 500"],
      [() => Promise.reject(new TypeError("fetch failed")), "GitHub is unreachable"],
      [() => Response.json({}), "GitHub answered /user without a login"],
    ];
    for (const [answer, message] of cases) {
      const v = verifier(answer);
      await expect(v.verify(`Bearer ${TOKEN}`)).rejects.toThrow(new VerificationUnavailableError(message));
    }
    const repoDown = verifier((url) => url.endsWith("/user") ? login() : new Response("", { status: 503 }));
    await expect(repoDown.verify(`Bearer ${TOKEN}`)).rejects.toBeInstanceOf(VerificationUnavailableError);
  });
});

describe("CompositeVerifier", () => {
  it("sends every GitHub prefix to GitHub and everything else to the static tokens", async () => {
    const seen: string[] = [];
    const named = (kind: string) => ({ async verify() { seen.push(kind); return undefined; } });
    const v = new CompositeVerifier(named("github"), named("static"));
    for (const p of ["ghp_", "gho_", "ghu_", "ghs_", "github_pat_"]) await v.verify(`Bearer ${p}x`);
    await v.verify(`Bearer ${A}`);
    await v.verify(undefined);
    expect(seen).toEqual(["github", "github", "github", "github", "github", "static", "static"]);
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
