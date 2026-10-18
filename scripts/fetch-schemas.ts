// Shared by `pnpm schemas` (scripts/fetch-log-schemas.ts) and
// `pnpm fetch:redacted-schemas` (scripts/fetch-redacted-schemas.ts): downloads
// one kind of per-app file from each app repo through the GitHub API into
// `schemas/`, validating each before it is written (D37).
//
//   [--app shop] [--app crm] [--strict]
//
// `--app` (repeatable) limits the run to those apps; without it every app is
// fetched. Every app whose file fetches and validates is written; every other
// is reported as a warning. Exit 1 when nothing could be written, or with
// `--strict` when any requested app failed; 0 otherwise. Auth: GITHUB_TOKEN,
// else GH_TOKEN, else the token of a logged-in `gh`.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { APPS, type App } from "../src/config.ts";
import { parseAppSchema, redactedSchemaFile, SCHEMA_DIR, SCHEMA_SOURCES, schemaFile } from "../src/schemas.ts";

export interface Source {
  repo: string;
  path: string;
  ref: string;
}

export interface SchemaKind {
  /** The command, for messages: `pnpm schemas`. */
  command: string;
  source(app: App): Source;
  /** The file it is written to. */
  target(app: App, dir: string): string;
  /** Throws when `text` is not a valid file of this kind for `app`. */
  validate(app: App, text: string): void;
}

/** Log field schemas (D23): `prisma/hyde-json.json` → `schemas/<app>.hyde-json.json`. */
export const LOG_SCHEMAS: SchemaKind = {
  command: "pnpm schemas",
  source: (app) => SCHEMA_SOURCES[app],
  target: schemaFile,
  validate(app, text) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${SCHEMA_SOURCES[app].repo}:${SCHEMA_SOURCES[app].path} is not JSON`);
    }
    parseAppSchema(app, json);
  },
};

/** hyde-db's redacted schema: `prisma/redacted/redacted-schema.md` → `schemas/<app>.redacted-schema.md`. */
export const REDACTED_SCHEMAS: SchemaKind = {
  command: "pnpm fetch:redacted-schemas",
  source: (app) => ({ repo: SCHEMA_SOURCES[app].repo, path: "prisma/redacted/redacted-schema.md", ref: "main" }),
  target: redactedSchemaFile,
  validate(app, text) {
    if (text.trim() === "") throw new Error(`${SCHEMA_SOURCES[app].repo}:prisma/redacted/redacted-schema.md is empty`);
  },
};

export interface Args {
  apps: App[];
  strict: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const apps: App[] = [];
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--strict") strict = true;
    else if (arg === "--app" || arg.startsWith("--app=")) {
      const name = arg === "--app" ? argv[++i] : arg.slice("--app=".length);
      if (!name || !(APPS as readonly string[]).includes(name)) {
        throw new Error(`--app needs one of ${APPS.join(", ")}${name ? `, got ${name}` : ""}`);
      }
      if (!apps.includes(name as App)) apps.push(name as App);
    } else throw new Error(`Unknown argument ${arg} (usage: [--app ${APPS.join("|")}]... [--strict])`);
  }
  return { apps: apps.length ? apps : [...APPS], strict };
}

export function githubToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  if (env.GH_TOKEN) return env.GH_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function fetchSource(source: Source, auth: string | undefined, fetchImpl: typeof fetch = fetch): Promise<string> {
  const { repo, path, ref } = source;
  const where = `${repo}@${ref}:${path}`;
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
    headers: {
      accept: "application/vnd.github.raw+json",
      "x-github-api-version": "2022-11-28",
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
  });
  if (res.status === 404) throw new Error(`${where} not found${auth ? "" : " (no GITHUB_TOKEN and no gh login; private repos answer 404)"}`);
  if (!res.ok) throw new Error(`${where}: GitHub answered ${res.status} ${res.statusText}`);
  return res.text();
}

export interface RunOptions extends Args {
  dir?: string;
  auth?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export interface RunResult {
  written: App[];
  failed: { app: App; reason: string }[];
  exitCode: 0 | 1;
}

/** Fetches `apps`, writes each that validates, warns for each that does not. Never throws for one app. */
export async function fetchSchemas(kind: SchemaKind, options: RunOptions): Promise<RunResult> {
  const { apps, strict, dir = SCHEMA_DIR, auth, log = console.log, warn = console.warn } = options;
  const results = await Promise.allSettled(apps.map(async (app) => {
    const text = await fetchSource(kind.source(app), auth, options.fetch);
    kind.validate(app, text);
    return text.endsWith("\n") ? text : `${text}\n`;
  }));
  const written: App[] = [];
  const failed: RunResult["failed"] = [];
  results.forEach((result, i) => {
    const app = apps[i]!;
    if (result.status === "rejected") {
      failed.push({ app, reason: (result.reason as Error).message });
      return;
    }
    mkdirSync(dir, { recursive: true });
    const file = kind.target(app, dir);
    writeFileSync(file, result.value);
    written.push(app);
    const { repo, ref } = kind.source(app);
    log(`${app}: ${repo}@${ref} → ${file}`);
  });
  for (const { app, reason } of failed) warn(`warning: ${app} not written: ${reason}`);
  const exitCode = written.length === 0 || (strict && failed.length > 0) ? 1 : 0;
  if (written.length === 0) warn(`${kind.command}: nothing written.`);
  else if (failed.length > 0) {
    warn(`${kind.command}: ${failed.map((f) => f.app).join(", ")} left out; ${strict ? "--strict fails the run" : "its tools answer that it is not configured (D37)"}.`);
  }
  return { written, failed, exitCode };
}

/** The command line: parse `argv`, run, set the exit code. */
export async function main(kind: SchemaKind, argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`${kind.command}: ${(e as Error).message}`);
    process.exitCode = 2;
    return;
  }
  const { exitCode } = await fetchSchemas(kind, { ...args, auth: githubToken() });
  process.exitCode = exitCode;
}
