// One file from a GitHub repository through the contents API, as raw text.
// Shared by the schema store (src/schema-store.ts, D58), which reads each
// app's schema files at runtime, and the developer fetch scripts
// (scripts/fetch-schemas.ts).

export interface Source {
  repo: string;
  path: string;
  /** A branch, tag or commit; omitted, the repository's default branch. */
  ref?: string;
}

/** `<repo>@<ref>:<path>`, the default branch shown as `default`. */
export function describeSource({ repo, path, ref }: Source): string {
  return `${repo}@${ref ?? "default"}:${path}`;
}

/** The file's text. Throws naming the source on 404, any other non-2xx answer, or a network error. */
export async function fetchSource(
  source: Source,
  auth: string | undefined,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string> {
  const { repo, path, ref } = source;
  const where = describeSource(source);
  const query = ref === undefined ? "" : `?ref=${encodeURIComponent(ref)}`;
  let res: Response;
  try {
    res = await fetchImpl(`https://api.github.com/repos/${repo}/contents/${path}${query}`, {
      headers: {
        accept: "application/vnd.github.raw+json",
        "x-github-api-version": "2022-11-28",
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    throw new Error(`${where}: ${(e as Error).message}`);
  }
  if (res.status === 404) throw new Error(`${where} not found${auth ? "" : " (no GITHUB_TOKEN and no gh login; private repos answer 404)"}`);
  if (!res.ok) throw new Error(`${where}: GitHub answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
  return res.text();
}
