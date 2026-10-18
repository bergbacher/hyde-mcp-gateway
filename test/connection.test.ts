import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config.ts";
import { resolveDatabase } from "../src/db/connection.ts";
import { REGISTRY } from "./helpers.ts";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const TLS_URL = "mysql://redacted_reader:p%40ss@rw-instance.rdb.example.test:3306/redacted?ssl=true";
const base = { name: "HYDE_APP_X_REDACTED_URL", caName: "HYDE_APP_X_DATABASE_CA", ca: undefined, certName: undefined, production: false };

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
    expect(() => resolveDatabase({ ...base, url: TLS_URL })).toThrow(/HYDE_APP_X_DATABASE_CA/);
    expect(() => resolveDatabase({ ...base, url: TLS_URL, ca: PEM })).toThrow(/database\.certName/);
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
    expect(() => resolveDatabase({ ...base, url: "not a url secret-password" })).toThrow(/^HYDE_APP_X_REDACTED_URL: not a valid connection string$/);
  });

  it("config reads each app's database; in production an app with a URL needs its CA (D37)", () => {
    const token = { HYDE_TOKEN_X: "a".repeat(32) };
    expect(readConfig(REGISTRY, token).databases.size).toBe(0);
    const c = readConfig(REGISTRY, { ...token, HYDE_APP_SHOP_REDACTED_URL: "mysql://r:x@localhost/redacted" });
    expect([...c.databases.keys()]).toEqual(["shop"]);
    expect(readConfig(REGISTRY, { ...token, NODE_ENV: "production" }).databases.size).toBe(0);
    const shopOnly = readConfig(REGISTRY, { ...token, NODE_ENV: "production", HYDE_APP_SHOP_REDACTED_URL: TLS_URL, HYDE_APP_SHOP_DATABASE_CA: PEM });
    expect([...shopOnly.databases.keys()]).toEqual(["shop"]);
    // The certificate name comes from apps.json.
    expect(shopOnly.databases.get("shop")?.tls?.servername).toBe(REGISTRY.apps.get("shop")!.database.certName);
    expect(() => readConfig(REGISTRY, { ...token, NODE_ENV: "production", HYDE_APP_SHOP_REDACTED_URL: TLS_URL }))
      .toThrow(/^HYDE_APP_SHOP_REDACTED_URL: .*HYDE_APP_SHOP_DATABASE_CA/);
    expect(() =>
      readConfig(REGISTRY, {
        ...token, NODE_ENV: "production",
        HYDE_APP_SHOP_REDACTED_URL: TLS_URL, HYDE_APP_CRM_REDACTED_URL: TLS_URL, HYDE_APP_SHOP_DATABASE_CA: PEM,
      }),
    ).toThrow(/HYDE_APP_CRM_DATABASE_CA/);
  });
});
