// TLS to Postgres (docs/adr/0007-tls-to-supabase.md). The URL carries the rule: a Supabase host must say
// `sslmode=verify-full`, and the bundled Supabase root CA is then what the server is verified against.
// Any other URL (local Docker, CI) is passed through unchanged.
//
// Errors here never echo the URL: it holds the password.
import type { ConnectionOptions } from "node:tls";
import { SUPABASE_ROOT_CA } from "./supabase-ca.ts";

const SUPABASE_HOST = /(^|\.)supabase\.(com|co)$/;

/** URL parameters node-postgres turns into its `ssl` setting, which then overrides an explicit `ssl` object. */
export const PG_SSL_PARAMS = [
  "ssl",
  "sslmode",
  "sslrootcert",
  "sslcert",
  "sslkey",
  "sslnegotiation",
  "uselibpqcompat",
] as const;

export type TlsRule =
  /** Not a Supabase host and not `verify-full`: leave the URL alone. */
  | { kind: "unchanged" }
  /** A Supabase host with `verify-full`: verify against the bundled root CA. */
  | { kind: "bundled-ca"; url: URL }
  /** `verify-full` with the URL's own `sslrootcert`. */
  | { kind: "own-ca"; url: URL; caPath: string }
  /** `verify-full` on another host, without `sslrootcert`: the system's root CAs. */
  | { kind: "system-ca"; url: URL };

export class TlsConfigError extends Error {
  override name = "TlsConfigError";
}

function parseUrl(connectionString: string): URL {
  try {
    // node-postgres also accepts an empty host after the credentials (`user@/db?host=/socket`).
    return new URL(connectionString.replace("@/", "@localhost/"));
  } catch {
    // Not rethrown: Node's error carries the input.
    throw new TlsConfigError("The database URL isn't a valid URL");
  }
}

/** Which TLS rule a database URL asks for. Throws for a Supabase host without `sslmode=verify-full`. */
export function tlsRule(connectionString: string): TlsRule {
  const url = parseUrl(connectionString);
  // As node-postgres resolves it: a non-empty `host` parameter wins, and the last repeated one counts.
  const last = (name: string) => url.searchParams.getAll(name).at(-1);
  const host = (last("host") || decodeURIComponent(url.hostname)).toLowerCase().replace(/\.$/, "");
  const hosted = SUPABASE_HOST.test(host);

  if (last("sslmode") !== "verify-full") {
    if (hosted) {
      throw new TlsConfigError(
        "A Supabase database URL must set sslmode=verify-full (docs/adr/0007-tls-to-supabase.md)",
      );
    }
    return { kind: "unchanged" };
  }
  const caPath = last("sslrootcert");
  if (caPath) return { kind: "own-ca", url, caPath };
  return hosted ? { kind: "bundled-ca", url } : { kind: "system-ca", url };
}

export interface PgConnectionConfig {
  connectionString: string;
  ssl?: ConnectionOptions;
}

/**
 * What to hand node-postgres (a Pool, a Client, PrismaPg, pg-boss) for a database URL. With the bundled
 * CA, every SSL parameter is removed from the URL, because node-postgres would let it replace `ssl`.
 */
export function pgConnectionConfig(connectionString: string): PgConnectionConfig {
  const rule = tlsRule(connectionString);
  if (rule.kind !== "bundled-ca") return { connectionString };
  for (const name of PG_SSL_PARAMS) rule.url.searchParams.delete(name);
  return {
    connectionString: rule.url.toString(),
    ssl: { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true },
  };
}
