import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { createPgPool } from "@repo/db";

/**
 * Session-level advisory lock that serializes `pg-boss migrate` across processes. pg-boss takes its own lock
 * only around its work inside one run; on a fresh database two runs that start together both try to
 * `CREATE TYPE pgboss.job_state` and one fails with `type "job_state" already exists`. This key is only for
 * our migrate calls (the ASCII bytes "pgmi"), so it never collides with pg-boss's own key.
 */
export const PGBOSS_MIGRATE_LOCK_KEY = 0x70676d69;

/** The installed pg-boss's own CLI (its `pg-boss` bin). */
export function pgBossCliPath(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve("pg-boss/package.json")), "dist", "cli.js");
}

/**
 * Run `pg-boss <args>` and return its exit code. The connection goes in `PGBOSS_DATABASE_URL`, which
 * the CLI reads, so the URL and its password never appear in argv or in pnpm's echo of the script.
 */
export function runPgBossCli(args: readonly string[], connectionString: string): number {
  const result = spawnSync(process.execPath, [pgBossCliPath(), ...args], {
    stdio: "inherit",
    env: { ...process.env, PGBOSS_DATABASE_URL: connectionString },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/**
 * Run `pg-boss migrate` for one database while holding PGBOSS_MIGRATE_LOCK_KEY, so parallel callers (the
 * web and queue test setups under Turborepo) run one after the other. Throws if the migrate exits non-zero.
 * The lock is session-level, so it is released explicitly and the pool is ended in `finally`.
 */
export async function migratePgBoss(connectionString: string): Promise<void> {
  const pool = createPgPool(connectionString, { max: 1, applicationName: "pgboss-migrate" });
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [PGBOSS_MIGRATE_LOCK_KEY]);
    locked = true;
    const code = runPgBossCli(["migrate"], connectionString);
    if (code !== 0) throw new Error(`pg-boss migrate exited ${code}`);
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock($1)", [PGBOSS_MIGRATE_LOCK_KEY]);
    }
    client.release();
    await pool.end();
  }
}
