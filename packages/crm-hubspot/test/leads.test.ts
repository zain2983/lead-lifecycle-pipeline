import { createHash } from "node:crypto";
import { loadEnv } from "@repo/core";
import { createPrismaClient, type PrismaClient } from "@repo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HubSpotClient } from "../src/api.ts";
import { purgeLeadPii, upsertHubSpotDirectLead } from "../src/leads.ts";
import { type FakeHubSpot, startFakeHubSpot } from "../src/testing/fake-hubspot.ts";

// Real, migrated Postgres. Every row these tests write belongs to two portal IDs no fixture uses.
const portalId = 900000555n;
const otherPortal = 900000556n;
const portals = [portalId, otherPortal];

let prisma: PrismaClient;
let hubspot: FakeHubSpot;
let client: HubSpotClient;

async function cleanup() {
  await prisma.crmEvent.deleteMany({ where: { portalId: { in: portals } } });
  await prisma.lead.deleteMany({ where: { hubspotPortalId: { in: portals } } });
}

beforeAll(async () => {
  prisma = createPrismaClient(loadEnv(["database"]).DATABASE_URL);
});
afterAll(async () => {
  await cleanup();
  await prisma?.$disconnect();
});
beforeEach(async () => {
  await cleanup();
  hubspot = await startFakeHubSpot({ token: "synthetic-key" });
  client = new HubSpotClient({ token: "synthetic-key", baseUrl: hubspot.url, maxRetries: 1 });
});
afterEach(async () => {
  await hubspot.close();
});

const contactValues = {
  email: "Lead.Upsert@Example.com",
  firstname: "Lead",
  lastname: "Upsert",
  phone: "+1 201-555-0142",
  company: "Quillmark",
  jobtitle: "Operations lead",
  message: "We need help sorting inbound leads.",
  fixture_key: "phase3-test-0001",
  hs_analytics_source: "OFFLINE",
};

async function privacyEvent(contactId: bigint) {
  const dedupeKey = `v1:${createHash("sha256").update(`privacy:${contactId}`).digest("hex")}`;
  return prisma.crmEvent.create({
    data: {
      dedupeKey,
      portalId,
      subscriptionId: 5100006n,
      subscriptionType: "contact.privacyDeletion",
      objectId: contactId,
      eventId: 4100000099n,
      occurredAt: new Date(),
      attemptNumber: 0,
      rawPayload: {},
    },
  });
}

