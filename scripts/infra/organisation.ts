// Refuses to touch Scaleway unless the credential in scope reaches the
// configured target (infra/environments/<env>.yaml): organisation and project.
//
// Why: `SCW_ACCESS_KEY` / `SCW_SECRET_KEY` may also exist as organisation-level
// GitHub secrets for a different Scaleway organisation, and repository
// secrets of the same name only override them. Without the
// repository pair, that key authenticates fine and a deploy would succeed in
// the wrong place. The credential does not state its organisation, so the
// configured container namespace is read: another organisation's key either
// cannot read it (non-zero exit) or reports a different `organization_id`.
// The namespace, not the project, because a deploy key scoped to Containers
// and Registry may not read projects.

import { assertScwSuccess } from "./config.ts";
import type { ScwExecutor } from "./config.ts";

export const ORGANISATION_ID_ENV = "SCW_DEFAULT_ORGANIZATION_ID";
export const PROJECT_ID_ENV = "SCW_DEFAULT_PROJECT_ID";

export interface Target {
  organizationId: string;
  projectId: string;
  namespaceId: string;
  region: string;
}

export function assertTarget(target: Target, deps: { exec: ScwExecutor; env: Record<string, string | undefined> }): void {
  // A local shell pointing `scw` elsewhere is its own cause, named as such.
  for (const [name, expected] of [
    [ORGANISATION_ID_ENV, target.organizationId],
    [PROJECT_ID_ENV, target.projectId],
  ] as const) {
    const declared = deps.env[name]?.trim();
    if (declared && declared !== expected) {
      throw new Error(`Refusing to run: ${name} is ${declared}, but the configured target (infra/environments) is ${expected}. Unset it.`);
    }
  }

  const args = ["container", "namespace", "get", target.namespaceId, `region=${target.region}`, "-o", "json"];
  const result = deps.exec(args);
  assertScwSuccess(args, result);

  let namespace: { organization_id?: string; project_id?: string };
  try {
    namespace = JSON.parse(result.stdout) as typeof namespace;
  } catch {
    throw new Error(`Refusing to run: \`scw ${args.join(" ")}\` did not answer JSON, so the credential's organisation is unknown.`);
  }
  if (namespace.organization_id !== target.organizationId) {
    throw new Error(
      `Refusing to run: the credential reads container namespace ${target.namespaceId} as organisation ` +
        `${namespace.organization_id ?? "<none>"}, but the configured target (infra/environments) is ${target.organizationId}. ` +
        "Set this repository's own SCW_ACCESS_KEY / SCW_SECRET_KEY; the organisation-level pair belongs elsewhere.",
    );
  }
  if (namespace.project_id !== target.projectId) {
    throw new Error(
      `Refusing to run: container namespace ${target.namespaceId} is in project ${namespace.project_id ?? "<none>"}, ` +
        `but the configured target (infra/environments) is ${target.projectId}.`,
    );
  }
}
