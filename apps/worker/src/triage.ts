import { type Env, loadEnv } from "@repo/core";
import {
  type HubSpotClient,
  HubSpotTokenManager,
  type LeadUpsertOutcome,
  parseEncryptionKey,
  prismaOAuthTokenStore,
  upsertHubSpotDirectLead,
} from "@repo/crm-hubspot";
import { createPrismaClient, type PrismaClient } from "@repo/db";
import type { Job, JobHandler, TriageJobData } from "@repo/queue";

/**
 * The `triage` queue's handler, as far as Phase 3 goes: make sure the contact has a `hubspot_direct`
 * Lead (read the contact through the portal's OAuth install, then upsert). Phase 5 continues from the
 * returned Lead into the Sim run. Only the local worker consumes `triage` (sweepOnce refuses it).
 *
 * This step lives here and not in the webhook, because the webhook payload has no email and the
 * receiver must not call HubSpot inline (a change to PLAN 3.3).
 *
 * A HubSpot error, a token refresh with no answer, or a portal with no install throws: the job fails and
 * pg-boss retries it (Phase 4 sets the retry policy and the dead-letter queue). A skip is a completed
 * job with its reason as the output.
 */

export interface TriageDeps {
  prisma: PrismaClient;
  /** A HubSpot client acting for one portal. */
  clientFor: (portalId: bigint) => HubSpotClient;
  log?: (event: Record<string, unknown>) => void;
}

const defaultLog = (event: Record<string, unknown>) => console.info(JSON.stringify(event));

export function parseTriageJob(data: unknown): {
  crmEventId: bigint;
  portalId: bigint;
  contactId: bigint;
} {
  const job = (data ?? {}) as Partial<Record<keyof TriageJobData, unknown>>;
  const id = (name: keyof TriageJobData) => {
    const value = job[name];
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
      throw new TypeError(`triage job: ${name} must be a numeric string`);
    }
    return BigInt(value);
  };
  return { crmEventId: id("crmEventId"), portalId: id("portalId"), contactId: id("contactId") };
}

export function createTriageHandler(deps: TriageDeps): JobHandler {
  const log = deps.log ?? defaultLog;
  return async (job: Job<unknown>): Promise<LeadUpsertOutcome> => {
    const input = parseTriageJob(job.data);
    const started = performance.now();
    const result = await upsertHubSpotDirectLead(
      { prisma: deps.prisma, hubspot: deps.clientFor(input.portalId) },
      input,
    );
    log({
      msg: "triage lead upsert",
      jobId: job.id,
      crmEventId: input.crmEventId.toString(),
      portalId: input.portalId.toString(),
      contactId: input.contactId.toString(),
      ...result,
      ms: Math.round(performance.now() - started),
    });
    return result;
  };
}

/** Production wiring: the refresh credentials, the stored installs, and HubSpot's API. */
export function triageDepsFromEnv(
  env: Env<"database" | "hubspotTokenRefresh" | "hubspotApi"> = loadEnv([
    "database",
    "hubspotTokenRefresh",
    "hubspotApi",
  ]),
): TriageDeps & { tokens: HubSpotTokenManager } {
  const prisma = createPrismaClient(env.DATABASE_URL);
  const tokens = new HubSpotTokenManager({
    clientId: env.HUBSPOT_CLIENT_ID,
    clientSecret: env.HUBSPOT_CLIENT_SECRET,
    tokenUrl: env.HUBSPOT_OAUTH_TOKEN_URL,
    encryptionKey: parseEncryptionKey(env.TOKEN_ENCRYPTION_KEY),
    store: prismaOAuthTokenStore(prisma),
    log: defaultLog,
  });
  return {
    prisma,
    tokens,
    clientFor: (portalId) => tokens.clientFor(portalId, { baseUrl: env.HUBSPOT_API_BASE_URL }),
  };
}
