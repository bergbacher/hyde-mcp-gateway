import { describe, expect, it } from "vitest";
import { checkViews, compareViews, groupColumns, parseRedactedSchema, staleNotice, VIEW_COLUMNS_SQL, type ViewColumns } from "../src/db/views.ts";
import { sqlReadiness } from "../src/mcp/sql.ts";
import { answering, connectInMemory, FIXTURE_REDACTED_SCHEMA, FIXTURE_VIEW_COLUMNS, textOf } from "./helpers.ts";

const views = (entries: Record<string, string[]>): ViewColumns => new Map(Object.entries(entries).map(([v, cs]) => [v, new Set(cs)]));
const FIX = "Fix: drop → migrate → apply (docs/runbooks/redacted-reader.md).";

describe("parseRedactedSchema", () => {
  it("reads the views and columns of hyde-db's MySQL redacted-schema.md", () => {
    expect(parseRedactedSchema(FIXTURE_REDACTED_SCHEMA)).toEqual(views({
      users: ["id", "created_at", "country", "plan"],
      orders: ["id", "user_id", "total_cents", "placed_at"],
    }));
  });

  it("undoes the code span and the identifier quoting, including backticks and pipes in names", () => {
    const md = [
      "## `odd``view`",
      "",
      "| column | Prisma type | notes |",
      "|---|---|---|",
      "| ```` `ends``` ```` | String |  |",
      "| `` `a\\|b` `` | Int | a \\| note |",
      "",
      "Joins:",
      "- `` `odd``view` ``.`` `x` `` = `` `other` ``.`` `id` ``",
    ].join("\n");
    expect(parseRedactedSchema(md)).toEqual(views({ "odd`view": ["ends`", "a|b"] }));
  });

  it("finds no views in a document without view headings", () => {
    expect(parseRedactedSchema("# shop\n\nNothing here.\n").size).toBe(0);
  });
});

describe("compareViews", () => {
  const doc = views({ users: ["id", "plan"], orders: ["id", "total_cents"] });

  it("finds nothing when the views match", () => {
    expect(compareViews(doc, views({ orders: ["total_cents", "id"], users: ["plan", "id"] })))
      .toEqual({ missingViews: [], extraViews: [], columnDiffs: [] });
  });

  it("names a view the database lacks", () => {
    expect(compareViews(doc, views({ users: ["id", "plan"] }))).toEqual({ missingViews: ["orders"], extraViews: [], columnDiffs: [] });
  });

  it("names a view the document does not list", () => {
    expect(compareViews(doc, views({ users: ["id", "plan"], orders: ["id", "total_cents"], legacy: ["id"] })))
      .toEqual({ missingViews: [], extraViews: ["legacy"], columnDiffs: [] });
  });

  it("names a column the views lack (added to the schema) and one they still have (removed from it)", () => {
    expect(compareViews(doc, views({ users: ["id"], orders: ["id", "total_cents", "email"] }))).toEqual({
      missingViews: [],
      extraViews: [],
      columnDiffs: [{ view: "users", missing: ["plan"], extra: [] }, { view: "orders", missing: [], extra: ["email"] }],
    });
  });

  it("ignores hyde-db's marker view", () => {
    expect(groupColumns([["hyde_db_marker", "marker"], ["users", "id"]])).toEqual(views({ users: ["id"] }));
  });
});

describe("staleNotice", () => {
  it("is absent when the views match, and names every difference and the fix otherwise", () => {
    expect(staleNotice(checkViews(FIXTURE_REDACTED_SCHEMA, FIXTURE_VIEW_COLUMNS))).toBeUndefined();
    const notice = staleNotice({
      ok: true,
      diff: { missingViews: ["orders"], extraViews: ["legacy"], columnDiffs: [{ view: "users", missing: ["plan"], extra: ["email"] }] },
    });
    expect(notice).toBe(
      "Stale views: missing views `orders`; views not in this schema `legacy`; view `users` lacks `plan`, has columns not in this schema `email`. " +
      `Queries that name them may fail. ${FIX}`,
    );
  });

  it("says the check could not run for a document without views", () => {
    const check = checkViews("# shop\n", FIXTURE_VIEW_COLUMNS);
    expect(check).toEqual({ ok: false, reason: "the redacted schema lists no views" });
    expect(staleNotice(check)).toMatch(/^Stale views: the check could not run: the redacted schema lists no views\./);
  });
});

