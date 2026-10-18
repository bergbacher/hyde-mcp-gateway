// The app registry (D38): apps are configuration, not code. `apps.json` at the
// repository root, free of secrets but the operator's own (gitignored; copy
// `apps.example.json` to start), holds one entry per app:
// where its log field schema, redacted schema and hyde-db scripts live, its
// Loki stream selector and `service` value, and its database endpoint with the
// certificate name and the source of its instance CA, and optionally a second
// Loki source, its Edge Services access logs (`edge`, D46). Each app's secrets come
// from the environment under `HYDE_APP_<NAME>_` (appVariables). Everything
// that once named an app (the server, the fetch scripts, the wizard, infra/)
// reads this file instead, so adding an app changes no code.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** An app is a name registered in apps.json. */
export type App = string;

export const REGISTRY_FILE = fileURLToPath(new URL("../apps.json", import.meta.url));
/** The committed example registry: two apps, `shop` and `crm`, with placeholder hosts and ids. */
export const EXAMPLE_REGISTRY_FILE = fileURLToPath(new URL("../apps.example.json", import.meta.url));

/** Lower case, starts with a letter; digits and `-` after. Upper-cased with `-` → `_` it is the env infix. */
export const APP_NAME = /^[a-z][a-z0-9-]*$/;
/** A LogQL stream selector and nothing else: no pipeline, no second selector. */
export const STREAM_SELECTOR = /^\{[^{}|`]+\}$/;
/** Not app names: `schemas/edge.hyde-json.json` is the committed edge schema (D46), not an app's. */
export const RESERVED_APP_NAMES: readonly string[] = ["edge"];

const repo = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "must be <owner>/<repo>");
const repoPath = z.string().regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/, "must be a relative path inside the repo");
const nonEmpty = z.string().trim().min(1, "must not be empty");
const streamSelector = z.string().regex(STREAM_SELECTOR, 'must be a LogQL stream selector ({label="value", …})');

const entrySchema = z.strictObject({
  repo,
  logSchemaPath: repoPath,
  redactedSchemaPath: repoPath,
  /** The directory holding hyde-db's redacted-views.sql and redacted-views-drop.sql. */
  redactedSqlPath: repoPath,
  loki: z.strictObject({
    stream: streamSelector,
    /** The `service` field the app's log() writes. */
    service: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "must be a service name"),
  }),
  /**
   * Optional: the app's Scaleway Edge Services access logs (D46), plain JSON
   * lines without the app envelope, redacted by hyde-mcp-gateway's own
   * `schemas/edge.hyde-json.json`. `source: "edge"` on the log tools reads it.
   */
  edge: z.strictObject({ stream: streamSelector }).optional(),
  database: z.strictObject({
    /** The endpoint's DNS name; TLS needs a name, not an address. */
    host: z.string().regex(/^(?=.*[A-Za-z])[A-Za-z0-9.-]+$/, "must be a DNS name"),
    port: z.number().int().min(1).max(65535),
    /** The database the hyde-db views read from. */
    sourceDatabase: nonEmpty,
    /** The name the instance certificate carries, checked instead of the host. */
    certName: nonEmpty,
    caSource: z.strictObject({ repo, path: repoPath, ref: nonEmpty }),
  }),
});

const registrySchema = z.strictObject({
  apps: z.record(z.string(), entrySchema).superRefine((apps, ctx) => {
    if (Object.keys(apps).length === 0) ctx.addIssue({ code: "custom", message: "registers no app" });
    for (const name of Object.keys(apps)) {
      if (!APP_NAME.test(name)) ctx.addIssue({ code: "custom", path: [name], message: "app name must match ^[a-z][a-z0-9-]*$" });
      if (RESERVED_APP_NAMES.includes(name)) ctx.addIssue({ code: "custom", path: [name], message: `app name ${name} is reserved` });
    }
  }),
});

export type AppEntry = z.infer<typeof entrySchema> & { name: App };

export interface Registry {
  /** name → entry, in the order apps.json lists them. */
  apps: ReadonlyMap<App, AppEntry>;
}

/** Validates a parsed apps.json. Throws naming every problem with its path. */
export function parseRegistry(json: unknown, source = "apps.json"): Registry {
  const result = registrySchema.safeParse(json);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
    throw new Error(`${source} is not a valid app registry:\n  ${problems.join("\n  ")}`);
  }
  const apps = new Map<App, AppEntry>();
  for (const [name, entry] of Object.entries(result.data.apps)) apps.set(name, { ...entry, name });
  return { apps };
}

export function loadRegistry(path: string = REGISTRY_FILE): Registry {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(missingRegistry(path));
    throw new Error(`App registry ${path} not readable: ${(e as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`App registry ${path} is not JSON`);
  }
  return parseRegistry(json, path);
}

/** The error for a registry file that does not exist: apps.json is an operator file, not committed. */
export function missingRegistry(path: string): string {
  return `App registry ${path} is missing: copy apps.example.json to apps.json and register your apps (README, Operator files)`;
}

export function appNames(registry: Registry): App[] {
  return [...registry.apps.keys()];
}

/** The tool error text for a name the registry does not hold. */
export function unknownApp(name: string, registry: Registry): string {
  return `unknown app ${name}; registered: ${appNames(registry).join(", ")}`;
}

/** `HYDE_APP_<NAME>_`: the name upper-cased, `-` → `_`. Names hold no `_`, so no two apps share a prefix. */
export function envPrefix(app: App): string {
  return `HYDE_APP_${app.toUpperCase().replaceAll("-", "_")}_`;
}

/** The environment variables one app reads. */
export function appVariables(app: App) {
  const prefix = envPrefix(app);
  return {
    /** The redacted reader's connection string. Secret. */
    redactedUrl: `${prefix}REDACTED_URL`,
    /** The instance CA, PEM text. Secret. */
    databaseCa: `${prefix}DATABASE_CA`,
    /** Optional: overrides the registry's `loki.stream`. */
    lokiStream: `${prefix}LOKI_STREAM`,
    /** Optional: overrides the registry's `database.certName`. */
    certName: `${prefix}CERT_NAME`,
  };
}
