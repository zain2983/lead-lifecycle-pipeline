import type { Job, PgBoss } from "pg-boss";

/** One job in, its output out. A throw fails the attempt, and pg-boss retries it per the queue's policy. */
export type JobHandler = (job: Job<unknown>) => Promise<unknown>;
export type QueueHandlers = Readonly<Record<string, JobHandler>>;

export interface DrainSummary {
  queues: string[];
  processed: number;
  failed: number;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Register one worker per queue in `handlers`, run them with pg-boss's `drain()` until nothing is ready
 * or `timeoutSeconds` runs out, then remove those workers. The instance stays started: the caller calls
 * `boss.stop()`, which waits for any batch still running at the deadline. Jobs that aren't ready yet
 * (deferred, or a retry waiting out its delay) are not waited for.
 */
export async function drainQueues(
  boss: PgBoss,
  handlers: QueueHandlers,
  { timeoutSeconds }: { timeoutSeconds: number },
): Promise<DrainSummary> {
  const started = Date.now();
  const workers: { name: string; id: string }[] = [];
  try {
    for (const [name, handler] of Object.entries(handlers)) {
      const id = await boss.work<unknown>(name, { batchSize: 1 }, async (jobs) => {
        const [job] = jobs;
        return job ? handler(job) : undefined;
      });
      workers.push({ name, id });
    }
    const result =
      workers.length > 0
        ? await boss.drain({ timeoutSeconds })
        : { processed: 0, failed: 0, timedOut: false };
    return {
      queues: workers.map((worker) => worker.name),
      processed: result.processed,
      failed: result.failed,
      timedOut: result.timedOut,
      durationMs: Date.now() - started,
    };
  } finally {
    // Only this call's workers. A batch still running keeps running; stop() waits for it.
    for (const { name, id } of workers) {
      await boss.offWork(name, { id, wait: false });
    }
  }
}
