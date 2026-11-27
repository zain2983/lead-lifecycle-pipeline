import {
  type QueueHandlers,
  SPIKE_ECHO_QUEUE,
  SPIKE_KILL_QUEUE,
  spikeEchoHandler,
} from "@repo/queue";

/**
 * What `pnpm ops sweep --once` may work: every queue with a handler here. Never `triage` (sweepOnce
 * refuses it). Phase 4 replaces the spike queues with the real ones.
 */
export const sweeperHandlers: QueueHandlers = {
  [SPIKE_ECHO_QUEUE]: spikeEchoHandler("sweeper"),
  [SPIKE_KILL_QUEUE]: spikeEchoHandler("sweeper"),
};
