import { randomUUID } from "node:crypto";
import { loadEnv } from "@repo/core";

export function databaseUrl(): string {
  return loadEnv(["database"]).DATABASE_URL;
}

/** A queue name no other test (or run) uses, so tests never see each other's jobs or monitor claims. */
export function uniqueQueue(prefix: string): string {
  return `test-${prefix}-${randomUUID().slice(0, 8)}`;
}

/** Heartbeat.source for rows tests write, so cleanup can't touch anything else. */
export const TEST_SOURCE = "test:queue";
