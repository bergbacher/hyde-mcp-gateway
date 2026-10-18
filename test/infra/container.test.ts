import { describe, expect, it, vi } from "vitest";
import type { KindContext, ScwExecResult } from "../../scripts/infra/config.ts";
import * as container from "../../scripts/infra/kinds/container.ts";
import { LIVE, config, makeExec } from "./fixtures.ts";

describe("container.read", () => {
  it("returns null when no container has the configured name", () => {
    expect(container.read({ exec: makeExec([]), config: config() })).toBeNull();
  });

  it("returns the live container found by namespace + name, in the configured region", () => {
    const exec = makeExec([{ id: LIVE.id }]);
    const ctx: KindContext = { exec, config: { ...config(), region: "nl-ams" } };
    expect(container.read(ctx)).toEqual(LIVE);
    const [list] = exec.mock.calls[0];
    expect(list).toEqual(expect.arrayContaining([`namespace-id=${LIVE.namespace_id}`, "name=hyde-mcp-gateway"]));
    for (const [args] of exec.mock.calls) expect(args).toContain("region=nl-ams");
  });

  it("throws (never returns null) when `list` fails, naming command and stderr", () => {
    const exec = (): ScwExecResult => ({ stdout: "", stderr: "permission denied", exitCode: 1 });
    expect(() => container.read({ exec, config: config() })).toThrow(/container container list.*permission denied/);
  });

  it("throws when the name is ambiguous", () => {
    expect(() => container.read({ exec: makeExec([{ id: "a" }, { id: "b" }]), config: config() })).toThrow(/Ambiguous.*a, b/);
  });
});

describe("container.diff", () => {
  const ctx: KindContext = { exec: makeExec([]), config: config() };

  it("reports one absent entry, not one per field, when no container exists", () => {
    expect(container.diff(ctx, null)).toEqual([{ field: "container", status: "absent", live: null, desired: "hyde-mcp-gateway" }]);
  });

  it("reports no drift when live matches, across duration formats and image tags", () => {
    expect(container.diff(ctx, LIVE)).toEqual([]);
  });

  it("detects a changed scalar and a changed probe", () => {
    const entries = container.diff(ctx, {
      ...LIVE,
      min_scale: 1,
      liveness_probe: { ...LIVE.liveness_probe, http: { path: "/" } },
    });
    expect(entries.map((e) => [e.field, e.live, e.desired])).toEqual([
      ["min-scale", 1, 0],
      ["liveness-probe.http.path", "/", "/health"],
    ]);
    expect(entries.every((e) => e.status === "divergent")).toBe(true);
  });

  it("detects a different image repository", () => {
    const entries = container.diff(ctx, { ...LIVE, image: "rg.fr-par.scw.cloud/other/hyde-mcp-gateway:abcdef" });
    expect(entries.map((e) => e.field)).toEqual(["image"]);
  });

  it("does not report a secret's value changing (rotation is not drift)", () => {
    const rotated = { ...LIVE, secret_environment_variables: { HYDE_TOKEN_AGENT: "$other", COCKPIT_LOGS_READ_TOKEN: "$other" } };
    expect(container.diff(ctx, rotated)).toEqual([]);
  });

  it("reports a required secret missing live, and an undeclared one present", () => {
    const missing = container.diff(ctx, { ...LIVE, secret_environment_variables: { HYDE_TOKEN_AGENT: "$d" } });
    expect(missing).toEqual([
      {
        field: "secret-environment-variables",
        status: "divergent",
        live: ["HYDE_TOKEN_AGENT"],
        desired: ["COCKPIT_LOGS_READ_TOKEN", "HYDE_TOKEN_AGENT"],
      },
    ]);
    const extra = container.diff(ctx, {
      ...LIVE,
      secret_environment_variables: { ...LIVE.secret_environment_variables, HYDE_TOKEN_OLD: "$d" },
    });
    expect(extra.map((e) => e.field)).toEqual(["secret-environment-variables"]);
  });

  it("accepts an optional variable whether set live or not", () => {
    expect(container.diff(ctx, { ...LIVE, environment_variables: { LOG_LEVEL: "debug" } })).toEqual([]);
  });

  it("never puts a variable value into a diff entry", () => {
    const entries = container.diff(ctx, { ...LIVE, secret_environment_variables: { HYDE_TOKEN_AGENT: "$argon2id$digest" } });
    expect(JSON.stringify(entries)).not.toContain("argon2id");
  });
});

