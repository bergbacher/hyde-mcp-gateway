// The committed files agree with each other and with the server.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appVariableSpecs, loadConfig } from "../../scripts/infra/config.ts";
import { appNames, appVariables, loadRegistry } from "../../src/registry.ts";

const root = path.resolve(import.meta.dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("committed infra/", () => {
  const config = loadConfig("production");

  it("declares hyde-mcp-gateway in the apps' namespace, fr-par, scale to zero, probes on /health", () => {
    expect(config.region).toBe("fr-par");
    expect(config.container).toMatchObject({
      name: "hyde-mcp-gateway",
      image: `${config.registryEndpoint}/hyde-mcp-gateway`,
      "min-scale": 0,
      "startup-probe.http.path": "/health",
      "liveness-probe.http.path": "/health",
    });
  });

  // Derived from apps.json, never listed by hand (D38).
  const registry = loadRegistry();
  const perApp = Object.fromEntries(appNames(registry).flatMap((app) => {
    const vars = appVariables(app);
    return [[vars.redactedUrl, { required: false, secret: true }], [vars.databaseCa, { required: false, secret: true }]];
  }));

  it("declares exactly the runtime values the server reads, with their flags: the global ones and each app's from apps.json", () => {
    const flags = (required: boolean, secret: boolean) => ({ required, secret });
    expect(Object.fromEntries(config.variables.map(({ name, required, secret }) => [name, flags(required, secret)]))).toEqual({
      COCKPIT_LOGS_URL: flags(true, false),
      COCKPIT_LOGS_READ_TOKEN: flags(true, true),
      HYDE_TOKEN_CLAUDE_CODE: flags(true, true),
      HYDE_TOKEN_AGENT: flags(true, true),
      ...perApp,
    });
    expect(new Set(config.variables.map((v) => v.name)).size).toBe(config.variables.length);
  });

  it("infra/base.yaml lists no per-app variable and names no app", () => {
    const base = read("infra/base.yaml");
    expect(base).not.toMatch(/name: HYDE_APP_/);
    for (const app of appNames(registry)) expect(base).not.toMatch(new RegExp(`name: ${app.toUpperCase()}_`));
    expect(config.variables.filter((v) => v.app)).toEqual(appVariableSpecs(registry));
  });

  it("README's apply.env table lists every declared variable, each app's included", () => {
    const readme = read("README.md");
    const table = readme.slice(readme.indexOf("### apply.env"), readme.indexOf("### Deploy workflow"));
    for (const { name } of config.variables) expect(table).toContain(`| \`${name}\``);
    // And no variable the server no longer reads.
    for (const old of table.matchAll(/\| `((?:[A-Z]+_)+[A-Z]+)`/g)) {
      const name = old[1]!;
      const known = config.variables.some((v) => v.name === name) || ["HYDE_IMAGE_TAG", "SCW_ACCESS_KEY"].includes(name);
      expect(known, `${name} in the apply.env table is not a declared variable`).toBe(true);
    }
  });

  it("refuses an environment without an overlay", () => {
    expect(() => loadConfig("staging")).toThrow(/No infrastructure overlay/);
  });
});

describe("Dockerfile", () => {
  const dockerfile = read("Dockerfile");

  it("listens on the port infra/ declares and runs the server", () => {
    expect(dockerfile).toContain(`ENV PORT=${loadConfig("production").container.port}`);
    expect(dockerfile).toContain('CMD ["node", "src/mcp/main.ts"]');
    expect(dockerfile).toMatch(/pnpm install --frozen-lockfile --prod/);
  });

  it("copies apps.json and the fetched schemas/ into the image", () => {
    expect(read(".dockerignore").split("\n").some((line) => /^!?(schemas|apps\.json)/.test(line.trim()))).toBe(false);
    expect(dockerfile).toMatch(/^COPY \. \.$/m);
  });

  // The schema check, run with sh in a scratch directory per case (D37).
  const check = (() => {
    const lines = dockerfile.split("\n");
    const start = lines.findIndex((l) => l.startsWith("RUN test -s apps.json"));
    const end = lines.findIndex((l, i) => i >= start && !l.endsWith("\\"));
    return lines.slice(start, end + 1).join("\n").replace(/^RUN /, "").replaceAll("\\\n", "\n");
  })();
  const build = (files: string[], registry: string | null = read("apps.json")) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hyde-docker-"));
    if (registry !== null) fs.writeFileSync(path.join(dir, "apps.json"), registry);
    fs.mkdirSync(path.join(dir, "schemas"));
    for (const file of files) fs.writeFileSync(path.join(dir, "schemas", file), "x\n");
    const run = spawnSync("sh", ["-c", check], { cwd: dir, encoding: "utf8" });
    fs.rmSync(dir, { recursive: true, force: true });
    return { status: run.status, out: `${run.stdout}${run.stderr}` };
  };

  it("builds with one app's complete pair, warning for the other", () => {
    const shop = build(["shop.hyde-json.json", "shop.redacted-schema.md"]);
    expect(shop.status).toBe(0);
    expect(shop.out).toMatch(/apps with schemas: shop\n/);
    expect(shop.out).toMatch(/warning: crm is not configured/);
    const both = build(["shop.hyde-json.json", "shop.redacted-schema.md", "crm.hyde-json.json", "crm.redacted-schema.md"]);
    expect(both).toMatchObject({ status: 0 });
    expect(both.out).toMatch(/apps with schemas: shop crm/);
  });

  it("takes the apps from apps.json", () => {
    const third = JSON.stringify({ apps: { "help-desk": {} } });
    const helpdesk = build(["help-desk.hyde-json.json", "help-desk.redacted-schema.md"], third);
    expect(helpdesk.status).toBe(0);
    expect(helpdesk.out).toMatch(/apps with schemas: help-desk\n/);
    // shop's pair is no use when apps.json does not register shop.
    expect(build(["shop.hyde-json.json", "shop.redacted-schema.md"], third).status).not.toBe(0);
    expect(build(["shop.hyde-json.json", "shop.redacted-schema.md"], null).out).toMatch(/apps\.json is missing/);
  });

  it("refuses to build when no app has its complete pair", () => {
    expect(build([]).status).not.toBe(0);
    const split = build(["shop.hyde-json.json", "crm.redacted-schema.md"]);
    expect(split.status).not.toBe(0);
    expect(split.out).toMatch(/no app has both schema files/);
  });

  it("cannot copy apply.env or .env files into the image", () => {
    const ignored = read(".dockerignore").split("\n");
    expect(ignored).toEqual(expect.arrayContaining(["apply.env", ".env*", "**/node_modules"]));
  });
});

