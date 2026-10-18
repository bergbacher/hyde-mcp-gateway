import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config.ts";
import { resolveDatabase } from "../src/db/connection.ts";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const TLS_URL = "mysql://redacted_reader:p%40ss@rw-instance.rdb.example.test:3306/redacted?ssl=true";
const base = { name: "CRM_REDACTED_URL", ca: undefined, certName: undefined, production: false };

describe("database connection", () => {
  it("ssl=true verifies against the CA with the certificate name", () => {
    const db = resolveDatabase({ ...base, url: TLS_URL, ca: PEM, certName: "instance-id", production: true });
    expect(db).toEqual({
      host: "rw-instance.rdb.example.test",
      port: 3306,
      user: "redacted_reader",
      password: "p@ss",
      database: "redacted",
      tls: { ca: PEM, servername: "instance-id" },
    });
  });

  it("ssl=true without CA or certificate name is refused", () => {
    expect(() => resolveDatabase({ ...base, url: TLS_URL })).toThrow(/CRM_DATABASE_CA/);
    expect(() => resolveDatabase({ ...base, url: TLS_URL, ca: PEM })).toThrow(/CRM_DATABASE_CERT_NAME/);
  });

  it("without ssl=true: plain locally, refused in production", () => {
    const local = "mysql://redacted_reader:x@127.0.0.1:3306/redacted";
    expect(resolveDatabase({ ...base, url: local }).tls).toBeUndefined();
    expect(() => resolveDatabase({ ...base, url: local, production: true })).toThrow(/production needs TLS/);
    expect(() => resolveDatabase({ ...base, url: local, ca: PEM })).toThrow(/lacks `ssl=true`/);
  });

  it("always reads database `redacted`", () => {
    expect(resolveDatabase({ ...base, url: "mysql://r:x@localhost" }).database).toBe("redacted");
    expect(() => resolveDatabase({ ...base, url: "mysql://r:x@localhost/app" })).toThrow(/`app`/);
  });

  it("refuses unknown parameters, addresses under TLS, and keeps the password out of errors", () => {
    expect(() => resolveDatabase({ ...base, url: `${TLS_URL}&sslaccept=strict` })).toThrow(/sslaccept/);
    const ip = "mysql://r:x@203.0.113.1/redacted?ssl=true";
    expect(() => resolveDatabase({ ...base, url: ip, ca: PEM, certName: "id" })).toThrow(/DNS name/);
    expect(() => resolveDatabase({ ...base, url: "not a url secret-password" })).toThrow(/^CRM_REDACTED_URL: not a valid connection string$/);
  });

  it("config reads each app's database and requires both in production", () => {
    const token = { HYDE_TOKEN_X: "a".repeat(32) };
    expect(readConfig(token).databases).toEqual({});
    const c = readConfig({ ...token, SHOP_REDACTED_URL: "mysql://r:x@localhost/redacted" });
    expect(Object.keys(c.databases)).toEqual(["shop"]);
    expect(() => readConfig({ ...token, NODE_ENV: "production" })).toThrow(/SHOP_REDACTED_URL is not set/);
    expect(() =>
      readConfig({ ...token, NODE_ENV: "production", SHOP_REDACTED_URL: TLS_URL, CRM_REDACTED_URL: TLS_URL, SHOP_DATABASE_CA: PEM, SHOP_DATABASE_CERT_NAME: "m" }),
    ).toThrow(/CRM_DATABASE_CA/);
  });
});