describe("container.apply", () => {
  const values = { HYDE_TOKEN_AGENT: "t".repeat(32), COCKPIT_LOGS_READ_TOKEN: "cockpit-secret" };

  it("creates with namespace, name, tagged image, whole-GB memory and every value as a secret", () => {
    const exec = makeExec([]);
    container.apply({ exec, config: config(), env: { HYDE_IMAGE_TAG: "sha1" }, variableValues: values }, null);
    const [args] = exec.mock.calls[0];
    expect(args.slice(0, 3)).toEqual(["container", "container", "create"]);
    expect(args).toEqual(
      expect.arrayContaining([
        "namespace-id=00000000-0000-4000-8000-00000000000a",
        "name=hyde-mcp-gateway",
        "region=fr-par",
        "image=rg.fr-par.scw.cloud/test-registry/hyde-mcp-gateway:sha1",
        "memory-limit-bytes=1GB",
        "port=8080",
        "min-scale=0",
        "startup-probe.http.path=/health",
        "liveness-probe.http.path=/health",
        `secret-environment-variables.HYDE_TOKEN_AGENT=${"t".repeat(32)}`,
        "secret-environment-variables.COCKPIT_LOGS_READ_TOKEN=cockpit-secret",
      ]),
    );
    expect(args.some((a) => a.startsWith("environment-variables."))).toBe(false);
  });

  it("refuses to create without an image tag: the bare repository is not pullable", () => {
    const exec = makeExec([]);
    expect(() => container.apply({ exec, config: config(), env: {}, variableValues: values }, null)).toThrow(/HYDE_IMAGE_TAG/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("updates by id, without namespace or name", () => {
    const exec = makeExec([]);
    container.apply({ exec, config: config(), env: { HYDE_IMAGE_TAG: "sha2" }, variableValues: values }, LIVE);
    const [args] = exec.mock.calls[0];
    expect(args.slice(0, 4)).toEqual(["container", "container", "update", LIVE.id]);
    expect(args).toContain("image=rg.fr-par.scw.cloud/test-registry/hyde-mcp-gateway:sha2");
    expect(args.some((a) => a.startsWith("namespace-id=") || a.startsWith("name="))).toBe(false);
  });

  it("keeps the live image on an update without a tag (a secret rotation does not move the revision)", () => {
    const exec = makeExec([]);
    container.apply({ exec, config: config(), env: {}, variableValues: values }, LIVE);
    expect(exec.mock.calls[0][0].some((a) => a.startsWith("image="))).toBe(false);
  });

  it("sends no secret argument for a variable without a value, so the live one is kept", () => {
    const exec = makeExec([]);
    container.apply({ exec, config: config(), env: { HYDE_IMAGE_TAG: "sha" }, variableValues: {} }, LIVE);
    expect(exec.mock.calls[0][0].some((a) => a.includes("environment-variables."))).toBe(false);
  });

  it("throws on a failed write, with every secret value redacted", () => {
    const exec = (): ScwExecResult => ({ stdout: "", stderr: "invalid argument", exitCode: 1 });
    let caught: unknown;
    try {
      container.apply({ exec, config: config(), env: { HYDE_IMAGE_TAG: "sha" }, variableValues: values }, LIVE);
    } catch (e) {
      caught = e;
    }
    const message = (caught as Error).message;
    expect(message).toMatch(/container container update.*invalid argument/);
    expect(message).toContain("secret-environment-variables.HYDE_TOKEN_AGENT=<REDACTED>");
    expect(message).not.toContain("t".repeat(32));
    expect(message).not.toContain("cockpit-secret");
  });
});

describe("container.awaitSettled", () => {
  function sequence(statuses: string[]) {
    let i = 0;
    return (args: string[]): ScwExecResult => {
      expect(args).toContain("region=fr-par");
      return { stdout: JSON.stringify({ ...LIVE, status: statuses[Math.min(i++, statuses.length - 1)] }), exitCode: 0 };
    };
  }
  const noSleep = { sleep: () => {} };

  it("returns once the status has been settled for several consecutive reads", () => {
    const exec = sequence(["updating", "ready", "ready", "ready"]);
    const settled = container.awaitSettled({ exec, config: config() }, { ...LIVE, status: "updating" }, noSleep);
    expect(settled.status).toBe("ready");
  });

  it("resets the count when the container flips back to a transient state", () => {
    // ready (1) → updating (0) → ready ×3: four reads after the initial one.
    const exec = vi.fn(sequence(["updating", "ready", "ready", "ready"]));
    container.awaitSettled({ exec, config: config() }, { ...LIVE, status: "ready" }, noSleep);
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it('throws on "error" without waiting', () => {
    expect(() =>
      container.awaitSettled({ exec: sequence(["ready"]), config: config() }, { ...LIVE, status: "error" }, noSleep),
    ).toThrow(/"error" state/);
  });

  it("times out naming the last status rather than looping forever", () => {
    expect(() =>
      container.awaitSettled({ exec: sequence(["updating"]), config: config() }, { ...LIVE, status: "updating" }, {
        ...noSleep,
        maxAttempts: 3,
      }),
    ).toThrow(/Timed out.*"updating"/);
  });
});

describe("formatMemoryLimitArg / imageRepository / endpoint", () => {
  it("renders whole GB and refuses to round", () => {
    expect(container.formatMemoryLimitArg(2_000_000_000)).toBe("2GB");
    expect(() => container.formatMemoryLimitArg(512_000_000)).toThrow(/whole GB/);
  });

  it("strips only a tag, not a registry port", () => {
    expect(container.imageRepository("rg.example:5000/ns/hyde-mcp-gateway:abc")).toBe("rg.example:5000/ns/hyde-mcp-gateway");
    expect(container.imageRepository("rg.example:5000/ns/hyde-mcp-gateway")).toBe("rg.example:5000/ns/hyde-mcp-gateway");
  });

  it("builds the HTTPS endpoint from the domain name", () => {
    expect(container.endpoint(LIVE)).toBe("https://hyde-mcp-gateway.example.invalid");
    expect(container.endpoint({ ...LIVE, domain_name: undefined })).toBeUndefined();
  });
});
