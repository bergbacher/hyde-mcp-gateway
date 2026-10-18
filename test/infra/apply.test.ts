import { describe, expect, it, vi } from "vitest";
import { parseCliArgs, runApply, runCli, runDiff } from "../../scripts/infra/apply.ts";
import type { ScwExecResult } from "../../scripts/infra/config.ts";
import { LIVE, config, makeExec } from "./fixtures.ts";

const SECRETS = { HYDE_TOKEN_AGENT: "t".repeat(32), COCKPIT_LOGS_READ_TOKEN: "cockpit-secret" };

/** A Scaleway fake: the namespace, then the container (or none). Records every call. */
function scaleway(opts: { container?: boolean; organization?: string; project?: string } = {}) {
  const c = config();
  return vi.fn((args: string[]): ScwExecResult => {
    if (args[1] === "namespace") {
      return {
        stdout: JSON.stringify({
          organization_id: opts.organization ?? c.organizationId,
          project_id: opts.project ?? c.projectId,
        }),
        exitCode: 0,
      };
    }
    if (args.includes("list")) return { stdout: JSON.stringify(opts.container === false ? [] : [{ id: LIVE.id }]), exitCode: 0 };
    if (args.includes("get")) return { stdout: JSON.stringify(LIVE), exitCode: 0 };
    return { stdout: "{}", exitCode: 0 };
  });
}

function cli(argv: string[], exec: ReturnType<typeof scaleway>, env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(argv, {
    exec,
    env,
    loadConfig: () => config(),
    log: (m) => out.push(m),
    errorLog: (m) => err.push(m),
    sleep: () => {},
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const writes = (exec: ReturnType<typeof scaleway>) =>
  exec.mock.calls.map(([a]) => a).filter((a) => a.includes("create") || a.includes("update"));

describe("parseCliArgs", () => {
  it("requires a subcommand and an explicit environment", () => {
    expect(() => parseCliArgs([])).toThrow(/Unknown subcommand/);
    expect(() => parseCliArgs(["apply"])).toThrow(/explicit environment/);
    expect(parseCliArgs(["diff", "production", "--strict"])).toMatchObject({ subcommand: "diff", strict: true });
  });

  it("refuses unknown or misplaced flags", () => {
    expect(() => parseCliArgs(["apply", "production", "--keep-secret"])).toThrow(/Unknown option/);
    expect(() => parseCliArgs(["apply", "production", "--strict"])).toThrow(/diff only/);
    expect(() => parseCliArgs(["diff", "production", "--keep-secrets"])).toThrow(/apply only/);
  });
});

describe("runDiff", () => {
  it("passes on an absent container unless strict", () => {
    expect(runDiff(config(), makeExec([]), false).exitCode).toBe(0);
    expect(runDiff(config(), makeExec([]), true).exitCode).toBe(1);
  });

  it("fails on divergence and on a failing scw call", () => {
    expect(runDiff(config(), makeExec([{ id: LIVE.id }], { ...LIVE, port: 3000 }), false).exitCode).toBe(1);
    const broken = runDiff(config(), () => ({ stdout: "", stderr: "boom", exitCode: 2 }), false);
    expect(broken).toMatchObject({ exitCode: 1, error: expect.stringMatching(/boom/) });
  });
});

describe("runApply", () => {
  it("lists every missing required variable before any scw call", () => {
    const exec = scaleway();
    expect(runApply(config(), exec, {})).toEqual({ ok: false, missing: ["HYDE_TOKEN_AGENT", "COCKPIT_LOGS_READ_TOKEN"] });
    expect(exec).not.toHaveBeenCalled();
  });

  it("writes every secret and reports the container id and HTTPS endpoint", () => {
    const exec = scaleway();
    const result = runApply(config(), exec, { ...SECRETS }, { sleep: () => {} });
    expect(result).toEqual({ ok: true, containerId: LIVE.id, endpoint: "https://hyde-mcp-gateway.example.invalid" });
    expect(writes(exec)[0]).toEqual(expect.arrayContaining([`secret-environment-variables.HYDE_TOKEN_AGENT=${"t".repeat(32)}`]));
  });

  describe("--keep-secrets (the deploy workflow)", () => {
    it("needs no runtime variable but the image tag", () => {
      expect(runApply(config(), scaleway(), {}, { keepSecrets: true })).toEqual({ ok: false, missing: ["HYDE_IMAGE_TAG"] });
    });

    it("sends no secret argument even when a value is in the environment", () => {
      const exec = scaleway();
      const result = runApply(config(), exec, { ...SECRETS, HYDE_IMAGE_TAG: "sha" }, { keepSecrets: true, sleep: () => {} });
      expect(result.ok).toBe(true);
      const [update] = writes(exec);
      expect(update).toContain("image=rg.fr-par.scw.cloud/test-registry/hyde-mcp-gateway:sha");
      expect(update.some((a) => a.startsWith("secret-environment-variables."))).toBe(false);
    });

    it("needs no required plain variable either, and sends no plain one", () => {
      const withPlain = config({}, [
        { name: "HYDE_TOKEN_AGENT", required: true, secret: true },
        { name: "COCKPIT_LOGS_URL", required: true, secret: false },
      ]);
      expect(runApply(withPlain, scaleway(), {}, { keepSecrets: true })).toEqual({ ok: false, missing: ["HYDE_IMAGE_TAG"] });

      const exec = scaleway();
      const env = { ...SECRETS, COCKPIT_LOGS_URL: "https://logs.test", HYDE_IMAGE_TAG: "sha" };
      expect(runApply(withPlain, exec, env, { keepSecrets: true, sleep: () => {} }).ok).toBe(true);
      expect(writes(exec)[0].some((a) => a.includes("environment-variables."))).toBe(false);
    });

    it("a local apply refuses without a required plain variable and sends it when set", () => {
      const withPlain = config({}, [{ name: "COCKPIT_LOGS_URL", required: true, secret: false }]);
      expect(runApply(withPlain, scaleway(), {})).toEqual({ ok: false, missing: ["COCKPIT_LOGS_URL"] });
      const exec = scaleway();
      expect(runApply(withPlain, exec, { COCKPIT_LOGS_URL: "https://logs.test" }, { sleep: () => {} }).ok).toBe(true);
      expect(writes(exec)[0]).toContain("environment-variables.COCKPIT_LOGS_URL=https://logs.test");
    });

    it("refuses to create the container", () => {
      const exec = scaleway({ container: false });
      const result = runApply(config(), exec, { HYDE_IMAGE_TAG: "sha" }, { keepSecrets: true });
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/does not exist.*pnpm infra:apply/) });
      expect(writes(exec)).toEqual([]);
    });
  });
});

