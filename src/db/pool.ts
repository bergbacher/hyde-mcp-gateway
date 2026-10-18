// The redacted databases: one per app, answering one guarded SELECT as the
// redacted reader on database `redacted` (src/db/connection.ts). The database
// privileges are the boundary (D2); this module only bounds the run (D30): a
// 15 s statement timeout, a row cap and a 1 MB result cap. Rows are streamed,
// so a query that would return more is cut off at the cap instead of being
// read into memory. Database errors reject with the database's message unchanged.
//
// Behind the interface: one mysql2 pool per app, created on first use.
//
// TLS: mysql2 verifies the chain against the instance CA but checks identity
// only against the host it connects to, which the instance certificate does
// not name. So the identity is checked here, against the certificate name
// (`servername`), on every connection before its first query (A13). With the
// self-signed instance certificate as the only trust anchor, the chain check
// already pins that certificate; the name check confirms which one.

import { checkServerIdentity, TLSSocket } from "node:tls";
import type { Connection } from "mysql2";
import mysql from "mysql2/promise";
import type { App } from "../registry.ts";
import type { DatabaseConfig } from "./connection.ts";

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 1000;
export const TIMEOUT_MS = 15_000;
export const MAX_RESULT_BYTES = 1_000_000;

/** The bounds of every run; the defaults are D30's, tests lower them. */
export interface Bounds {
  timeoutMs: number;
  maxBytes: number;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  /** A cap cut the result. */
  truncated: boolean;
}

export interface Databases {
  /**
   * Runs `sql`, already through the statement guard (src/db/guard.ts), on the
   * app's redacted database, with at most `limit` rows (clamped by
   * `clampLimit`). Rejects with the database's error unchanged, or when the
   * certificate does not carry the app's certificate name.
   */
  query(app: App, sql: string, limit: number | undefined): Promise<QueryResult>;
  has(app: App): boolean;
  close(): Promise<void>;
}

/** The row cap for a requested limit: default 200, at least 1, at most 1000. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

const NOT_A_SELECT = "query_sql accepts a single SELECT statement";

export function createDatabases(
  configs: ReadonlyMap<App, DatabaseConfig>,
  bounds: Bounds = { timeoutMs: TIMEOUT_MS, maxBytes: MAX_RESULT_BYTES },
): Databases {
  const pools = new Map<App, mysql.Pool>();
  const verified = new WeakSet<object>();

  function pool(app: App): mysql.Pool {
    const config = configs.get(app);
    if (!config) throw new Error(`No database configured for ${app}`);
    let p = pools.get(app);
    if (!p) {
      p = mysql.createPool({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        ssl: config.tls ? { ca: config.tls.ca, rejectUnauthorized: true } : undefined,
        connectionLimit: 4,
        connectTimeout: 10_000,
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
        multipleStatements: false,
      });
      pools.set(app, p);
    }
    return p;
  }

  /** A verified connection to the app's redacted database. */
  async function connect(app: App): Promise<mysql.PoolConnection> {
    const conn = await pool(app).getConnection();
    const servername = configs.get(app)!.tls?.servername;
    if (servername && !verified.has(conn.connection)) {
      try {
        verifyIdentity(conn, servername);
      } catch (e) {
        conn.destroy();
        throw e;
      }
      verified.add(conn.connection);
    }
    return conn;
  }

  return {
    has: (app) => configs.has(app),
    query: async (app, sql, limit) => run(await connect(app), sql, clampLimit(limit), bounds),
    async close() {
      await Promise.all([...pools.values()].map((p) => p.end()));
      pools.clear();
    },
  };
}

function verifyIdentity(conn: mysql.PoolConnection, servername: string) {
  const socket = (conn.connection as unknown as { stream: unknown }).stream;
  if (!(socket instanceof TLSSocket)) throw new Error("Database connection is not TLS although the URL sets ssl=true");
  const error = checkServerIdentity(servername, socket.getPeerCertificate());
  if (error) throw new Error(`Database certificate does not match ${servername}: ${error.message}`);
}

/** Runs `sql` on `conn`, then releases it, or destroys it when it cannot serve another query. */
async function run(conn: mysql.PoolConnection, sql: string, limit: number, { timeoutMs, maxBytes }: Bounds): Promise<QueryResult> {
  let stopped = false;
  try {
    // The server cancels a SELECT running past max_execution_time. sql_select_limit
    // lets it stop one row past the cap unless the query carries its own LIMIT.
    await conn.query("SET SESSION max_execution_time = ?, sql_select_limit = ?", [timeoutMs, limit + 1]);
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
        if (!isResultSet) return reject(new Error(NOT_A_SELECT));
        const values = (row as unknown[]).map(toJson);
        const size = Buffer.byteLength(JSON.stringify(values)) + 1;
        if (result.rows.length >= limit || bytes + size > maxBytes) {
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
        if (!isResultSet) return reject(new Error(NOT_A_SELECT));
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
