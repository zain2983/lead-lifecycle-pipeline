// Phase 1 spike only (Spike A). Phase 4 replaces this with the real queues and handlers.
import type { JobHandler } from "./drain.ts";
import type { QueueDefinition } from "./queues.ts";

export const SPIKE_ECHO_QUEUE = "spike-echo";

/** No backoff, so a job that expires is ready again at once and a sweep or drain picks it up. */
export const SPIKE_QUEUES: readonly QueueDefinition[] = [
  { name: SPIKE_ECHO_QUEUE, options: { retryLimit: 2, retryDelay: 0, expireInSeconds: 60 } },
];

/** Completes the job with its own data plus which runtime handled it and on which attempt. */
export function spikeEchoHandler(handledBy: string): JobHandler {
  return async (job) => ({
    echoed: job.data,
    handledBy,
    retryCount: job.retryCount,
    handledAt: new Date().toISOString(),
  });
}
