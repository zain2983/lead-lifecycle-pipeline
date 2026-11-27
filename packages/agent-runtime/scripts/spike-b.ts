/**
 * Spike B live checks against the local Sim instance (PLAN Phase 1, step 5). Every HTTP exchange is recorded,
 * redacted, into docs/evidence/spike-b/live/<step>.json exactly as it went over the wire, so nothing in the
 * evidence is reconstructed or mocked.
 *
 * Needs: Sim up (infra/sim), the two spike workflows created and deployed (sim/README.md), and in the root .env:
 *   SIM_BASE_URL, SIM_API_KEY (personal key), SIM_WORKSPACE_ID.
 *
 * Run from the repo root:  pnpm --filter @repo/agent-runtime spike [all|idempotency|versions|hitl]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "@repo/core";
import {
  createSimClient,
  type FetchLike,
  type RunStatus,
  SimApiError,
  type SimClient,
} from "../src/index.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = join(repoRoot, "docs/evidence/spike-b/live");

try {
  process.loadEnvFile(join(repoRoot, ".env"));
} catch {
  // No root .env: rely on the process environment.
}
const env = loadEnv(["sim"]);

/** The workflow ID the CLI recorded for a source directory (instance-specific, gitignored). */
function workflowIdOf(dir: string): string {
  const base = JSON.parse(readFileSync(join(repoRoot, dir, ".sim/base.json"), "utf8")) as {
    workflowId?: unknown;
  };
  if (typeof base.workflowId !== "string")
    throw new Error(`${dir}/.sim/base.json has no workflowId`);
  return base.workflowId;
}

// --- recording + redaction -------------------------------------------------------------------------------

interface Exchange {
  at: string;
  request: { method: string; url: string; headers: Record<string, string>; body: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown; elapsedMs: number };
}

const SECRET_KEY = /(api[-_]?key|token|secret|password|authorization|cookie)/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SIM_KEY = /\b(sk-sim-|sim_)[A-Za-z0-9_-]{8,}/g;

function redact(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key) && typeof value === "string" && value.length > 0) return "[redacted]";
  if (typeof value === "string") {
    return value.replace(SIM_KEY, "$1[redacted]").replace(EMAIL, "[redacted-email]");
  }
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

const KEEP_RESPONSE_HEADERS = ["content-type", "x-request-id", "x-run-id", "retry-after"];

let exchanges: Exchange[] = [];

const recordingFetch: FetchLike = async (input, init) => {
  const started = performance.now();
  const response = await fetch(input, init);
  const text = await response.clone().text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  const reqHeaders = Object.fromEntries(new Headers(init.headers).entries());
  exchanges.push({
    at: new Date().toISOString(),
    request: {
      method: init.method ?? "GET",
      url: input,
      headers: redact(reqHeaders) as Record<string, string>,
      body: redact(typeof init.body === "string" ? JSON.parse(init.body) : null),
    },
    response: {
      status: response.status,
      headers: Object.fromEntries(
        [...response.headers.entries()].filter(([k]) => KEEP_RESPONSE_HEADERS.includes(k)),
      ),
      body: redact(body),
      elapsedMs: Math.round(performance.now() - started),
    },
  });
  return response;
};

function save(step: string, notes: Record<string, unknown>) {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${step}.json`);
  writeFileSync(file, `${JSON.stringify({ step, notes: redact(notes), exchanges }, null, 2)}\n`);
  console.log(`  saved ${file.slice(repoRoot.length + 1)} (${exchanges.length} exchanges)`);
  exchanges = [];
}

// --- helpers ---------------------------------------------------------------------------------------------

const sim: SimClient = createSimClient({
  baseUrl: env.SIM_BASE_URL,
  apiKey: env.SIM_API_KEY,
  fetch: recordingFetch,
});
const stamp = new Date()
  .toISOString()
  .replace(/[-:.TZ]/g, "")
  .slice(0, 14);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

async function waitFor(
  workflowId: string,
  runId: string,
  until: (run: RunStatus) => boolean,
  timeoutMs = 60_000,
): Promise<RunStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await sim.getRun(workflowId, runId, { includeOutput: true });
    if (until(run)) return run;
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} still ${run.status} after ${timeoutMs} ms (outcome unknown)`);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

async function caught<T>(p: Promise<T>): Promise<T | SimApiError> {
  try {
    return await p;
  } catch (error) {
    if (error instanceof SimApiError) return error;
    throw error;
  }
}

function describeError(e: SimApiError) {
  return { status: e.status, code: e.code, detailCode: e.detailCode, message: e.message };
}

async function versionsOf(workflowId: string): Promise<unknown> {
  const response = await recordingFetch(
    `${env.SIM_BASE_URL}/api/v2/workflows/${workflowId}/versions`,
    {
      method: "GET",
      headers: { Accept: "application/json", "X-API-Key": env.SIM_API_KEY },
    },
  );
  return response.json();
}

// --- checks ----------------------------------------------------------------------------------------------

/** Async execute with X-Run-Id (expect 202), then the same ID again (expect 409 RUN_ID_CONFLICT). */
async function idempotency() {
  console.log("idempotency: async execute twice with one X-Run-Id");
  const wf = workflowIdOf("sim/hello");
  const runId = `spikeb_dup_${stamp}`;
  const first = await sim.execute(wf, { input: { name: "Spike B" }, runId });
  const second = await caught(sim.execute(wf, { input: { name: "Spike B" }, runId }));
  const done = await waitFor(wf, runId, (r) => TERMINAL.has(r.status));
  const log = await sim.getLog(runId, { includeWorkflowState: false });
  save("01-idempotency", {
    runId,
    first: { httpStatus: first.httpStatus, kind: first.kind },
    second:
      second instanceof SimApiError
        ? { ...describeError(second), isRunIdConflict: second.isRunIdConflict }
        : { unexpected: "second execute was accepted", httpStatus: second.httpStatus },
    final: { status: done.status, version: done.version, output: done.output },
    log: { status: log.status, spans: log.traceSpans.map((s) => s.name) },
  });
}

