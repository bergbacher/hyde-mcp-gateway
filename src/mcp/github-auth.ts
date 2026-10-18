// GitHub tokens as client credentials (D59). The client sends a GitHub token
// it already holds (`gh auth token`, a fine-grained PAT); the gateway asks
// GitHub, as that token, who it is (`GET /user`) and which registered apps'
// repositories it can read (`GET /repos/{owner}/{repo}`, 200 = readable). The
// principal is `gh:<login>` with those apps; a token that reads none of them
// is still a principal, with an empty scope, so every tool refuses it as
// unauthorized. GitHub's 401 means the token is not accepted (HTTP 401 here);
// anything else GitHub cannot answer is a `VerificationUnavailableError`,
// never a refusal, so an outage never shrinks a scope that is then cached.
// Results are cached by the token's SHA-256, never the token itself.

import { createHash } from "node:crypto";
import type { App, Registry } from "../registry.ts";
import { bearerToken, isGitHubToken, VerificationUnavailableError, type Principal, type TokenVerifier } from "./auth.ts";

export const GITHUB_API = "https://api.github.com";
export const DEFAULT_SCOPE_TTL_SECONDS = 300;

export interface GitHubVerifierOptions {
  registry: Registry;
  /** How long a resolved principal is reused, in seconds; 0 checks GitHub on every request. */
  ttlSeconds?: number;
  fetch?: typeof globalThis.fetch;
  /** Clock in ms, for tests. */
  now?: () => number;
  timeoutMs?: number;
}

/** What one GitHub request said: the token is refused, the resource is (not) there, or GitHub could not answer. */
type Answer = { status: "ok"; body: unknown } | { status: "unauthorized" } | { status: "absent" };

export class GitHubTokenVerifier implements TokenVerifier {
  readonly #repos: ReadonlyMap<string, App[]>;
  readonly #ttlMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  /** SHA-256 of the token → the pending or resolved principal and when it expires. */
  readonly #cache = new Map<string, { principal: Promise<Principal | undefined>; expires: number }>();

  constructor({ registry, ttlSeconds = DEFAULT_SCOPE_TTL_SECONDS, fetch = globalThis.fetch, now = Date.now, timeoutMs = 10_000 }: GitHubVerifierOptions) {
    // Apps sharing a repository cost one request.
    const repos = new Map<string, App[]>();
    for (const entry of registry.apps.values()) repos.set(entry.repo, [...(repos.get(entry.repo) ?? []), entry.name]);
    this.#repos = repos;
    this.#ttlMs = ttlSeconds * 1000;
    this.#fetch = fetch;
    this.#now = now;
    this.#timeoutMs = timeoutMs;
  }

  verify(header: string | undefined): Promise<Principal | undefined> {
    const token = bearerToken(header);
    if (!token || !isGitHubToken(token)) return Promise.resolve(undefined);
    const key = createHash("sha256").update(token).digest("hex");
    const now = this.#now();
    const cached = this.#cache.get(key);
    if (cached && cached.expires > now) return cached.principal;
    this.#prune(now);
    const principal = this.#resolve(token);
    // Concurrent requests with one token share the lookup; only a principal is kept.
    this.#cache.set(key, { principal, expires: now + this.#ttlMs });
    principal.then(
      (p) => { if (!p) this.#cache.delete(key); },
      () => this.#cache.delete(key),
    );
    return principal;
  }

  async #resolve(token: string): Promise<Principal | undefined> {
    const user = await this.#get(token, "/user", "user");
    if (user.status !== "ok") return undefined;
    const login = (user.body as { login?: unknown } | null)?.login;
    if (typeof login !== "string" || login === "") throw new VerificationUnavailableError("GitHub answered /user without a login");
    const readable = await Promise.all([...this.#repos].map(async ([repo, apps]) => {
      const answer = await this.#get(token, `/repos/${repo}`, "repo");
      if (answer.status === "unauthorized") return undefined;
      return answer.status === "ok" ? apps : [];
    }));
    // A token revoked between the two requests is refused, not given an empty scope.
    if (readable.some((apps) => apps === undefined)) return undefined;
    return { client: `gh:${login}`, apps: new Set(readable.flat() as App[]) };
  }

  async #get(token: string, path: string, kind: "user" | "repo"): Promise<Answer> {
    let res: Response;
    try {
      res = await this.#fetch(`${GITHUB_API}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "hyde-mcp-gateway",
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (e) {
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      throw new VerificationUnavailableError(timedOut ? `GitHub did not answer within ${this.#timeoutMs / 1000}s` : "GitHub is unreachable");
    }
    if (res.status === 200) {
      try {
        return { status: "ok", body: await res.json() };
      } catch {
        throw new VerificationUnavailableError("GitHub answered with a body that is not JSON");
      }
    }
    await res.body?.cancel();
    if (res.status === 401) return { status: "unauthorized" };
    if (res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")))) {
      throw new VerificationUnavailableError("GitHub rate limit reached");
    }
    // /user refused (an installation token has no user; SSO not authorized): no login, no principal.
    if (kind === "user" && res.status === 403) return { status: "unauthorized" };
    // A repository the token cannot see is 404; one an organisation policy (SSO, IP allow list) hides is 403.
    if (kind === "repo" && (res.status === 404 || res.status === 403)) return { status: "absent" };
    throw new VerificationUnavailableError(`GitHub answered HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
  }

  #prune(now: number) {
    for (const [key, entry] of this.#cache) if (entry.expires <= now) this.#cache.delete(key);
  }
}
