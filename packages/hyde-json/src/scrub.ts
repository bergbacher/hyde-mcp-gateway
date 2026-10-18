// Free-text scrubbing (D12): personal data and secrets in text become typed
// placeholders. Order matters: query strings carry emails and tokens, and an
// IBAN must be caught before its digits read as a token or phone number.

type Rule = [RegExp, (match: string) => string];

const RULES: Rule[] = [
  // URL query string: `?key=…` up to whitespace, quote or fragment.
  [/\?(?=[^\s=&#"'<>]+=)[^\s#"'<>]*/g, () => "?[query]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, () => "[email]"],
  [/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, () => "[iban]"],
  // JWT, then any opaque run of 24+ word characters mixing letters and digits.
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, () => "[token]"],
  [/\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{24,}/g, () => "[token]"],
  // Phone: starts with + or 0, 7–15 digits, spaces, dashes, slashes or parentheses between.
  [/(?<![\w.:+\-/])(?:\+|0)[\d \-/()]{5,}\d(?![\w.:\-/])/g, (m) => {
    const digits = m.replace(/\D/g, "").length;
    return digits >= 7 && digits <= 15 ? "[phone]" : m;
  }],
];

export function scrubText(s: string): string {
  return RULES.reduce((out, [pattern, replace]) => out.replace(pattern, replace), s);
}

const FRAME = /^\s*at /;

/**
 * A stack passes frame by frame (D13, A9): every `at …` line stays intact;
 * every other line (the error's message, which may span lines) is scrubbed.
 */
export function scrubStack(stack: string): string {
  return stack
    .split("\n")
    .map((line) => (FRAME.test(line) ? line : scrubText(line)))
    .join("\n");
}
