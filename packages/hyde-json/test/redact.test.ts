import { describe, expect, it } from "vitest";
import { HIDDEN, parseSchema, redactLine } from "../src/index.ts";

const schema = parseSchema({
  app: "crm",
  fields: {
    action: "visible",
    error: "visible",
    level: "visible",
    timestamp: "visible",
    service: "visible",
    "message.memberId": "visible",
    "message.email": "hidden",
    "message.note": "text",
    "message.err": "text",
    "message.err.code": "visible",
  },
});

const line = (message: unknown) =>
  JSON.stringify({ action: "a", error: false, level: "info", timestamp: "2026-10-18T08:15:00.000Z", service: "crm", message });

const envelope = (inner: string) =>
  JSON.stringify({ resource_instance: "c0ffee00-1111-2222-3333-444455556666", message: inner, stream: "stdout" });

function frames(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `    at fn${i} (/app/lib/business/sepa/step${i}.ts:${10 + i}:${3 + i})`);
}

describe("redactLine", () => {
  it("visible passes, hidden becomes [hidden]", () => {
    const out = redactLine(line({ memberId: 4711, email: "jane.k@example.org" }), schema);
    expect(out.format).toBe("json");
    expect(out.line).toMatchObject({ message: { memberId: 4711, email: HIDDEN } });
  });

  it("an undeclared field is [hidden], also an undeclared object", () => {
    const out = redactLine(line({ memberId: 1, iban: "DE89370400440532013000", profile: { city: "Kiel" } }), schema);
    expect(out.line).toMatchObject({ message: { memberId: 1, iban: HIDDEN, profile: HIDDEN } });
    expect(redactLine(JSON.stringify({ extra: "x", level: "info" }), schema).line).toEqual({ extra: HIDDEN, level: "info" });
  });

  it("a text field is scrubbed", () => {
    const out = redactLine(line({ note: "Mail an jane.k@example.org fehlgeschlagen" }), schema);
    expect(out.line).toMatchObject({ message: { note: "Mail an [email] fehlgeschlagen" } });
  });

  it("an Error with a 14-frame stack keeps every frame and scrubs the message line", () => {
    const at = frames(14);
    const err = {
      name: "MailError",
      message: "Mail an jane.k@example.org fehlgeschlagen",
      stack: ["MailError: Mail an jane.k@example.org fehlgeschlagen", ...at].join("\n"),
      code: "E_MAIL",
    };
    const out = redactLine(line({ err }), schema).line as { message: { err: typeof err } };
    const stack = out.message.err.stack.split("\n");
    expect(stack).toHaveLength(15);
    expect(stack[0]).toBe("MailError: Mail an [email] fehlgeschlagen");
    expect(stack.slice(1)).toEqual(at);
    expect(out.message.err).toMatchObject({ name: "MailError", message: "Mail an [email] fehlgeschlagen", code: "E_MAIL" });
  });

  it("an Error's multi-line message is scrubbed on every non-frame line", () => {
    const stack = ["Error: first line", "member jane.k@example.org", ...frames(2)].join("\n");
    const out = redactLine(line({ err: { name: "Error", message: "x", stack } }), schema).line as { message: { err: { stack: string } } };
    expect(out.message.err.stack).toBe(["Error: first line", "member [email]", ...frames(2)].join("\n"));
  });

  it("an Error at an undeclared path stays [hidden]", () => {
    const out = redactLine(line({ cause: { name: "Error", message: "m", stack: "Error: m\n    at x (a.ts:1:1)" } }), schema);
    expect(out.line).toMatchObject({ message: { cause: HIDDEN } });
  });

  it("a non-JSON line is scrubbed as text", () => {
    const out = redactLine("Mail an jane.k@example.org fehlgeschlagen, ruf +49 170 1234567 an", schema);
    expect(out).toEqual({ format: "text", line: "Mail an [email] fehlgeschlagen, ruf [phone] an" });
  });

  it("JSON that is not an object is scrubbed as text", () => {
    expect(redactLine('"jane.k@example.org"', schema)).toEqual({ format: "text", line: '"[email]"' });
  });

  it("unwraps the Scaleway envelope", () => {
    const out = redactLine(envelope(line({ memberId: 7, email: "jane.k@example.org" })), schema);
    expect(out.envelope).toEqual({ resource_instance: "c0ffee00-1111-2222-3333-444455556666", stream: "stdout" });
    expect(out.format).toBe("json");
    expect(out.line).toMatchObject({ level: "info", message: { memberId: 7, email: HIDDEN } });
  });

  it("an envelope around a non-JSON message scrubs the message as text", () => {
    const out = redactLine(envelope("listening for jane.k@example.org"), schema);
    expect(out).toMatchObject({ format: "text", line: "listening for [email]" });
    expect(out.envelope?.stream).toBe("stdout");
  });

  it("numbers and *Id fields pass only when the schema says so", () => {
    const payload = line({ paymentId: "pi_3Kx", id: 5, amount: 1200, count: "3" });
    expect(redactLine(payload, schema).line).toMatchObject({ message: { paymentId: HIDDEN, id: HIDDEN, amount: HIDDEN } });
    const lenient = parseSchema({ app: "crm", passIds: true, passNumbers: true, fields: { message: "visible" } });
    expect(redactLine(payload, lenient).line).toMatchObject({ message: { paymentId: "pi_3Kx", id: 5, amount: 1200, count: HIDDEN } });
  });

  it("explicit hidden beats passIds", () => {
    const s = parseSchema({ app: "crm", passIds: true, fields: { "message.secretId": "hidden" } });
    expect(redactLine(line({ secretId: 9, userId: 3 }), s).line).toMatchObject({ message: { secretId: HIDDEN, userId: 3 } });
  });

  it("array elements share their array's path", () => {
    const s = parseSchema({ app: "crm", fields: { "message.ids": "visible", "message.items.id": "visible" } });
    const out = redactLine(line({ ids: [1, 2], items: [{ id: 1, email: "a@b.de" }] }), s);
    expect(out.line).toMatchObject({ message: { ids: [1, 2], items: [{ id: 1, email: HIDDEN }] } });
  });

  it("a __proto__ key stays data", () => {
    const out = redactLine('{"__proto__":{"polluted":true},"level":"info"}', schema).line as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("a realistic crm line", () => {
  const crm = parseSchema({
    app: "crm",
    fields: {
      action: "visible",
      error: "visible",
      level: "visible",
      timestamp: "visible",
      service: "visible",
      "message.memberId": "visible",
      "message.email": "hidden",
      "message.err": "text",
    },
  });
  const stack = [
    "PrismaClientKnownRequestError: ",
    "Invalid `prisma.sepaMandate.create()` invocation in",
    "/app/lib/business/sepa/mandate.ts:88:12",
    "Unique constraint failed on the fields: (`email`)",
    "    at create (lib/business/sepa/mandate.ts:88:12)",
    "    at async createMandate (lib/business/sepa/service.ts:41:5)",
    "    at async POST (app/api/sepa/mandate/route.ts:23:20)",
  ].join("\n");
  const app = {
    action: "sepa-mandate-create",
    error: true,
    level: "error",
    timestamp: "2026-10-18T08:15:02.311Z",
    service: "crm",
    message: {
      memberId: 4711,
      email: "jane.k@example.org",
      err: { name: "PrismaClientKnownRequestError", message: "Unique constraint failed on the fields: (`email`)", stack },
    },
  };

  it("passes the allowlist, hides the email, keeps the error readable", () => {
    const out = redactLine(envelope(JSON.stringify(app)), crm);
    expect(out.envelope?.stream).toBe("stdout");
    expect(out.line).toEqual({ ...app, message: { ...app.message, email: HIDDEN } });
    expect(JSON.stringify(out)).not.toContain("jane.k");
  });
});
