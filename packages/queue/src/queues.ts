import type { PgBoss, Queue } from "pg-boss";

/** Triage calls Sim, which only the local worker can reach, so only the local worker consumes it. */
export const TRIAGE_QUEUE = "triage";

export interface QueueDefinition {
  name: string;
  options?: Omit<Queue, "name">;
}

/**
 * Create each queue that is missing, in order (a dead-letter queue must exist before a queue that
 * names it). `createQueue` is idempotent in pg-boss 12 (`ON CONFLICT DO NOTHING`), but it never changes
 * an existing queue's options; Phase 4 adds `updateQueue` for that. Returns the names it created.
 */
export async function ensureQueues(
  boss: PgBoss,
  definitions: readonly QueueDefinition[],
): Promise<string[]> {
  const existing = new Set(
    (await boss.getQueues(definitions.map((definition) => definition.name))).map((q) => q.name),
  );
  const created: string[] = [];
  for (const { name, options } of definitions) {
    if (existing.has(name)) continue;
    await boss.createQueue(name, options);
    created.push(name);
  }
  return created;
}
