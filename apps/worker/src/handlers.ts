import {
  type QueueHandlers,
  SPIKE_ECHO_QUEUE,
  SPIKE_KILL_QUEUE,
  spikeEchoHandler,
  TRIAGE_QUEUE,
} from "@repo/queue";
import { createTriageHandler, type TriageDeps } from "./triage.ts";

/**
 * What `pnpm ops sweep --once` may work: every queue with a handler here. Never `triage` (sweepOnce
 * refuses it). Phase 4 replaces the spike queues with the real ones.
 */
export const sweeperHandlers: QueueHandlers = {
  [SPIKE_ECHO_QUEUE]: spikeEchoHandler("sweeper"),
  [SPIKE_KILL_QUEUE]: spikeEchoHandler("sweeper"),
};

/**
 * What the local worker adds on top: `triage`, which only it may consume (it is the only process that
 * can reach Sim). Phase 4's worker loop registers these next to the sweeper's queues.
 */
export function localWorkerHandlers(deps: TriageDeps): QueueHandlers {
  return { [TRIAGE_QUEUE]: createTriageHandler(deps) };
}
