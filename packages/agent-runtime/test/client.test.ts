import { describe, expect, it } from "vitest";
import {
  createSimClient,
  type FetchLike,
  SimApiError,
  SimContractError,
  SimOutcomeUnknownError,
} from "../src/index.ts";

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake fetch that records each call and answers from a queue of canned responses. */
function fakeFetch(...responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({
      url: new URL(input),
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = responses.shift();
    if (next === undefined) throw new Error("fakeFetch: no response queued");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const base = "http://localhost:3000";
const wf = "3b1f7c92-8d4e-4a6b-9c0d-5e2f8a714b36";

const pausePoint = {
  contextId: "ctx-1",
  blockId: "blk-approval",
  blockName: "Approval",
  kind: "human",
  status: "paused",
  registeredAt: "2026-11-27T10:00:00.000Z",
  resumeAt: null,
  parallel: null,
  loop: null,
  inputFields: [{ name: "approved", label: "approved", type: "boolean", required: true }],
  display: null,
  queuePosition: null,
};

describe("execute", () => {
  it("sends an async run with X-Run-Id and a pinned version, and returns the 202 receipt", async () => {
    const { fetch, calls } = fakeFetch(
      json(
        202,
        {
          data: {
            runId: "spike_1",
            statusUrl: `${base}/api/v2/workflows/${wf}/runs/spike_1`,
            executionTimeoutSeconds: 5400,
          },
        },
        { "x-request-id": "req-1" },
      ),
    );
    const sim = createSimClient({ baseUrl: `${base}/`, apiKey: "sk-test", fetch });

    const result = await sim.execute(wf, { input: { name: "Ada" }, runId: "spike_1", version: 1 });

    expect(result).toMatchObject({
      kind: "queued",
      runId: "spike_1",
      httpStatus: 202,
      requestId: "req-1",
    });
    const [call] = calls;
    expect(call?.method).toBe("POST");
    expect(call?.url.toString()).toBe(`${base}/api/v2/workflows/${wf}/execute`);
    expect(call?.headers["X-API-Key"]).toBe("sk-test");
    expect(call?.headers["X-Run-Id"]).toBe("spike_1");
    expect(call?.body).toEqual({
      input: { name: "Ada" },
      async: true,
      run: { source: "deployment", version: 1 },
    });
  });

  it("returns a synchronous result without the async flag", async () => {
    const { fetch, calls } = fakeFetch(
      json(200, {
        data: {
          runId: "r2",
          workflowId: wf,
          status: "completed",
          output: { echo: "hi" },
          blockOutputs: null,
          error: null,
          executionTimeoutSeconds: 300,
        },
      }),
    );
    const sim = createSimClient({ baseUrl: base, apiKey: "k", fetch });
    const result = await sim.execute(wf, { mode: "sync", input: { name: "x" } });
    expect(result.kind).toBe("result");
    expect(calls[0]?.body).toEqual({ input: { name: "x" } });
    expect(calls[0]?.headers["X-Run-Id"]).toBeUndefined();
  });

  it("raises a SimApiError marked as a run-ID conflict on 409 RUN_ID_CONFLICT", async () => {
    const { fetch } = fakeFetch(
      json(409, {
        error: {
          code: "CONFLICT",
          message: "Run ID is already in use",
          details: { code: "RUN_ID_CONFLICT" },
          requestId: "req-9",
        },
      }),
    );
    const sim = createSimClient({ baseUrl: base, apiKey: "k", fetch });
    const error = await sim.execute(wf, { runId: "spike_1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SimApiError);
    const apiError = error as SimApiError;
    expect(apiError.status).toBe(409);
    expect(apiError.isRunIdConflict).toBe(true);
    expect(apiError.requestId).toBe("req-9");
  });

  it("treats a timeout as an unknown outcome, not a failure", async () => {
    const { fetch } = fakeFetch(new DOMException("The operation timed out.", "TimeoutError"));
    const sim = createSimClient({ baseUrl: base, apiKey: "k", fetch });
    const error = await sim.execute(wf, { runId: "spike_2" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SimOutcomeUnknownError);
    expect(error).toMatchObject({ outcome: "unknown", reason: "timeout", runId: "spike_2" });
  });

  it("treats a dropped connection as an unknown outcome", async () => {
    const { fetch } = fakeFetch(new TypeError("fetch failed"));
    const sim = createSimClient({ baseUrl: base, apiKey: "k", fetch });
    const error = await sim.execute(wf, { runId: "spike_3" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ outcome: "unknown", reason: "network" });
  });

  it("treats 503 ASYNC_ENQUEUE_AMBIGUOUS as an unknown outcome", async () => {
    const { fetch } = fakeFetch(
      json(503, {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "enqueue result unknown",
          details: { code: "ASYNC_ENQUEUE_AMBIGUOUS" },
        },
      }),
    );
    const sim = createSimClient({ baseUrl: base, apiKey: "k", fetch });
    const error = await sim.execute(wf, { runId: "spike_4" }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      outcome: "unknown",
      reason: "ambiguous_enqueue",
      runId: "spike_4",
    });
  });

  it("refuses a run ID Sim would reject, before sending anything", async () => {
    const { fetch, calls } = fakeFetch();
    const sim = createSimClient({ baseUrl: base, apiKey: "k", fetch });
    await expect(sim.execute(wf, { runId: "has space" })).rejects.toThrowError(TypeError);
    await expect(sim.execute(wf, { runId: "x".repeat(129) })).rejects.toThrowError(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("raises a SimContractError when a 2xx body doesn't match the contract", async () => {
    const { fetch } = fakeFetch(json(202, { data: { id: "not-a-receipt" } }));
    const sim = createSimClient({ baseUrl: base, apiKey: "k", fetch });
    await expect(sim.execute(wf)).rejects.toBeInstanceOf(SimContractError);
  });

  it("keeps a non-JSON error body as text", async () => {
    const { fetch } = fakeFetch(new Response("Bad Gateway", { status: 502 }));
    const sim = createSimClient({ baseUrl: base, apiKey: "k", fetch });
    const error = (await sim.execute(wf).catch((e: unknown) => e)) as SimApiError;
    expect(error).toBeInstanceOf(SimApiError);
    expect(error).toMatchObject({ status: 502, code: null, body: "Bad Gateway" });
  });
});

describe("runs", () => {
  it("reads run status with the version it ran and its pause points", async () => {
    const { fetch, calls } = fakeFetch(
      json(200, {
        data: {
          runId: "r1",
          workflowId: wf,
          status: "paused",
          trigger: "api",
          startedAt: "2026-11-27T10:00:00.000Z",
          endedAt: null,
          durationMs: null,
          version: 2,
          paused: {
            contextId: "ctx-1",
            pausedAt: "2026-11-27T10:00:01.000Z",
            resumeAt: null,
            pauseKind: "human",
            blockedOnBlockId: "blk-approval",
            automaticResumeWaitingReason: null,
            pausePointCount: 1,
            resumedCount: 0,
            points: [pausePoint],
          },
          cost: { total: 0 },
          error: null,
          output: null,
          blockOutputs: null,
          files: null,
        },
      }),
    );
    const sim = createSimClient({ baseUrl: base, apiKey: "k", fetch });
    const run = await sim.getRun(wf, "r1", { includeOutput: true });
    expect(run.version).toBe(2);
    expect(run.paused?.points[0]?.contextId).toBe("ctx-1");
    expect(calls[0]?.url.pathname).toBe(`/api/v2/workflows/${wf}/runs/r1`);
    expect(calls[0]?.url.searchParams.get("includeOutput")).toBe("true");
  });

  it("lists paused runs for a workspace", async () => {
    const { fetch, calls } = fakeFetch(
      json(200, {
        data: [
          {
            runId: "r1",
            workflowId: wf,
            workflowName: "hello-approval",
            pausedAt: "2026-11-27T10:00:01.000Z",
            points: [pausePoint],
          },
        ],
        nextCursor: null,
      }),
    );
    const sim = createSimClient({ baseUrl: base, apiKey: "k", fetch });
    const page = await sim.listPausedRuns({ workspaceId: "ws-1", limit: 25 });
    expect(page.data[0]?.points[0]?.kind).toBe("human");
    expect(page.nextCursor).toBeNull();
    expect(calls[0]?.url.pathname).toBe("/api/v2/workflows/runs/paused");
    expect(calls[0]?.url.searchParams.get("workspaceId")).toBe("ws-1");
    expect(calls[0]?.url.searchParams.get("limit")).toBe("25");
    expect(calls[0]?.url.searchParams.has("cursor")).toBe(false);
  });

  it("resumes with { contextId, input } and returns the new run's receipt", async () => {
    const { fetch, calls } = fakeFetch(
      json(202, { data: { runId: "r1-resume", statusUrl: `${base}/x` } }),
    );
    const sim = createSimClient({ baseUrl: base, apiKey: "k", fetch });
    const result = await sim.resume(wf, "r1", { contextId: "ctx-1", input: { approved: true } });
    expect(result).toMatchObject({ kind: "queued", runId: "r1-resume", httpStatus: 202 });
    expect(calls[0]?.url.pathname).toBe(`/api/v2/workflows/${wf}/runs/r1/resume`);
    expect(calls[0]?.body).toEqual({ contextId: "ctx-1", input: { approved: true } });
  });

  it("surfaces a refused second resume exactly as Sim sent it", async () => {
    const { fetch } = fakeFetch(
      json(409, {
        error: { code: "CONFLICT", message: "Pause point already resumed or in progress" },
      }),
    );
    const sim = createSimClient({ baseUrl: base, apiKey: "k", fetch });
    const error = (await sim
      .resume(wf, "r1", { contextId: "ctx-1", input: { approved: true } })
      .catch((e: unknown) => e)) as SimApiError;
    expect(error).toBeInstanceOf(SimApiError);
    expect(error.status).toBe(409);
    expect(error.message).toContain("already resumed");
    expect(error.isRunIdConflict).toBe(false);
  });

  it("cancels a run with no body", async () => {
    const { fetch, calls } = fakeFetch(
      json(200, {
        data: {
          success: true,
          runId: "r3",
          redisAvailable: true,
          durablyRecorded: true,
          locallyAborted: false,
          pausedCancelled: true,
          reason: "recorded",
        },
      }),
    );
    const sim = createSimClient({ baseUrl: base, apiKey: "k", fetch });
    const result = await sim.cancel(wf, "r3");
    expect(result).toMatchObject({ success: true, pausedCancelled: true });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.url.pathname).toBe(`/api/v2/workflows/${wf}/runs/r3/cancel`);
  });

  it("reads a run's log", async () => {
    const { fetch, calls } = fakeFetch(
      json(200, {
        data: {
          runId: "r1",
          workflowId: wf,
          deploymentVersionId: "dv-1",
          status: "completed",
          level: "info",
          trigger: "api",
          startedAt: "2026-11-27T10:00:00.000Z",
          endedAt: "2026-11-27T10:00:01.000Z",
          totalDurationMs: 1000,
          files: null,
          executedByEmail: null,
          workflow: { id: wf, name: "hello" },
          workflowState: null,
          traceSpans: [{ id: "s1", name: "Echo", type: "function" }],
          finalOutput: { echo: "hi" },
          cost: { total: 0, items: null },
          workflowInput: { name: "x" },
          createdAt: "2026-11-27T10:00:00.000Z",
        },
      }),
    );
    const sim = createSimClient({ baseUrl: base, apiKey: "k", fetch });
    const log = await sim.getLog("r1", { includeWorkflowState: false });
    expect(log.traceSpans).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe("/api/v2/logs/r1");
    expect(calls[0]?.url.searchParams.get("includeWorkflowState")).toBe("false");
  });
});
