// The committed files agree with each other and with the server.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appVariableSpecs, loadConfig } from "../../scripts/infra/config.ts";
import { appNames, appVariables, EXAMPLE_REGISTRY_FILE, loadRegistry } from "../../src/registry.ts";
import { exampleReader, loadExampleConfig } from "./fixtures.ts";

const root = path.resolve(import.meta.dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("committed infra/", () => {
  const config = loadExampleConfig("production");

  it("declares hyde-mcp-gateway, fr-par, scale to zero, probes on /health", () => {
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
  const registry = loadRegistry(EXAMPLE_REGISTRY_FILE);
  const perApp = Object.fromEntries(appNames(registry).flatMap((app) => {
    const vars = appVariables(app);
    return [[vars.redactedUrl, { required: false, secret: true }], [vars.databaseCa, { required: false, secret: true }]];
  }));

  it("declares exactly the runtime values the server reads, with their flags: the global ones and each app's from apps.json", () => {
    const flags = (required: boolean, secret: boolean) => ({ required, secret });
    expect(Object.fromEntries(config.variables.map(({ name, required, secret }) => [name, flags(required, secret)]))).toEqual({
      COCKPIT_LOGS_URL: flags(true, false),
      COCKPIT_LOGS_READ_TOKEN: flags(true, true),
      APP_REPOS_READ_TOKEN: flags(true, true),
      HYDE_TOKEN_CLAUDE_CODE: flags(true, true),
      HYDE_TOKEN_CLAUDE_CODE_APPS: flags(true, false),
      HYDE_TOKEN_AGENT: flags(true, true),
      HYDE_TOKEN_AGENT_APPS: flags(true, false),
      ...perApp,
    });
    expect(new Set(config.variables.map((v) => v.name)).size).toBe(config.variables.length);
  });

  it("infra/base.yaml lists no per-app variable, names no app and holds no account id", () => {
    const base = read("infra/base.yaml");
    expect(base).not.toMatch(/name: HYDE_APP_/);
    expect(base).not.toMatch(/organizationId|projectId|registryEndpoint|namespace-id|image:/);
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
    expect(() => loadExampleConfig("staging")).toThrow(/No infrastructure overlay/);
  });

  it("points at the examples when an operator file is missing", () => {
    const missing = (p: string) => {
      if (p.endsWith("apps.json") || p.endsWith(path.join("environments", "production.yaml"))) throw new Error("ENOENT");
      return fs.readFileSync(p, "utf8");
    };
    expect(() => loadConfig("production", { repoRoot: root, readFileSync: missing }))
      .toThrow(/copy infra\/environments\/production\.example\.yaml to production\.yaml/);
    const noRegistry = (p: string) => (p.endsWith("apps.json") ? missing(p) : exampleReader()(p));
    expect(() => loadConfig("production", { repoRoot: root, readFileSync: noRegistry }))
      .toThrow(/copy apps\.example\.json to apps\.json/);
  });

  it("refuses an overlay without the account's ids", () => {
    expect(() => loadExampleConfig("production", { "infra/environments/production.yaml": "container:\n  name: x\n" }))
      .toThrow(/organizationId, projectId, registryEndpoint, container\.namespace-id, container\.image must be set in infra\/environments\/production\.yaml/);
  });
});

describe("Dockerfile", () => {
  const dockerfile = read("Dockerfile");

  it("listens on the port infra/ declares and runs the server", () => {
    expect(dockerfile).toContain(`ENV PORT=${loadExampleConfig("production").container.port}`);
    expect(dockerfile).toContain('CMD ["node", "src/mcp/main.ts"]');
    expect(dockerfile).toMatch(/pnpm install --frozen-lockfile --prod/);
  });

  it("copies apps.json and the edge schema into the image, no app schema (D58)", () => {
    const ignored = read(".dockerignore").split("\n").map((line) => line.trim());
    expect(ignored.some((line) => /^!?apps\.json/.test(line))).toBe(false);
    expect(ignored).toEqual(expect.arrayContaining(["schemas/*", "!schemas/edge.hyde-json.json"]));
    expect(ignored.filter((line) => line.startsWith("!"))).toEqual(["!schemas/edge.hyde-json.json"]);
    expect(dockerfile).toMatch(/^COPY \. \.$/m);
    // No schema check: the image never holds an app's schema files.
    expect(dockerfile).not.toMatch(/schemas\/\$app|redacted-schema\.md/);
  });

  // The registry check, run with sh in a scratch directory per case.
  const check = (() => {
    const lines = dockerfile.split("\n");
    const start = lines.findIndex((l) => l.startsWith("RUN test -s apps.json"));
    const end = lines.findIndex((l, i) => i >= start && !l.endsWith("\\"));
    return lines.slice(start, end + 1).join("\n").replace(/^RUN /, "").replaceAll("\\\n", "\n");
  })();
  const build = (registry: string | null) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hyde-docker-"));
    if (registry !== null) fs.writeFileSync(path.join(dir, "apps.json"), registry);
    const run = spawnSync("sh", ["-c", check], { cwd: dir, encoding: "utf8" });
    fs.rmSync(dir, { recursive: true, force: true });
    return { status: run.status, out: `${run.stdout}${run.stderr}` };
  };

  it("builds with apps.json alone, no schema file (D58)", () => {
    const example = build(read("apps.example.json"));
    expect(example.status).toBe(0);
    expect(example.out).toMatch(/apps: shop crm\n/);
    const third = build(JSON.stringify({ apps: { "help-desk": {} } }));
    expect(third).toMatchObject({ status: 0, out: "apps: help-desk\n" });
  });

  it("refuses to build without apps.json or with one that is not a registry", () => {
    const missing = build(null);
    expect(missing.status).not.toBe(0);
    expect(missing.out).toMatch(/apps\.json is missing/);
    const broken = build("{ not json");
    expect(broken.status).not.toBe(0);
    expect(broken.out).toMatch(/apps\.json is not a registry/);
  });

  it("cannot copy apply.env or .env files into the image", () => {
    const ignored = read(".dockerignore").split("\n");
    expect(ignored).toEqual(expect.arrayContaining(["apply.env", ".env*", "**/node_modules"]));
  });
});

describe("secrets stay out of the repository", () => {
  it("the operator files are gitignored, their examples are not", () => {
    const ignored = read(".gitignore").split("\n");
    expect(ignored).toEqual(expect.arrayContaining(["apply.env", "apps.json", "infra/environments/*.yaml", "!infra/environments/*.example.yaml"]));
  });

  it("the deploy workflow reads no runtime secret: only the scw key pair and the operator files", () => {
    const workflow = read(".github/workflows/deploy.yml");
    const secrets = [...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
    expect([...new Set(secrets)].sort()).toEqual(["HYDE_APPS_JSON", "HYDE_PRODUCTION_YAML", "SCW_ACCESS_KEY", "SCW_SECRET_KEY"]);
    expect(workflow).toContain("apply production --keep-secrets");
    expect(workflow).toContain("diff production --strict");
  });

  it("the deploy workflow fetches no schema (D58) and builds from the path context", () => {
    const workflow = read(".github/workflows/deploy.yml");
    for (const step of ["pnpm schemas", "pnpm fetch:redacted-schemas", "GITHUB_TOKEN", "GH_TOKEN"]) expect(workflow).not.toContain(step);
    // A repository context would build from the commit, without the untracked apps.json.
    expect(workflow.slice(workflow.indexOf("docker/build-push-action"))).toMatch(/context: \.\n/);
  });

  // D44: a manual build-only run pushes the image for the first local apply and never touches the container.
  it("the deploy workflow's build-only run pushes a manual tag and skips apply, diff and smoke check, whatever the switch says", async () => {
    const { parse } = await import("yaml");
    const workflow = parse(read(".github/workflows/deploy.yml"));
    expect(workflow.on.workflow_dispatch.inputs.build_only).toMatchObject({ type: "boolean", default: false });
    const job = workflow.jobs.deploy;
    expect(job.if).toBe("vars.HYDE_DEPLOY_ENABLED == 'true' || (github.event_name == 'workflow_dispatch' && inputs.build_only)");
    const steps: { name?: string; uses?: string; if?: string; run?: string; with?: Record<string, string> }[] = job.steps;
    const index = (match: (s: (typeof steps)[number]) => boolean) => steps.findIndex(match);
    const push = index((s) => s.uses?.startsWith("docker/build-push-action") ?? false);
    expect(steps[push]!.if).toBeUndefined();
    expect(steps[push]!.with!.tags).toContain("format('manual-{0}', github.sha)");
    for (const step of steps.slice(push + 1)) {
      if (step.run?.includes("GITHUB_STEP_SUMMARY")) {
        expect(step.if).toBe("inputs.build_only");
        expect(step.run).toContain("HYDE_IMAGE_TAG=$GITHUB_SHA pnpm infra:apply");
      } else {
        expect(step.if, `${step.name} must not run in a build-only run`).toBe("${{ !inputs.build_only }}");
      }
    }
    for (const command of ["apply production", "diff production"]) {
      const step = index((s) => s.run?.includes(command) ?? false);
      expect(step).toBeGreaterThan(push);
    }
  });

  it("schemas/ is gitignored but its README and the edge schema hyde-mcp-gateway owns (D46)", () => {
    expect(read(".gitignore").split("\n")).toEqual(
      expect.arrayContaining(["schemas/*", "!schemas/README.md", "!schemas/edge.hyde-json.json"]),
    );
  });
});
