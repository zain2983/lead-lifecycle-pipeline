import { createHash } from "node:crypto";
import type { HubSpotWebhookEvent } from "./webhook-events.ts";

/**
 * The unique key of a stored webhook event (`crm_event.dedupe_key`). HubSpot's `eventId` is not unique,
 * and a retry resends the same event with a higher `attemptNumber`. So the key hashes the fields that
 * identify the change itself, and leaves `attemptNumber` (and everything about delivery) out:
 * `v1:` + sha256 of [portalId, subscriptionId, subscriptionType, objectId, propertyName, propertyValue,
 * occurredAt, eventId]. Bump the prefix if the field list ever changes; old rows keep their v1 keys.
 */
export function crmEventDedupeKey(event: HubSpotWebhookEvent): string {
  const identity = [
    event.portalId,
    event.subscriptionId,
    event.subscriptionType,
    event.objectId,
    event.propertyName ?? null,
    event.propertyValue ?? null,
    event.occurredAt,
    event.eventId,
  ];
  return `v1:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}
