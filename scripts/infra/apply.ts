// Driver for hyde-mcp-gateway's committed infrastructure (infra/), trimmed to
// the container kind: no kind registry, no --only.
//
//   node scripts/infra/apply.ts diff  <environment> [--strict]
//   node scripts/infra/apply.ts apply <environment> [--keep-secrets]
//   node scripts/infra/apply.ts verify-organisation <environment>
//   node scripts/infra/apply.ts target <environment>
//
// No default environment, so a bare invocation cannot touch production.
// Every subcommand but `target` first verifies that the credential reaches
// the committed organisation and project (./organisation.ts).
//
// `apply` writes every declared variable from the environment
// (`pnpm infra:apply` loads apply.env) and refuses, listing each missing
// required name, before any write. The per-app variables are derived from
// apps.json (config.ts appVariableSpecs); the container gets the apps whose
// values apply.env holds, and an app with one of its values needs all. `--keep-secrets` is the deploy workflow's
// mode: it sends no runtime variable at all, secret or plain, so
// `container update` keeps the live ones, and it refuses to create the
// container, because a container created without them would not start
// (src/config.ts needs a client token). Plain variables are skipped too: the
// API replaces the whole environment-variables map when one is sent, and the
// workflow holds none of their values. Runtime values therefore live in
// apply.env and on the container, never in GitHub.

import { spawnSync } from "node:child_process";
import type { DiffEntry, InfraConfig, KindContext, ScwExecResult, ScwExecutor } from "./config.ts";
import { loadConfig } from "./config.ts";
import * as container from "./kinds/container.ts";
import { assertTarget } from "./organisation.ts";
import { blockingSleep } from "./sleep.ts";

export type Subcommand = "diff" | "apply" | "verify-organisation" | "target";

export interface CliArgs {
  subcommand: Subcommand;
  environment: string;
  /** diff: an absent container fails too, not just a divergent field. */
  strict: boolean;
  /** apply: send no runtime variable (secret or plain); refuse to create. */
  keepSecrets: boolean;
}

const USAGE = "node scripts/infra/apply.ts <diff|apply|verify-organisation|target> <environment> [--strict] [--keep-secrets]";
const SUBCOMMANDS: Subcommand[] = ["diff", "apply", "verify-organisation", "target"];

export function parseCliArgs(argv: string[]): CliArgs {
  const flags = argv.filter((a) => a.startsWith("-"));
  const positionals = argv.filter((a) => !a.startsWith("-"));
  // Fail closed: a misspelt flag must not silently widen what runs.
  for (const flag of flags) {
    if (flag !== "--strict" && flag !== "--keep-secrets") throw new Error(`Unknown option "${flag}". Usage: ${USAGE}`);
  }
  if (positionals.length > 2) throw new Error(`Unexpected argument "${positionals[2]}". Usage: ${USAGE}`);
  const [subcommand, environment] = positionals;
  if (!SUBCOMMANDS.includes(subcommand as Subcommand)) throw new Error(`Unknown subcommand "${subcommand ?? ""}". Usage: ${USAGE}`);
  if (!environment?.trim()) throw new Error(`Refusing to run without an explicit environment. Usage: ${USAGE}`);
  const strict = flags.includes("--strict");
  const keepSecrets = flags.includes("--keep-secrets");
  if (strict && subcommand !== "diff") throw new Error("--strict applies to diff only.");
  if (keepSecrets && subcommand !== "apply") throw new Error("--keep-secrets applies to apply only.");
  return { subcommand: subcommand as Subcommand, environment, strict, keepSecrets };
}

// --- diff --------------------------------------------------------------------

export interface RunDiffResult {
  exitCode: number;
  entries: DiffEntry[];
  error?: string;
}

/** Reads the container back and compares. Never sees a variable value. */
export function runDiff(config: InfraConfig, exec: ScwExecutor, strict: boolean): RunDiffResult {
  let entries: DiffEntry[];
  try {
    const ctx: KindContext = { exec, config };
    entries = container.diff(ctx, container.read(ctx));
  } catch (err) {
    return { exitCode: 1, entries: [], error: message(err) };
  }
  const failed = strict ? entries.length > 0 : entries.some((e) => e.status === "divergent");
  return { exitCode: failed ? 1 : 0, entries };
}

// --- apply -------------------------------------------------------------------

export type RunApplyResult =
  | { ok: true; containerId: string; endpoint?: string }
  | { ok: false; missing: string[]; error?: string };

/** The apps with at least one of their derived variables set in `env`: the apps this apply configures. */
export function configuredApps(config: InfraConfig, env: Record<string, string | undefined>): string[] {
  return [...new Set(config.variables.filter((v) => v.app && env[v.name]).map((v) => v.app!))];
}

/**
 * Every required name missing from `env`, in declaration order, all at once.
 * An app's derived variables are optional as a group, not one by one: an app
 * with any of them set needs all of them, since the server refuses to start
 * with a URL but no CA in production.
 */
