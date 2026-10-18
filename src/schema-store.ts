// The schema store (D58): each registered app's log field schema and
// redacted schema, read at runtime instead of bundled in the image.
//
// With a read token (APP_REPOS_READ_TOKEN, Contents: read on the app repos)
// `start()` fetches both files of every app in apps.json (`logSchemaPath`,
// `redactedSchemaPath`) from its repository's default branch through the
// GitHub API, then again every HYDE_SCHEMA_REFRESH_SECONDS (default 600).
// Without a token it reads `schemas/<app>.hyde-json.json` and
// `schemas/<app>.redacted-schema.md` instead, as `pnpm schemas` and
// `pnpm fetch:redacted-schemas` wrote them (developer mode), on the same
// schedule.
//
// Each file is validated before it replaces the one held (src/schemas.ts). A
// file that fails to fetch or validate keeps the last good one, and the app
// gets one warn line per refresh naming every reason. An app with no good
// file of a kind is left out of that kind, and its tools answer that it is
// not configured (D37). No app failing ever stops the server.
//
// `logSchemas` and `redactedSchemas` are live maps: the tools read them per
// call, so a refresh changes behaviour without a restart or a deploy.

import { readFile } from "node:fs/promises";
import type { LogSchema } from "hyde-json";
import { describeSource, fetchSource } from "./github.ts";
import { appNames, type App, type AppEntry, type Registry } from "./registry.ts";
import { parseLogSchemaText, parseRedactedSchemaText, redactedSchemaFile, SCHEMA_DIR, schemaFile, type Schemas } from "./schemas.ts";

export const DEFAULT_REFRESH_SECONDS = 600;
/** How long one file fetch may take before it counts as failed. */
export const FETCH_TIMEOUT_MS = 10_000;

export interface SchemaStoreConfig {
  /** APP_REPOS_READ_TOKEN; absent, the store reads local files. */
  token?: string;
  refreshSeconds: number;
}

/** Reads APP_REPOS_READ_TOKEN and HYDE_SCHEMA_REFRESH_SECONDS. Throws when the interval is not a positive whole number. */
export function readSchemaStoreConfig(env: NodeJS.ProcessEnv = process.env): SchemaStoreConfig {
  const token = env.APP_REPOS_READ_TOKEN?.trim() || undefined;
  const raw = env.HYDE_SCHEMA_REFRESH_SECONDS?.trim();
  const refreshSeconds = raw ? Number(raw) : DEFAULT_REFRESH_SECONDS;
  if (!Number.isInteger(refreshSeconds) || refreshSeconds <= 0) {
    throw new Error(`HYDE_SCHEMA_REFRESH_SECONDS is not a positive whole number of seconds: ${raw}`);
  }
  return { ...(token ? { token } : {}), refreshSeconds };
}

export interface SchemaStoreOptions extends Partial<SchemaStoreConfig> {
  registry: Registry;
  /** The GitHub API's fetch, for tests. */
  fetch?: typeof fetch;
  /** Where local files are read without a token; defaults to `schemas/`. */
  dir?: string;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/** One app's schemas as the store holds them; a kind not loaded is absent. */
export interface AppSchemas {
  log?: LogSchema;
  redacted?: string;
}

type Kind = "log" | "redacted";
const KINDS: readonly Kind[] = ["log", "redacted"];

/** A file's text, or undefined when a local file does not exist. Throws with the reason when it cannot be read. */
type Read = (app: App, entry: AppEntry, kind: Kind) => Promise<string | undefined>;

export class SchemaStore {
  readonly mode: "github" | "local";
  readonly refreshSeconds: number;
  readonly #logSchemas = new Map<App, LogSchema>();
  readonly #redactedSchemas = new Map<App, string>();
  /** The text each held file was parsed from, to tell a change from a refresh that found the same file. */
  readonly #texts = new Map<string, string>();
  readonly #registry: Registry;
  readonly #dir: string;
  readonly #read: Read;
  readonly #log: (line: string) => void;
  readonly #warn: (line: string) => void;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;

