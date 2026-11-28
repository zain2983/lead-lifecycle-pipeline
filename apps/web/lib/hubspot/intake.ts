import { deterministicJobId } from "@repo/core";
import { crmEventDedupeKey, type HubSpotWebhookEvent, purgeLeadPii } from "@repo/crm-hubspot";
import type { PrismaClient } from "@repo/db";
import { type PgBoss, prismaTxDb, routeCrmEvent, type TriageJobData } from "@repo/queue";

/**
 * Store one verified webhook batch and enqueue its jobs, in **one transaction** (PLAN Phase 3.3):
 *
 * 1. each event is inserted as a `crm_event` row with `ON CONFLICT (dedupe_key) DO NOTHING`, so a
 *    HubSpot retry (same event, higher `attemptNumber`), even inside the same batch, stores nothing;
 * 2. for each newly stored event:
 *    - `contact.privacyDeletion` purges the matching Lead's PII (DB-only, idempotent);
 *    - `routeCrmEvent` decides: `enqueue` sends one job with an ID derived from the dedupe key, through
 *      the same transaction (`prismaTxDb`), or `log_only` writes one log line with the decision.
 *
 * All of it commits or none of it does. A failure throws, the receiver answers 500, and HubSpot retries
 * the batch; the rows that would have been stored are simply stored then. Log lines carry IDs, types and
 * property names only, never a contact's personal data.
 */

export interface IngestSummary {
  received: number;
  stored: number;
  duplicates: number;
  enqueued: number;
  purged: number;
}

export interface IngestOptions {
  log?: (event: Record<string, unknown>) => void;
  /** Prisma's interactive-transaction timeout. Under HubSpot's 5 s, so a slow database answers 500. */
  timeoutMs?: number;
}

const defaultLog = (event: Record<string, unknown>) => console.info(JSON.stringify(event));

/** The job ID for an event's job on `queue`: deterministic, so a second send can't make a second job. */
export function crmEventJobId(queue: string, dedupeKey: string): string {
  return deterministicJobId(`${queue}:${dedupeKey}`);
}

export async function ingestHubSpotEvents(
  prisma: PrismaClient,
  boss: PgBoss,
  events: readonly HubSpotWebhookEvent[],
  options: IngestOptions = {},
): Promise<IngestSummary> {
  const log = options.log ?? defaultLog;
  const lines: Record<string, unknown>[] = [];
  const summary = await prisma.$transaction(
    async (tx) => {
      const counts: IngestSummary = {
        received: events.length,
        stored: 0,
        duplicates: 0,
        enqueued: 0,
        purged: 0,
      };
      for (const event of events) {
        const dedupeKey = crmEventDedupeKey(event);
        const inserted = await tx.$queryRaw<{ id: bigint }[]>`
          INSERT INTO crm_event (dedupe_key, portal_id, app_id, subscription_id, subscription_type,
            object_type_id, object_id, property_name, property_value, event_id, occurred_at,
            change_source, source_id, attempt_number, raw_payload)
          VALUES (${dedupeKey}, ${BigInt(event.portalId)}, ${BigInt(event.appId)},
            ${BigInt(event.subscriptionId)}, ${event.subscriptionType}, ${event.objectTypeId ?? null},
            ${BigInt(event.objectId)}, ${event.propertyName ?? null}, ${event.propertyValue ?? null},
            ${BigInt(event.eventId)}, ${new Date(event.occurredAt)}, ${event.changeSource ?? null},
            ${event.sourceId ?? null}, ${event.attemptNumber}, ${JSON.stringify(event)}::jsonb)
          ON CONFLICT (dedupe_key) DO NOTHING
          RETURNING id`;
        const crmEventId = inserted[0]?.id;
        if (crmEventId === undefined) {
          counts.duplicates++;
          continue;
        }
        counts.stored++;
        const line: Record<string, unknown> = {
          msg: "hubspot event routed",
          crmEventId: crmEventId.toString(),
          portalId: String(event.portalId),
          objectId: String(event.objectId),
          subscriptionType: event.subscriptionType,
          ...(event.propertyName ? { propertyName: event.propertyName } : {}),
          attemptNumber: event.attemptNumber,
        };

        if (event.subscriptionType === "contact.privacyDeletion") {
          const purge = await purgeLeadPii(tx, BigInt(event.portalId), BigInt(event.objectId));
          if (purge) {
            if (!purge.alreadyPurged) counts.purged++;
            await tx.crmEvent.update({ where: { id: crmEventId }, data: { leadId: purge.leadId } });
          }
          line.purge = purge
            ? { leadId: purge.leadId, alreadyPurged: purge.alreadyPurged }
            : { leadId: null, note: "no lead for this contact" };
        }

        const decision = routeCrmEvent(event);
        line.decision = decision.action;
        line.reason = decision.reason;
        if (decision.action === "enqueue") {
          const data: TriageJobData = {
            crmEventId: crmEventId.toString(),
            dedupeKey,
            portalId: String(event.portalId),
            contactId: String(event.objectId),
            occurredAt: new Date(event.occurredAt).toISOString(),
          };
          const id = crmEventJobId(decision.queue, dedupeKey);
          const sent = await boss.send(decision.queue, data, { id, db: prismaTxDb(tx) });
          if (sent !== null) counts.enqueued++;
          line.queue = decision.queue;
          line.jobId = id;
          line.jobCreated = sent !== null;
        }
        lines.push(line);
      }
      return counts;
    },
    { timeout: options.timeoutMs ?? 4_000, maxWait: 2_000 },
  );
  // Only after the commit: a rolled-back batch logs nothing it didn't do.
  for (const line of lines) log(line);
  return summary;
}
