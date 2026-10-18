// The hyde-mcp-gateway container: `scw container container`. Copied from crm's
// kinds/container.ts (itself shop's). Departures: the image-tag variable is
// HYDE_IMAGE_TAG and an update without one keeps the live image, so a local
// `apply` that only rotates a secret cannot move the running revision.
//
// The config side uses the CLI's dashed args; `scw container container get
// -o json` answers in snake_case. SCALAR_FIELDS maps one onto the other.

import { assertScwSuccess, exactlyOneOrThrow } from "../config.ts";
import type { ContainerConfig, DiffEntry, KindContext } from "../config.ts";
import { blockingSleep } from "../sleep.ts";

interface Probe {
  http?: { path?: string };
  interval?: string;
  timeout?: string;
  failure_threshold?: number;
}

export interface LiveContainer {
  id: string;
  name: string;
  status: string;
  namespace_id: string;
  domain_name?: string;
  image: string;
  min_scale: number;
  max_scale: number;
  memory_limit_bytes: number;
  mvcpu_limit: number;
  port: number;
  protocol: string;
  privacy: string;
  timeout: string;
  sandbox: string;
  scaling_option?: { concurrent_requests_threshold?: number };
  startup_probe?: Probe | null;
  liveness_probe?: Probe | null;
  environment_variables?: Record<string, string>;
  /** Digests only, never values. */
  secret_environment_variables?: Record<string, string>;
}

export const IMAGE_TAG_VARIABLE = "HYDE_IMAGE_TAG";

/** `scw` reports "300.000000000s" for "300s"; compare numerically. */
function durationEqual(desired: unknown, live: unknown): boolean {
  const seconds = (v: string) => Number.parseFloat(v.replace(/s$/, ""));
  return typeof desired === "string" && typeof live === "string" && seconds(desired) === seconds(live);
}

/** Without the tag: which revision runs is the pipeline's decision, not configuration. */
export function imageRepository(ref: string): string {
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  return colon > slash ? ref.slice(0, colon) : ref;
}

const SCALAR_FIELDS: {
  field: keyof ContainerConfig;
  read: (live: LiveContainer) => unknown;
  equal?: (desired: unknown, live: unknown) => boolean;
}[] = [
  {
    field: "image",
    read: (l) => l.image,
    equal: (d, l) => typeof d === "string" && typeof l === "string" && imageRepository(d) === imageRepository(l),
  },
  { field: "min-scale", read: (l) => l.min_scale },
  { field: "max-scale", read: (l) => l.max_scale },
  { field: "memory-limit-bytes", read: (l) => l.memory_limit_bytes },
  { field: "mvcpu-limit", read: (l) => l.mvcpu_limit },
  { field: "port", read: (l) => l.port },
  { field: "protocol", read: (l) => l.protocol },
  { field: "privacy", read: (l) => l.privacy },
  { field: "timeout", read: (l) => l.timeout, equal: durationEqual },
  { field: "sandbox", read: (l) => l.sandbox },
  { field: "scaling-option.concurrent-requests-threshold", read: (l) => l.scaling_option?.concurrent_requests_threshold },
  { field: "startup-probe.http.path", read: (l) => l.startup_probe?.http?.path },
  { field: "startup-probe.interval", read: (l) => l.startup_probe?.interval, equal: durationEqual },
  { field: "startup-probe.timeout", read: (l) => l.startup_probe?.timeout, equal: durationEqual },
  { field: "startup-probe.failure-threshold", read: (l) => l.startup_probe?.failure_threshold },
  { field: "liveness-probe.http.path", read: (l) => l.liveness_probe?.http?.path },
  { field: "liveness-probe.interval", read: (l) => l.liveness_probe?.interval, equal: durationEqual },
  { field: "liveness-probe.timeout", read: (l) => l.liveness_probe?.timeout, equal: durationEqual },
  { field: "liveness-probe.failure-threshold", read: (l) => l.liveness_probe?.failure_threshold },
];

