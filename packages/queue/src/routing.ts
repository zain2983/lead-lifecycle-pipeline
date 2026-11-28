import { TRIAGE_QUEUE } from "./queues.ts";

/**
 * Where one stored HubSpot webhook event goes (PLAN Phase 3.3). **Phase 4 replaces this function** with
 * the real router (conversion queues, the `changeSource` loop guard); the webhook intake calls only
 * `routeCrmEvent`, so swapping it touches nothing else.
 *
 * For now:
 * - a contact's `object.creation` → the `triage` queue (the worker reads the contact and upserts the
 *   `hubspot_direct` Lead, then Phase 5 triages it);
 * - everything else → a log line with the decision, and no job. `contact.privacyDeletion` is handled by
 *   the intake itself (a DB-only purge in the same transaction), not by a queue.
 */

/** The fields routing looks at; a HubSpotWebhookEvent has all of them. */
export interface RoutableCrmEvent {
  portalId: number;
  objectId: number;
  subscriptionType: string;
  objectTypeId?: string;
  propertyName?: string;
  changeSource?: string;
  occurredAt: number;
}

/** HubSpot's object type ID for contacts. */
export const CONTACT_OBJECT_TYPE_ID = "0-1";

/** The `triage` job's payload. IDs as strings: pg-boss stores JSON, and CrmEvent IDs are bigints. */
export interface TriageJobData {
  crmEventId: string;
  dedupeKey: string;
  portalId: string;
  contactId: string;
  occurredAt: string;
}

export type RoutingDecision =
  | { action: "enqueue"; queue: typeof TRIAGE_QUEUE; reason: string }
  | { action: "log_only"; reason: string };

export function routeCrmEvent(event: RoutableCrmEvent): RoutingDecision {
  if (event.subscriptionType === "object.creation") {
    if (event.objectTypeId === CONTACT_OBJECT_TYPE_ID) {
      return { action: "enqueue", queue: TRIAGE_QUEUE, reason: "contact created" };
    }
    // UNVERIFIED (live check pending): that object.creation carries objectTypeId (the docs' examples do).
    // Without it the event is logged, not guessed at, so a missing field shows up in the logs.
    return {
      action: "log_only",
      reason: event.objectTypeId
        ? `object.creation for object type ${event.objectTypeId}: not routed`
        : "object.creation without objectTypeId: not routed",
    };
  }
  if (event.subscriptionType === "contact.privacyDeletion") {
    return { action: "log_only", reason: "privacy deletion: purged by the intake, no job" };
  }
  return {
    action: "log_only",
    reason: `${event.subscriptionType}${event.propertyName ? ` (${event.propertyName})` : ""}: Phase 4 routes stage and disposition changes`,
  };
}
