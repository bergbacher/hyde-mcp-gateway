import { vi } from "vitest";
import type { InfraConfig, ScwExecResult } from "../../scripts/infra/config.ts";
import type { LiveContainer } from "../../scripts/infra/kinds/container.ts";

export function config(
  overrides: Partial<InfraConfig["container"]> = {},
  variables?: InfraConfig["variables"],
): InfraConfig {
  return {
    environment: "production",
    region: "fr-par",
    organizationId: "00000000-0000-4000-8000-0000000000aa",
    projectId: "00000000-0000-4000-8000-0000000000bb",
    registryEndpoint: "rg.fr-par.scw.cloud/test-registry",
    container: {
      name: "hyde-mcp-gateway",
      "namespace-id": "00000000-0000-4000-8000-00000000000a",
      image: "rg.fr-par.scw.cloud/test-registry/hyde-mcp-gateway",
      "min-scale": 0,
      "max-scale": 2,
      "memory-limit-bytes": 1000000000,
      "mvcpu-limit": 500,
      port: 8080,
      protocol: "http1",
      privacy: "public",
      timeout: "300s",
      sandbox: "v2",
      "scaling-option.concurrent-requests-threshold": 80,
      "startup-probe.http.path": "/health",
      "startup-probe.interval": "5s",
      "startup-probe.timeout": "3s",
      "startup-probe.failure-threshold": 12,
      "liveness-probe.http.path": "/health",
      "liveness-probe.interval": "30s",
      "liveness-probe.timeout": "5s",
      "liveness-probe.failure-threshold": 3,
      ...overrides,
    },
    variables: variables ?? [
      { name: "HYDE_TOKEN_AGENT", required: true, secret: true },
      { name: "COCKPIT_LOGS_READ_TOKEN", required: true, secret: true },
      { name: "LOG_LEVEL", required: false, secret: false },
    ],
  };
}

export const LIVE: LiveContainer = {
  id: "c0ffee00-0000-0000-0000-000000000000",
  name: "hyde-mcp-gateway",
  status: "ready",
  namespace_id: "00000000-0000-4000-8000-00000000000a",
  domain_name: "hyde-mcp-gateway.example.invalid",
  image: "rg.fr-par.scw.cloud/test-registry/hyde-mcp-gateway:abcdef",
  min_scale: 0,
  max_scale: 2,
  memory_limit_bytes: 1000000000,
  mvcpu_limit: 500,
  port: 8080,
  protocol: "http1",
  privacy: "public",
  timeout: "300.000000000s",
  sandbox: "v2",
  scaling_option: { concurrent_requests_threshold: 80 },
  startup_probe: { http: { path: "/health" }, interval: "5.000000000s", timeout: "3.000000000s", failure_threshold: 12 },
  liveness_probe: { http: { path: "/health" }, interval: "30.000000000s", timeout: "5.000000000s", failure_threshold: 3 },
  environment_variables: {},
  secret_environment_variables: { HYDE_TOKEN_AGENT: "$argon2id$digest", COCKPIT_LOGS_READ_TOKEN: "$argon2id$digest" },
};

/** `list` answers `list`, `get` answers `get`; every write answers `{}` and is recorded. */
export function makeExec(list: unknown[], get: unknown = LIVE) {
  return vi.fn((args: string[]): ScwExecResult => {
    if (args.includes("list")) return { stdout: JSON.stringify(list), exitCode: 0 };
    if (args.includes("get")) return { stdout: JSON.stringify(get), exitCode: 0 };
    return { stdout: "{}", exitCode: 0 };
  });
}
