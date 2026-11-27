// Sim v2 API client: execute (async, X-Run-Id), run status, paused runs, resume, cancel, logs.
export {
  assertRunId,
  createSimClient,
  type ExecuteOptions,
  type ExecuteResult,
  type FetchLike,
  type ListPausedRunsOptions,
  type ResumeOptions,
  type ResumeResult,
  SimClient,
  type SimClientOptions,
  type SimMeta,
} from "./client.ts";
export { SimApiError, SimContractError, SimOutcomeUnknownError } from "./errors.ts";
export type {
  CancelResult,
  LogDetail,
  PausedRunsPage,
  PausePoint,
  QueuedResume,
  QueuedRun,
  RunStatus,
  RunStatusValue,
  SyncRun,
} from "./schemas.ts";