describe("runCli", () => {
  it("refuses a credential from another organisation before reading or writing the container", () => {
    const exec = scaleway({ organization: "11111111-1111-4111-8111-111111111111" });
    const { code, err } = cli(["apply", "production"], exec, SECRETS);
    expect(code).toBe(1);
    expect(err).toMatch(/organisation 11111111/);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("refuses a namespace in another project", () => {
    const { code, err } = cli(["diff", "production"], scaleway({ project: "22222222-2222-4222-8222-222222222222" }));
    expect(code).toBe(1);
    expect(err).toMatch(/project 22222222/);
  });

  it("refuses a local SCW_DEFAULT_PROJECT_ID that points elsewhere", () => {
    const exec = scaleway();
    const { code, err } = cli(["verify-organisation", "production"], exec, { SCW_DEFAULT_PROJECT_ID: "elsewhere" });
    expect(code).toBe(1);
    expect(err).toMatch(/SCW_DEFAULT_PROJECT_ID is elsewhere/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("prints the committed target without any scw call", () => {
    const exec = scaleway();
    const { code, out } = cli(["target", "production"], exec);
    expect(code).toBe(0);
    expect(out.split("\n")).toEqual([
      "region=fr-par",
      "registry-host=rg.fr-par.scw.cloud",
      "image=rg.fr-par.scw.cloud/test-registry/hyde-mcp-gateway",
      "organization-id=00000000-0000-4000-8000-0000000000aa",
      "project-id=00000000-0000-4000-8000-0000000000bb",
    ]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("diff --strict is clean against a matching container and prints no value", () => {
    const { code, out } = cli(["diff", "production", "--strict"], scaleway());
    expect(code).toBe(0);
    expect(out).toBe("No drift detected.");
  });

  it("apply logs no secret value, on success or failure", () => {
    const ok = cli(["apply", "production"], scaleway(), SECRETS);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain(`containerId=${LIVE.id}`);
    expect(ok.out).toContain("endpoint=https://");

    const failing = vi.fn((args: string[]): ScwExecResult =>
      args.includes("update") ? { stdout: "", stderr: "rejected", exitCode: 1 } : scaleway()(args),
    );
    const bad = cli(["apply", "production"], failing as ReturnType<typeof scaleway>, SECRETS);
    expect(bad.code).toBe(1);
    for (const text of [ok.out, ok.err, bad.out, bad.err]) {
      expect(text).not.toContain("t".repeat(32));
      expect(text).not.toContain("cockpit-secret");
    }
  });
});
