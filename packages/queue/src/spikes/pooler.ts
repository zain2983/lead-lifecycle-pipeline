// Spike A, pooler test (PLAN Phase 1 step 4). Runs the same checks against the app Postgres directly and
// through PgBouncer in transaction mode (infra/docker-compose.yml, profile `pooler`, 127.0.0.1:6433), with
// and without `?pgbouncer=true`, and prints one JSON line per check with the real result or error.
//
//   pnpm --filter @repo/queue exec tsx src/spikes/pooler.ts [--targets direct,pooler,pooler-pgbouncer]
//     [--no-listen | --listen-only] [--listen-settle-ms 1500]
//
// Against a hosted database, raise --listen-settle-ms (e.g. 10000): if the worker's first poll is still
// running when the job is sent, that poll picks it up and the latency says nothing about NOTIFY.
//
// Connection strings are built from DATABASE_URL (only the port and query change) and never printed.
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { loadEnv } from "@repo/core";
import { loadRootEnvFile } from "@repo/core/dotenv";
import { createPgPool, createPrismaClient } from "@repo/db";
import type { PgBoss } from "pg-boss";
import { createBoss } from "../boss.ts";
import { prismaTxDb } from "../prisma-tx.ts";

loadRootEnvFile();
const { values } = parseArgs({
  options: {
    targets: { type: "string", default: "direct,pooler,pooler-pgbouncer" },
    "no-listen": { type: "boolean", default: false },
    "listen-only": { type: "boolean", default: false },
    "listen-settle-ms": { type: "string", default: "1500" },
    "pooler-port": { type: "string", default: "6433" },
  },
});
const settleMs = Number(values["listen-settle-ms"]);

const base = new URL(loadEnv(["database"]).DATABASE_URL);
function targetUrl(name: string): string {
  const url = new URL(base);
  if (name.startsWith("pooler")) url.port = values["pooler-port"];
  if (name.endsWith("-pgbouncer")) url.searchParams.set("pgbouncer", "true");
  return url.toString();
}

function errorInfo(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) };
  const { code, severity } = error as Error & { code?: string; severity?: string };
  return { name: error.name, message: error.message.split("\n")[0], code, severity };
}

async function check(target: string, name: string, fn: () => Promise<unknown>): Promise<boolean> {
  const started = performance.now();
  try {
    const result = await fn();
    const ms = Math.round(performance.now() - started);
    console.log(JSON.stringify({ target, check: name, ok: true, ms, result }));
    return true;
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    console.log(JSON.stringify({ target, check: name, ok: false, ms, error: errorInfo(error) }));
    return false;
  }
}

async function withBoss<T>(boss: PgBoss, fn: (boss: PgBoss) => Promise<T>): Promise<T> {
  await boss.start();
  try {
    return await fn(boss);
  } finally {
    await boss.stop({ timeout: 2_000 }).catch(() => undefined);
  }
}

async function run(target: string): Promise<void> {
  const url = targetUrl(target);
  if (values["listen-only"]) {
    await rawListenCheck(target, url);
    await listenCheck(target, url);
    return;
  }

  const pool = createPgPool(url, { max: 4, applicationName: `spike-pooler:${target}` });
  pool.on("error", () => undefined);
  await check(target, "pg: 40 unnamed parameterised queries, 8 at a time", async () => {
    for (let round = 0; round < 5; round++) {
      await Promise.all(
        Array.from({ length: 8 }, (_, i) => pool.query("SELECT $1::int AS n", [round * 8 + i])),
      );
    }
    return { queries: 40 };
  });
  await check(
    target,
    "pg: named prepared statements (what a statementNameGenerator turns on)",
    async () => {
      for (let round = 0; round < 5; round++) {
        await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            pool.query({ name: `spike_stmt_${i % 2}`, text: "SELECT $1::int AS n", values: [i] }),
          ),
        );
      }
      return { queries: 40 };
    },
  );
  await pool.end();

  const prisma = createPrismaClient(url);
  const marker = `pooler:${target}:${randomUUID().slice(0, 8)}`;
  await check(target, "prisma (adapter-pg): 40 queries, 8 at a time", async () => {
    for (let round = 0; round < 5; round++) {
      await Promise.all(
        Array.from({ length: 8 }, () => prisma.heartbeat.count({ where: { source: marker } })),
      );
    }
    return { queries: 40 };
  });

  const boss = createBoss({ mode: "vercel", connectionString: url, onError: () => undefined });
  const queue = `spike-pooler-${target}-${randomUUID().slice(0, 6)}`;
  await check(target, "pg-boss vercel mode: start, createQueue, send, fetch, complete", async () =>
    withBoss(boss, async (b) => {
      await b.createQueue(queue);
      const id = await b.send(queue, { target });
      const [job] = await b.fetch(queue);
      await b.complete(queue, job?.id ?? "");
      const [stored] = await b.findJobs(queue, { id: id ?? "" });
      return { sent: id, fetched: job?.id === id, state: stored?.state };
    }),
  );
  const txBoss = createBoss({ mode: "vercel", connectionString: url, onError: () => undefined });
  await check(
    target,
    "prisma interactive tx + pg-boss send (prismaTxDb): commit, then rollback",
    async () =>
      withBoss(txBoss, async (b) => {
        const committed = await prisma.$transaction(async (tx) => {
          await tx.heartbeat.create({ data: { source: marker, detail: "commit" } });
          return b.send(queue, { kind: "commit" }, { db: prismaTxDb(tx) });
        });
        const rolledBack = await prisma
          .$transaction(async (tx) => {
            await tx.heartbeat.create({ data: { source: marker, detail: "rollback" } });
            await b.send(queue, { kind: "rollback" }, { db: prismaTxDb(tx) });
            throw new Error("rollback on purpose");
          })
          .catch((error: unknown) => (error as Error).message);
        const jobs = await b.findJobs(queue, { data: { kind: "commit" } });
        const ghosts = await b.findJobs(queue, { data: { kind: "rollback" } });
        const rows = await prisma.heartbeat.count({ where: { source: marker } });
        await b.deleteQueue(queue);
        return {
          committedJob: jobs.length === 1 && jobs[0]?.id === committed,
          rolledBack,
          rollbackJobs: ghosts.length,
          heartbeatRows: rows,
        };
      }),
  );
  await prisma.heartbeat.deleteMany({ where: { source: marker } }).catch(() => undefined);
  await prisma.$disconnect();

  const sweeper = createBoss({ mode: "sweeper", connectionString: url, onError: () => undefined });
  await check(target, "pg-boss sweeper mode: start, supervise() (maintenance), stop", async () =>
    withBoss(sweeper, async (b) => {
      const started = performance.now();
      await b.supervise();
      return { superviseMs: Math.round(performance.now() - started) };
    }),
  );

  if (!values["no-listen"]) {
    await rawListenCheck(target, url);
    await listenCheck(target, url);
  }
}

