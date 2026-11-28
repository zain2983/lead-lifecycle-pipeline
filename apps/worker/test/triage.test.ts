import { randomBytes } from "node:crypto";
import { loadEnv } from "@repo/core";
import {
  encryptSecret,
  HubSpotNotInstalledError,
  prismaOAuthTokenStore,
  refreshTokenAad,
} from "@repo/crm-hubspot";
import {
  type FakeHubSpot,
  startFakeHubSpot,
  startFakeTokenServer,
  syntheticTokenResponse,
} from "@repo/crm-hubspot/testing";
import { createPrismaClient, type PrismaClient } from "@repo/db";
import type { Job } from "@repo/queue";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { localWorkerHandlers } from "../src/handlers.ts";
import { triageDepsFromEnv } from "../src/triage.ts";

// The worker's side of Phase 3 against a real Postgres, a fake token endpoint and a fake HubSpot: the
// portal's install is stored encrypted, the handler refreshes an access token with it, reads the
// contact and upserts the Lead. Rows belong to portal IDs no fixture uses.
const portalId = 900000333n;
const notInstalled = 900000334n;
const key = randomBytes(32);

let prisma: PrismaClient;
let hubspot: FakeHubSpot;
let tokenServer: Awaited<ReturnType<typeof startFakeTokenServer>>;
let issued: string[];
let logged: Record<string, unknown>[];

async function cleanup() {
  for (const id of [portalId, notInstalled]) {
    await prisma.crmEvent.deleteMany({ where: { portalId: id } });
    await prisma.lead.deleteMany({ where: { hubspotPortalId: id } });
    await prisma.oAuthToken.deleteMany({ where: { portalId: id } });
  }
}

function job(contactId: string, portal = portalId, crmEventId = "9000000000000001"): Job<unknown> {
  return {
    id: "00000000-0000-5000-8000-000000000001",
    name: "triage",
    data: { crmEventId, dedupeKey: "v1:test", portalId: String(portal), contactId, occurredAt: "" },
  } as unknown as Job<unknown>;
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
  issued = [];
  logged = [];
  tokenServer = await startFakeTokenServer((request) => {
    const accessToken = `worker-access-token-${issued.length + 1}`;
    issued.push(accessToken);
    return {
      status: 200,
      body: syntheticTokenResponse({
        access_token: accessToken,
        hub_id: Number(portalId),
        refresh_token: request.form.get("refresh_token"),
      }),
    };
  });
  hubspot = await startFakeHubSpot({
    token: "not-the-service-key",
    acceptToken: (token) => issued.includes(token),
  });
  await prismaOAuthTokenStore(prisma).save({
    portalId,
    refreshToken: encryptSecret("na1-worker-refresh", key, refreshTokenAad(portalId)),
    scopes: ["oauth", "crm.objects.contacts.read"],
    accessTokenExpiresAt: null,
  });
});
afterEach(async () => {
  await hubspot.close();
  await tokenServer.close();
});

function handlers() {
  const deps = triageDepsFromEnv({
    DATABASE_URL: loadEnv(["database"]).DATABASE_URL,
    HUBSPOT_CLIENT_ID: "client-0001",
    HUBSPOT_CLIENT_SECRET: "client-secret-0001",
    HUBSPOT_OAUTH_TOKEN_URL: tokenServer.url,
    TOKEN_ENCRYPTION_KEY: key.toString("base64"),
    HUBSPOT_API_BASE_URL: hubspot.url,
  });
  const triage = localWorkerHandlers({ ...deps, log: (line) => void logged.push(line) }).triage;
  if (!triage) throw new Error("no triage handler");
  return { triage, deps };
}

describe("the local worker's triage handler (Phase 3: the hubspot_direct Lead)", () => {
  it("refreshes the portal's token, reads the contact and creates the Lead once", async () => {
    const contactId = hubspot.mutate.addContact({
      email: "worker.triage@example.com",
      firstname: "Worker",
      lastname: "Triage",
      company: "Quillmark",
    });
    const { triage, deps } = handlers();
    expect(await triage(job(contactId))).toMatchObject({ outcome: "created" });
    expect(await triage(job(contactId))).toMatchObject({ outcome: "exists" });

    const lead = await prisma.lead.findFirstOrThrow({ where: { hubspotPortalId: portalId } });
    expect([lead.source, lead.email, lead.companyName]).toEqual([
      "hubspot_direct",
      "worker.triage@example.com",
      "Quillmark",
    ]);
    expect(tokenServer.requests).toHaveLength(1); // one refresh, then the cached token
    expect(hubspot.requests.filter((r) => r.path.includes("/contacts/"))).toHaveLength(1);
    expect(hubspot.requests[0]?.bearer).toBe("worker-access-token-1");
    const row = await prisma.oAuthToken.findUniqueOrThrow({ where: { portalId } });
    expect(row.lastRefreshedAt).toBeInstanceOf(Date);
    expect(deps.tokens.stats.refreshes).toBe(1);
    expect(logged[0]).toMatchObject({ msg: "triage lead upsert", outcome: "created" });
    expect(JSON.stringify(logged)).not.toContain("worker.triage@example.com");
  });

  it("completes with a reason for a non-reserved email, and stores nothing", async () => {
    const contactId = hubspot.mutate.addContact({ email: "a.person@gmail.com" });
    const { triage } = handlers();
    expect(await triage(job(contactId))).toEqual({
      outcome: "skipped",
      reason: "email_not_reserved",
    });
    expect(await prisma.lead.count({ where: { hubspotPortalId: portalId } })).toBe(0);
    expect(JSON.stringify(logged)).not.toContain("gmail");
  });

  it("throws (so pg-boss retries) for a portal with no install or a malformed job", async () => {
    const { triage } = handlers();
    await expect(triage(job("610000000001", notInstalled))).rejects.toBeInstanceOf(
      HubSpotNotInstalledError,
    );
    await expect(triage(job("not-a-number"))).rejects.toThrow("contactId must be a numeric string");
  });
});
