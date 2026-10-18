// The per-app runtime variables are derived from apps.json (D38): loadConfig
// appends them, apply sends the apps apply.env holds values for, and diff
// expects an app's whole group once any of it is live.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectMissing, configuredApps, runApply } from "../../scripts/infra/apply.ts";
import { appVariableSpecs, loadConfig, type InfraConfig, type KindContext } from "../../scripts/infra/config.ts";
import * as container from "../../scripts/infra/kinds/container.ts";
import { parseRegistry } from "../../src/registry.ts";
import { registryJsonWithThirdApp, REGISTRY_WITH_THIRD } from "../helpers.ts";
import { LIVE, config, makeExec } from "./fixtures.ts";

const root = path.resolve(import.meta.dirname, "..", "..");

/** loadConfig over the committed infra/ with `registry` as apps.json. */
function load(registry: string, base?: string): InfraConfig {
  return loadConfig("production", {
    repoRoot: root,
    readFileSync: (p) => {
      if (p === path.join(root, "apps.json")) return registry;
      if (base !== undefined && p === path.join(root, "infra", "base.yaml")) return base;
      return fs.readFileSync(p, "utf8");
    },
  });
}

/** The fixture config plus the per-app variables of the registry with a third app. */
function withApps(): InfraConfig {
  return config({}, [...config().variables, ...appVariableSpecs(REGISTRY_WITH_THIRD)]);
}

const TOKENS = { HYDE_TOKEN_AGENT: "t".repeat(32), COCKPIT_LOGS_READ_TOKEN: "cockpit-secret" };

describe("loadConfig derives each app's variables from apps.json", () => {
  it("a third app adds its two secrets, optional, with no change to infra/", () => {
    const c = load(JSON.stringify(registryJsonWithThirdApp()));
    expect(c.variables.filter((v) => v.app === "help-desk")).toEqual([
      { name: "HYDE_APP_HELP_DESK_REDACTED_URL", required: false, secret: true, app: "help-desk" },
      { name: "HYDE_APP_HELP_DESK_DATABASE_CA", required: false, secret: true, app: "help-desk" },
    ]);
    // The global ones stay as infra/base.yaml lists them.
    expect(c.variables.filter((v) => !v.app).map((v) => v.name)).toEqual(loadConfig("production").variables.filter((v) => !v.app).map((v) => v.name));
  });

  it("refuses an invalid registry and a per-app variable listed by hand", () => {
    expect(() => load("{")).toThrow(/apps\.json is not JSON/);
    expect(() => load(JSON.stringify({ apps: { Bad: {} } }))).toThrow(/not a valid app registry/);
    const base = fs.readFileSync(path.join(root, "infra", "base.yaml"), "utf8")
      + "  - { name: HYDE_APP_SHOP_REDACTED_URL, required: true, secret: true }\n";
    expect(() => load(fs.readFileSync(path.join(root, "apps.json"), "utf8"), base)).toThrow(/derived from apps\.json, never listed by hand/);
  });

  it("appVariableSpecs follows the registry's order and prefix", () => {
    const one = parseRegistry({ apps: { "a-b": registryJsonWithThirdApp().apps["help-desk"] } });
    expect(appVariableSpecs(one).map((v) => v.name)).toEqual(["HYDE_APP_A_B_REDACTED_URL", "HYDE_APP_A_B_DATABASE_CA"]);
  });
});

describe("apply with the apps apply.env holds values for", () => {
  it("an app with no values is left out; the global variables are still required", () => {
    const c = withApps();
    expect(collectMissing(c, TOKENS, false)).toEqual([]);
    expect(configuredApps(c, TOKENS)).toEqual([]);
    expect(collectMissing(c, {}, false)).toEqual(["HYDE_TOKEN_AGENT", "COCKPIT_LOGS_READ_TOKEN"]);
  });

  it("an app with one of its values needs the other", () => {
    const c = withApps();
    const env = { ...TOKENS, HYDE_APP_SHOP_REDACTED_URL: "mysql://r:x@h/redacted?ssl=true" };
    expect(configuredApps(c, env)).toEqual(["shop"]);
    expect(collectMissing(c, env, false)).toEqual(["HYDE_APP_SHOP_DATABASE_CA"]);
    expect(collectMissing(c, env, true)).toEqual(["HYDE_IMAGE_TAG"]);
  });

  it("sends the configured apps' values as secrets, and nothing of the others", () => {
    const c = withApps();
    const exec = makeExec([{ id: LIVE.id }]);
    const env = {
      ...TOKENS,
      HYDE_APP_HELP_DESK_REDACTED_URL: "mysql://r:x@h/redacted?ssl=true",
      HYDE_APP_HELP_DESK_DATABASE_CA: "PEM",
    };
    expect(runApply(c, exec, env, { sleep: () => {} })).toMatchObject({ ok: true });
    const update = exec.mock.calls.map(([a]) => a).find((a) => a.includes("update"))!;
    expect(update).toEqual(expect.arrayContaining([
      "secret-environment-variables.HYDE_APP_HELP_DESK_REDACTED_URL=mysql://r:x@h/redacted?ssl=true",
      "secret-environment-variables.HYDE_APP_HELP_DESK_DATABASE_CA=PEM",
    ]));
    expect(update.some((a) => /HYDE_APP_(SHOP|CRM)_/.test(a))).toBe(false);
  });
});

describe("diff --strict against the derived list", () => {
  const ctx = (): KindContext => ({ exec: makeExec([]), config: withApps() });
  const secrets = (extra: Record<string, string>) => ({ ...LIVE, secret_environment_variables: { ...LIVE.secret_environment_variables, ...extra } });

  it("an app configured whole, or not at all, is no drift", () => {
    expect(container.diff(ctx(), LIVE)).toEqual([]);
    expect(container.diff(ctx(), secrets({ HYDE_APP_SHOP_REDACTED_URL: "$d", HYDE_APP_SHOP_DATABASE_CA: "$d" }))).toEqual([]);
  });

  it("an app with only one of its variables live is drift", () => {
    const entries = container.diff(ctx(), secrets({ HYDE_APP_SHOP_REDACTED_URL: "$d" }));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ field: "secret-environment-variables", status: "divergent" });
    expect(entries[0]!.desired).toContain("HYDE_APP_SHOP_DATABASE_CA");
  });

  it("a live variable of an app no longer in apps.json is drift", () => {
    expect(container.diff(ctx(), secrets({ HYDE_APP_GONE_REDACTED_URL: "$d" }))).toHaveLength(1);
  });
});
