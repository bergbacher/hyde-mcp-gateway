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
