// Turns an app's `<APP>_REDACTED_URL` into mysql2 pool options, with the TLS
// setup the apps' runtime uses: `ssl=true` verifies the server against the
// instance CA, and the identity is checked against the certificate's only
// name, the bare instance id (`servername`), since the certificate names
// neither the endpoint host nor its address. The CA arrives as PEM text in
// `<APP>_DATABASE_CA`, the name in `<APP>_DATABASE_CERT_NAME`.
//
// Without `ssl=true` the connection is plain, for a local MySQL; production
// refuses it. The pool always connects to database `redacted`, which holds
// only the hyde-db views (D2).

export const REDACTED_DATABASE = "redacted";

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: typeof REDACTED_DATABASE;
  /** Present with `ssl=true`: the CA to verify against and the name the certificate must carry. */
  tls?: { ca: string; servername: string };
}

export interface DatabaseEnv {
  /** The variable name, for error messages. */
  name: string;
  url: string;
  ca: string | undefined;
  certName: string | undefined;
  production: boolean;
}

// The TLS path hands the driver an object, not the string, so an unlisted
// parameter would be dropped without a word; it is refused instead.
const ALLOWED_PARAMETERS = new Set(["ssl"]);
const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[.*\])$/;

export function resolveDatabase(env: DatabaseEnv): DatabaseConfig {
  const refuse = (reason: string): never => {
    throw new Error(`${env.name}: ${reason}`);
  };
  let url: URL;
  try {
    url = new URL(env.url);
  } catch {
    // The URL error would carry the whole input, password included.
    return refuse("not a valid connection string");
  }
  if (url.protocol !== "mysql:") refuse(`expected a mysql:// URL, got ${url.protocol}//`);
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_PARAMETERS.has(key)) refuse(`unsupported parameter \`${key}\` (allowed: ${[...ALLOWED_PARAMETERS].join(", ")})`);
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (database && database !== REDACTED_DATABASE) refuse(`names database \`${database}\`; the reader reads \`${REDACTED_DATABASE}\` only`);

  const base = {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: REDACTED_DATABASE,
  } as const;

  const tls = url.searchParams.get("ssl");
  if (tls !== null && tls !== "true") refuse("`ssl` must be `true` or absent");
  if (tls === null) {
    if (env.production) refuse("production needs TLS: set `ssl=true` and the instance CA");
    if (env.ca) refuse("a CA is set but the URL lacks `ssl=true`");
    return base;
  }

  const prefix = env.name.replace(/_REDACTED_URL$/, "");
  if (!env.ca) refuse(`\`ssl=true\` needs the instance CA in ${prefix}_DATABASE_CA`);
  if (!env.certName) refuse(`\`ssl=true\` needs the certificate name in ${prefix}_DATABASE_CERT_NAME`);
  if (IP_LITERAL.test(url.hostname)) refuse("TLS needs the endpoint's DNS name, not an address");
  return { ...base, tls: { ca: env.ca!, servername: env.certName! } };
}
