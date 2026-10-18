// Configuration from the environment. Client tokens are `HYDE_TOKEN_<CLIENT>`,
// one per client (D16); the client name is the suffix, lower-cased. Each token
// needs its app scope in `HYDE_TOKEN_<CLIENT>_APPS` (D39, src/mcp/auth.ts),
// checked against the registry. Each registered app (src/registry.ts, D38) reads its secrets under
// `HYDE_APP_<NAME>_`: `REDACTED_URL` for its redacted database and
// `DATABASE_CA` for TLS (src/db/connection.ts); `CERT_NAME` and `LOKI_STREAM`
// override the registry's values. Each app's URL is optional: an app without
// one answers its database tools that it is not configured (D37). In
// production an app with a URL needs `ssl=true` and its CA. GitHub tokens
// (D59, src/mcp/github-auth.ts) need no variable; their resolved scope is
// cached for `HYDE_GITHUB_SCOPE_TTL_SECONDS` (default 300).

import { resolveDatabase, type DatabaseConfig } from "./db/connection.ts";
import { readClientTokens, type Principal } from "./mcp/auth.ts";
import { DEFAULT_SCOPE_TTL_SECONDS } from "./mcp/github-auth.ts";
import { appVariables, STREAM_SELECTOR, type App, type Registry } from "./registry.ts";

export interface Config {
  port: number;
  /** token → client name and app scope (src/mcp/auth.ts readClientTokens, D39) */
  clients: ReadonlyMap<string, Principal>;
  /** The apps whose URL is set; the others are left out (D37). */
  databases: ReadonlyMap<App, DatabaseConfig>;
  /** How long a GitHub token's resolved scope is reused (D59); 0 asks GitHub on every request. */
  githubScopeTtlSeconds: number;
}

export function readConfig(registry: Registry, env: NodeJS.ProcessEnv = process.env): Config {
  const clients = readClientTokens(registry, env);
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT is not a port: ${env.PORT}`);
  const rawTtl = env.HYDE_GITHUB_SCOPE_TTL_SECONDS?.trim();
  const githubScopeTtlSeconds = rawTtl ? Number(rawTtl) : DEFAULT_SCOPE_TTL_SECONDS;
  if (!/^\d+$/.test(rawTtl ?? "0") || !Number.isSafeInteger(githubScopeTtlSeconds)) {
    throw new Error(`HYDE_GITHUB_SCOPE_TTL_SECONDS is not a whole number of seconds: ${rawTtl}`);
  }
  return { port, clients, databases: readDatabases(registry, env), githubScopeTtlSeconds };
}

function readDatabases(registry: Registry, env: NodeJS.ProcessEnv): Map<App, DatabaseConfig> {
  const production = env.NODE_ENV === "production";
  const databases = new Map<App, DatabaseConfig>();
  for (const entry of registry.apps.values()) {
    const vars = appVariables(entry.name);
    const url = env[vars.redactedUrl];
    if (!url) continue;
    databases.set(entry.name, resolveDatabase({
      name: vars.redactedUrl,
      url,
      ca: env[vars.databaseCa] || undefined,
      caName: vars.databaseCa,
      certName: env[vars.certName]?.trim() || entry.database.certName,
      production,
    }));
  }
  return databases;
}

// Loki (D14, D20): the Cockpit logs data source and its `read_only_logs` token.
// The apps share the data source (A10); an app's lines are selected by its
// stream selector, then by the `service` field its log() writes.

/** Where one app's lines are: its stream selector and its `service` value, and its edge stream when it has one (D46). */
export interface LogSource {
  stream: string;
  service: string;
  /** The stream selector of the app's Edge Services access logs; absent when the registry declares no `edge`. */
  edgeStream?: string;
}

export interface LokiConfig {
  /** Data source URL without trailing slash, e.g. `https://<id>.logs.cockpit.fr-par.scw.cloud`. */
  url: string;
  token: string;
  /** app → stream selector and service, for every registered app */
  sources: ReadonlyMap<App, LogSource>;
}

/** The registry's stream and service per app, without overrides. */
export function logSources(registry: Registry): Map<App, LogSource> {
  return new Map([...registry.apps.values()].map((e) => [e.name, {
    stream: e.loki.stream,
    service: e.loki.service,
    ...(e.edge ? { edgeStream: e.edge.stream } : {}),
  }]));
}

/** Reads `COCKPIT_LOGS_URL`, `COCKPIT_LOGS_READ_TOKEN` and each app's `LOKI_STREAM` override. Throws naming each problem. */
export function readLokiConfig(registry: Registry, env: NodeJS.ProcessEnv = process.env): LokiConfig {
  const problems: string[] = [];
  let url = "";
  const rawUrl = env.COCKPIT_LOGS_URL;
  if (!rawUrl) problems.push("COCKPIT_LOGS_URL is not set");
  else if (!/^https?:\/\/[^/?#\s]+(\/[^?#\s]*)?$/.test(rawUrl)) problems.push("COCKPIT_LOGS_URL is not an http(s) URL");
  else url = rawUrl.replace(/\/+$/, "");
  const token = env.COCKPIT_LOGS_READ_TOKEN ?? "";
  if (!token) problems.push("COCKPIT_LOGS_READ_TOKEN is not set");
  const sources = logSources(registry);
  for (const [app, source] of sources) {
    const key = appVariables(app).lokiStream;
    const override = env[key]?.trim();
    if (!override) continue;
    if (!STREAM_SELECTOR.test(override)) problems.push(`${key} is not a LogQL stream selector ({label="value", …})`);
    source.stream = override;
  }
  if (problems.length > 0) throw new Error(`Loki not configured: ${problems.join("; ")}`);
  return { url, token, sources };
}