export function collectMissing(config: InfraConfig, env: Record<string, string | undefined>, keepSecrets: boolean): string[] {
  // --keep-secrets sends no runtime variable, so it needs none.
  const apps = new Set(configuredApps(config, env));
  const missing = keepSecrets
    ? []
    : config.variables.filter((v) => (v.required || (v.app && apps.has(v.app))) && !env[v.name]).map((v) => v.name);
  // The workflow always deploys a commit; a local apply may keep the live image.
  if (keepSecrets && !env[container.IMAGE_TAG_VARIABLE]) missing.push(container.IMAGE_TAG_VARIABLE);
  return missing;
}

export function runApply(
  config: InfraConfig,
  exec: ScwExecutor,
  env: Record<string, string | undefined>,
  options: { keepSecrets?: boolean; sleep?: (ms: number) => void } = {},
): RunApplyResult {
  const keepSecrets = options.keepSecrets ?? false;
  const missing = collectMissing(config, env, keepSecrets);
  if (missing.length > 0) return { ok: false, missing };

  const variableValues: Record<string, string> = {};
  for (const v of config.variables) {
    const value = env[v.name];
    if (value !== undefined && value !== "" && !keepSecrets) variableValues[v.name] = value;
  }
  const ctx: KindContext = { exec, config, env, variableValues, sleep: options.sleep };

  try {
    const live = container.read(ctx);
    if (!live && keepSecrets) {
      throw new Error(
        `Container "${config.container.name}" does not exist. The first deploy is a local \`pnpm infra:apply\` ` +
          "with apply.env (README, Deploy); --keep-secrets never creates it.",
      );
    }
    container.apply(ctx, live);
    // Re-read: on a create, `live` had no id; on an update, it is stale.
    const settled = container.awaitSettled(ctx, container.read(ctx));
    return { ok: true, containerId: settled.id, endpoint: container.endpoint(settled) };
  } catch (err) {
    return { ok: false, missing: [], error: message(err) };
  }
}

// --- CLI -----------------------------------------------------------------------

export interface CliDeps {
  exec: ScwExecutor;
  env: Record<string, string | undefined>;
  loadConfig?: (environment: string) => InfraConfig;
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
  sleep?: (ms: number) => void;
}

/** Returns the exit code; never exits itself. */
export function runCli(argv: string[], deps: CliDeps): number {
  const log = deps.log ?? ((m: string) => console.log(m));
  const errorLog = deps.errorLog ?? ((m: string) => console.error(m));

  let args: CliArgs;
  let config: InfraConfig;
  try {
    args = parseCliArgs(argv);
    config = (deps.loadConfig ?? loadConfig)(args.environment);
  } catch (err) {
    errorLog(message(err));
    return 1;
  }

  if (args.subcommand === "target") {
    // Committed, non-secret values for the deploy workflow ($GITHUB_OUTPUT lines).
    log(`region=${config.region}`);
    log(`registry-host=${config.registryEndpoint.split("/")[0]}`);
    log(`image=${config.container.image}`);
    log(`organization-id=${config.organizationId}`);
    log(`project-id=${config.projectId}`);
    return 0;
  }

  try {
    assertTarget(
      {
        organizationId: config.organizationId,
        projectId: config.projectId,
        namespaceId: config.container["namespace-id"],
        region: config.region,
      },
      { exec: deps.exec, env: deps.env },
    );
  } catch (err) {
    errorLog(message(err));
    return 1;
  }

  if (args.subcommand === "verify-organisation") {
    log(`Credential verified against organisation ${config.organizationId}, project ${config.projectId}.`);
    return 0;
  }

  if (args.subcommand === "diff") {
    const result = runDiff(config, deps.exec, args.strict);
    for (const e of result.entries) {
      log(`[container] (${e.status}) ${e.field}: live=${JSON.stringify(e.live)} desired=${JSON.stringify(e.desired)}`);
    }
    if (result.error) errorLog(`Failed to compute drift: ${result.error}`);
    else if (result.entries.length === 0) log("No drift detected.");
    else if (!args.strict && result.exitCode === 0) log("Absent only; pass --strict to fail on that.");
    return result.exitCode;
  }

  const result = runApply(config, deps.exec, deps.env, { keepSecrets: args.keepSecrets, sleep: deps.sleep });
  if (!result.ok) {
    errorLog(
      result.missing.length > 0
        ? `Refusing to apply: missing required variable(s): ${result.missing.join(", ")}`
        : `Apply failed: ${result.error}`,
    );
    return 1;
  }
  log(`Applied infrastructure config for "${args.environment}"${args.keepSecrets ? " (secrets kept as live)" : ""}.`);
  if (!args.keepSecrets) log(`apps=${configuredApps(config, deps.env).join(",")}`);
  log(`containerId=${result.containerId}`);
  // Always printed, empty when unknown: the deploy workflow reads this line and
  // fails on an empty value instead of smoke-checking an empty URL.
  log(`endpoint=${result.endpoint ?? ""}`);
  if (!result.endpoint) errorLog("The container reports no public endpoint (public_endpoint, domain_name).");
  return 0;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function realExec(args: string[]): ScwExecResult {
  const result = spawnSync("scw", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status ?? 1 };
}

if (import.meta.main) {
  process.exitCode = runCli(process.argv.slice(2), { exec: realExec, env: process.env, sleep: blockingSleep });
}
