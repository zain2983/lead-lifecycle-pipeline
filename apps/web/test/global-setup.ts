import { loadEnv } from "@repo/core";
import { migratePgBoss } from "@repo/queue";

/**
 * Bring the pgboss schema up to date once per run, as migrate.yml does. @repo/queue's test setup runs the
 * same migrate in parallel, so migratePgBoss takes a shared advisory lock: the two take turns instead of
 * racing on CREATE TYPE pgboss.job_state (a fresh database fails that way without the lock).
 */
export default async function setup(): Promise<void> {
  const { DIRECT_URL } = loadEnv(["databaseDirect"]);
  await migratePgBoss(DIRECT_URL);
}
