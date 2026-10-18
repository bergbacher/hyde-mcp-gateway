// Fetches each app's generated `prisma/redacted/redacted-schema.md` from the
// app repo's main branch into `schemas/<app>.redacted-schema.md`, where the
// server reads it at startup for `describe_schema`. Needs an authenticated `gh`.
//
//   node scripts/fetch-redacted-schemas.ts [shop|crm ...]

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { APPS, type App } from "../src/config.ts";
import { redactedSchemaFile, SCHEMA_DIR } from "../src/schemas.ts";

export const APP_REPOS: Record<App, string> = {
  crm: "example-org/crm",
  shop: "example-org/shop",
};

const SOURCE_PATH = "prisma/redacted/redacted-schema.md";

function fetchSchema(app: App): string {
  return execFileSync(
    "gh",
    ["api", `repos/${APP_REPOS[app]}/contents/${SOURCE_PATH}?ref=main`, "-H", "Accept: application/vnd.github.raw"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

const requested = process.argv.slice(2);
for (const name of requested) {
  if (!(APPS as readonly string[]).includes(name)) throw new Error(`Unknown app ${name} (expected ${APPS.join(", ")})`);
}
const apps = requested.length ? (requested as App[]) : [...APPS];

mkdirSync(SCHEMA_DIR, { recursive: true });
let failed = false;
for (const app of apps) {
  try {
    const file = redactedSchemaFile(app);
    writeFileSync(file, fetchSchema(app));
    console.log(`${app}: ${APP_REPOS[app]}/${SOURCE_PATH} → ${file}`);
  } catch (e) {
    failed = true;
    const stderr = (e as { stderr?: string }).stderr?.trim();
    console.error(`${app}: could not fetch ${APP_REPOS[app]}/${SOURCE_PATH}: ${stderr || (e as Error).message}`);
  }
}
if (failed) process.exitCode = 1;
