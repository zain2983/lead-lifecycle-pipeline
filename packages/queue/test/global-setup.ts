import { loadEnv } from "@repo/core";
import { migratePgBoss } from "../src/pgboss-cli.ts";

/**
 * Bring the pgboss schema up to date once per run, the same way migrate.yml does. migratePgBoss holds an
 * advisory lock, so this and the web suite's setup can run at once without racing on CREATE TYPE.
 */
export default async function setup(): Promise<void> {
  const { DIRECT_URL } = loadEnv(["databaseDirect"]);
  await migratePgBoss(DIRECT_URL);
}
