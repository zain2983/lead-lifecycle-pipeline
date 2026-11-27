import { loadEnv } from "@repo/core";
import { runPgBossCli } from "../src/pgboss-cli.ts";

/** Bring the pgboss schema up to date once per run, the same way migrate.yml does. */
export default function setup(): void {
  const { DIRECT_URL } = loadEnv(["databaseDirect"]);
  const code = runPgBossCli(["migrate"], DIRECT_URL);
  if (code !== 0) throw new Error(`pg-boss migrate exited ${code}`);
}