/** LISTEN/NOTIFY without pg-boss or polling: does an idle listener get another connection's NOTIFY? */
async function rawListenCheck(target: string, url: string): Promise<void> {
  const channel = `spike_raw_${randomUUID().slice(0, 8)}`;
  await check(
    target,
    "pg: idle LISTEN, then NOTIFY from a second connection (10 s wait)",
    async () => {
      // Two one-connection pools, so listener and sender never share a client.
      const listenerPool = createPgPool(url, { max: 1 });
      const sender = createPgPool(url, { max: 1 });
      listenerPool.on("error", () => undefined);
      sender.on("error", () => undefined);
      try {
        const listener = await listenerPool.connect();
        listener.on("error", () => undefined);
        await sender.query("SELECT 1"); // connect before the clock starts
        let sentAt = 0;
        let timer: NodeJS.Timeout | undefined;
        const received = new Promise<number | null>((resolve) => {
          listener.on("notification", (message) => {
            if (message.channel === channel) resolve((Date.now() - sentAt) / 1000);
          });
          timer = setTimeout(() => resolve(null), settleMs + 10_000);
        });
        await listener.query(`LISTEN ${channel}`);
        await new Promise((resolve) => setTimeout(resolve, settleMs));
        sentAt = Date.now();
        await sender.query("SELECT pg_notify($1, 'spike')", [channel]);
        const latencySeconds = await received;
        clearTimeout(timer);
        await listener.query(`UNLISTEN ${channel}`);
        listener.release();
        return { delivered: latencySeconds !== null, latencySeconds };
      } finally {
        // A client still checked out after a failure would make end() wait for ever; don't await it.
        void listenerPool.end().catch(() => undefined);
        await sender.end().catch(() => undefined);
      }
    },
  );
}

/** LISTEN/NOTIFY: how long a notify-enabled worker takes to see a new job. */
async function listenCheck(target: string, url: string): Promise<void> {
  const warnings: string[] = [];
  const worker = createBoss({
    mode: "worker",
    connectionString: url,
    onError: () => undefined,
    overrides: { useListenNotify: true, registerInstance: false },
  });
  worker.on("warning", (warning) =>
    warnings.push(
      `${warning.data && (warning.data as { type?: string }).type}: ${warning.message}`,
    ),
  );
  const sender = createBoss({ mode: "vercel", connectionString: url, onError: () => undefined });
  const queue = `spike-listen-${target}-${randomUUID().slice(0, 6)}`;
  await check(
    target,
    "pg-boss LISTEN/NOTIFY: seconds from send to handler (notify queue, 30 s poll backstop)",
    async () => {
      await sender.start();
      await worker.start();
      try {
        await sender.createQueue(queue, { notify: true });
        let sentAt = 0;
        const seen = new Promise<number>((resolve) => {
          void worker.work(queue, { pollingIntervalSeconds: 30 }, async () => {
            resolve(Date.now() - sentAt);
          });
        });
        // Let the worker finish its first (empty) poll so only a notification can wake it early.
        await new Promise((resolve) => setTimeout(resolve, settleMs));
        sentAt = Date.now();
        await sender.send(queue, { target });
        const timeout = new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error("no pickup within 40 s")), 40_000),
        );
        const latencyMs = await Promise.race([seen, timeout]);
        return { latencySeconds: latencyMs / 1000, settleMs, warnings };
      } finally {
        await worker.stop({ timeout: 2_000 }).catch(() => undefined);
        await sender.deleteQueue(queue).catch(() => undefined);
        await sender.stop().catch(() => undefined);
      }
    },
  );
}

for (const target of values.targets.split(",")) {
  await run(target.trim());
}