function getById(ctx: KindContext, id: string): LiveContainer {
  const args = ["container", "container", "get", id, `region=${ctx.config.region}`, "-o", "json"];
  const result = ctx.exec(args);
  assertScwSuccess(args, result);
  return JSON.parse(result.stdout) as LiveContainer;
}

export function read(ctx: KindContext): LiveContainer | null {
  const { container } = ctx.config;
  const args = [
    "container",
    "container",
    "list",
    `region=${ctx.config.region}`,
    `namespace-id=${container["namespace-id"]}`,
    `name=${container.name}`,
    "-o",
    "json",
  ];
  const result = ctx.exec(args);
  assertScwSuccess(args, result);
  const list = JSON.parse(result.stdout || "[]") as { id: string }[];
  const match = exactlyOneOrThrow(list, "container", container.name);
  return match ? getById(ctx, match.id) : null;
}

/**
 * Names whose presence live is expected: every required one, an optional one
 * set deliberately, and every variable of an app (derived from apps.json)
 * once any of that app's variables is live, so a half-configured app is drift.
 */
function expectedNames(ctx: KindContext, secret: boolean, live: string[]): string[] {
  const liveApps = new Set(ctx.config.variables.filter((v) => v.app && live.includes(v.name)).map((v) => v.app));
  return ctx.config.variables
    .filter((v) => v.secret === secret && (v.required || live.includes(v.name) || (v.app && liveApps.has(v.app))))
    .map((v) => v.name)
    .sort();
}

export function diff(ctx: KindContext, live: LiveContainer | null): DiffEntry[] {
  const desired = ctx.config.container;
  // Nothing exists, so nothing diverged: one entry, not one per field.
  if (!live) return [{ field: "container", status: "absent", live: null, desired: desired.name }];

  const entries: DiffEntry[] = [];
  for (const spec of SCALAR_FIELDS) {
    const d = desired[spec.field];
    const l = spec.read(live);
    if (!(spec.equal ? spec.equal(d, l) : d === l)) entries.push({ field: spec.field, status: "divergent", live: l, desired: d });
  }

  // Names only, never values: a rotated secret is not drift; a name that
  // appears or disappears is.
  const allLive = [...Object.keys(live.environment_variables ?? {}), ...Object.keys(live.secret_environment_variables ?? {})];
  for (const [field, secret, liveMap] of [
    ["environment-variables", false, live.environment_variables],
    ["secret-environment-variables", true, live.secret_environment_variables],
  ] as const) {
    const liveNames = Object.keys(liveMap ?? {}).sort();
    const expected = expectedNames(ctx, secret, allLive);
    if (JSON.stringify(expected) !== JSON.stringify(liveNames)) {
      entries.push({ field, status: "divergent", live: liveNames, desired: expected });
    }
  }
  return entries;
}

/**
 * The CLI rejects a byte count on write ("size must be defined using the G or
 * GB unit") although the API reports bytes. The config stays in bytes, which
 * `diff` compares; only the write path converts, and refuses to round.
 */
export function formatMemoryLimitArg(bytes: number): string {
  const GB = 1_000_000_000;
  if (bytes % GB !== 0) throw new Error(`memory-limit-bytes must be a whole GB for the scw CLI (got ${bytes}).`);
  return `${bytes / GB}GB`;
}

