import { describe, expect, it } from "vitest";
import { guardStatement } from "../src/db/guard.ts";
import { clampLimit } from "../src/engine/query.ts";

const ok = (sql: string) => {
  const r = guardStatement(sql);
  if (!r.ok) throw new Error(r.reason);
  return r.sql;
};
const refused = (sql: string) => {
  const r = guardStatement(sql);
  if (r.ok) throw new Error(`accepted: ${sql}`);
  return r.reason;
};

describe("statement guard", () => {
  it("allows a SELECT, any case, with one trailing semicolon cut", () => {
    expect(ok("SELECT id, status FROM users LIMIT 5")).toBe("SELECT id, status FROM users LIMIT 5");
    expect(ok("  select 1 ;  ")).toBe("select 1");
    expect(ok("SELECT 1; -- done")).toBe("SELECT 1");
  });

  it("allows a CTE leading into SELECT", () => {
    expect(ok("WITH a AS (SELECT id FROM users), b (x) AS (SELECT 1) SELECT * FROM a JOIN b")).toMatch(/^WITH/);
    expect(ok("with recursive n AS (SELECT 1 AS i UNION ALL SELECT i + 1 FROM n WHERE i < 3) select i from n")).toMatch(/^with/);
  });

  it("refuses a CTE leading into a write", () => {
    expect(refused("WITH a AS (SELECT id FROM users) UPDATE users SET status = 'x'")).toMatch(/UPDATE/);
    expect(refused("WITH a AS (SELECT 1) DELETE FROM users")).toMatch(/DELETE/);
  });

  it("refuses writes and anything not starting with SELECT", () => {
    expect(refused("UPDATE users SET status = 'x'")).toMatch(/only SELECT.*UPDATE/);
    expect(refused("delete from users")).toMatch(/DELETE/);
    expect(refused("INSERT INTO users VALUES (1)")).toMatch(/INSERT/);
    expect(refused("SHOW TABLES")).toMatch(/SHOW/);
    expect(refused("(SELECT 1)")).toMatch(/only SELECT/);
    expect(refused("")).toMatch(/empty/);
    expect(refused("-- nothing")).toMatch(/empty/);
  });

  it("refuses two statements", () => {
    expect(refused("SELECT 1; SELECT 2")).toMatch(/one statement/);
    expect(refused("SELECT 1; DROP TABLE users")).toMatch(/one statement/);
    expect(refused("SELECT 1;;")).toMatch(/one statement/);
    expect(refused("SELECT 1; /* c */ UPDATE users SET a = 1")).toMatch(/one statement/);
  });

  it("refuses semicolons hidden in comments and executable comments", () => {
    expect(refused("SELECT 1 /* ; */")).toMatch(/comment/);
    expect(refused("SELECT 1 -- ;\n FROM users")).toMatch(/comment/);
    expect(refused("SELECT 1 # x; y")).toMatch(/comment/);
    expect(refused("SELECT 1 /*!50000 , 2 */")).toMatch(/executable/);
    expect(refused("SELECT 1 /* unterminated")).toMatch(/unterminated/);
  });

  it("allows comments without semicolons and semicolons inside quotes", () => {
    expect(ok("SELECT /* note */ id FROM users -- tail")).toMatch(/^SELECT/);
    expect(ok("SELECT id FROM users WHERE status = 'a;b'")).toMatch(/'a;b'$/);
    expect(ok(`SELECT "it\\'s; fine", 'it''s; fine', \`odd;name\` FROM users`)).toMatch(/FROM users$/);
    expect(ok("SELECT 1--1")).toBe("SELECT 1--1");
  });

  it("does not let a quote hide a second statement", () => {
    expect(refused("SELECT 'a'; UPDATE users SET a = ';'")).toMatch(/one statement/);
    expect(refused("SELECT 'unterminated; UPDATE users")).toMatch(/unterminated/);
  });
});

describe("limit", () => {
  it("defaults to 200 and clamps to 1..1000", () => {
    expect(clampLimit(undefined)).toBe(200);
    expect(clampLimit(5)).toBe(5);
    expect(clampLimit(1000)).toBe(1000);
    expect(clampLimit(5000)).toBe(1000);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-3)).toBe(1);
    expect(clampLimit(Number.NaN)).toBe(200);
  });
});
