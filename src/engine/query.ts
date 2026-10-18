// Runs one guarded SELECT as the redacted reader. The database privileges are
// the boundary (D2); this code only bounds the run: a statement timeout, a row
// cap and a result size cap. Rows are streamed, so a query that would return
// more is cut off at the cap instead of being read into memory.

import type { Connection } from "mysql2";
import type { PoolConnection } from "mysql2/promise";

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 1000;
export const TIMEOUT_MS = 15_000;
export const MAX_RESULT_BYTES = 1_000_000;

export interface QueryOptions {
  limit: number;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

/** The row cap for a requested limit: default 200, at least 1, at most 1000. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * Runs `sql` (already through the guard) on `conn` and releases it. Database
 * errors reject with the database's message unchanged.
 */
export async function runQuery(conn: PoolConnection, sql: string, options: QueryOptions): Promise<QueryResult> {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_RESULT_BYTES;
  let stopped = false;
  try {
    // The server cancels a SELECT running past max_execution_time. sql_select_limit
    // lets it stop one row past the cap unless the query carries its own LIMIT.
    await conn.query("SET SESSION max_execution_time = ?, sql_select_limit = ?", [timeoutMs, options.limit + 1]);
    return await new Promise<QueryResult>((resolve, reject) => {
      const result: QueryResult = { columns: [], rows: [], truncated: false };
      let bytes = 2;
      let isResultSet = false;
      // The client-side timeout is a backstop in case the server does not cancel.
      // The callback connection underneath streams rows as events; the promise wrapper buffers them.
      const raw = conn.connection as unknown as Connection;
      const query = raw.query({ sql, rowsAsArray: true, timeout: timeoutMs + 2_000 });
      query.on("fields", (fields: { name: string }[]) => {
        isResultSet = true;
        result.columns = fields.map((f) => f.name);
        bytes += Buffer.byteLength(JSON.stringify(result.columns));
      });
      query.on("result", (row: unknown) => {
        if (stopped) return;
        if (!isResultSet) return reject(new Error("query_sql accepts a single SELECT statement"));
        const values = (row as unknown[]).map(toJson);
        const size = Buffer.byteLength(JSON.stringify(values)) + 1;
        if (result.rows.length >= options.limit || bytes + size > maxBytes) {
          // Destroying the connection is how a running result set is abandoned.
          stopped = true;
          result.truncated = true;
          conn.destroy();
          return resolve(result);
        }
        bytes += size;
        result.rows.push(values);
      });
      query.on("error", (e: Error) => {
        if (!stopped) reject(e);
      });
      query.on("end", () => {
        if (stopped) return;
        if (!isResultSet) return reject(new Error("query_sql accepts a single SELECT statement"));
        resolve(result);
      });
    });
  } catch (e) {
    // A database error ("Unknown column") leaves the connection usable; a timeout or lost connection does not.
    if ((e as { fatal?: boolean }).fatal) {
      stopped = true;
      conn.destroy();
    }
    throw e;
  } finally {
    if (!stopped) conn.release();
  }
}

function toJson(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (typeof value === "bigint") return value.toString();
  return value;
}
