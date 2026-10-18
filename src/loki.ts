// A minimal Loki HTTP client for the Cockpit logs data source (D14). It holds
// the only Loki token; its errors name Loki and the status, and carry neither
// a stack, a response body nor the token.

export interface LokiEntry {
  /** Unix epoch in nanoseconds, as Loki sends it. */
  ns: string;
  line: string;
}

export interface Loki {
  /** Log lines of `query` in [start, end], newest first, at most `limit`. */
  queryRange(query: string, range: { start: bigint; end: bigint; limit: number }): Promise<LokiEntry[]>;
  /** The value of a metric `query` at `time`, summed over its series; 0 when empty. */
  instant(query: string, time: bigint): Promise<number>;
}

export class LokiError extends Error {}

export interface LokiOptions {
  url: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export function createLoki({ url, token, fetch = globalThis.fetch, timeoutMs = 30_000 }: LokiOptions): Loki {
  async function get(path: string, params: Record<string, string>): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${url}${path}?${new URLSearchParams(params)}`, {
        headers: { "X-Token": token },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      throw new LokiError(timedOut ? `Loki did not answer within ${timeoutMs / 1000}s` : "Loki is unreachable");
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new LokiError(`Loki answered HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
    }
    try {
      return await res.json();
    } catch {
      throw new LokiError("Loki answered with a body that is not JSON");
    }
  }

  return {
    async queryRange(query, { start, end, limit }) {
      const body = await get("/loki/api/v1/query_range", {
        query, start: String(start), end: String(end), limit: String(limit), direction: "backward",
      });
      const entries: LokiEntry[] = [];
      for (const stream of resultOf(body, "streams")) {
        const values = (stream as { values?: unknown } | null)?.values;
        if (!Array.isArray(values)) throw unexpectedShape();
        for (const v of values) {
          if (!Array.isArray(v) || typeof v[0] !== "string" || !/^\d+$/.test(v[0]) || typeof v[1] !== "string") {
            throw unexpectedShape();
          }
          entries.push({ ns: v[0], line: v[1] });
        }
      }
      // Every distinct label set is its own stream: merge them, newest first.
      entries.sort((a, b) => compareNs(b.ns, a.ns));
      return entries.slice(0, limit);
    },
    async instant(query, time) {
      const body = await get("/loki/api/v1/query", { query, time: String(time) });
      let sum = 0;
      for (const sample of resultOf(body, "vector")) {
        const value = (sample as { value?: unknown } | null)?.value;
        const n = Array.isArray(value) ? Number(value[1]) : NaN;
        if (!Number.isFinite(n)) throw unexpectedShape();
        sum += n;
      }
      return sum;
    },
  };
}

function resultOf(body: unknown, resultType: "streams" | "vector"): unknown[] {
  const data = (body as { data?: { resultType?: unknown; result?: unknown } } | null)?.data;
  if (!data || data.resultType !== resultType || !Array.isArray(data.result)) throw unexpectedShape();
  return data.result;
}

function unexpectedShape(): LokiError {
  return new LokiError("Loki answered in an unexpected shape");
}

function compareNs(a: string, b: string): number {
  const x = BigInt(a), y = BigInt(b);
  return x > y ? 1 : x < y ? -1 : 0;
}

/** Milliseconds → nanoseconds since the epoch. */
export function nsOf(ms: number): bigint {
  return BigInt(Math.round(ms)) * 1_000_000n;
}
