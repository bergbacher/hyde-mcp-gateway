// Who is calling and which apps they may read (D16, D39). Token verification
// sits behind `TokenVerifier`, so a stored-token or OAuth implementation can
// replace the static one without touching the tools; the tools see only the
// `Principal`. Two implementations: GitHub tokens (src/mcp/github-auth.ts,
// D59), scoped by the repositories they can read, and `StaticTokenVerifier`: one
// `HYDE_TOKEN_<CLIENT>` per client, its app scope in
// `HYDE_TOKEN_<CLIENT>_APPS` (a comma list of apps.json names, or `*`).
// There is no implicit all-access: a token without its scope variable, a scope
// without its token, or a scope naming an app apps.json does not hold stops
// the start.

import { timingSafeEqual } from "node:crypto";
import { appNames, type App, type Registry } from "../registry.ts";

/** An authenticated caller: its client name and the apps it may read, or `"*"` for every registered app. */
export interface Principal {
  client: string;
  apps: ReadonlySet<App> | "*";
}

export interface TokenVerifier {
  /**
   * The principal for an `Authorization` header, or undefined when it carries
   * no accepted token. Throws `VerificationUnavailableError` when the token
   * cannot be checked right now (its issuer is down or rate-limits).
   */
  verify(header: string | undefined): Promise<Principal | undefined>;
}

/** A token that could not be checked, as opposed to one that was refused. The message names the cause, never the token. */
export class VerificationUnavailableError extends Error {}

/** The prefixes GitHub gives its tokens: classic and fine-grained PATs, OAuth, user-to-server and installation tokens. */
export const GITHUB_TOKEN_PREFIXES: readonly string[] = ["ghp_", "gho_", "ghu_", "ghs_", "github_pat_"];

/** Whether `token` is shaped like a GitHub token, and so is checked against GitHub (D59). */
export function isGitHubToken(token: string): boolean {
  return GITHUB_TOKEN_PREFIXES.some((p) => token.startsWith(p));
}

/** The token of a `Bearer <token>` header, else undefined. */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  return /^Bearer\s+(\S+)$/i.exec(header)?.[1];
}

/** Whether `principal` may read `app`. Scope is per app, not per tool. */
export function allowed(principal: Principal, app: App): boolean {
  return principal.apps === "*" || principal.apps.has(app);
}

/** The tool error text for a call outside the caller's scope. */
export function unauthorized(principal: Principal, app: App): string {
  return `client ${principal.client} is not authorized for app ${app}`;
}

/** The scope as `ping` and the startup line report it. */
export function scopeOf(principal: Principal): App[] | "*" {
  return principal.apps === "*" ? "*" : [...principal.apps];
}

export const TOKEN_PREFIX = "HYDE_TOKEN_";
export const SCOPE_SUFFIX = "_APPS";

/**
 * Reads every `HYDE_TOKEN_<CLIENT>` and its `HYDE_TOKEN_<CLIENT>_APPS`.
 * Returns token → principal. Throws naming the variable at the first problem.
 * A variable ending in `_APPS` is always a scope, so no client name ends in `-apps`.
 */
export function readClientTokens(registry: Registry, env: NodeJS.ProcessEnv): Map<string, Principal> {
  const tokens = new Map<string, Principal>();
  const scopes = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(TOKEN_PREFIX)) continue;
    if (key.endsWith(SCOPE_SUFFIX)) {
      scopes.add(key);
      continue;
    }
    if (!value) continue;
    if (isGitHubToken(value)) throw new Error(`${key} starts like a GitHub token; static tokens must not (openssl rand -hex 32)`);
    const client = key.slice(TOKEN_PREFIX.length).toLowerCase().replaceAll("_", "-");
    if (value.length < 32) throw new Error(`${key} is shorter than 32 characters`);
    if (tokens.has(value)) throw new Error(`${key} repeats another client's token`);
    const scopeKey = `${key}${SCOPE_SUFFIX}`;
    tokens.set(value, { client, apps: parseScope(scopeKey, env[scopeKey], registry) });
  }
  for (const key of scopes) {
    const tokenKey = key.slice(0, -SCOPE_SUFFIX.length);
    if (!env[tokenKey]) throw new Error(`${key} is set but ${tokenKey} is not`);
  }
  if (tokens.size === 0) throw new Error(`No client token set (${TOKEN_PREFIX}<CLIENT>)`);
  return tokens;
}

function parseScope(key: string, raw: string | undefined, registry: Registry): Principal["apps"] {
  const value = raw?.trim();
  if (!value) {
    throw new Error(`${key} is not set: list the apps this client may read (comma-separated apps.json names) or * for all`);
  }
  if (value === "*") return "*";
  const apps = value.split(",").map((s) => s.trim());
  if (apps.some((a) => a === "")) throw new Error(`${key} has an empty entry: ${value}`);
  if (apps.includes("*")) throw new Error(`${key} mixes * with app names: ${value}`);
  const unknown = apps.filter((a) => !registry.apps.has(a));
  if (unknown.length > 0) {
    throw new Error(`${key} names ${unknown.join(", ")}, not in apps.json; registered: ${appNames(registry).join(", ")}`);
  }
  return new Set(apps);
}

/** Static bearer tokens from the environment, compared in constant time. */
export class StaticTokenVerifier implements TokenVerifier {
  readonly #tokens: ReadonlyMap<string, Principal>;

  /** `tokens`: token → principal, as `readClientTokens` returns it. */
  constructor(tokens: ReadonlyMap<string, Principal>) {
    this.#tokens = tokens;
  }

  async verify(header: string | undefined): Promise<Principal | undefined> {
    const token = bearerToken(header);
    if (!token) return undefined;
    const given = Buffer.from(token);
    // Every token is compared, so the time taken does not say which one matched.
    let found: Principal | undefined;
    for (const [token, principal] of this.#tokens) {
      const known = Buffer.from(token);
      if (known.length === given.length && timingSafeEqual(known, given)) found = principal;
    }
    return found;
  }
}

/**
 * Routes a GitHub-shaped token to the GitHub verifier and every other token to
 * the static one; a token is checked by exactly one of them.
 */
export class CompositeVerifier implements TokenVerifier {
  /** The verifier kinds, as the startup line lists them. */
  readonly kinds = ["github", "static"] as const;
  readonly #github: TokenVerifier;
  readonly #fallback: TokenVerifier;

  constructor(github: TokenVerifier, fallback: TokenVerifier) {
    this.#github = github;
    this.#fallback = fallback;
  }

  verify(header: string | undefined): Promise<Principal | undefined> {
    const token = bearerToken(header);
    return token && isGitHubToken(token) ? this.#github.verify(header) : this.#fallback.verify(header);
  }
}
