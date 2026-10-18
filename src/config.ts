// Configuration from the environment. Client tokens are `HYDE_TOKEN_<CLIENT>`,
// one per client (D16); the client name is the suffix, lower-cased.

export const APPS = ["shop", "crm"] as const;
export type App = (typeof APPS)[number];

export interface Config {
  port: number;
  /** token → client name */
  clients: Map<string, string>;
}

const TOKEN_PREFIX = "HYDE_TOKEN_";

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const clients = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(TOKEN_PREFIX) || !value) continue;
    const name = key.slice(TOKEN_PREFIX.length).toLowerCase().replaceAll("_", "-");
    if (value.length < 32) throw new Error(`${key} is shorter than 32 characters`);
    if (clients.has(value)) throw new Error(`${key} repeats another client's token`);
    clients.set(value, name);
  }
  if (clients.size === 0) throw new Error(`No client token set (${TOKEN_PREFIX}<CLIENT>)`);
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT is not a port: ${env.PORT}`);
  return { port, clients };
}

// Loki (D14, D20): the Cockpit logs data source and its `read_only_logs` token.
// Both apps share the data source (A10); an app's lines are selected by its
// stream selector, then by the `service` field its log() writes.

/** The `service` field each app's log() writes (crm lib/logging.ts, shop lib/log.ts). */
export const SERVICES: Readonly<Record<App, string>> = { shop: "shop", crm: "crm" };

/** The container's stream, `<container resource name>` (crm docs/operations.md, Logging). */
export const DEFAULT_STREAMS: Readonly<Record<App, string>> = {
  shop: '{resource_name="example-shop-prod"}',
  crm: '{resource_name="example-crm-prod"}',
};

export interface LokiConfig {
  /** Data source URL without trailing slash, e.g. `https://<id>.logs.cockpit.fr-par.scw.cloud`. */
  url: string;
  token: string;
  /** app → LogQL stream selector */
  streams: Readonly<Record<App, string>>;
}

const SELECTOR = /^\{[^{}|`]+\}$/;

/** Reads `COCKPIT_LOGS_URL`, `COCKPIT_LOGS_READ_TOKEN` and `LOKI_STREAM_<APP>`. Throws naming each problem. */
export function readLokiConfig(env: NodeJS.ProcessEnv = process.env): LokiConfig {
  const problems: string[] = [];
  let url = "";
  const rawUrl = env.COCKPIT_LOGS_URL;
  if (!rawUrl) problems.push("COCKPIT_LOGS_URL is not set");
  else if (!/^https?:\/\/[^/?#\s]+(\/[^?#\s]*)?$/.test(rawUrl)) problems.push("COCKPIT_LOGS_URL is not an http(s) URL");
  else url = rawUrl.replace(/\/+$/, "");
  const token = env.COCKPIT_LOGS_READ_TOKEN ?? "";
  if (!token) problems.push("COCKPIT_LOGS_READ_TOKEN is not set");
  const streams = {} as Record<App, string>;
  for (const app of APPS) {
    const key = `LOKI_STREAM_${app.toUpperCase()}`;
    const selector = env[key]?.trim() || DEFAULT_STREAMS[app];
    if (!SELECTOR.test(selector)) problems.push(`${key} is not a LogQL stream selector ({label="value", …})`);
    streams[app] = selector;
  }
  if (problems.length > 0) throw new Error(`Loki not configured: ${problems.join("; ")}`);
  return { url, token, streams: Object.freeze(streams) };
}