describe("describe_schema and stale views (D48)", () => {
  async function describeWith(viewColumns: () => Promise<[string, string][]>) {
    const calls: string[] = [];
    const databases = answering(
      (_app, sql) => { calls.push(`query: ${sql}`); return Promise.reject(new Error("reached query")); },
      async (app) => { calls.push(`viewColumns: ${app}`); return viewColumns(); },
    );
    const client = await connectInMemory({ sql: sqlReadiness({ databases, schemas: new Map([["shop", FIXTURE_REDACTED_SCHEMA]]) }) });
    const describe = async () => {
      const result = await client.callTool({ name: "describe_schema", arguments: { app: "shop" } });
      expect(result.isError).toBeFalsy();
      return textOf(result);
    };
    return { describe, calls, close: () => client.close() };
  }

  it("returns the document alone when the views match", async () => {
    const { describe, close } = await describeWith(async () => FIXTURE_VIEW_COLUMNS);
    expect(await describe()).toBe(FIXTURE_REDACTED_SCHEMA);
    await close();
  });

  it("puts a notice naming the differences above the document for views from an older schema", async () => {
    const older: [string, string][] = FIXTURE_VIEW_COLUMNS.filter(([v, c]) => !(v === "users" && c === "plan"));
    const { describe, close } = await describeWith(async () => [...older, ["users", "email_hash"]]);
    expect(await describe()).toBe(
      `Stale views: view \`users\` lacks \`plan\`, has columns not in this schema \`email_hash\`. Queries that name them may fail. ${FIX}\n\n` +
      FIXTURE_REDACTED_SCHEMA,
    );
    await close();
  });

  it("asks the database afresh on every call, through viewColumns only", async () => {
    let rows = FIXTURE_VIEW_COLUMNS;
    const { describe, calls, close } = await describeWith(async () => rows);
    expect(await describe()).toBe(FIXTURE_REDACTED_SCHEMA);
    rows = FIXTURE_VIEW_COLUMNS.filter(([v]) => v !== "orders");
    expect(await describe()).toMatch(/^Stale views: missing views `orders`\./);
    expect(calls).toEqual(["viewColumns: shop", "viewColumns: shop"]);
    await close();
  });

  it("returns the document with a notice that the check could not run when the database cannot be read", async () => {
    const { describe, close } = await describeWith(() => Promise.reject(new Error("getaddrinfo ENOTFOUND rdb.example.invalid")));
    const text = await describe();
    expect(text).toBe(
      "Stale views: the check could not run: the redacted database could not be read. The views may not match this schema.\n\n" +
      FIXTURE_REDACTED_SCHEMA,
    );
    // The database's error, which can name the host, stays out of the answer.
    expect(text).not.toMatch(/ENOTFOUND|example\.invalid/);
    await close();
  });

  it("leaves query_sql unchanged: no check before a query", async () => {
    const client = await connectInMemory({
      sql: sqlReadiness({
        databases: answering(async () => ({ columns: ["1"], rows: [[1]], truncated: false }), () => Promise.reject(new Error("checked"))),
        schemas: new Map([["shop", FIXTURE_REDACTED_SCHEMA]]),
      }),
    });
    const result = await client.callTool({ name: "query_sql", arguments: { app: "shop", sql: "SELECT 1" } });
    // viewColumns would reject; the query answers as before.
    expect(JSON.parse(textOf(result))).toEqual({ columns: ["1"], rows: [[1]], truncated: false });
    await client.close();
  });

  it("runs the one information_schema query of the issue", () => {
    expect(VIEW_COLUMNS_SQL).toBe("SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'redacted'");
  });
});
