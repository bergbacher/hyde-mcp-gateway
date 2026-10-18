// Loads and merges the committed infrastructure configuration
// (infra/base.yaml + infra/environments/<env>.yaml), and the `scw` seam every
// kind goes through. Copied from crm's scripts/infra/config.ts and
// trimmed to the container kind; crm's open values are gone because every
// value here is known.

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

// --- shape -----------------------------------------------------------------

/** Field names mirror the `scw` CLI's dashed args 1:1. */
export interface ContainerConfig {
  name: string;
  "namespace-id": string;
  image: string;
  "min-scale": number;
  "max-scale": number;
  "memory-limit-bytes": number;
  "mvcpu-limit": number;
  port: number;
  protocol: string;
  privacy: string;
  timeout: string;
  sandbox: string;
  "scaling-option.concurrent-requests-threshold": number;
  "startup-probe.http.path": string;
  "startup-probe.interval": string;
  "startup-probe.timeout": string;
  "startup-probe.failure-threshold": number;
  "liveness-probe.http.path": string;
  "liveness-probe.interval": string;
  "liveness-probe.timeout": string;
  "liveness-probe.failure-threshold": number;
}

export interface VariableSpec {
  name: string;
  required: boolean;
  secret: boolean;
}

export interface InfraConfig {
  environment: string;
  region: string;
  /** Compared against the live namespace before anything runs (./organisation.ts). */
  organizationId: string;
  projectId: string;
  registryEndpoint: string;
  container: ContainerConfig;
  variables: VariableSpec[];
}

// --- YAML and merge --------------------------------------------------------

export function parseInfraYaml(source: string): Record<string, unknown> {
  const parsed: unknown = parseYaml(source);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Infrastructure configuration must be a mapping at the top level.");
  }
  return parsed as Record<string, unknown>;
}

/** Overlay wins on scalars; mappings merge key by key; arrays are replaced. */
export function deepMerge<T>(base: T, overlay: unknown): T {
  if (overlay === null || overlay === undefined) return base;
  if (Array.isArray(overlay)) return overlay as T;
  if (typeof overlay === "object" && isPlainObject(base)) {
    const result: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(overlay as Record<string, unknown>)) {
      const baseValue = base[key];
      result[key] = isPlainObject(baseValue) && isPlainObject(value) ? deepMerge(baseValue, value) : value;
    }
    return result as T;
  }
  return overlay as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface LoadConfigDeps {
  readFileSync?: (path: string) => string;
  repoRoot?: string;
}

export function loadConfig(environment: string, deps: LoadConfigDeps = {}): InfraConfig {
  if (!environment || environment.trim() === "") {
    throw new Error("Refusing to run without an explicit environment, e.g. `diff production`.");
  }
  const read = deps.readFileSync ?? ((p: string) => fs.readFileSync(p, "utf8"));
  const root = deps.repoRoot ?? REPO_ROOT;
  const basePath = path.join(root, "infra", "base.yaml");
  const overlayPath = path.join(root, "infra", "environments", `${environment}.yaml`);

  let baseText: string;
  try {
    baseText = read(basePath);
  } catch {
    throw new Error(`Could not read base infrastructure config at ${basePath}`);
  }
  let overlayText: string;
  try {
    overlayText = read(overlayPath);
  } catch {
    throw new Error(`No infrastructure overlay for environment "${environment}" (expected ${overlayPath}).`);
  }

  const merged = deepMerge(parseInfraYaml(baseText), parseInfraYaml(overlayText)) as Omit<InfraConfig, "environment">;

  // Per environment, never in the base, so environments cannot collide on one
  // name in a namespace that also holds shop's and crm's containers.
  if (!merged.container?.name) {
    throw new Error(`container.name is missing for environment "${environment}" (infra/environments/${environment}.yaml).`);
  }
  if (!merged.organizationId || !merged.projectId) {
    throw new Error("organizationId and projectId must be set in infra/base.yaml: every run is verified against them.");
  }
  return { ...merged, variables: merged.variables ?? [], environment };
}

// --- scw seam --------------------------------------------------------------

export interface ScwExecResult {
  stdout: string;
  /** Only used in the error message assertScwSuccess throws. */
  stderr?: string;
  exitCode: number;
}

export type ScwExecutor = (args: string[]) => ScwExecResult;

/**
 * `scw` takes secrets as ordinary arguments, so echoing a failing command
 * verbatim would print them into a CI log on exactly the path that runs when
 * something already went wrong. Matched on the argument name, so a new
 * secret is redacted by construction.
 */
const SECRET_ARG_PREFIXES = ["secret-environment-variables."];

export function redactScwArgs(args: string[]): string[] {
  return args.map((arg) => {
    const eq = arg.indexOf("=");
    if (eq === -1) return arg;
    const name = arg.slice(0, eq);
    return SECRET_ARG_PREFIXES.some((p) => name.startsWith(p)) ? `${name}=<REDACTED>` : arg;
  });
}

/** Call after every `ctx.exec`. A non-zero exit is an error, never "absent". */
export function assertScwSuccess(args: string[], result: ScwExecResult): void {
  if (result.exitCode === 0) return;
  const output = result.stderr?.trim() || result.stdout?.trim() || "(no output)";
  throw new Error(`scw ${redactScwArgs(args).join(" ")} failed (exit code ${result.exitCode}): ${output}`);
}

/** Zero matches is not an error (diff runs before the resource exists); several are. */
export function exactlyOneOrThrow<T extends { id?: string }>(matches: T[], kind: string, name: string): T | undefined {
  if (matches.length <= 1) return matches[0];
  throw new Error(
    `Ambiguous ${kind} name "${name}": ${matches.length} resources match (${matches.map((m) => m.id ?? "?").join(", ")}). ` +
      "Refusing to guess which one was meant.",
  );
}

export interface DiffEntry {
  field: string;
  /** "absent": nothing exists live (fails only under --strict). "divergent": exists and disagrees (always fails). */
  status: "absent" | "divergent";
  live: unknown;
  desired: unknown;
}

export interface KindContext {
  exec: ScwExecutor;
  config: InfraConfig;
  /** Variable values from the environment. `apply` only; `diff` never sees values. */
  variableValues?: Record<string, string>;
  /** The process environment (HYDE_IMAGE_TAG). */
  env?: Record<string, string | undefined>;
  sleep?: (ms: number) => void;
}
