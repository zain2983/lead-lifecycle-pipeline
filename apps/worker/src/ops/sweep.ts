import { parseArgs } from "node:util";
import { loadEnv } from "@repo/core";
import { loadRootEnvFile } from "@repo/core/dotenv";
import { createPrismaClient } from "@repo/db";
import { createBoss, ensureQueues, SPIKE_QUEUES, type SweepSummary, sweepOnce } from "@repo/queue";
import { sweeperHandlers } from "../handlers.ts";

export const USAGE = `usage: pnpm ops sweep --once [--budget <seconds>]

  sweep --once   pg-boss maintenance (expire abandoned jobs so they retry, retention), then work every
                 queue this process has a handler for except triage, within the budget (default 240 s),
                 then write a Heartbeat row (source "sweeper") and stop. This is what sweeper.yml runs.`;

export interface SweepArgs {
  budgetSeconds: number;
}

/** Parse `sweep` arguments. Throws with the usage text on anything it doesn't understand. */
export function parseSweepArgs(argv: readonly string[]): SweepArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { once: { type: "boolean" }, budget: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 0) throw new Error(`unexpected argument ${positionals[0]}\n\n${USAGE}`);
  if (!values.once) throw new Error(`sweep only runs once per process: pass --once\n\n${USAGE}`);
  const budgetSeconds = values.budget === undefined ? 240 : Number(values.budget);
  if (!Number.isInteger(budgetSeconds) || budgetSeconds < 1 || budgetSeconds > 3_000) {
    throw new Error(`--budget must be a whole number of seconds from 1 to 3000\n\n${USAGE}`);
  }
  return { budgetSeconds };
}

/** Run one sweep. Returns false when it failed (the Heartbeat row records why). */
export async function runSweep({ budgetSeconds }: SweepArgs): Promise<boolean> {
  loadRootEnvFile();
  // A CLI on Actions: the session pooler (DIRECT_URL), like migrations. See ADR 0002.
  const { DIRECT_URL } = loadEnv(["databaseDirect"]);
  const boss = createBoss({ mode: "sweeper", connectionString: DIRECT_URL });
  const prisma = createPrismaClient(DIRECT_URL);
  let summary: SweepSummary | undefined;
  let failure: string | undefined;
  try {
    await boss.start();
    await ensureQueues(boss, SPIKE_QUEUES);
    summary = await sweepOnce(boss, sweeperHandlers, { budgetSeconds });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const detail = failure ? { ok: false, error: failure } : { ok: true, ...summary };
  try {
    const heartbeat = await prisma.heartbeat.create({
      data: { source: "sweeper", detail: JSON.stringify(detail) },
    });
    console.log(JSON.stringify({ sweep: detail, heartbeatId: heartbeat.id.toString() }));
  } catch (error) {
    failure ??= `heartbeat: ${error instanceof Error ? error.message : String(error)}`;
    console.log(JSON.stringify({ sweep: detail, heartbeatError: failure }));
  } finally {
    // stop() waits (up to 10 s) for a batch still running when the budget ran out.
    await boss.stop({ timeout: 10_000 }).catch((error: unknown) => console.error(error));
    await prisma.$disconnect();
  }
  return failure === undefined;
}
