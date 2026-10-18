// Refuses everything but a single SELECT before the database is reached. The
// database is the boundary (D2: the reader sees only the redacted views); this
// guard turns writes and statement chains into a clear refusal.
//
// The SQL is scanned with MySQL's lexical rules for quotes and comments: a
// semicolon inside a string or quoted identifier is data; anywhere else,
// comments included, only one trailing semicolon is allowed. Executable
// comments (`/*! ... */`) are refused, since MySQL runs their content.

export type GuardResult = { ok: true; sql: string } | { ok: false; reason: string };

interface Token {
  word?: string;
  char?: string;
  depth: number;
}

const STATEMENT_KEYWORDS = new Set(["SELECT", "UPDATE", "DELETE", "INSERT", "REPLACE", "TABLE", "VALUES"]);

export function guardStatement(input: string): GuardResult {
  const sql = input.trim();
  const tokens: Token[] = [];
  let depth = 0;
  let semicolonAt = -1;

  for (let i = 0; i < sql.length; ) {
    const c = sql[i]!;
    const next = sql[i + 1];

    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "#" || (c === "-" && next === "-" && (i + 2 >= sql.length || /\s/.test(sql[i + 2]!)))) {
      const end = sql.indexOf("\n", i);
      const comment = end === -1 ? sql.slice(i) : sql.slice(i, end);
      if (comment.includes(";")) return refuse("a semicolon inside a comment is not allowed");
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (c === "/" && next === "*") {
      if (sql[i + 2] === "!") return refuse("executable comments (/*! ... */) are not allowed");
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return refuse("unterminated comment");
      if (sql.slice(i, end).includes(";")) return refuse("a semicolon inside a comment is not allowed");
      i = end + 2;
      continue;
    }
    // Anything after the semicolon other than whitespace and comments is a second statement.
    if (semicolonAt !== -1) return refuse("only one statement is allowed");
    if (c === ";") {
      semicolonAt = i;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const end = closingQuote(sql, i);
      if (end === -1) return refuse("unterminated quoted string or identifier");
      tokens.push({ char: c, depth });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let end = i + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end]!)) end++;
      tokens.push({ word: sql.slice(i, end).toUpperCase(), depth });
      i = end;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") depth--;
    tokens.push({ char: c, depth });
    i++;
  }

  const first = tokens[0];
  if (first?.word === "SELECT") return accept(sql, semicolonAt);
  if (first?.word === "WITH") {
    // A CTE list leads into the first top-level statement keyword after it.
    const main = tokens.find((t) => t.depth === 0 && t.word !== undefined && STATEMENT_KEYWORDS.has(t.word));
    if (main?.word === "SELECT") return accept(sql, semicolonAt);
    return refuse(`only SELECT is allowed, this WITH leads into ${main?.word ?? "no statement"}`);
  }
  return refuse(`only SELECT is allowed, got ${first?.word ?? first?.char ?? "an empty statement"}`);
}

/** Index of the quote closing the one at `start`; honours doubled quotes, and backslash escapes in strings. */
function closingQuote(sql: string, start: number): number {
  const quote = sql[start]!;
  for (let i = start + 1; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "\\" && quote !== "`") {
      i++;
      continue;
    }
    if (c === quote) {
      if (sql[i + 1] === quote) {
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

function accept(sql: string, semicolonAt: number): GuardResult {
  // The trailing semicolon and anything after it (whitespace, comments) is cut.
  return { ok: true, sql: semicolonAt === -1 ? sql : sql.slice(0, semicolonAt).trimEnd() };
}

function refuse(reason: string): GuardResult {
  return { ok: false, reason: `Refused before reaching the database: ${reason}.` };
}