describe("upsertHubSpotDirectLead", () => {
  it("creates the Lead from allow-listed properties, then leaves it alone", async () => {
    const contactId = BigInt(hubspot.mutate.addContact(contactValues));
    const first = await upsertHubSpotDirectLead(
      { prisma, hubspot: client },
      { portalId, contactId },
    );
    expect(first.outcome).toBe("created");
    const lead = await prisma.lead.findUniqueOrThrow({
      where: {
        hubspotPortalId_hubspotContactId: {
          hubspotPortalId: portalId,
          hubspotContactId: contactId,
        },
      },
    });
    expect(lead).toMatchObject({
      source: "hubspot_direct",
      email: "lead.upsert@example.com",
      firstName: "Lead",
      lastName: "Upsert",
      phone: "+1 201-555-0142",
      companyName: "Quillmark",
      jobTitle: "Operations lead",
      message: "We need help sorting inbound leads.",
      submittedTimeZone: "UTC",
      syntheticKey: "phase3-test-0001",
      submission: null,
      siteId: null,
    });
    expect(lead.submittedAtLocal).toMatch(/\+00:00$/);
    expect(JSON.stringify(lead, (_, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain(
      "OFFLINE",
    );

    const reads = hubspot.requests.length;
    const second = await upsertHubSpotDirectLead(
      { prisma, hubspot: client },
      { portalId, contactId },
    );
    expect(second).toEqual({ outcome: "exists", leadId: lead.id });
    expect(hubspot.requests).toHaveLength(reads); // no second HubSpot read
  });

  it("skips and never stores a contact without a reserved email, a deleted one, or none at all", async () => {
    const real = BigInt(
      hubspot.mutate.addContact({ ...contactValues, email: "someone@gmail.com" }),
    );
    const none = BigInt(hubspot.mutate.addContact({ firstname: "No", lastname: "Email" }));
    const gone = BigInt(hubspot.mutate.addContact(contactValues));
    hubspot.mutate.deleteContact(gone.toString());
    const deps = { prisma, hubspot: client };
    expect(await upsertHubSpotDirectLead(deps, { portalId, contactId: real })).toEqual({
      outcome: "skipped",
      reason: "email_not_reserved",
    });
    expect(await upsertHubSpotDirectLead(deps, { portalId, contactId: none })).toEqual({
      outcome: "skipped",
      reason: "no_email",
    });
    expect(await upsertHubSpotDirectLead(deps, { portalId, contactId: gone })).toEqual({
      outcome: "skipped",
      reason: "contact_not_found",
    });
    expect(await prisma.lead.count({ where: { hubspotPortalId: portalId } })).toBe(0);
  });

  it("throws when HubSpot fails, so the job is retried", async () => {
    const contactId = BigInt(hubspot.mutate.addContact(contactValues));
    hubspot.failNext({ path: /\/contacts\/\d+$/ }, { status: 503, body: { status: "error" } }, 5);
    await expect(
      upsertHubSpotDirectLead({ prisma, hubspot: client }, { portalId, contactId }),
    ).rejects.toThrow();
    expect(await prisma.lead.count({ where: { hubspotPortalId: portalId } })).toBe(0);
  });

  it("keeps the synthetic-key link only while no other portal's lead holds it", async () => {
    const deps = { prisma, hubspot: client };
    const a = BigInt(hubspot.mutate.addContact(contactValues));
    await upsertHubSpotDirectLead(deps, { portalId, contactId: a });
    // The same seed in another portal (a renewed test account).
    const b = BigInt(
      hubspot.mutate.addContact({ ...contactValues, email: "lead.upsert@renewed.example.com" }),
    );
    const result = await upsertHubSpotDirectLead(deps, { portalId: otherPortal, contactId: b });
    expect(result).toMatchObject({ outcome: "created", syntheticKeyTaken: true });
  });
});

describe("purgeLeadPii and the lead upsert after a privacy deletion", () => {
  it("purges every PII column, keeps the row, and is idempotent", async () => {
    const contactId = BigInt(hubspot.mutate.addContact(contactValues));
    const created = await upsertHubSpotDirectLead(
      { prisma, hubspot: client },
      { portalId, contactId },
    );
    const purge = () => prisma.$transaction((tx) => purgeLeadPii(tx, portalId, contactId));

    expect(await purge()).toEqual({
      leadId: created.outcome === "created" ? created.leadId : "",
      alreadyPurged: false,
    });
    const lead = await prisma.lead.findFirstOrThrow({ where: { hubspotContactId: contactId } });
    expect([
      lead.email,
      lead.firstName,
      lead.lastName,
      lead.phone,
      lead.companyName,
      lead.jobTitle,
      lead.message,
      lead.submission,
    ]).toEqual([null, null, null, null, null, null, null, null]);
    expect(lead.piiPurgedAt).toBeInstanceOf(Date);
    expect([lead.source, lead.hubspotContactId, lead.syntheticKey]).toEqual([
      "hubspot_direct",
      contactId,
      "phase3-test-0001",
    ]);

    expect((await purge())?.alreadyPurged).toBe(true);
    // A late upsert finds the row and never refills it.
    expect(
      (await upsertHubSpotDirectLead({ prisma, hubspot: client }, { portalId, contactId })).outcome,
    ).toBe("exists");
    expect(
      (await prisma.lead.findFirstOrThrow({ where: { hubspotContactId: contactId } })).email,
    ).toBeNull();
  });

  it("returns null when the contact never became a Lead, and a later upsert stores nothing", async () => {
    const contactId = BigInt(hubspot.mutate.addContact(contactValues));
    expect(await prisma.$transaction((tx) => purgeLeadPii(tx, portalId, contactId))).toBeNull();
    await privacyEvent(contactId);
    // HubSpot may still answer for a moment after the deletion; the stored event wins.
    expect(
      await upsertHubSpotDirectLead({ prisma, hubspot: client }, { portalId, contactId }),
    ).toEqual({
      outcome: "skipped",
      reason: "privacy_deleted",
    });
    expect(await prisma.lead.count({ where: { hubspotPortalId: portalId } })).toBe(0);
  });
});
