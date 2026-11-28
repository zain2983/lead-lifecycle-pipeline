import { isReservedEmail } from "@repo/core";
import type { Prisma, PrismaClient } from "@repo/db";
import type { HubSpotClient } from "./api.ts";
import { getContactById } from "./contact-read.ts";

/**
 * The `Lead` rows that HubSpot contacts make or unmake (PLAN Phases 3.3 and 3.4).
 *
 * Both paths take the same per-contact advisory lock inside their transaction, so a privacy deletion and
 * a late lead upsert for the same contact can't interleave: whichever runs second sees the other's
 * committed rows. Without it, an upsert that read the contact just before the deletion could insert the
 * PII after the purge found nothing to purge.
 */

type Tx = Prisma.TransactionClient;

/** `pg_advisory_xact_lock` on (portal, contact); released at commit or rollback. */
export async function lockHubSpotContact(tx: Tx, portalId: bigint, contactId: bigint) {
  const name = `hubspot-contact:${portalId}:${contactId}`;
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${name}, 0))`;
}

export interface PurgeResult {
  leadId: string;
  /** True if an earlier deletion event already purged it (a retry, or two deletion events). */
  alreadyPurged: boolean;
}

/**
 * `contact.privacyDeletion`: null every PII column of the contact's Lead and set `pii_purged_at`. The row
 * stays, with its IDs, timestamps, disposition and links, so reconciliation still counts it. DB-only and
 * idempotent, so it runs inside the webhook transaction. Returns null when no Lead matches (the contact
 * never became one). Logs nothing itself: the caller logs IDs only.
 *
 * Phase 5 note: `agent_run.output` and `approval.diff` will hold the agent's evidence, which quotes the
 * lead's text. This purge must cover them once those tables are written.
 */
export async function purgeLeadPii(
  tx: Tx,
  portalId: bigint,
  contactId: bigint,
): Promise<PurgeResult | null> {
  await lockHubSpotContact(tx, portalId, contactId);
  const lead = await tx.lead.findUnique({
    where: {
      hubspotPortalId_hubspotContactId: { hubspotPortalId: portalId, hubspotContactId: contactId },
    },
    select: { id: true, piiPurgedAt: true },
  });
  if (!lead) return null;
  if (lead.piiPurgedAt) return { leadId: lead.id, alreadyPurged: true };
  await tx.$executeRaw`
    UPDATE lead SET email = NULL, first_name = NULL, last_name = NULL, phone = NULL,
      company_name = NULL, job_title = NULL, message = NULL, submission = NULL,
      pii_purged_at = now(), updated_at = now()
    WHERE id = ${lead.id}::uuid`;
  return { leadId: lead.id, alreadyPurged: false };
}

export type LeadUpsertOutcome =
  | { outcome: "created"; leadId: string; syntheticKeyTaken?: boolean }
  | { outcome: "exists"; leadId: string }
  | {
      outcome: "skipped";
      reason:
        | "contact_not_found"
        | "contact_merged"
        | "no_email"
        | "email_not_reserved"
        | "privacy_deleted";
      /** contact_merged: the record ID HubSpot answered with. */
      answeredContactId?: string;
    };

export interface LeadUpsertInput {
  portalId: bigint;
  contactId: bigint;
  /** The webhook event behind it; linked to the lead. */
  crmEventId?: bigint;
}

export interface LeadUpsertDeps {
  prisma: PrismaClient;
  /** A client acting for `portalId` (OAuth, see HubSpotTokenManager.clientFor). */
  hubspot: HubSpotClient;
}

/**
 * The `hubspot_direct` Lead for a contact created in HubSpot: read the contact (allow-listed properties),
 * then insert the Lead if there is none. This runs in the worker's `triage` job, not in the webhook: the
 * webhook payload has no email, and the receiver never calls HubSpot inline (a change to PLAN 3.3).
 *
 * - An existing Lead for the contact is left alone (`exists`): a web-form lead's submission wins over
 *   HubSpot's copy, and a purged lead is never refilled.
 * - Skipped, never stored, and not retried: a contact HubSpot no longer has (404), one merged into
 *   another record, one without an email, and one whose email isn't on a reserved domain (synthetic data
 *   only; the database would refuse it anyway). Also a contact with a stored privacy deletion.
 * - A HubSpot error or no answer throws, so the job is retried. The read happens outside the
 *   transaction; nothing is held open across a network call.
 */
export async function upsertHubSpotDirectLead(
  deps: LeadUpsertDeps,
  input: LeadUpsertInput,
): Promise<LeadUpsertOutcome> {
  const { prisma } = deps;
  const where = {
    hubspotPortalId_hubspotContactId: {
      hubspotPortalId: input.portalId,
      hubspotContactId: input.contactId,
    },
  };
  const existing = await prisma.lead.findUnique({ where, select: { id: true } });
  if (existing) {
    await linkEvent(prisma, input.crmEventId, existing.id);
    return { outcome: "exists", leadId: existing.id };
  }

  const contact = await getContactById(deps.hubspot, input.contactId);
  if (!contact) return { outcome: "skipped", reason: "contact_not_found" };
  if (contact.id !== input.contactId.toString()) {
    return { outcome: "skipped", reason: "contact_merged", answeredContactId: contact.id };
  }
  const email = contact.properties.email?.trim().toLowerCase();
  if (!email) return { outcome: "skipped", reason: "no_email" };
  if (!isReservedEmail(email)) return { outcome: "skipped", reason: "email_not_reserved" };

  return prisma.$transaction(async (tx) => {
    await lockHubSpotContact(tx, input.portalId, input.contactId);
    const deleted = await tx.crmEvent.findFirst({
      where: {
        portalId: input.portalId,
        objectId: input.contactId,
        subscriptionType: "contact.privacyDeletion",
      },
      select: { id: true },
    });
    if (deleted) return { outcome: "skipped", reason: "privacy_deleted" } as const;
    const again = await tx.lead.findUnique({ where, select: { id: true } });
    if (again) {
      await linkEvent(tx, input.crmEventId, again.id);
      return { outcome: "exists", leadId: again.id } as const;
    }

    // `synthetic_key` is unique across portals, but a re-seed after a 90-day renewal puts the same
    // fixture keys into a new portal. Keep the link only while it is free.
    const fixtureKey = contact.properties.fixture_key?.trim() || null;
    const keyTaken = fixtureKey
      ? (await tx.lead.count({ where: { syntheticKey: fixtureKey } })) > 0
      : false;
    const p = contact.properties;
    const lead = await tx.lead.create({
      data: {
        source: "hubspot_direct",
        email,
        firstName: p.firstname,
        lastName: p.lastname,
        phone: p.phone,
        companyName: p.company,
        jobTitle: p.jobtitle,
        message: p.message,
        // No site, so no site clock: HubSpot's creation time, stamped in UTC.
        submittedAt: contact.createdAt,
        submittedTimeZone: "UTC",
        submittedAtLocal: contact.createdAt.toISOString().replace("Z", "+00:00"),
        hubspotPortalId: input.portalId,
        hubspotContactId: input.contactId,
        syntheticKey: keyTaken ? null : fixtureKey,
      },
      select: { id: true },
    });
    await linkEvent(tx, input.crmEventId, lead.id);
    return {
      outcome: "created",
      leadId: lead.id,
      ...(keyTaken ? { syntheticKeyTaken: true } : {}),
    } as const;
  });
}

async function linkEvent(db: Tx | PrismaClient, crmEventId: bigint | undefined, leadId: string) {
  if (crmEventId === undefined) return;
  await db.crmEvent.updateMany({ where: { id: crmEventId, leadId: null }, data: { leadId } });
}
