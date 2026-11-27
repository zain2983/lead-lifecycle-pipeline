import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { crmEventDedupeKey } from "../src/crm-event-key.ts";
import { type HubSpotWebhookEvent, webhookBatchSchema } from "../src/webhook-events.ts";

const fixture = (name: string): HubSpotWebhookEvent[] =>
  webhookBatchSchema.parse(
    JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../fixtures", name), "utf8")),
  );

describe("crmEventDedupeKey", () => {
  const [event] = fixture("contact-lifecyclestage-change.json");
  if (!event) throw new Error("fixture is empty");

  it("is v1 + a sha256 hex, the format crm_event.dedupe_key checks", () => {
    expect(crmEventDedupeKey(event)).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it("is the same for a retry (only attemptNumber differs)", () => {
    expect(crmEventDedupeKey({ ...event, attemptNumber: 3 })).toBe(crmEventDedupeKey(event));
  });

  it("differs when anything that identifies the change differs, even with the same eventId", () => {
    const key = crmEventDedupeKey(event);
    for (const change of [
      { portalId: event.portalId + 1 },
      { subscriptionId: event.subscriptionId + 1 },
      { subscriptionType: "contact.creation" },
      { objectId: event.objectId + 1 },
      { propertyName: "hs_lead_status" },
      { propertyValue: "customer" },
      { occurredAt: event.occurredAt + 1 },
      { eventId: event.eventId + 1 },
    ]) {
      expect(crmEventDedupeKey({ ...event, ...change }), JSON.stringify(change)).not.toBe(key);
    }
  });

  it("gives the batch's retried lifecycle event the same key as its first delivery", () => {
    const keys = new Set(
      [...fixture("contact-lifecyclestage-change.json"), ...fixture("batch-mixed.json")].map(
        crmEventDedupeKey,
      ),
    );
    expect(keys.size).toBe(4); // five deliveries, four distinct events
  });
});