/** With v2 active, run v1 through run.version and show v1's output next to v2's. */
async function versions() {
  console.log("versions: run the active version and v1 by run.version");
  const wf = workflowIdOf("sim/hello");
  const list = await versionsOf(wf);
  const activeId = `spikeb_active_${stamp}`;
  const v1Id = `spikeb_v1_${stamp}`;
  await sim.execute(wf, { input: { name: "Spike B" }, runId: activeId });
  await sim.execute(wf, { input: { name: "Spike B" }, runId: v1Id, version: 1 });
  const active = await waitFor(wf, activeId, (r) => TERMINAL.has(r.status));
  const v1 = await waitFor(wf, v1Id, (r) => TERMINAL.has(r.status));
  const missing = await caught(
    sim.execute(wf, { input: { name: "Spike B" }, runId: `spikeb_v99_${stamp}`, version: 99 }),
  );
  save("02-versions", {
    versions: list,
    active: { runId: activeId, version: active.version, output: active.output },
    pinnedV1: { runId: v1Id, version: v1.version, output: v1.output },
    unknownVersion:
      missing instanceof SimApiError ? describeError(missing) : { unexpected: missing },
  });
}

/** Pause at a Human block, list it, resume it, try a second resume, and cancel a separate paused run. */
async function hitl() {
  console.log("hitl: pause, list, resume, resume again, cancel another");
  const wf = workflowIdOf("sim/hello-approval");

  const runA = `spikeb_hitl_a_${stamp}`;
  await sim.execute(wf, { input: { item: "synthetic lead 001" }, runId: runA });
  const pausedA = await waitFor(wf, runA, (r) => r.status === "paused" || TERMINAL.has(r.status));
  save("03-hitl-pause", { runId: runA, status: pausedA.status, paused: pausedA.paused });

  const page = await sim.listPausedRuns({ workspaceId: env.SIM_WORKSPACE_ID, includeOutput: true });
  const listed = page.data.find((r) => r.runId === runA);
  save("04-hitl-list-paused", {
    runId: runA,
    listed: listed !== undefined,
    count: page.data.length,
  });

  const contextId = pausedA.paused?.points[0]?.contextId;
  if (!contextId) throw new Error(`run ${runA} has no pause point: ${pausedA.status}`);
  const resumed = await sim.resume(wf, runA, { contextId, input: { approved: true } });
  const resumedRun = await waitFor(wf, resumed.runId, (r) => TERMINAL.has(r.status));
  const originalAfter = await sim.getRun(wf, runA, { includeOutput: true });
  save("05-hitl-resume", {
    pausedRunId: runA,
    contextId,
    resume: { httpStatus: resumed.httpStatus, kind: resumed.kind, newRunId: resumed.runId },
    resumedRun: { status: resumedRun.status, output: resumedRun.output },
    originalRunAfter: { status: originalAfter.status },
  });

  const again = await caught(sim.resume(wf, runA, { contextId, input: { approved: true } }));
  save("06-hitl-resume-again", {
    pausedRunId: runA,
    contextId,
    second: again instanceof SimApiError ? describeError(again) : { unexpected: "accepted", again },
  });

  const runB = `spikeb_hitl_b_${stamp}`;
  await sim.execute(wf, { input: { item: "synthetic lead 002" }, runId: runB });
  await waitFor(wf, runB, (r) => r.status === "paused" || TERMINAL.has(r.status));
  const cancelled = await sim.cancel(wf, runB);
  const afterCancel = await waitFor(wf, runB, (r) => r.status !== "paused", 15_000).catch(
    async () => sim.getRun(wf, runB),
  );
  const pageAfter = await sim.listPausedRuns({ workspaceId: env.SIM_WORKSPACE_ID });
  save("07-hitl-cancel", {
    runId: runB,
    cancel: cancelled,
    statusAfter: afterCancel.status,
    stillListedAsPaused: pageAfter.data.some((r) => r.runId === runB),
  });
}

/** Resuming is not approving: `approved: false` must take the Condition's else branch. */
async function reject() {
  console.log("reject: resume with approved:false");
  const wf = workflowIdOf("sim/hello-approval");
  const runC = `spikeb_hitl_c_${stamp}`;
  await sim.execute(wf, { input: { item: "synthetic lead 003" }, runId: runC });
  const paused = await waitFor(wf, runC, (r) => r.status === "paused" || TERMINAL.has(r.status));
  const contextId = paused.paused?.points[0]?.contextId;
  if (!contextId) throw new Error(`run ${runC} has no pause point: ${paused.status}`);
  const resumed = await sim.resume(wf, runC, {
    contextId,
    input: { approved: false, comment: "spike: reject path" },
  });
  const done = await waitFor(wf, resumed.runId, (r) => TERMINAL.has(r.status));
  save("08-hitl-reject", {
    pausedRunId: runC,
    resume: { httpStatus: resumed.httpStatus, newRunId: resumed.runId },
    resumedRun: { status: done.status, output: done.output },
  });
}

const steps: Record<string, () => Promise<void>> = { idempotency, versions, hitl, reject };
const pick = process.argv[2] ?? "all";
for (const [name, run] of Object.entries(steps)) {
  if (pick === "all" || pick === name) await run();
}