describe("secrets stay out of the repository", () => {
  it("apply.env is gitignored", () => {
    expect(read(".gitignore").split("\n")).toContain("apply.env");
  });

  it("the deploy workflow reads no runtime secret: only the scw key pair and the app-repo read token", () => {
    const workflow = read(".github/workflows/deploy.yml");
    const secrets = [...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
    expect([...new Set(secrets)].sort()).toEqual(["APP_REPOS_READ_TOKEN", "SCW_ACCESS_KEY", "SCW_SECRET_KEY"]);
    expect(workflow).toContain("apply production --keep-secrets");
    expect(workflow).toContain("diff production --strict");
  });

  it("the deploy workflow fetches both schema kinds before building the image, from the path context", () => {
    const workflow = read(".github/workflows/deploy.yml");
    const build = workflow.indexOf("docker/build-push-action");
    for (const step of ["pnpm schemas", "pnpm fetch:redacted-schemas"]) {
      expect(workflow.indexOf(step)).toBeGreaterThan(-1);
      expect(workflow.indexOf(step)).toBeLessThan(build);
    }
    // A repository context would build from the commit, without the untracked schemas/.
    expect(workflow.slice(build)).toMatch(/context: \.\n/);
  });

  it("schemas/ is gitignored but its README", () => {
    expect(read(".gitignore").split("\n")).toEqual(expect.arrayContaining(["schemas/*", "!schemas/README.md"]));
  });
});
