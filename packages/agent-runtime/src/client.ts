import type { z } from "zod";
import { SimApiError, SimContractError, SimOutcomeUnknownError } from "./errors.ts";
import {
  type CancelResult,
  cancelResultSchema,
  dataEnvelope,
  type LogDetail,
  logDetailSchema,
  type PausedRunsPage,
  pausedRunsPageSchema,
  type QueuedResume,
  type QueuedRun,
  queuedResumeSchema,
  queuedRunSchema,
  RUN_ID_MAX_LENGTH,
  RUN_ID_PATTERN,
  type RunStatus,
  runStatusSchema,
  type SyncRun,
  syncRunSchema,
  v2ErrorSchema,
} from "./schemas.ts";

/**
 * A small client for the six Sim v2 calls the worker needs: execute, run status, paused runs, resume, cancel
 * and logs. Paths, bodies and headers follow `apps/docs/openapi-v2-workflows.json` and `openapi-v2-logs.json`
 * at Sim v0.9.66. Authentication is a personal or workspace API key in `X-API-Key`.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface SimClientOptions {
  /** For example `http://localhost:3000`. */
  baseUrl: string;
  apiKey: string;
  /** Defaults to the global `fetch`. Tests pass a fake. */
  fetch?: FetchLike;
  /** Per-request timeout. A timeout raises `SimOutcomeUnknownError`, never a failure. Default 30 s. */
  timeoutMs?: number;
}

/** Metadata every call returns next to its data, for logs and evidence. */
export interface SimMeta {
  httpStatus: number;
  /** `x-request-id`, the ID Sim asks you to quote. */
  requestId: string | null;
}

export interface ExecuteOptions {
  /** Keyed by the Start block's input field names. */
  input?: Record<string, unknown>;
  /**
   * Sent as `X-Run-Id`. Reusing a claimed ID returns `409 RUN_ID_CONFLICT` and starts nothing, so a retry
   * after an unknown outcome must reuse it.
   */
  runId?: string;
  /** Run this deployed version instead of the active one (`run: { source: "deployment", version }`). */
  version?: number;
  /** `async` (default) returns a 202 receipt; `sync` waits for the result. */
  mode?: "async" | "sync";
  /** Cap for an async run, in seconds. */
  executionTimeoutSeconds?: number;
}

export type ExecuteResult =
  | ({ kind: "queued" } & QueuedRun & SimMeta)
  | ({ kind: "result" } & SyncRun & SimMeta);

export interface ResumeOptions {
  /** From `paused.points[].contextId`. */
  contextId: string;
  /** Becomes the Human block's form submission (`<approval.approved>`, `<approval.submission.approved>`). */
  input?: Record<string, unknown>;
}

export type ResumeResult =
  | ({ kind: "queued" } & QueuedResume & SimMeta)
  | ({ kind: "result" } & SyncRun & SimMeta);

export interface ListPausedRunsOptions {
  workspaceId: string;
  includeOutput?: boolean;
  /** 1 to 25; Sim's default is 10. */
  limit?: number;
  cursor?: string;
}

type Query = Record<string, string | number | boolean | undefined>;

interface RequestSpec {
  method: "GET" | "POST";
  path: string;
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
  /** Passed to `SimOutcomeUnknownError` so the caller can reconcile. */
  runId?: string;
}

interface RawResponse {
  httpStatus: number;
  requestId: string | null;
  body: unknown;
}

export function assertRunId(runId: string): void {
  if (runId.length === 0 || runId.length > RUN_ID_MAX_LENGTH || !RUN_ID_PATTERN.test(runId)) {
    throw new TypeError(
      `Sim run IDs are 1-${RUN_ID_MAX_LENGTH} characters of [A-Za-z0-9._:-]; got ${JSON.stringify(runId)}`,
    );
  }
}

const seg = (value: string) => encodeURIComponent(value);

