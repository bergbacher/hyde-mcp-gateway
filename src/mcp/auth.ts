// Bearer-token check in constant time. Returns the client name or undefined.

import { timingSafeEqual } from "node:crypto";

export function authenticate(header: string | undefined, clients: Map<string, string>): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return undefined;
  const given = Buffer.from(match[1]!);
  for (const [token, name] of clients) {
    const known = Buffer.from(token);
    if (known.length === given.length && timingSafeEqual(known, given)) return name;
  }
  return undefined;
}
