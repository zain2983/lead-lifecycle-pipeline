import { z } from "zod";
import { HUBSPOT_API_VERSION, HubSpotApiError, type HubSpotClient } from "./api.ts";

/**
 * Read one contact by record ID, with an allow-listed property set (data minimisation).
 *
 * `GET /crm/objects/2026-09/contacts/{contactId}?properties=a,b,c` (the "Retrieve a contact" reference,
 * https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contacts/get-contact, read
 * 2026-11-28). The docs say properties that don't exist on the record "will be ignored", and the
 * response always carries `createdate`, `hs_object_id` and `lastmodifieddate` as well, so the result
 * keeps **only** the allow-listed names that were asked for. Nothing else leaves this function.
 *
 * The allow-list is what the `hubspot_direct` lead upsert and the triage snapshot (Phase 5) need. Add a
 * name here only with a reason; the test lists them.
 */
export const CONTACT_READ_PROPERTIES = [
  // Identity, for the Lead row (every one is purged on contact.privacyDeletion).
  "email",
  "firstname",
  "lastname",
  "phone",
  "company",
  "jobtitle",
  // What triage reads: the message, where they are (out-of-area), and the current stages it must not
  // move backwards.
  "message",
  "city",
  "country",
  "lifecyclestage",
  "hs_lead_status",
  "triage_disposition",
  // Links a seeded contact to its @repo/synthetic record.
  "fixture_key",
] as const;

export type ContactReadProperty = (typeof CONTACT_READ_PROPERTIES)[number];

const contactSchema = z.looseObject({
  id: z.string().regex(/^\d+$/),
  properties: z.record(z.string(), z.string().nullable()),
  createdAt: z.string(),
  updatedAt: z.string(),
  archived: z.boolean(),
});

export interface HubSpotContact {
  id: string;
  /** Allow-listed names only. A property the record doesn't have is `null`. */
  properties: Record<ContactReadProperty, string | null>;
  createdAt: Date;
  updatedAt: Date;
  archived: boolean;
}

export class HubSpotContractError extends Error {
  override name = "HubSpotContractError";
}

/**
 * Returns `null` when HubSpot answers 404 (deleted, merged away, or never existed). UNVERIFIED (live
 * check pending): the 404 body for this endpoint; the code relies on the status only. A merged contact's
 * old ID may also answer 200 with the surviving record (the docs mention merges, not this endpoint's
 * behaviour), so callers compare `id` with what they asked for.
 */
export async function getContactById(
  client: HubSpotClient,
  contactId: string | bigint | number,
  properties: readonly ContactReadProperty[] = CONTACT_READ_PROPERTIES,
): Promise<HubSpotContact | null> {
  const id = String(contactId);
  if (!/^\d+$/.test(id)) throw new TypeError(`contact ID must be numeric: ${id}`);
  const allowed = new Set<string>(CONTACT_READ_PROPERTIES);
  for (const name of properties) {
    if (!allowed.has(name)) throw new TypeError(`property not on the read allow-list: ${name}`);
  }
  const query = new URLSearchParams({ properties: properties.join(","), archived: "false" });
  const path = `/crm/objects/${HUBSPOT_API_VERSION}/contacts/${id}?${query.toString().replaceAll("%2C", ",")}`;

  let body: unknown;
  try {
    ({ body } = await client.request({ method: "GET", path }));
  } catch (error) {
    if (error instanceof HubSpotApiError && error.status === 404) return null;
    throw error;
  }
  const parsed = contactSchema.safeParse(body);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)");
    // Field names only: the values are personal data.
    throw new HubSpotContractError(`contact response has unexpected fields: ${fields.join(", ")}`);
  }
  const contact = parsed.data;
  const kept = {} as Record<ContactReadProperty, string | null>;
  for (const name of properties) kept[name] = contact.properties[name] ?? null;
  return {
    id: contact.id,
    properties: kept,
    createdAt: new Date(contact.createdAt),
    updatedAt: new Date(contact.updatedAt),
    archived: contact.archived,
  };
}
