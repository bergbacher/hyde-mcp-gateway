// The app registry for shell scripts (scripts/wizard/*.sh): validates
// apps.json with src/registry.ts and prints what the script asks for, one
// value per line.
//
//   node scripts/registry.ts names                     every registered app, in order
//   node scripts/registry.ts get <app> <field>...      e.g. get shop repo database.host
//   node scripts/registry.ts env <app> <variable>      e.g. env shop redactedUrl → HYDE_APP_SHOP_REDACTED_URL
//
// HYDE_APPS_FILE points at another registry (tests). Exit 2 on an unknown
// app, field or command; 1 on an invalid registry.

import { appNames, appVariables, loadRegistry, REGISTRY_FILE, unknownApp, type Registry } from "../src/registry.ts";

export function query(registry: Registry, argv: readonly string[]): string[] {
  const [command, app, ...fields] = argv;
  if (command === "names" && app === undefined) return appNames(registry);
  if (command !== "get" && command !== "env") throw new UsageError(`unknown command ${command ?? "(none)"}: names | get <app> <field>... | env <app> <variable>`);
  if (!app) throw new UsageError(`${command} needs an app`);
  const entry = registry.apps.get(app);
  if (!entry) throw new UsageError(unknownApp(app, registry));
  if (fields.length === 0) throw new UsageError(`${command} needs at least one field`);
  if (command === "env") {
    const vars = appVariables(app) as Record<string, string>;
    return fields.map((f) => {
      if (!Object.hasOwn(vars, f)) throw new UsageError(`unknown variable ${f}; one of ${Object.keys(vars).join(", ")}`);
      return vars[f]!;
    });
  }
  return fields.map((field) => {
    let value: unknown = entry;
    for (const key of field.split(".")) {
      value = value !== null && typeof value === "object" && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
    }
    if (typeof value !== "string" && typeof value !== "number") throw new UsageError(`${app} has no field ${field}`);
    return String(value);
  });
}

export class UsageError extends Error {}

if (import.meta.main) {
  try {
    const registry = loadRegistry(process.env.HYDE_APPS_FILE || REGISTRY_FILE);
    for (const line of query(registry, process.argv.slice(2))) console.log(line);
  } catch (e) {
    console.error(`registry: ${(e as Error).message}`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}
