import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseWebhookBatch } from "../src/webhook-events.ts";

const fixtures = path.resolve(import.meta.dirname, "../fixtures");
const read = (name: string) => readFileSync(path.join(fixtures, name), "utf8");

describe("parseWebhookBatch", () => {
  it("parses every synthetic fixture", () => {
    const files = readdirSync(fixtures).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      expect(parseWebhookBatch(read(file)), file).toMatchObject({ ok: true });
    }
  });

  it("keeps the fields the consumer needs, and unknown fields", () => {
    const result = parseWebhookBatch(read("contact-lifecyclestage-change.json"));
    expect(result).toMatchObject({
      ok: true,
      events: [
        {
          subscriptionType: "contact.propertyChange",
          propertyName: "lifecyclestage",
          propertyValue: "marketingqualifiedlead",
          attemptNumber: 0,
          sourceId: "userId:81000001",
        },
      ],
    });
    const creation = parseWebhookBatch(read("contact-creation.json"));
    expect(creation).toMatchObject({ ok: true, events: [{ objectTypeId: "0-1" }] });
  });

  it("rejects bodies that are not a batch of events", () => {
    expect(parseWebhookBatch("not json")).toEqual({ ok: false, error: "invalid_json" });
    expect(parseWebhookBatch("[]")).toMatchObject({ ok: false, error: "invalid_shape" });
    expect(parseWebhookBatch('{"eventId":1}')).toMatchObject({ ok: false, error: "invalid_shape" });
    expect(parseWebhookBatch('[{"eventId":"1"}]')).toMatchObject({
      ok: false,
      error: "invalid_shape",
      issues: expect.arrayContaining([expect.stringContaining("0.eventId")]),
    });
  });
});
