import { randomUUID } from "node:crypto";
import { deterministicJobId } from "@repo/core";
import { createPrismaClient, type PrismaClient } from "@repo/db";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoss } from "../src/boss.ts";
import { prismaTxDb } from "../src/prisma-tx.ts";
import { databaseUrl, TEST_SOURCE, uniqueQueue } from "./helpers.ts";

describe("transactional enqueue through a Prisma interactive transaction", () => {
  const queue = uniqueQueue("tx");
  let prisma: PrismaClient;
  let boss: PgBoss;

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl());
    boss = createBoss({ mode: "vercel", connectionString: databaseUrl() });
    await boss.start();
    await boss.createQueue(queue);
  });

  afterAll(async () => {
    await boss?.deleteQueue(queue);
    await boss?.stop();
    await prisma?.heartbeat.deleteMany({ where: { source: TEST_SOURCE } });
    await prisma?.$disconnect();
  });

  async function jobsWithKey(key: string) {
    return boss.findJobs(queue, { data: { key } });
  }

  it("rollback leaves no job and no heartbeat", async () => {
    const key = randomUUID();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.heartbeat.create({ data: { source: TEST_SOURCE, detail: key } });
        const id = await boss.send(queue, { key }, { db: prismaTxDb(tx) });
        expect(id).toBeTypeOf("string");
        // Inside the transaction the job is visible...
        expect(await boss.findJobs(queue, { data: { key }, db: prismaTxDb(tx) })).toHaveLength(1);
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    // ...and after the rollback it's gone, together with the app's own row.
    expect(await jobsWithKey(key)).toHaveLength(0);
    expect(await prisma.heartbeat.count({ where: { source: TEST_SOURCE, detail: key } })).toBe(0);
  });

  it("commit leaves exactly one job and the app's row", async () => {
    const key = randomUUID();
    const id = await prisma.$transaction(async (tx) => {
      await tx.heartbeat.create({ data: { source: TEST_SOURCE, detail: key } });
      const sent = await boss.send(queue, { key }, { db: prismaTxDb(tx) });
      // Not visible outside the transaction before it commits.
      expect(await jobsWithKey(key)).toHaveLength(0);
      return sent;
    });
    const jobs = await jobsWithKey(key);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe(id);
    expect(jobs[0]?.state).toBe("created");
    expect(await prisma.heartbeat.count({ where: { source: TEST_SOURCE, detail: key } })).toBe(1);
  });

  it("the same deterministic job id sent twice leaves one job", async () => {
    const key = randomUUID();
    const id = deterministicJobId(`${queue}:${key}`);
    const send = () =>
      prisma.$transaction(async (tx) => {
        await tx.heartbeat.create({ data: { source: TEST_SOURCE, detail: key } });
        return boss.send(queue, { key }, { id, db: prismaTxDb(tx) });
      });
    expect(await send()).toBe(id);
    // The second insert hits ON CONFLICT DO NOTHING: send returns null and the transaction still
    // commits. Callers that must not write their own row twice dedupe on their own key first.
    expect(await send()).toBeNull();
    const jobs = await jobsWithKey(key);
    expect(jobs.map((job) => job.id)).toEqual([id]);
  });

  it("refuses the root client, which would auto-commit the job outside the transaction", () => {
    expect(() => prismaTxDb(prisma)).toThrowError(/transaction client/);
  });
});
