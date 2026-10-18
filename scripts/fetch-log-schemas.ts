// `pnpm schemas`: downloads each app's log field schema from its repo's `main`
// branch into `schemas/<app>.hyde-json.json` (D23). Validates all before
// writing any, and exits non-zero naming every app whose schema is missing or
// invalid. Auth: GITHUB_TOKEN, else the token of a logged-in `gh`.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { APPS, type App } from "../src/config.ts";
import { parseAppSchema, SCHEMA_DIR, SCHEMA_SOURCES, schemaFile } from "../src/schemas.ts";

function token(): string | undefined {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function fetchSchema(app: App, auth: string | undefined): Promise<string> {
  const { repo, path, ref } = SCHEMA_SOURCES[app];
  const where = `${repo}@${ref}:${path}`;
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${ref}`, {
    headers: {
      accept: "application/vnd.github.raw+json",
      "x-github-api-version": "2022-11-28",
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
  });
  if (res.status === 404) throw new Error(`${where} not found${auth ? "" : " (no GITHUB_TOKEN and no gh login; private repos answer 404)"}`);
  if (!res.ok) throw new Error(`${where}: GitHub answered ${res.status} ${res.statusText}`);
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${where} is not JSON`);
  }
  parseAppSchema(app, json);
  return text.endsWith("\n") ? text : `${text}\n`;
}

const auth = token();
const results = await Promise.allSettled(APPS.map((app) => fetchSchema(app, auth)));
const failures = results.flatMap((r, i) => (r.status === "rejected" ? [`${APPS[i]}: ${(r.reason as Error).message}`] : []));
if (failures.length > 0) {
  console.error(`pnpm schemas: no schema written.\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
mkdirSync(SCHEMA_DIR, { recursive: true });
results.forEach((r, i) => {
  const app = APPS[i]!;
  writeFileSync(schemaFile(app), (r as PromiseFulfilledResult<string>).value);
  console.log(`${app}: ${SCHEMA_SOURCES[app].repo}@${SCHEMA_SOURCES[app].ref} → ${schemaFile(app)}`);
});
