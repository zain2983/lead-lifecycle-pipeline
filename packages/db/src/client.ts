import { PrismaPg } from "@prisma/adapter-pg";
import type pg from "pg";
import { PrismaClient } from "./generated/prisma/client.ts";
import { RetryingPool } from "./retry-pool.ts";
import { pgConnectionConfig } from "./tls.ts";

export type { PrismaClient };
export type PgPool = pg.Pool;

export interface PgPoolOptions {
  /** Most connections the pool opens. pg's default is 10. */
  max?: number;
  /** Shows in pg_stat_activity, so each runtime's connections can be told apart. */
  applicationName?: string;
}

/**
 * Create a node-postgres pool that the caller owns. Use it when something must wrap the pool itself,
 * such as `attachDatabasePool` from `@vercel/functions` (docs/adr/0002-queue-and-db.md). Prisma's adapter
 * and pg-boss can each take one. A connection dropped during setup is tried again (retry-pool.ts).
 */
export function createPgPool(connectionString: string, options: PgPoolOptions = {}): pg.Pool {
  return new RetryingPool({
    ...pgConnectionConfig(connectionString),
    max: options.max,
    application_name: options.applicationName,
  });
}

/**
 * Create a Prisma client on the pg driver adapter. Runtime code passes DATABASE_URL (the transaction
 * pooler in production), or a pool from `createPgPool` when the pool has to be wrapped first; see
 * docs/adr/0002-queue-and-db.md for the connection matrix. A passed pool stays open when Prisma
 * disconnects: its owner ends it.
 */
export function createPrismaClient(source: string | pg.Pool): PrismaClient {
  // A pool made here belongs to the client, so `$disconnect()` ends it. (Using the client again after that
  // would give it a plain pg.Pool, without the connect retry.)
  const adapter =
    typeof source === "string"
      ? new PrismaPg(createPgPool(source), { disposeExternalPool: true })
      : new PrismaPg(source);
  return new PrismaClient({ adapter });
}
