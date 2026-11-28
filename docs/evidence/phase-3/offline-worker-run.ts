// Offline evidence for Phase 3.1–3.4, the worker's half: drains the `triage` job that the webhook
// transcript left (01-webhook-replay.txt, step 6) with the real local-worker handler. The HubSpot
// side is two in-process fakes (a token endpoint and the CRM API), so **nothing here is a HubSpot
// response**. The install row is written with a key generated for this run only.
//
//   pnpm --filter @repo/worker exec tsx ../../docs/evidence/phase-3/offline-worker-run.ts \
//     > docs/evidence/phase-3/02-offline-worker-run.txt
import { randomBytes } from "node:crypto";
import { localWorkerHandlers } from "../../../apps/worker/src/handlers.ts";
import { triageDepsFromEnv } from "../../../apps/worker/src/triage.ts";
import { loadRootEnvFile } from "../../../packages/core/src/dotenv.ts";
import { loadEnv } from "../../../packages/core/src/index.ts";
import {
  encryptSecret,
  prismaOAuthTokenStore,
  refreshTokenAad,
} from "../../../packages/crm-hubspot/src/index.ts";
import {
  startFakeHubSpot,
  startFakeTokenServer,
  syntheticTokenResponse,
} from "../../../packages/crm-hubspot/src/testing/index.ts";
import { createBoss, drainQueues, TRIAGE_QUEUE } from "../../../packages/queue/src/index.ts";

loadRootEnvFile(import.meta.dirname);
const { DATABASE_URL, DIRECT_URL } = loadEnv(["database", "databaseDirect"]);
const portalId = 900000001n; // the fixtures' portal
const contactId = "610000000001"; // contact-creation.json's objectId
const key = randomBytes(32);
const redact = (value: unknown) =>
  JSON.stringify(value, (_, v) =>
    typeof v === "bigint"
      ? v.toString()
      : typeof v === "string" && v.includes("@")
        ? "<email redacted>"
        : v,
  );

const issued: string[] = [];
const tokenServer = await startFakeTokenServer((request) => {
  const accessToken = `offline-access-token-${issued.length + 1}`;
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
const hubspot = await startFakeHubSpot({
  token: "no-service-key-in-this-run",
  acceptToken: (token) => issued.includes(token),
});
hubspot.mutate.addContact(
  {
    email: "offline.worker@example.com",
    firstname: "Offline",
    lastname: "Worker",
    company: "Quillmark",
    jobtitle: "Operations lead",
    message: "Synthetic contact for the Phase 3 offline run.",
  },
  contactId,
);

const deps = triageDepsFromEnv({
  DATABASE_URL,
  HUBSPOT_CLIENT_ID: "offline-client-0001",
  HUBSPOT_CLIENT_SECRET: "offline-client-secret-0001",
  HUBSPOT_OAUTH_TOKEN_URL: tokenServer.url,
  TOKEN_ENCRYPTION_KEY: key.toString("base64"),
  HUBSPOT_API_BASE_URL: hubspot.url,
});
const { prisma } = deps;
await prismaOAuthTokenStore(prisma).save({
  portalId,
  refreshToken: encryptSecret("na1-offline-refresh-0001", key, refreshTokenAad(portalId)),
  scopes: ["oauth", "crm.objects.contacts.read"],
  accessTokenExpiresAt: null,
});
console.log(
  "1. install stored for portal 900000001 (refresh token encrypted with a key made for this run)",
);

const boss = createBoss({ mode: "worker", connectionString: DIRECT_URL });
await boss.start();
const before = await boss.findJobs(TRIAGE_QUEUE, { data: { portalId: portalId.toString() } });
console.log(
  `2. triage jobs for the portal before the drain: ${redact(before.map((j) => [j.id, j.state]))}`,
);

const lines: Record<string, unknown>[] = [];
const summary = await drainQueues(
  boss,
  localWorkerHandlers({ ...deps, log: (line) => void lines.push(line) }),
  { timeoutSeconds: 20 },
);
console.log(
  `3. drain: processed ${summary.processed}, failed ${summary.failed}, timedOut ${summary.timedOut}`,
);
for (const line of lines) console.log(`   worker log: ${redact({ ...line, ms: "<ms>" })}`);

const [job] = await boss.findJobs(TRIAGE_QUEUE, { data: { portalId: portalId.toString() } });
console.log(`4. the job after: state ${job?.state}, output ${redact(job?.output)}`);

const lead = await prisma.lead.findFirst({ where: { hubspotPortalId: portalId } });
console.log(
  `5. the Lead: ${redact({
    source: lead?.source,
    email: lead?.email,
    firstName: lead?.firstName ? "<set>" : null,
    companyName: lead?.companyName,
    jobTitle: lead?.jobTitle,
    submittedTimeZone: lead?.submittedTimeZone,
    hubspotContactId: lead?.hubspotContactId,
    piiPurgedAt: lead?.piiPurgedAt,
  })}`,
);
const linked = await prisma.crmEvent.findMany({
  where: { portalId, leadId: { not: null } },
  select: { id: true, subscriptionType: true },
});
console.log(`6. crm_event rows linked to it: ${redact(linked)}`);
const token = await prisma.oAuthToken.findUniqueOrThrow({ where: { portalId } });
console.log(
  `7. oauth_token bookkeeping: ${redact({
    installedVia: token.installedVia,
    lastRefreshedAt: token.lastRefreshedAt ? "<set>" : null,
    refreshTokenRotatedAt: token.refreshTokenRotatedAt,
    lastRefreshError: token.lastRefreshError,
    accessTokenExpiresAt: token.accessTokenExpiresAt ? "<set>" : null,
  })}`,
);
console.log(
  `8. requests: token endpoint ${tokenServer.requests.length} (grant ${tokenServer.requests[0]?.form.get("grant_type")}), ` +
    `HubSpot ${hubspot.requests.length} (${hubspot.requests.map((r) => `${r.method} ${r.path}?${r.query.slice(0, 40)}… bearer=${r.bearer?.slice(0, 20)}`).join("; ")})`,
);

await boss.stop();
await prisma.$disconnect();
await hubspot.close();
await tokenServer.close();
