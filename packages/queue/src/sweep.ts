import type { PgBoss } from "pg-boss";
import { drainQueues, type QueueHandlers } from "./drain.ts";
import { TRIAGE_QUEUE } from "./queues.ts";

export interface SweepSummary {
  /** Time spent in pg-boss maintenance (expiry, retention) before any work. */
  supervisedMs: number;
  worked: string[];
  skipped: { name: string; reason: string }[];
  processed: number;
  failed: number;
  timedOut: boolean;
  durationMs: number;
}

/**
 * One sweeper pass on a started `sweeper`-mode instance:
 *
 * 1. `supervise()`: pg-boss maintenance. Jobs a killed process left `active` past their expiry go to
 *    `retry` (or `failed` and the dead-letter queue when out of retries), and retention runs. pg-boss
 *    rate-limits each step per queue across instances (`monitorIntervalSeconds`, default 60 s), so a
 *    queue another instance monitored less than a minute ago is skipped until its next pass.
 * 2. Work every queue this process has a handler for, except `triage`, until nothing is ready or the
 *    budget (counted from the start of the pass) runs out.
 */
export async function sweepOnce(
  boss: PgBoss,
  handlers: QueueHandlers,
  { budgetSeconds }: { budgetSeconds: number },
): Promise<SweepSummary> {
  if (Object.hasOwn(handlers, TRIAGE_QUEUE)) {
    throw new Error(
      "sweepOnce: triage runs only on the local worker, the one process that reaches Sim",
    );
  }
  const started = Date.now();
  await boss.supervise();
  const supervisedMs = Date.now() - started;

  const toWork: Record<string, QueueHandlers[string]> = {};
  const skipped: SweepSummary["skipped"] = [];
  for (const { name } of await boss.getQueues()) {
    const handler = handlers[name];
    if (name === TRIAGE_QUEUE) skipped.push({ name, reason: "triage: local worker only" });
    else if (handler) toWork[name] = handler;
    else skipped.push({ name, reason: "no handler in this process" });
  }

  const remainingSeconds = Math.max(1, budgetSeconds - (Date.now() - started) / 1000);
  const drained = await drainQueues(boss, toWork, { timeoutSeconds: remainingSeconds });
  return {
    supervisedMs,
    worked: drained.queues,
    skipped,
    processed: drained.processed,
    failed: drained.failed,
    timedOut: drained.timedOut,
    durationMs: Date.now() - started,
  };
}
