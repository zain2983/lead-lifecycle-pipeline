// The same TLS rule for the two command-line tools, which take only a URL. Not part of the app runtime:
// it needs the certificate as a file. Import it as `@repo/db/tls-cli`.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PG_SSL_PARAMS, tlsRule } from "./tls.ts";

/** packages/db/certs/supabase-root.crt, as an absolute path. */
export function supabaseCaPath(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "certs",
    "supabase-root.crt",
  );
}

/** For a CLI that connects with node-postgres (pg-boss's): the CA goes in `sslrootcert`. */
export function pgCliUrl(connectionString: string): string {
  const rule = tlsRule(connectionString);
  if (rule.kind !== "bundled-ca") return connectionString;
  const { searchParams } = rule.url;
  for (const name of PG_SSL_PARAMS) searchParams.delete(name);
  searchParams.set("sslmode", "verify-full");
  searchParams.set("sslrootcert", supabaseCaPath());
  return rule.url.toString();
}

/**
 * For the Prisma CLI, whose schema engine isn't node-postgres. It knows `sslmode` only as
 * disable/prefer/require, takes the CA in `sslcert`, and verifies the server only with
 * `sslaccept=strict`.
 */
export function prismaCliUrl(connectionString: string): string {
  const rule = tlsRule(connectionString);
  if (rule.kind === "unchanged") return connectionString;
  const { searchParams } = rule.url;
  for (const name of PG_SSL_PARAMS) searchParams.delete(name);
  searchParams.set("sslmode", "require");
  searchParams.set("sslaccept", "strict");
  if (rule.kind === "bundled-ca") searchParams.set("sslcert", supabaseCaPath());
  // Resolved here, so a relative path means the same file as it does to node-postgres.
  if (rule.kind === "own-ca") searchParams.set("sslcert", path.resolve(rule.caPath));
  return rule.url.toString();
}
