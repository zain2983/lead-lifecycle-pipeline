import { describe, expect, it } from "vitest";
import { routeCrmEvent } from "../src/routing.ts";

const base = { portalId: 900000001, objectId: 610000000001, occurredAt: 1795792181733 };

describe("routeCrmEvent (Phase 3; Phase 4 replaces it)", () => {
  it("sends a contact's object.creation to triage", () => {
    expect(
      routeCrmEvent({ ...base, subscriptionType: "object.creation", objectTypeId: "0-1" }),
    ).toEqual({ action: "enqueue", queue: "triage", reason: "contact created" });
  });

  it("only logs everything else, with the reason", () => {
    expect(
      routeCrmEvent({ ...base, subscriptionType: "object.creation", objectTypeId: "0-3" }).action,
    ).toBe("log_only");
    expect(routeCrmEvent({ ...base, subscriptionType: "object.creation" })).toEqual({
      action: "log_only",
      reason: "object.creation without objectTypeId: not routed",
    });
    expect(
      routeCrmEvent({
        ...base,
        subscriptionType: "contact.propertyChange",
        propertyName: "lifecyclestage",
        changeSource: "CRM_UI",
      }),
    ).toEqual({
      action: "log_only",
      reason:
        "contact.propertyChange (lifecyclestage): Phase 4 routes stage and disposition changes",
    });
    expect(routeCrmEvent({ ...base, subscriptionType: "contact.privacyDeletion" }).action).toBe(
      "log_only",
    );
  });
});