export class SimClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: SimClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** POST /api/v2/workflows/{workflowId}/execute */
  async execute(workflowId: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    const mode = options.mode ?? "async";
    const headers: Record<string, string> = {};
    if (options.runId !== undefined) {
      assertRunId(options.runId);
      headers["X-Run-Id"] = options.runId;
    }
    const body: Record<string, unknown> = { input: options.input ?? {} };
    if (mode === "async") body.async = true;
    if (options.version !== undefined)
      body.run = { source: "deployment", version: options.version };
    if (options.executionTimeoutSeconds !== undefined) {
      body.executionTimeoutSeconds = options.executionTimeoutSeconds;
    }

    const spec: RequestSpec = {
      method: "POST",
      path: `/api/v2/workflows/${seg(workflowId)}/execute`,
      body,
      headers,
      ...(options.runId !== undefined && { runId: options.runId }),
    };
    const raw = await this.#send(spec);
    if (raw.httpStatus === 202) {
      const data = this.#parse(spec, raw, dataEnvelope(queuedRunSchema)).data;
      return { kind: "queued", ...data, ...meta(raw) };
    }
    const data = this.#parse(spec, raw, dataEnvelope(syncRunSchema)).data;
    return { kind: "result", ...data, ...meta(raw) };
  }

  /** GET /api/v2/workflows/{workflowId}/runs/{runId} */
  async getRun(
    workflowId: string,
    runId: string,
    options: { includeOutput?: boolean } = {},
  ): Promise<RunStatus & SimMeta> {
    const spec: RequestSpec = {
      method: "GET",
      path: `/api/v2/workflows/${seg(workflowId)}/runs/${seg(runId)}`,
      query: { includeOutput: options.includeOutput },
    };
    const raw = await this.#send(spec);
    return { ...this.#parse(spec, raw, dataEnvelope(runStatusSchema)).data, ...meta(raw) };
  }

  /** GET /api/v2/workflows/runs/paused?workspaceId=… (one page) */
  async listPausedRuns(options: ListPausedRunsOptions): Promise<PausedRunsPage & SimMeta> {
    const spec: RequestSpec = {
      method: "GET",
      path: "/api/v2/workflows/runs/paused",
      query: {
        workspaceId: options.workspaceId,
        includeOutput: options.includeOutput,
        limit: options.limit,
        cursor: options.cursor,
      },
    };
    const raw = await this.#send(spec);
    return { ...this.#parse(spec, raw, pausedRunsPageSchema), ...meta(raw) };
  }

  /**
   * POST /api/v2/workflows/{workflowId}/runs/{runId}/resume with `{ contextId, input }`. The resumed attempt
   * gets a new run ID. Resuming does not itself approve anything: the workflow must check the submitted value.
   */
  async resume(workflowId: string, runId: string, options: ResumeOptions): Promise<ResumeResult> {
    const spec: RequestSpec = {
      method: "POST",
      path: `/api/v2/workflows/${seg(workflowId)}/runs/${seg(runId)}/resume`,
      body: { contextId: options.contextId, input: options.input ?? {} },
      runId,
    };
    const raw = await this.#send(spec);
    if (raw.httpStatus === 202) {
      const data = this.#parse(spec, raw, dataEnvelope(queuedResumeSchema)).data;
      return { kind: "queued", ...data, ...meta(raw) };
    }
    const data = this.#parse(spec, raw, dataEnvelope(syncRunSchema)).data;
    return { kind: "result", ...data, ...meta(raw) };
  }

  /** POST /api/v2/workflows/{workflowId}/runs/{runId}/cancel. Best effort: read `success` and `reason`. */
  async cancel(workflowId: string, runId: string): Promise<CancelResult & SimMeta> {
    const spec: RequestSpec = {
      method: "POST",
      path: `/api/v2/workflows/${seg(workflowId)}/runs/${seg(runId)}/cancel`,
      runId,
    };
    const raw = await this.#send(spec);
    return { ...this.#parse(spec, raw, dataEnvelope(cancelResultSchema)).data, ...meta(raw) };
  }

  /** GET /api/v2/logs/{runId}: trace spans, final output and cost. */
  async getLog(
    runId: string,
    options: { includeWorkflowState?: boolean } = {},
  ): Promise<LogDetail & SimMeta> {
    const spec: RequestSpec = {
      method: "GET",
      path: `/api/v2/logs/${seg(runId)}`,
      query: { includeWorkflowState: options.includeWorkflowState },
    };
    const raw = await this.#send(spec);
    return { ...this.#parse(spec, raw, dataEnvelope(logDetailSchema)).data, ...meta(raw) };
  }

  async #send(spec: RequestSpec): Promise<RawResponse> {
    const url = new URL(this.#baseUrl + spec.path);
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-API-Key": this.#apiKey,
      ...spec.headers,
    };
    const init: RequestInit = {
      method: spec.method,
      headers,
      signal: AbortSignal.timeout(this.#timeoutMs),
    };
    if (spec.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(spec.body);
    }

    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(url.toString(), init);
      text = await response.text();
    } catch (cause) {
      const timedOut =
        cause instanceof DOMException &&
        (cause.name === "TimeoutError" || cause.name === "AbortError");
      throw new SimOutcomeUnknownError({
        method: spec.method,
        path: spec.path,
        reason: timedOut ? "timeout" : "network",
        ...(spec.runId !== undefined && { runId: spec.runId }),
        cause,
      });
    }

    const body = parseBody(text);
    const requestId = response.headers.get("x-request-id");
    if (response.ok) return { httpStatus: response.status, requestId, body };

    const envelope = v2ErrorSchema.safeParse(body);
    const error = envelope.success ? envelope.data.error : null;
    const detailCode = readDetailCode(error?.details);
    if (response.status === 503 && detailCode === "ASYNC_ENQUEUE_AMBIGUOUS") {
      // Sim's own words: "the run may already have started. Reconcile using the returned run ID".
      throw new SimOutcomeUnknownError({
        method: spec.method,
        path: spec.path,
        reason: "ambiguous_enqueue",
        ...(spec.runId !== undefined && { runId: spec.runId }),
        cause: body,
      });
    }
    throw new SimApiError({
      method: spec.method,
      path: spec.path,
      status: response.status,
      code: error?.code ?? null,
      message:
        error?.message ?? (typeof body === "string" ? body.slice(0, 200) : response.statusText),
      detailCode,
      details: error?.details,
      requestId: error?.requestId ?? requestId,
      body,
    });
  }

  #parse<T extends z.ZodType>(spec: RequestSpec, raw: RawResponse, schema: T): z.infer<T> {
    const result = schema.safeParse(raw.body);
    if (!result.success) {
      throw new SimContractError(
        spec.method,
        spec.path,
        raw.httpStatus,
        raw.body,
        result.error.message,
      );
    }
    return result.data;
  }
}

export function createSimClient(options: SimClientOptions): SimClient {
  return new SimClient(options);
}

function meta(raw: RawResponse): SimMeta {
  return { httpStatus: raw.httpStatus, requestId: raw.requestId };
}

function parseBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function readDetailCode(details: unknown): string | null {
  if (typeof details === "object" && details !== null && "code" in details) {
    const code = (details as { code: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}
