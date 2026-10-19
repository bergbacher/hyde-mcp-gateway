// Stale views (D48): the redacted views a reader sees can lag the app's
// redacted-schema.md. hyde-db's deploy order is drop → migrate → apply; when
// a deploy skips the apply, the views keep the old columns while the schema
// store already serves the new document (D58). This module compares the two
// and words the difference.
//
// The document is hyde-db's MySQL redacted-schema.md: a `## <view>` heading
// per view, the name a backtick-quoted identifier, then a table whose first
// cell is a column, a code span around the backtick-quoted name. The live
// side is one information_schema query the reader runs without an extra
// grant: MySQL shows an account the columns of the views it may SELECT from,
// which is exactly what query_sql can read. Nothing here changes the database
// (D2); the fix belongs to each app's migration job (D47).

/** view → its columns. */
export type ViewColumns = Map<string, Set<string>>;

export interface ColumnDiff {
  view: string;
  /** In the document, not in the database. */
  missing: string[];
  /** In the database, not in the document. */
  extra: string[];
}

export interface ViewDiff {
  /** Views the document lists that the database lacks. */
  missingViews: string[];
  /** Views the database has that the document does not list. */
  extraViews: string[];
  /** Views in both whose columns differ. */
  columnDiffs: ColumnDiff[];
}

/**
 * The outcome of one check: the differences, or why it could not run.
 * `reason` is ours and safe to show an agent; `detail` is the database's
 * error, which can name hosts, and goes to the log only.
 */
export type ViewCheck = { ok: true; diff: ViewDiff } | { ok: false; reason: string; detail?: string };

export const RUNBOOK = "docs/runbooks/redacted-reader.md";

/** The one query the check runs, as the reader. */
export const VIEW_COLUMNS_SQL = "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'redacted'";

/** hyde-db's marker view in `redacted`: not a model and not granted to the reader; never compared. */
const MARKER_VIEW = "hyde_db_marker";

/** The views and columns a redacted-schema.md lists. */
export function parseRedactedSchema(markdown: string): ViewColumns {
  const views: ViewColumns = new Map();
  let current: Set<string> | undefined;
  let header = false;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = new Set();
      views.set(unquote(heading[1]!), current);
      header = false;
      continue;
    }
    if (!current) continue;
    if (!line.startsWith("|")) {
      header = false;
      continue;
    }
    const first = firstCell(line);
    if (!header) {
      // The header row (`| column | … |`); the separator row follows.
      header = true;
      continue;
    }
    if (/^:?-+:?$/.test(first)) continue;
    current.add(unquote(codeSpanText(first.replace(/\\\|/g, "|"))));
  }
  return views;
}

/** information_schema rows (view, column) grouped by view. */
export function groupColumns(rows: Iterable<readonly [string, string]>): ViewColumns {
  const views: ViewColumns = new Map();
  for (const [view, column] of rows) {
    if (view === MARKER_VIEW) continue;
    let columns = views.get(view);
    if (!columns) views.set(view, (columns = new Set()));
    columns.add(column);
  }
  return views;
}

/** What differs between the document (`expected`) and the database (`actual`). Names compare exactly. */
export function compareViews(expected: ViewColumns, actual: ViewColumns): ViewDiff {
  const missingViews = [...expected.keys()].filter((v) => !actual.has(v));
  const extraViews = [...actual.keys()].filter((v) => !expected.has(v)).sort();
  const columnDiffs: ColumnDiff[] = [];
  for (const [view, columns] of expected) {
    const live = actual.get(view);
    if (!live) continue;
    const missing = [...columns].filter((c) => !live.has(c));
    const extra = [...live].filter((c) => !columns.has(c)).sort();
    if (missing.length > 0 || extra.length > 0) columnDiffs.push({ view, missing, extra });
  }
  return { missingViews, extraViews, columnDiffs };
}

/** Compares `markdown` with the rows of VIEW_COLUMNS_SQL; a document without views is not compared. */
export function checkViews(markdown: string, rows: Iterable<readonly [string, string]>): ViewCheck {
  const expected = parseRedactedSchema(markdown);
  if (expected.size === 0) return { ok: false, reason: "the redacted schema lists no views" };
  return { ok: true, diff: compareViews(expected, groupColumns(rows)) };
}

export function isStale(diff: ViewDiff): boolean {
  return diff.missingViews.length > 0 || diff.extraViews.length > 0 || diff.columnDiffs.length > 0;
}

/** The notice for a check, one line; undefined when the views match. */
export function staleNotice(check: ViewCheck): string | undefined {
  if (!check.ok) return `Stale views: the check could not run: ${check.reason}. The views may not match this schema.`;
  if (!isStale(check.diff)) return undefined;
  const { missingViews, extraViews, columnDiffs } = check.diff;
  const parts = [
    ...(missingViews.length > 0 ? [`missing views ${names(missingViews)}`] : []),
    ...(extraViews.length > 0 ? [`views not in this schema ${names(extraViews)}`] : []),
    ...columnDiffs.map(({ view, missing, extra }) => {
      const details = [
        ...(missing.length > 0 ? [`lacks ${names(missing)}`] : []),
        ...(extra.length > 0 ? [`has columns not in this schema ${names(extra)}`] : []),
      ];
      return `view ${quote(view)} ${details.join(", ")}`;
    }),
  ];
  return `Stale views: ${parts.join("; ")}. Queries that name them may fail. Fix: drop → migrate → apply (${RUNBOOK}).`;
}

const quote = (n: string) => "`" + n.replace(/`/g, "``") + "`";
const names = (ns: string[]) => ns.map(quote).join(", ");

/** The first cell of a table row, up to the first unescaped pipe, trimmed. */
function firstCell(row: string): string {
  let i = 1;
  while (i < row.length && row[i] !== "|") i += row[i] === "\\" ? 2 : 1;
  return row.slice(1, i).trim();
}

/** The content of a CommonMark code span: the fence stripped, and one padding space each side when both are there. */
function codeSpanText(text: string): string {
  const fence = /^`+/.exec(text)?.[0];
  if (!fence || text.length < 2 * fence.length || !text.endsWith(fence)) return text;
  const inner = text.slice(fence.length, text.length - fence.length);
  return inner.length >= 2 && inner.startsWith(" ") && inner.endsWith(" ") && inner.trim() !== "" ? inner.slice(1, -1) : inner;
}

/** A MySQL identifier: backtick quotes stripped and doubled backticks undone; a bare name stays as it is. */
function unquote(identifier: string): string {
  if (identifier.length >= 2 && identifier.startsWith("`") && identifier.endsWith("`")) {
    return identifier.slice(1, -1).replace(/``/g, "`");
  }
  return identifier;
}
