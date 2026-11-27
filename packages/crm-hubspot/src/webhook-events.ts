import { z } from "zod";

/**
 * One event in a HubSpot webhook batch (webhooks v3, developer-platform `webhooks` component).
 * Docs: https://developers.hubspot.com/docs/api-reference/latest/webhooks/guide (classic types such as
 * `contact.propertyChange`) and .../create-generic-webhook-subscriptions (`object.*` types, which add
 * `objectTypeId`). Unknown fields are kept: HubSpot adds fields over time.
 *
 * Facts that shape the consumer (Phase 3): `eventId` is not unique, events are not ordered (use
 * `occurredAt`), the same event can arrive more than once, and a batch holds fewer than 100 events.
 */
export const webhookEventSchema = z.looseObject({
  eventId: z.number().int(),
  subscriptionId: z.number().int(),
  portalId: z.number().int(),
  appId: z.number().int(),
  /** Milliseconds since the epoch. */
  occurredAt: z.number().int(),
  /** `object.creation`, `contact.propertyChange`, `deal.propertyChange`, `contact.privacyDeletion`, … */
  subscriptionType: z.string().min(1),
  /** Starts at 0. */
  attemptNumber: z.number().int().nonnegative(),
  objectId: z.number().int(),
  /** `object.*` events only, e.g. `0-1` for contacts. */
  objectTypeId: z.string().optional(),
  /** Property-change events only. */
  propertyName: z.string().optional(),
  propertyValue: z.string().optional(),
  changeSource: z.string().optional(),
  sourceId: z.string().optional(),
});

export type HubSpotWebhookEvent = z.infer<typeof webhookEventSchema>;

export const webhookBatchSchema = z.array(webhookEventSchema).min(1).max(100);

export type ParseWebhookBatchResult =
  | { ok: true; events: HubSpotWebhookEvent[] }
  | { ok: false; error: "invalid_json" | "invalid_shape"; issues?: string[] };

/** Parse a body that has already passed signature verification. */
export function parseWebhookBatch(rawBody: string): ParseWebhookBatchResult {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  const parsed = webhookBatchSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: "invalid_shape",
      issues: parsed.error.issues
        .slice(0, 10)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    };
  }
  return { ok: true, events: parsed.data };
}
