import { createHash } from "node:crypto";

/**
 * This project's UUID v5 namespace: uuidv5(URL namespace, "https://example.com/lead-lifecycle-pipeline").
 * Fixed forever, because every deterministic ID below is derived from it.
 */
export const ID_NAMESPACE = "5bc6d3ed-76f3-58fc-8e67-183139773c23";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RFC 9562 UUID version 5 (SHA-1, name-based). The same name and namespace always give the same ID. */
export function uuidV5(name: string, namespace: string = ID_NAMESPACE): string {
  if (!UUID.test(namespace)) throw new TypeError(`uuidV5: namespace is not a UUID: ${namespace}`);
  const hash = createHash("sha1")
    .update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
    .update(name, "utf8")
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A pg-boss job ID derived from an idempotency key (pg-boss job IDs are UUIDs). Sending twice with the
 * same key inserts one job: the second `send` finds the ID taken and returns null.
 */
export function deterministicJobId(idempotencyKey: string): string {
  if (idempotencyKey.length === 0) throw new TypeError("deterministicJobId: empty idempotency key");
  return uuidV5(`job:${idempotencyKey}`);
}
