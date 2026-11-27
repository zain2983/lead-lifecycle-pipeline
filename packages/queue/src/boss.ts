import type { PgPool } from "@repo/db";
import { type ConstructorOptions, type Db, PgBoss } from "pg-boss";

/** Where a pg-boss instance runs. See docs/adr/0002-queue-and-db.md for the connection matrix. */
export type BossMode = "vercel" | "worker" | "sweeper";

/**
 * pg-boss options per run mode (checked against pg-boss 12.40.0).
 *
 * No mode migrates. The schema is created and upgraded only by `pnpm --filter @repo/queue migrate`
 * (pg-boss's own CLI, run by migrate.yml), so a schema older than this pg-boss makes `start()` throw
 * instead of being upgraded from inside a request.
 */
export const MODE_OPTIONS = {
  /**
   * A Vercel function. It sends jobs and drains them in `after()`. No maintenance, no cron, a two-
   * connection pool, and no instance-registry row per invocation (pg-boss's docs say short-lived
   * processes should not register).
   */
  vercel: {
    migrate: false,
    supervise: false,
    schedule: false,
    max: 2,
    registerInstance: false,
  },
  /** The local worker: long-running, runs maintenance and cron, and appears in `getInstances()`. */
  worker: {
    migrate: false,
    supervise: true,
    schedule: true,
    registerInstance: true,
    instanceName: "worker",
  },
  /**
   * `pnpm ops sweep --once` on GitHub Actions: short-lived. Its background supervisor would first fire
   * after 60 s, so the sweep calls `supervise()` itself at the start of each run.
   */
  sweeper: {
    migrate: false,
    supervise: true,
    schedule: false,
    registerInstance: false,
  },
} as const satisfies Record<BossMode, ConstructorOptions>;

export interface CreateBossOptions {
  mode: BossMode;
  /** pg-boss opens its own pool on this URL and closes it in `stop()`. */
  connectionString?: string;
  /**
   * `vercel` mode only: run on this caller-owned pool instead of opening one. Use it for a pool that
   * lives across invocations and is wrapped with `attachDatabasePool`. `stop()` leaves it open.
   */
  pool?: PgPool;
  /** Called for every pg-boss `error` event. Default: log to stderr. */
  onError?: (error: unknown) => void;
  /** Test-only: merged over the mode's options, e.g. a short `monitorIntervalSeconds`. */
  overrides?: Partial<ConstructorOptions>;
}

/**
 * A pg-boss `Db` on a node-postgres pool, the same `pool.query(text, values)` pg-boss's built-in pool
 * runs. It has no `listen` and no `beginTransaction`, which `vercel` mode doesn't use.
 */
export function poolDb(pool: PgPool): Db {
  return { executeSql: (text, values) => pool.query(text, values) };
}

/** Create (but don't start) a pg-boss instance configured for `mode`. */
export function createBoss(options: CreateBossOptions): PgBoss {
  const { mode, connectionString, pool, overrides } = options;
  if (pool && mode !== "vercel") {
    // Worker and sweeper need pg-boss's own pool: LISTEN, transactional workers, and stop()
    // dropping connections that are mid-query.
    throw new Error(
      `createBoss: a caller-owned pool is only supported in vercel mode, not ${mode}`,
    );
  }
  if (!pool && !connectionString) {
    throw new Error("createBoss: pass connectionString or pool");
  }
  const connection: ConstructorOptions = pool ? { db: poolDb(pool) } : { connectionString };
  const boss = new PgBoss({ ...MODE_OPTIONS[mode], ...connection, ...overrides });
  const onError =
    options.onError ?? ((error: unknown) => console.error(`[pg-boss:${mode}]`, error));
  boss.on("error", onError);
  return boss;
}