function commonArgs(ctx: KindContext, imageArg: string[]): string[] {
  const d = ctx.config.container;
  const args = [
    `region=${ctx.config.region}`,
    ...imageArg,
    `min-scale=${d["min-scale"]}`,
    `max-scale=${d["max-scale"]}`,
    `memory-limit-bytes=${formatMemoryLimitArg(d["memory-limit-bytes"])}`,
    `mvcpu-limit=${d["mvcpu-limit"]}`,
    `port=${d.port}`,
    `protocol=${d.protocol}`,
    `privacy=${d.privacy}`,
    `timeout=${d.timeout}`,
    `sandbox=${d.sandbox}`,
    `scaling-option.concurrent-requests-threshold=${d["scaling-option.concurrent-requests-threshold"]}`,
    `startup-probe.http.path=${d["startup-probe.http.path"]}`,
    `startup-probe.interval=${d["startup-probe.interval"]}`,
    `startup-probe.timeout=${d["startup-probe.timeout"]}`,
    `startup-probe.failure-threshold=${d["startup-probe.failure-threshold"]}`,
    `liveness-probe.http.path=${d["liveness-probe.http.path"]}`,
    `liveness-probe.interval=${d["liveness-probe.interval"]}`,
    `liveness-probe.timeout=${d["liveness-probe.timeout"]}`,
    `liveness-probe.failure-threshold=${d["liveness-probe.failure-threshold"]}`,
  ];
  // A variable without a value is not sent. A map that is not sent at all is
  // left as it is live by `container update`; that is what lets the deploy
  // workflow apply without holding any runtime value (apply.ts,
  // --keep-secrets, sends none). A local apply sends every value it has.
  const values = ctx.variableValues ?? {};
  for (const v of ctx.config.variables) {
    const value = values[v.name];
    if (value === undefined) continue;
    args.push(`${v.secret ? "secret-environment-variables" : "environment-variables"}.${v.name}=${value}`);
  }
  return args;
}

export function apply(ctx: KindContext, live: LiveContainer | null): void {
  const d = ctx.config.container;
  const tag = ctx.env?.[IMAGE_TAG_VARIABLE];
  const imageArg = tag ? [`image=${d.image}:${tag}`] : [];

  if (!live) {
    // The bare repository is not a pullable reference: a container created
    // from it sits in `error` ("image was not found in container registry").
    if (!tag) throw new Error(`${IMAGE_TAG_VARIABLE} is not set. Creating the container needs the tag of a pushed image.`);
    const args = [
      "container",
      "container",
      "create",
      `namespace-id=${d["namespace-id"]}`,
      `name=${d.name}`,
      ...commonArgs(ctx, imageArg),
      "-o",
      "json",
    ];
    assertScwSuccess(args, ctx.exec(args));
    return;
  }
  const args = ["container", "container", "update", live.id, ...commonArgs(ctx, imageArg), "-o", "json"];
  assertScwSuccess(args, ctx.exec(args));
}

// --- awaitSettled ------------------------------------------------------------
// `create` and every `update` leave the container in a transient state for
// ~10-20s. crm measured that the first read after `update` is already
// `updating`, and still requires several consecutive settled reads because a
// create was once followed by an immediately rejected write. Kept: `apply`
// reports success only once the new revision is up.

const TRANSIENT_STATUSES = new Set(["creating", "pending", "upgrading", "updating"]);
const POLL_INTERVAL_MS = 5_000;

export interface AwaitSettledOptions {
  sleep?: (ms: number) => void;
  maxAttempts?: number;
  stableReadsRequired?: number;
}

/** Polls until the status has been non-transient for `stableReadsRequired` reads; throws on `error` or timeout. */
export function awaitSettled(ctx: KindContext, live: LiveContainer | null, options: AwaitSettledOptions = {}): LiveContainer {
  const sleep = options.sleep ?? ctx.sleep ?? blockingSleep;
  const maxAttempts = options.maxAttempts ?? 60;
  const stableReadsRequired = options.stableReadsRequired ?? 3;
  if (!live) throw new Error("awaitSettled needs a live container: apply() creates or updates one first.");

  let current = live;
  let attempts = 0;
  let stable = 0;
  for (;;) {
    if (current.status === "error") {
      throw new Error(`Container "${current.name}" (${current.id}) is in "error" state after apply.`);
    }
    stable = TRANSIENT_STATUSES.has(current.status) ? 0 : stable + 1;
    if (stable >= stableReadsRequired) return current;
    if (attempts >= maxAttempts) {
      throw new Error(
        `Timed out waiting for container "${current.name}" (${current.id}) to settle after ${maxAttempts} polls; ` +
          `last status "${current.status}".`,
      );
    }
    attempts += 1;
    sleep(POLL_INTERVAL_MS);
    current = getById(ctx, current.id);
  }
}

/** The container's HTTPS endpoint on Scaleway's default domain. */
export function endpoint(live: LiveContainer): string | undefined {
  return live.domain_name ? `https://${live.domain_name}` : undefined;
}