  constructor(options: SchemaStoreOptions) {
    const { registry, token, fetch: fetchImpl = fetch, dir = SCHEMA_DIR } = options;
    this.#registry = registry;
    this.#dir = dir;
    this.refreshSeconds = options.refreshSeconds ?? DEFAULT_REFRESH_SECONDS;
    this.#log = options.log ?? console.log;
    this.#warn = options.warn ?? console.warn;
    this.mode = token ? "github" : "local";
    this.#read = token
      ? (_app, entry, kind) => fetchSource(
        { repo: entry.repo, path: kind === "log" ? entry.logSchemaPath : entry.redactedSchemaPath },
        token,
        fetchImpl,
        AbortSignal.timeout(FETCH_TIMEOUT_MS),
      )
      : async (app, _entry, kind) => {
        const file = kind === "log" ? schemaFile(app, dir) : redactedSchemaFile(app, dir);
        try {
          return await readFile(file, "utf8");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw new Error(`${file}: ${(e as Error).message}`);
        }
      };
  }

  /** The log schemas held, live (D37: an app left out is refused at the log tools). */
  get logSchemas(): Schemas {
    return this.#logSchemas;
  }

  /** The redacted schemas held, live (an app left out is refused at describe_schema and query_sql). */
  get redactedSchemas(): ReadonlyMap<App, string> {
    return this.#redactedSchemas;
  }

  /** What the store holds for `app`; undefined when it holds neither file. */
  get(app: App): AppSchemas | undefined {
    const log = this.#logSchemas.get(app);
    const redacted = this.#redactedSchemas.get(app);
    if (!log && redacted === undefined) return undefined;
    return { ...(log ? { log } : {}), ...(redacted !== undefined ? { redacted } : {}) };
  }

  /** Loads every app once, then schedules the refresh. Never throws for an app. */
  async start(): Promise<void> {
    await this.refresh();
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.refresh(), this.refreshSeconds * 1000);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Re-reads every app's files; a refresh already running is joined, not doubled. */
  refresh(): Promise<void> {
    this.#running ??= this.#refreshAll().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #refreshAll(): Promise<void> {
    await Promise.all(appNames(this.#registry).map((app) => this.#refreshApp(app)));
  }

  /** Where a file is read from, for messages. */
  #where(app: App, entry: AppEntry, kind: Kind): string {
    if (this.mode === "local") return kind === "log" ? schemaFile(app, this.#dir) : redactedSchemaFile(app, this.#dir);
    return describeSource({ repo: entry.repo, path: kind === "log" ? entry.logSchemaPath : entry.redactedSchemaPath });
  }

  async #refreshApp(app: App): Promise<void> {
    const entry = this.#registry.apps.get(app)!;
    // Per kind, in KINDS order: "changed", "same" (or absent locally), or the reason it failed.
    const outcomes = await Promise.all(KINDS.map(async (kind): Promise<{ failed: string } | "changed" | "same"> => {
      let text: string | undefined;
      try {
        text = await this.#read(app, entry, kind);
        if (text === undefined || this.#texts.get(`${app}:${kind}`) === text) return "same";
        if (kind === "log") this.#logSchemas.set(app, parseLogSchemaText(app, text));
        else this.#redactedSchemas.set(app, parseRedactedSchemaText(text));
        this.#texts.set(`${app}:${kind}`, text);
        return "changed";
      } catch (e) {
        const message = (e as Error).message;
        // A read error names its source already; a validation error does not.
        return { failed: text === undefined ? message : `${this.#where(app, entry, kind)}: ${message}` };
      }
    }));
    const changed = KINDS.filter((_, i) => outcomes[i] === "changed");
    const reasons = outcomes.flatMap((o) => (typeof o === "object" ? [o.failed] : []));
    if (changed.length > 0) {
      const schema = this.#logSchemas.get(app);
      this.#log(JSON.stringify({
        level: "info",
        message: `${app}: schemas loaded (${changed.join(", ")})`,
        app,
        source: this.mode,
        ...(schema ? { logFields: Object.keys(schema.fields).length } : {}),
        redacted: this.#redactedSchemas.has(app),
      }));
    }
    if (reasons.length > 0) {
      const kept = KINDS.filter((kind) => this.#texts.has(`${app}:${kind}`));
      this.#warn(JSON.stringify({
        level: "warn",
        message: `${app}: schemas not refreshed: ${reasons.join("; ")}${kept.length ? `; keeping the last good ${kept.join(", ")}` : ""}`,
        app,
        reasons,
      }));
    }
  }
}
