import { z } from "zod";

/**
 * Response shapes of Sim's v2 API, checked against `apps/docs/openapi-v2-workflows.json` and
 * `openapi-v2-logs.json` at tag v0.9.66. Objects are loose: fields this client doesn't read are kept, so
 * evidence files show exactly what came back. Only the fields the worker relies on are declared.
 */

export const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
export const RUN_ID_MAX_LENGTH = 128;

const runId = z.string().min(1).max(RUN_ID_MAX_LENGTH).regex(RUN_ID_PATTERN);
const nullableString = z.string().nullable();

export const runStatusValues = [
  "pending",
  "running",
  "paused",
  "redacting",
  "completed",
  "failed",
  "cancelled",
  "queued",
] as const;
export type RunStatusValue = (typeof runStatusValues)[number];

export const runErrorSchema = z.looseObject({
  message: z.string(),
  code: z.string(),
  blockId: z.string().optional(),
  blockName: z.string().optional(),
  blockType: z.string().optional(),
});

/** 202 from execute (async, or a sync run past `waitTimeoutSeconds`). */
export const queuedRunSchema = z.looseObject({
  runId,
  statusUrl: z.string(),
  executionTimeoutSeconds: z.number().nullable(),
});

/** 200 from a synchronous execute. */
export const syncRunSchema = z.looseObject({
  runId,
  workflowId: z.string(),
  status: z.enum(["completed", "failed", "paused", "cancelled"]),
  output: z.unknown(),
  blockOutputs: z.record(z.string(), z.unknown()).nullable(),
  error: runErrorSchema.nullable(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  durationMs: z.number().optional(),
});

export const inputFieldSchema = z.looseObject({
  name: z.string(),
  label: z.string(),
  type: z.string(),
  required: z.boolean(),
});

export const pausePointSchema = z.looseObject({
  contextId: z.string(),
  blockId: z.string(),
  blockName: nullableString,
  kind: z.enum(["human", "time"]),
  status: z.enum(["paused", "queued", "resuming", "resumed", "failed"]),
  registeredAt: nullableString,
  resumeAt: nullableString,
  inputFields: z.array(inputFieldSchema).nullable(),
  display: z.unknown().optional(),
  queuePosition: z.number().nullable(),
});

/** `data` of GET /api/v2/workflows/{workflowId}/runs/{runId}. */
export const runStatusSchema = z.looseObject({
  runId,
  workflowId: z.string(),
  status: z.enum(runStatusValues),
  trigger: nullableString,
  startedAt: nullableString,
  endedAt: nullableString,
  durationMs: z.number().nullable(),
  /** Deployment version the run executed; null for a manual run or a queued run not yet started. */
  version: z.number().int().nullable(),
  paused: z
    .looseObject({
      contextId: nullableString,
      pausedAt: z.string(),
      pauseKind: z.enum(["time", "human"]).nullable(),
      blockedOnBlockId: nullableString,
      pausePointCount: z.number(),
      resumedCount: z.number(),
      points: z.array(pausePointSchema),
    })
    .nullable(),
  cost: z.looseObject({ total: z.number() }).nullable(),
  error: runErrorSchema.nullable(),
  output: z.unknown().optional(),
});

/** GET /api/v2/workflows/runs/paused (the whole body: `data` plus `nextCursor`). */
export const pausedRunsPageSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      runId,
      workflowId: z.string(),
      workflowName: z.string(),
      pausedAt: z.string(),
      points: z.array(pausePointSchema),
    }),
  ),
  nextCursor: nullableString,
});

/** 202 from resume. The resumed attempt has its own run ID. */
export const queuedResumeSchema = z.looseObject({
  runId,
  statusUrl: z.string(),
  queuePosition: z.number().optional(),
});

/** `data` of POST /api/v2/workflows/{workflowId}/runs/{runId}/cancel. */
export const cancelResultSchema = z.looseObject({
  success: z.boolean(),
  runId,
  redisAvailable: z.boolean(),
  durablyRecorded: z.boolean(),
  locallyAborted: z.boolean(),
  pausedCancelled: z.boolean(),
  reason: z.string().optional(),
});

/** `data` of GET /api/v2/logs/{runId}. */
export const logDetailSchema = z.looseObject({
  runId,
  workflowId: nullableString,
  deploymentVersionId: nullableString,
  status: z.string(),
  level: z.string(),
  trigger: z.string(),
  startedAt: z.string(),
  endedAt: nullableString,
  totalDurationMs: z.number().nullable(),
  traceSpans: z.array(z.looseObject({ id: z.string(), name: z.string(), type: z.string() })),
  finalOutput: z.unknown(),
  cost: z.looseObject({ total: z.number() }).nullable(),
  workflowInput: z.unknown(),
  createdAt: z.string(),
});

/** The v2 error envelope: `{ error: { code, message, details?, requestId? } }`. */
export const v2ErrorSchema = z.looseObject({
  error: z.looseObject({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});

export const dataEnvelope = <T extends z.ZodType>(inner: T) => z.looseObject({ data: inner });

export type QueuedRun = z.infer<typeof queuedRunSchema>;
export type SyncRun = z.infer<typeof syncRunSchema>;
export type PausePoint = z.infer<typeof pausePointSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type PausedRunsPage = z.infer<typeof pausedRunsPageSchema>;
export type QueuedResume = z.infer<typeof queuedResumeSchema>;
export type CancelResult = z.infer<typeof cancelResultSchema>;
export type LogDetail = z.infer<typeof logDetailSchema>;
