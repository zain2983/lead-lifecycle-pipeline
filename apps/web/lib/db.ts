import { createPgPool, createPrismaClient, type PgPool, type PrismaClient } from "@repo/db";
import { createBoss, ensureQueues, INTAKE_QUEUES, type PgBoss } from "@repo/queue";
import { attachDatabasePool } from "@vercel/functions";

/**
 * The web app's database handles, one set per server instance (docs/adr/0002-queue-and-db.md):
 * a Prisma client and a pg-boss pool, each a two-connection `pg.Pool` we own, so both can be wrapped
 * with `attachDatabasePool` (on Vercel it keeps the instance alive until idle clients have closed;
 * elsewhere it does nothing). The spike route under /api/spikes keeps its own copy.
 */
interface WebDb {
  prisma: PrismaClient;
  bossPool: PgPool;
  queuesReady?: Promise<unknown>;
}
let shared: WebDb | undefined;

export function webDb(databaseUrl: string): WebDb {
  if (!shared) {
    const prismaPool = createPgPool(databaseUrl, { max: 2, applicationName: "web:prisma" });
    const bossPool = createPgPool(databaseUrl, { max: 2, applicationName: "web:pgboss" });
    attachDatabasePool(prismaPool);
    attachDatabasePool(bossPool);
    shared = { prisma: createPrismaClient(prismaPool), bossPool };
  }
  return shared;
}

/**
 * A pg-boss instance for one invocation, on the shared pool (`vercel` mode: no maintenance, no
 * migration), with the intake queues created once per server instance. The caller stops it.
 */
export async function startWebBoss(db: WebDb): Promise<PgBoss> {
  const boss = createBoss({ mode: "vercel", pool: db.bossPool });
  await boss.start();
  try {
    db.queuesReady ??= ensureQueues(boss, INTAKE_QUEUES).catch((error: unknown) => {
      db.queuesReady = undefined;
      throw error;
    });
    await db.queuesReady;
  } catch (error) {
    await boss.stop();
    throw error;
  }
  return boss;
}
