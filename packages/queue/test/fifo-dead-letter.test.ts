// Evidence for ADR 0002 "decide in Phase 4": what key_strict_fifo does after a job is dead-lettered.

import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoss } from "../src/boss.ts";
import { databaseUrl, uniqueQueue } from "./helpers.ts";

describe("key_strict_fifo after a dead-letter (pg-boss 12.40.0)", () => {
  const queue = uniqueQueue("fifo");
  const dlq = `${queue}-dlq`;
  let boss: PgBoss;

  beforeAll(async () => {
    boss = createBoss({ mode: "vercel", connectionString: databaseUrl() });
    await boss.start();
    await boss.createQueue(dlq);
    await boss.createQueue(queue, { policy: "key_strict_fifo", retryLimit: 0, deadLetter: dlq });
  });

  afterAll(async () => {
    await boss?.deleteQueue(queue);
    await boss?.deleteQueue(dlq);
    await boss?.stop();
  });

  it("holds the key's next job until the failed one is deleted or retried", async () => {
    const first = await boss.send(queue, { step: 1 }, { singletonKey: "contact-1" });
    const second = await boss.send(queue, { step: 2 }, { singletonKey: "contact-1" });
    const other = await boss.send(queue, { step: 1 }, { singletonKey: "contact-2" });

    // One head per key.
    const heads = await boss.fetch(queue, { batchSize: 10 });
    expect(heads.map((job) => job.id).sort()).toEqual([first, other].sort());
    const head = heads.find((job) => job.id === first);
    if (!head) throw new Error("first job not fetched");
    await boss.complete(queue, other ?? "");

    // Out of retries: the job fails and pg-boss copies it to the dead-letter queue.
    await boss.fail(queue, head, { message: "poison" });
    const [failed] = await boss.findJobs(queue, { id: first ?? "" });
    expect(failed?.state).toBe("failed");
    const dead = await boss.findJobs(dlq);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.sourceName).toBe(queue);

    // The failed job still holds contact-1, so its next event waits.
    expect(await boss.getBlockedKeys(queue)).toEqual(["contact-1"]);
    expect(await boss.fetch(queue)).toEqual([]);

    // Deleting (or retrying) the failed job releases the key.
    await boss.deleteJob(queue, first ?? "");
    expect(await boss.getBlockedKeys(queue)).toEqual([]);
    const [next] = await boss.fetch(queue);
    expect(next?.id).toBe(second);
  });
});
