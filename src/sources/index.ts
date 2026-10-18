// The log sources (D51), built once at startup from the registry (D38), the
// schema store's live log schemas (D58) and the environment. Per (app, source)
// the module answers a reader, or what is missing, which the tools refuse in
// the D37 form `<app> is not configured: <missing>` before Loki is asked. The
// answer is asked per call, so a schema refresh changes it without a restart.

import type { App, Registry } from "../registry.ts";
import { appSource } from "./app.ts";
import { edgeSource } from "./edge.ts";
import type { BuiltSource, LogReader, SourceInputs } from "./source.ts";

export { LEVELS } from "./source.ts";
export type { Level, LogFilter, LogLine, LogReader } from "./source.ts";

/** Every source kind; the first is the tools' default. */
export const KINDS = [appSource, edgeSource] as const;
/** A value of the tools' `source` parameter. */
export type Source = (typeof KINDS)[number]["name"];
/** Every `source` value, the default first. */
export const SOURCES = KINDS.map((k) => k.name) as [Source, ...Source[]];

/** The log sources of every registered app, built once (buildLogSources). */
export interface LogSources {
  /** The reader of `app`'s `source`, or what it lacks. */
  reader(app: App, source: Source): LogReader | { missing: string[] };
  /** What `app` lacks for `source`; empty when it answers. */
  missing(app: App, source: Source): string[];
  /** Per source apps.json declares for `app`: its startup group name → what it lacks now. */
  groups(app: App): Record<string, string[]>;
  /** Per source apps.json declares for `app`: the stream selector it reads. */
  streams(app: App): Partial<Record<Source, string>>;
}

/** Throws naming every invalid environment override. */
export function buildLogSources({ registry, ...inputs }: SourceInputs & { registry: Registry }): LogSources {
  const problems: string[] = [];
  const built = new Map<App, Map<Source, BuiltSource>>();
  for (const entry of registry.apps.values()) {
    const sources = new Map<Source, BuiltSource>();
    for (const kind of KINDS) {
      try {
        sources.set(kind.name, kind.build(entry, inputs));
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    built.set(entry.name, sources);
  }
  if (problems.length > 0) throw new Error(`Log sources not configured: ${problems.join("; ")}`);

  const get = (app: App, source: Source): BuiltSource =>
    built.get(app)?.get(source) ?? { stream: null, current: () => ({ missing: [`${app} is not in apps.json`] }) };
  const declared = (app: App) => KINDS.filter((k) => get(app, k.name).stream !== null);
  const missing = (app: App, source: Source) => get(app, source).current().missing ?? [];
  return {
    reader(app, source) {
      const now = get(app, source).current();
      return now.reader ?? { missing: now.missing };
    },
    missing,
    groups: (app) => Object.fromEntries(declared(app).map((k) => [k.group, missing(app, k.name)])),
    streams: (app) => Object.fromEntries(declared(app).map((k) => [k.name, get(app, k.name).stream!])),
  };
}
