import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

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
