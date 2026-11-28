import { readFileSync } from "node:fs";
import path from "node:path";
import { loadEnv } from "@repo/core";
import { crmEventDedupeKey, type HubSpotWebhookEvent, signatureV3 } from "@repo/crm-hubspot";
import { createPrismaClient, type PrismaClient } from "@repo/db";
import {
  createBoss,
  ensureQueues,
  INTAKE_QUEUES,
  type PgBoss,
  TRIAGE_QUEUE,
  type TriageJobData,
} from "@repo/queue";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { crmEventJobId, ingestHubSpotEvents } from "../lib/hubspot/intake.ts";
import { handleHubSpotWebhook } from "../lib/hubspot/webhook.ts";

/**
 * PLAN Phase 3 "done when", against the real receiver, a real Postgres and pg-boss: signed deliveries go
 * through `handleHubSpotWebhook` with the same `ingest` the route uses. Every row and job belongs to one
 * portal ID no fixture uses, rewritten into the fixtures, and is removed before each test.
 */
const portalId = 900000444;
const clientSecret = "test-client-secret-0001";
const publicWebhookUrl = "https://quick-tunnel.example.test/api/webhooks/hubspot";
const fixtures = path.resolve(import.meta.dirname, "../../../packages/crm-hubspot/fixtures");

let prisma: PrismaClient;
let boss: PgBoss;
let logged: Record<string, unknown>[];

function fixture(name: string): HubSpotWebhookEvent[] {
  const events = JSON.parse(
    readFileSync(path.join(fixtures, name), "utf8"),
  ) as HubSpotWebhookEvent[];
  return events.map((event) => ({ ...event, portalId }));
}

const creation = () => fixture("contact-creation.json")[0] as HubSpotWebhookEvent;
const lifecycle = () => fixture("contact-lifecyclestage-change.json")[0] as HubSpotWebhookEvent;

function signed(events: readonly HubSpotWebhookEvent[]): Request {
  const body = JSON.stringify(events);
  const timestamp = String(Date.now());
  return new Request("http://localhost:3100/api/webhooks/hubspot", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hubspot-request-timestamp": timestamp,
      "x-hubspot-signature-v3": signatureV3({
        method: "POST",
        uri: publicWebhookUrl,
        rawBody: body,
        timestamp,
        clientSecret,
      }),
    },
    body,
  });
}

