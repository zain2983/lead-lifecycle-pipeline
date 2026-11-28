import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { createBoss } from "../src/boss.ts";
import { drainQueues } from "../src/drain.ts";
import { ensureQueues, INTAKE_QUEUES, TRIAGE_QUEUE } from "../src/queues.ts";
import { spikeEchoHandler } from "../src/spike.ts";
import { sweepOnce } from "../src/sweep.ts";
import { databaseUrl, uniqueQueue } from "./helpers.ts";

const queues: string[] = [];

afterAll(async () => {
  const boss = createBoss({ mode: "vercel", connectionString: databaseUrl() });
  await boss.start();
  for (const name of queues) await boss.deleteQueue(name);
  await boss.stop();
});

describe("sweepOnce", () => {
  it("expires a job a dead process left active, then retries and completes it", async () => {
    const queue = uniqueQueue("sweep");
    queues.push(queue);

    // The process that dies: it fetches the job and never settles it, like a Vercel function killed
    // mid-job. stop() without settling stands in for the kill: fetch() jobs belong to no worker, so
    // pg-boss has nothing to fail on the way out. (The real SIGKILL run is in docs/evidence/spike-a.)
    const dead = createBoss({ mode: "vercel", connectionString: databaseUrl() });
    await dead.start();
    await dead.createQueue(queue, { retryLimit: 2, retryDelay: 0 });
    const id = await dead.send(queue, { n: 1 }, { expireInSeconds: 1 });
    const [fetched] = await dead.fetch(queue);
    expect(fetched?.id).toBe(id);
    await dead.stop({ graceful: false });

    const sweeper = createBoss({ mode: "sweeper", connectionString: databaseUrl() });
    await sweeper.start();
    try {
      const [stuck] = await sweeper.findJobs(queue, { id: id ?? "" });
      expect(stuck?.state).toBe("active");

      await sleep(1_500); // past the 1 s test-only expiry
      const summary = await sweepOnce(
        sweeper,
        { [queue]: spikeEchoHandler("sweeper") },
        { budgetSeconds: 10 },
      );
      expect(summary.worked).toContain(queue);
      expect(summary.processed).toBe(1);
      expect(summary.failed).toBe(0);
      expect(summary.timedOut).toBe(false);

      const [done] = await sweeper.findJobs(queue, { id: id ?? "" });
      expect(done?.state).toBe("completed");
      expect(done?.retryCount).toBe(1);
      expect(done?.output).toMatchObject({ handledBy: "sweeper", retryCount: 1 });
    } finally {
      await sweeper.stop();
    }
  });

  it("refuses a triage handler and skips the triage queue", async () => {
    const boss = createBoss({ mode: "sweeper", connectionString: databaseUrl() });
    await boss.start();
    try {
      await expect(
        sweepOnce(boss, { [TRIAGE_QUEUE]: spikeEchoHandler("sweeper") }, { budgetSeconds: 5 }),
      ).rejects.toThrow(/local worker/);
      // The triage queue is shared: the web intake tests send to it in a parallel suite on the same
      // database. Never delete it here. Create it the way they do (idempotent, same options), and leave it.
      await ensureQueues(boss, INTAKE_QUEUES);
      const summary = await sweepOnce(boss, {}, { budgetSeconds: 5 });
      expect(summary.skipped).toContainEqual({
        name: TRIAGE_QUEUE,
        reason: "triage: local worker only",
      });
      expect(summary.worked).not.toContain(TRIAGE_QUEUE);
    } finally {
      await boss.stop();
    }
  });
});

describe("drainQueues", () => {
  it("works every ready job, then removes its workers", async () => {
    const queue = uniqueQueue("drain");
    queues.push(queue);
    const boss = createBoss({ mode: "vercel", connectionString: databaseUrl() });
    await boss.start();
    try {
      await boss.createQueue(queue);
      await boss.send(queue, { n: 1 });
      await boss.send(queue, { n: 2 });
      const summary = await drainQueues(
        boss,
        { [queue]: spikeEchoHandler("after()") },
        { timeoutSeconds: 10 },
      );
      expect(summary).toMatchObject({ queues: [queue], processed: 2, failed: 0, timedOut: false });
      const states = (await boss.findJobs(queue)).map((job) => job.state);
      expect(states).toEqual(["completed", "completed"]);
      expect(boss.getWipData().length).toBe(0);
    } finally {
      await boss.stop();
    }
  });
});
