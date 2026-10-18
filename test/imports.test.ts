import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Every .ts file under `dir`, as absolute paths. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
}

/**
 * The relative imports of `file`, resolved to absolute paths: `import … from`,
 * `export … from` (type-only included), bare `import "…"` and `import("…")`.
 */
function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const patterns = [
    /^\s*(?:import|export)\b[^;]*?\bfrom\s+["'](\.{1,2}\/[^"']+)["']/gms,
    /^\s*import\s+["'](\.{1,2}\/[^"']+)["']/gm,
    /\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
  ];
  return patterns.flatMap((p) => [...source.matchAll(p)].map((m) => resolve(dirname(file), m[1]!)));
}

/** The first import cycle found, as src-relative paths from a module back to itself; undefined when there is none. */
function findCycle(graph: Map<string, string[]>): string[] | undefined {
  const done = new Set<string>();
  const path: string[] = [];
  function visit(node: string): string[] | undefined {
    const at = path.indexOf(node);
    if (at >= 0) return [...path.slice(at), node];
    if (done.has(node)) return undefined;
    path.push(node);
    for (const next of graph.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    done.add(node);
    return undefined;
  }
  for (const node of graph.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle.map((f) => relative(SRC, f));
  }
  return undefined;
}

describe("imports under src/", () => {
  it("form no cycle", () => {
    const files = sources(SRC);
    const graph = new Map(files.map((f) => [f, importsOf(f)]));
    expect(graph.get(join(SRC, "mcp/server.ts"))?.length).toBeGreaterThan(0);
    expect(findCycle(graph)).toBeUndefined();
  });

  it("finds a cycle when there is one", () => {
    const graph = new Map([["/a.ts", ["/b.ts"]], ["/b.ts", ["/c.ts"]], ["/c.ts", ["/a.ts"]]]);
    expect(findCycle(graph)).toHaveLength(4);
  });
});