async function deliver(events: readonly HubSpotWebhookEvent[], useBoss: PgBoss = boss) {
  const response = await handleHubSpotWebhook(signed(events), {
    clientSecret,
    publicWebhookUrl,
    ingest: async (batch) => ({
      ...(await ingestHubSpotEvents(prisma, useBoss, batch, { log: (l) => void logged.push(l) })),
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function triageJobs() {
  return boss.findJobs<TriageJobData>(TRIAGE_QUEUE, { data: { portalId: String(portalId) } });
}

async function storedEvents() {
  return prisma.crmEvent.findMany({
    where: { portalId: BigInt(portalId) },
    orderBy: { id: "asc" },
  });
}

async function cleanup() {
  const jobs = await triageJobs();
  if (jobs.length > 0)
    await boss.deleteJob(
      TRIAGE_QUEUE,
      jobs.map((job) => job.id),
    );
  await prisma.crmEvent.deleteMany({ where: { portalId: BigInt(portalId) } });
  await prisma.lead.deleteMany({ where: { hubspotPortalId: BigInt(portalId) } });
}

beforeAll(async () => {
  const { DATABASE_URL } = loadEnv(["database"]);
  prisma = createPrismaClient(DATABASE_URL);
  boss = createBoss({ mode: "vercel", connectionString: DATABASE_URL });
  await boss.start();
  await ensureQueues(boss, INTAKE_QUEUES);
});
afterAll(async () => {
  await cleanup();
  await boss?.stop();
  await prisma?.$disconnect();
});
beforeEach(async () => {
  logged = [];
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await cleanup();
  return () => vi.restoreAllMocks();
});

describe("POST /api/webhooks/hubspot: intake (done when)", () => {
  it("one event sent 3 times (attemptNumber 0, 1, 2) gives exactly one CrmEvent row and one job", async () => {
    const event = creation();
    const answers = [];
    for (const attemptNumber of [0, 1, 2])
      answers.push(await deliver([{ ...event, attemptNumber }]));

    expect(answers.map((a) => a.status)).toEqual([200, 200, 200]);
    expect(answers.map((a) => [a.body.stored, a.body.duplicates, a.body.enqueued])).toEqual([
      [1, 0, 1],
      [0, 1, 0],
      [0, 1, 0],
    ]);
    const rows = await storedEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attemptNumber).toBe(0);
    expect(rows[0]?.dedupeKey).toBe(crmEventDedupeKey(event));

    const jobs = await triageJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe(crmEventJobId(TRIAGE_QUEUE, crmEventDedupeKey(event)));
    expect(jobs[0]?.data).toEqual({
      crmEventId: rows[0]?.id.toString(),
      dedupeKey: crmEventDedupeKey(event),
      portalId: String(portalId),
      contactId: String(event.objectId),
      occurredAt: new Date(event.occurredAt).toISOString(),
    });
  });

  it("a mixed batch with a retry inside it is deduplicated too, and so is the whole batch resent", async () => {
    const mixed = fixture("batch-mixed.json"); // includes a retry (attemptNumber 1) of `lifecycle`
    const batch = [creation(), lifecycle(), { ...creation(), attemptNumber: 1 }, ...mixed];
    const first = await deliver(batch);
    expect(first).toEqual({
      status: 200,
      body: { ok: true, received: 7, stored: 5, duplicates: 2, enqueued: 1, purged: 0 },
    });
    const again = await deliver(batch.map((e) => ({ ...e, attemptNumber: e.attemptNumber + 1 })));
    expect(again.body).toMatchObject({ received: 7, stored: 0, duplicates: 7, enqueued: 0 });

    expect(await storedEvents()).toHaveLength(5);
    expect(await triageJobs()).toHaveLength(1);
    // Everything that isn't a contact creation is logged with its decision, and gets no job.
    const decisions = logged.map((l) => [l.subscriptionType, l.propertyName ?? null, l.decision]);
    expect(decisions).toEqual([
      ["object.creation", null, "enqueue"],
      ["contact.propertyChange", "lifecyclestage", "log_only"],
      ["contact.propertyChange", "hs_lead_status", "log_only"],
      ["deal.propertyChange", "dealstage", "log_only"],
      ["contact.privacyDeletion", null, "log_only"],
    ]);
  });

  it("concurrent deliveries of one batch store it once", async () => {
    const batch = [creation(), lifecycle()];
    const answers = await Promise.all(
      [0, 1, 2, 3, 4].map((n) => deliver(batch.map((e) => ({ ...e, attemptNumber: n })))),
    );
    expect(answers.every((a) => a.status === 200)).toBe(true);
    expect(answers.reduce((sum, a) => sum + Number(a.body.stored), 0)).toBe(2);
    expect(await storedEvents()).toHaveLength(2);
    expect(await triageJobs()).toHaveLength(1);
  });

  it("a database failure mid-batch answers 500 and commits nothing; HubSpot's retry stores it", async () => {
    const broken = {
      send: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    } as unknown as PgBoss;
    const failed = await deliver([lifecycle(), creation()], broken);
    expect(failed).toEqual({ status: 500, body: { ok: false, error: "storage_failed" } });
    expect(await storedEvents()).toHaveLength(0); // the lifecycle row rolled back with the job
    expect(logged).toHaveLength(0); // nothing is logged for a batch that didn't commit

    const retried = await deliver(
      [lifecycle(), creation()].map((e) => ({ ...e, attemptNumber: 1 })),
    );
    expect(retried.body).toMatchObject({ stored: 2, enqueued: 1 });
  });

  it("answers a 100-event batch well under 5 s", async () => {
    const base = lifecycle();
    const batch = Array.from({ length: 100 }, (_, n) => ({
      ...base,
      eventId: base.eventId + 1000 + n,
      objectId: base.objectId + n,
    }));
    const started = performance.now();
    const answer = await deliver(batch);
    const ms = performance.now() - started;
    expect(answer.body).toMatchObject({ stored: 100, duplicates: 0 });
    expect(ms).toBeLessThan(2_000);
  });
});

describe("contact.privacyDeletion in the webhook transaction", () => {
  it("purges the Lead's PII, keeps the row, links the event and logs IDs only", async () => {
    const deletion = fixture("batch-mixed.json").find(
      (e) => e.subscriptionType === "contact.privacyDeletion",
    ) as HubSpotWebhookEvent;
    const lead = await prisma.lead.create({
      data: {
        source: "hubspot_direct",
        email: "privacy.purge@example.com",
        firstName: "Privacy",
        lastName: "Purge",
        phone: "+1 201-555-0177",
        companyName: "Harborlight",
        jobTitle: "Clinic manager",
        message: "Please call me back.",
        submittedAt: new Date("2026-11-02T09:05:12Z"),
        submittedTimeZone: "UTC",
        submittedAtLocal: "2026-11-02T09:05:12.000+00:00",
        hubspotPortalId: BigInt(portalId),
        hubspotContactId: BigInt(deletion.objectId),
      },
    });

    const first = await deliver([deletion]);
    expect(first.body).toMatchObject({ stored: 1, purged: 1, enqueued: 0 });
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect([after.email, after.firstName, after.phone, after.companyName, after.message]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(after.piiPurgedAt).toBeInstanceOf(Date);
    expect((await storedEvents())[0]?.leadId).toBe(lead.id);
    expect(logged[0]).toMatchObject({ purge: { leadId: lead.id, alreadyPurged: false } });
    expect(JSON.stringify(logged)).not.toMatch(/privacy\.purge|Harborlight|555-0177/);

    // HubSpot's retry is a duplicate; a second deletion event (new eventId) finds it already purged.
    expect((await deliver([{ ...deletion, attemptNumber: 1 }])).body).toMatchObject({
      stored: 0,
      duplicates: 1,
    });
    const second = await deliver([{ ...deletion, eventId: deletion.eventId + 1 }]);
    expect(second.body).toMatchObject({ stored: 1, purged: 0 });
    expect(logged.at(-1)).toMatchObject({ purge: { alreadyPurged: true } });
  });
});
