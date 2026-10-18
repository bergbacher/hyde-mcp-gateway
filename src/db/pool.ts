// One mysql2 pool per app, created on first use, connecting as the redacted
// reader to database `redacted` (src/db/connection.ts).
//
// TLS: mysql2 verifies the chain against the instance CA but checks identity
// only against the host it connects to, which the instance certificate does
// not name. So the identity is checked here, against the certificate name
// (`servername`), on every connection before its first query. With the
// self-signed instance certificate as the only trust anchor, the chain check
// already pins that certificate; the name check confirms which one.

import { checkServerIdentity, TLSSocket } from "node:tls";
import mysql from "mysql2/promise";
import type { App } from "../registry.ts";
import type { DatabaseConfig } from "./connection.ts";

export interface Databases {
  /** A verified connection to the app's redacted database; release it when done. */
  connect(app: App): Promise<mysql.PoolConnection>;
  has(app: App): boolean;
  close(): Promise<void>;
}

export function createDatabases(configs: ReadonlyMap<App, DatabaseConfig>): Databases {
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

  return {
    has: (app) => configs.has(app),
    async connect(app) {
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
    },
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
