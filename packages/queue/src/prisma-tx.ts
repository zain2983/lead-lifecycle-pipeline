import { type Db, fromPrisma, type PrismaTransactionLike } from "pg-boss";

/**
 * Run a pg-boss call inside a Prisma interactive transaction:
 *
 * ```ts
 * await prisma.$transaction(async (tx) => {
 *   await tx.heartbeat.create({ data: { source: "web" } });
 *   await boss.send("spike-echo", data, { id, db: prismaTxDb(tx) });
 * });
 * ```
 *
 * The job row commits or rolls back with the caller's own writes (a transactional outbox). It wraps
 * pg-boss's `fromPrisma`, and is for per-call `db` options only: Prisma rejects multi-statement SQL,
 * which pg-boss's maintenance uses, so it can never be a constructor `db`.
 *
 * It refuses the root `PrismaClient`. That object has `$queryRawUnsafe` too, so it would type-check,
 * but each statement would auto-commit on its own and the job would survive a rollback. Prisma 7's
 * transaction client keeps `$transaction` (nested transactions) but has no `$disconnect`, matching
 * its `Prisma.TransactionClient` type, so that is the check.
 */
export function prismaTxDb(tx: PrismaTransactionLike): Db {
  if ("$disconnect" in tx && typeof tx.$disconnect === "function") {
    throw new TypeError(
      "prismaTxDb: pass the transaction client from prisma.$transaction(async (tx) => …), not the root client",
    );
  }
  return fromPrisma(tx);
}
