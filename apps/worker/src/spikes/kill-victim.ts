// Spike A kill test, the process that gets killed. It enqueues one spike-kill job with a short,
// test-only expiry, fetches it the way a Vercel function would (vercel mode: no supervisor), prints
// its id and then hangs without ever settling it, until the test SIGKILLs it.
// Run with `node --import tsx` (not the tsx CLI, which forks a child the kill would miss).
import { loadEnv, loadRootEnvFile } from "@repo/core";
import { createBoss, ensureQueues, SPIKE_KILL_QUEUE, SPIKE_QUEUES } from "@repo/queue";

loadRootEnvFile();
const { DATABASE_URL } = loadEnv(["database"]);
const expireInSeconds = Number(process.argv[2] ?? "5");

const boss = createBoss({ mode: "vercel", connectionString: DATABASE_URL });
await boss.start();
await ensureQueues(boss, SPIKE_QUEUES);
const id = await boss.send(
  SPIKE_KILL_QUEUE,
  { from: "kill-test", sentAt: new Date().toISOString() },
  { expireInSeconds },
);
const [job] = await boss.fetch(SPIKE_KILL_QUEUE);
if (!job || job.id !== id) {
  console.error(
    `kill-victim: fetched ${job?.id ?? "nothing"}, expected ${id}; is an old job ready?`,
  );
  process.exit(1);
}
console.log(`FETCHED ${job.id} pid=${process.pid} expireInSeconds=${job.expireInSeconds}`);
// Hang "mid-job". Nothing here will ever complete or fail it.
setInterval(() => {}, 1 << 30);
