import { describe, expect, it } from "vitest";
import { scrubStack, scrubText } from "../src/index.ts";

describe("scrubText", () => {
  it.each([
    ["Mail an jane.k@example.org fehlgeschlagen", "Mail an [email] fehlgeschlagen"],
    ["IBAN DE89 3704 0044 0532 0130 00 ungültig", "IBAN [iban] ungültig"],
    ["IBAN DE89370400440532013000", "IBAN [iban]"],
    ["call +49 170 1234567 or 0170/1234567", "call [phone] or [phone]"],
    ["GET https://crm.example/api/members?email=jane%40x.de&token=abc 500", "GET https://crm.example/api/members?[query] 500"],
    ["Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig-nature_x", "Bearer [token]"],
    ["key sk_live_51Hx0abcDEFghiJKLmnoPQR expired", "key [token] expired"],
  ])("%s", (input, expected) => {
    expect(scrubText(input)).toBe(expected);
  });

  it.each([
    "Unique constraint failed on the fields: (`email`)",
    "at 2026-10-18T08:15:02.311+02:00 after 1500 ms, retry 3 of 5",
    "PrismaClientKnownRequestError in lib/business/sepa/mandate.ts:88:12",
    "Did you mean? try again",
  ])("leaves technical text alone: %s", (input) => {
    expect(scrubText(input)).toBe(input);
  });
});

describe("scrubStack", () => {
  it("keeps frames whole, scrubs the rest", () => {
    const frame = "    at Object.send (file:///app/lib/mail/send.ts:12:7)";
    expect(scrubStack(`Error: to jane.k@example.org\n${frame}`)).toBe(`Error: to [email]\n${frame}`);
  });
});
