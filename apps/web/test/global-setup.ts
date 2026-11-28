import { loadEnv } from "@repo/core";
import { runPgBossCli } from "@repo/queue";

/**
 * Bring the pgboss schema up to date once per run, as migrate.yml does. @repo/queue's tests do the same;
 * pg-boss takes an advisory lock, so the two can run at once.
 */
export default function setup(): void {
  const { DIRECT_URL } = loadEnv(["databaseDirect"]);
  const code = runPgBossCli(["migrate"], DIRECT_URL);
  if (code !== 0) throw new Error(`pg-boss migrate exited ${code}`);
}
