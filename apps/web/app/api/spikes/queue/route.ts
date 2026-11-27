// Spike A (PLAN Phase 1 step 4): transactional enqueue, then an after() drain. Spike-only, and never
// live by accident: every method answers 404 unless SPIKE_ROUTES is exactly "1".
import { randomUUID } from "node:crypto";
import { deterministicJobId, loadEnv } from "@repo/core";
import { createPgPool, createPrismaClient, type PgPool, type PrismaClient } from "@repo/db";
import {
  createBoss,
  drainQueues,
  ensureQueues,
  type PgBoss,
  prismaTxDb,
  SPIKE_ECHO_QUEUE,
  SPIKE_QUEUES,
  spikeEchoHandler,
} from "@repo/queue";
import { attachDatabasePool } from "@vercel/functions";
import { after } from "next/server";

export const dynamic = "force-dynamic";
/** after() runs inside the same invocation and shares this limit: a 20 s drain plus start and stop. */
export const maxDuration = 60;

const DRAIN_SECONDS = 20;

interface Shared {
  prisma: PrismaClient;
  bossPool: PgPool;
  queuesReady?: Promise<unknown>;
}
let shared: Shared | undefined;

/**
 * Module scope, so a warm instance reuses its connections across invocations. Both pools are ours, so
 * both can be wrapped with attachDatabasePool: on Vercel it keeps the instance alive until idle clients
 * have closed, instead of being suspended while still holding them. Off Vercel it does nothing.
 */
function getShared(databaseUrl: string): Shared {
  if (!shared) {
    const prismaPool = createPgPool(databaseUrl, { max: 2, applicationName: "web:prisma" });
    const bossPool = createPgPool(databaseUrl, { max: 2, applicationName: "web:pgboss" });
    attachDatabasePool(prismaPool);
    attachDatabasePool(bossPool);
    shared = { prisma: createPrismaClient(prismaPool), bossPool };
  }
  return shared;
}

/** One pg-boss instance per invocation, on the shared pool. Cheap: no connections of its own, no timers once stopped. */
async function startBoss(state: Shared): Promise<PgBoss> {
  const boss = createBoss({ mode: "vercel", pool: state.bossPool });
  await boss.start();
  try {
    state.queuesReady ??= ensureQueues(boss, SPIKE_QUEUES).catch((error: unknown) => {
      state.queuesReady = undefined;
      throw error;
    });
    await state.queuesReady;
  } catch (error) {
    await boss.stop();
    throw error;
  }
  return boss;
}

function enabled(): boolean {
  return loadEnv(["spikes"]).SPIKE_ROUTES;
}

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ spike: "queue", ...event }));
}

/** Body (optional): {"key": "<idempotency key>"}. The same key gives the same job id, so one job. */
export async function POST(request: Request): Promise<Response> {
  if (!enabled()) return notFound();
  const state = getShared(loadEnv(["database"]).DATABASE_URL);
  const body: unknown = await request.json().catch(() => null);
  const given = (body as { key?: unknown } | null)?.key;
  const key =
    typeof given === "string" && given.length > 0 && given.length <= 200 ? given : randomUUID();
  const jobId = deterministicJobId(`${SPIKE_ECHO_QUEUE}:${key}`);

  const started = performance.now();
  const boss = await startBoss(state);
  const bossStartMs = Math.round(performance.now() - started);
  let committed: { heartbeatId: string; sent: string | null };
  try {
    committed = await state.prisma.$transaction(async (tx) => {
      const heartbeat = await tx.heartbeat.create({
        data: { source: "web:spike-queue", detail: key },
      });
      const sent = await boss.send(
        SPIKE_ECHO_QUEUE,
        { key, heartbeatId: heartbeat.id.toString() },
        { id: jobId, db: prismaTxDb(tx) },
      );
      return { heartbeatId: heartbeat.id.toString(), sent };
    });
  } catch (error) {
    await boss.stop();
    throw error;
  }
  const enqueued = committed.sent !== null;
  log({ phase: "enqueued", jobId, enqueued, heartbeatId: committed.heartbeatId, bossStartMs });

  after(async () => {
    try {
      const drained = await drainQueues(
        boss,
        { [SPIKE_ECHO_QUEUE]: spikeEchoHandler("after()") },
        { timeoutSeconds: DRAIN_SECONDS },
      );
      log({ phase: "after-drain", jobId, ...drained });
    } catch (error) {
      log({
        phase: "after-drain",
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Waits up to 5 s for a batch still running when the drain's deadline passed.
      await boss.stop({ timeout: 5_000 });
    }
  });

  return Response.json(
    {
      jobId,
      key,
      enqueued,
      heartbeatId: committed.heartbeatId,
      drainSeconds: DRAIN_SECONDS,
      bossStartMs,
    },
    { status: 202 },
  );
}

/** ?id=<job id>: the job as pg-boss stores it, to see what after() did. */
export async function GET(request: Request): Promise<Response> {
  if (!enabled()) return notFound();
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return Response.json({ error: "pass ?id=<job id>" }, { status: 400 });
  }
  const boss = await startBoss(getShared(loadEnv(["database"]).DATABASE_URL));
  try {
    const [job] = await boss.findJobs(SPIKE_ECHO_QUEUE, { id });
    if (!job) return Response.json({ id, found: false }, { status: 404 });
    return Response.json({
      id: job.id,
      state: job.state,
      retryCount: job.retryCount,
      createdOn: job.createdOn,
      startedOn: job.startedOn,
      completedOn: job.completedOn,
      output: job.output,
    });
  } finally {
    await boss.stop();
  }
}
