// Configuration from the environment. Client tokens are `HYDE_TOKEN_<CLIENT>`,
// one per client (D16); the client name is the suffix, lower-cased. Each token
// needs its app scope in `HYDE_TOKEN_<CLIENT>_APPS` (D39, src/mcp/auth.ts),
// checked against the registry. Each registered app (src/registry.ts, D38)
// reads its secrets under `HYDE_APP_<NAME>_`: `REDACTED_URL` for its redacted
// database and `DATABASE_CA` for TLS (src/db/connection.ts); `CERT_NAME`
// overrides the registry's value (`LOKI_STREAM` is read by the log sources,
// src/sources/). Each app's URL is optional: an app without one answers its
// database tools that it is not configured (D37). In production an app with a
// URL needs `ssl=true` and its CA.

import { resolveDatabase, type DatabaseConfig } from "./db/connection.ts";
import { readClientTokens, type Principal } from "./mcp/auth.ts";
import { appVariables, type App, type Registry } from "./registry.ts";

export interface Config {
  port: number;
  /** token → client name and app scope (src/mcp/auth.ts readClientTokens, D39) */
  clients: ReadonlyMap<string, Principal>;
  /** The apps whose URL is set; the others are left out (D37). */
  databases: ReadonlyMap<App, DatabaseConfig>;
}

export function readConfig(registry: Registry, env: NodeJS.ProcessEnv = process.env): Config {
  const clients = readClientTokens(registry, env);
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT is not a port: ${env.PORT}`);
  return { port, clients, databases: readDatabases(registry, env) };
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
// The apps share the data source (A10); which stream each app's sources read
// is the log sources module's (src/sources/index.ts).

export interface LokiConfig {
  /** Data source URL without trailing slash, e.g. `https://<id>.logs.cockpit.fr-par.scw.cloud`. */
  url: string;
  token: string;
}

/** Reads `COCKPIT_LOGS_URL` and `COCKPIT_LOGS_READ_TOKEN`. Throws naming each problem. */
export function readLokiConfig(env: NodeJS.ProcessEnv = process.env): LokiConfig {
  const problems: string[] = [];
  let url = "";
  const rawUrl = env.COCKPIT_LOGS_URL;
  if (!rawUrl) problems.push("COCKPIT_LOGS_URL is not set");
  else if (!/^https?:\/\/[^/?#\s]+(\/[^?#\s]*)?$/.test(rawUrl)) problems.push("COCKPIT_LOGS_URL is not an http(s) URL");
  else url = rawUrl.replace(/\/+$/, "");
  const token = env.COCKPIT_LOGS_READ_TOKEN ?? "";
  if (!token) problems.push("COCKPIT_LOGS_READ_TOKEN is not set");
  if (problems.length > 0) throw new Error(`Loki not configured: ${problems.join("; ")}`);
  return { url, token };
}
