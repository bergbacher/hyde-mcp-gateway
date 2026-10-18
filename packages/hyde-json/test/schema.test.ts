import { describe, expect, it } from "vitest";
import { parseSchema } from "../src/index.ts";

describe("parseSchema", () => {
  it("accepts visible, hidden and text with dotted paths", () => {
    const s = parseSchema({ app: "crm", fields: { level: "visible", "message.email": "hidden", "message.err": "text" } });
    expect(s).toMatchObject({ app: "crm", passIds: false, passNumbers: false });
    expect({ ...s.fields }).toEqual({ level: "visible", "message.email": "hidden", "message.err": "text" });
    expect(Object.isFrozen(s.fields)).toBe(true);
  });

  it("rejects a field that is neither visible, hidden nor text", () => {
    expect(() => parseSchema({ app: "crm", fields: { "message.email": "masked" } })).toThrow(/"message.email": "masked" is not one of visible, hidden, text/);
    expect(() => parseSchema({ app: "crm", fields: { level: true } })).toThrow(/not one of/);
  });

  it("rejects malformed shapes and paths", () => {
    expect(() => parseSchema(null)).toThrow(/not an object/);
    expect(() => parseSchema({ fields: {} })).toThrow(/"app"/);
    expect(() => parseSchema({ app: "crm" })).toThrow(/"fields"/);
    expect(() => parseSchema({ app: "crm", fields: {}, passIds: "yes" })).toThrow(/"passIds"/);
    expect(() => parseSchema({ app: "crm", fields: {}, extra: 1 })).toThrow(/unknown key "extra"/);
    expect(() => parseSchema({ app: "crm", fields: { "message..email": "hidden" } })).toThrow(/not a dotted path/);
  });

  it("rejects a field under a hidden parent", () => {
    expect(() => parseSchema({ app: "crm", fields: { message: "hidden", "message.memberId": "visible" } })).toThrow(/under hidden "message"/);
  });
});
