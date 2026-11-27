import {
  HUBSPOT_API_VERSION,
  HubSpotApiError,
  type HubSpotClient,
  HubSpotOutcomeUnknownError,
} from "./api.ts";

/**
 * Upsert contacts by email, so running it twice changes nothing.
 *
 * 1. `POST /crm/objects/2026-09/contacts/batch/read` with `idProperty: "email"` reads the current values of
 *    exactly the properties we write.
 * 2. Contacts that are missing or differ go to `POST /crm/objects/2026-09/contacts/batch/upsert`
 *    (`inputs: [{ idProperty: "email", id, properties }]`); equal ones are not sent at all, so a second run
 *    makes no write. Each result's `new` flag says created or updated.
 *
 * Docs (read 2026-11-28):
 * - https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contacts/guide: "Batch operations
 *   are limited to 100 records at a time"; email may be the upsert `idProperty`; "Partial upserts are not
 *   supported when using email as the idProperty for contacts".
 * - https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contacts/batch/upsert-contacts:
 *   200, or 207 with `errors[]` and `numErrors`; each result has `id, properties, new, createdAt, updatedAt`.
 * - https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contacts/batch/get-contacts:
 *   200, or 207 with `errors[]`. Which error a missing email produces isn't documented, so a missing
 *   contact is simply one with no result.
 * - Scopes: crm.objects.contacts.read and crm.objects.contacts.write.
 * Rate limits: see api.ts. Twenty contacts are 2 requests per run (1 read, at most 1 upsert).
 */

export const BATCH_LIMIT = 100;

const READ_PATH = `/crm/objects/${HUBSPOT_API_VERSION}/contacts/batch/read`;
const UPSERT_PATH = `/crm/objects/${HUBSPOT_API_VERSION}/contacts/batch/upsert`;

export interface ContactInput {
  /** Lower-case. The upsert key. */
  email: string;
  /** HubSpot property values are strings. `email` is added automatically. */
  properties: Record<string, string>;
  /** Shown in the summary (e.g. the synthetic fixture key). */
  label?: string;
}

export type ContactAction = "created" | "updated" | "unchanged" | "failed" | "unknown";

export interface ContactResult {
  email: string;
  label?: string;
  action: ContactAction;
  /** HubSpot record ID, when known. */
  id?: string;
  /** Properties that differed (updated), or every property (created). */
  changes: string[];
  /** HubSpot's error exactly as returned, or why the outcome is unknown. */
  error?: string;
}

export interface UpsertSummary {
  results: ContactResult[];
  counts: Record<ContactAction, number>;
  /** Upsert requests actually sent (0 when nothing differed). */
  upsertRequests: number;
}

interface BatchObject {
  id?: string;
  new?: boolean;
  properties?: Record<string, string | null>;
}

interface BatchResponse {
  status?: string;
  results?: BatchObject[];
  errors?: {
    status?: string;
    category?: string;
    message?: string;
    context?: Record<string, unknown>;
  }[];
  numErrors?: number;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The properties of `want` whose value HubSpot doesn't hold exactly. */
export function diffContact(
  want: Record<string, string>,
  have: Record<string, string | null> | undefined,
): string[] {
  return Object.keys(want).filter((key) => (have?.[key] ?? null) !== want[key]);
}

export interface UpsertOptions {
  /** Read and compare only; report what would change and write nothing. */
  dryRun?: boolean;
}

export async function upsertContactsByEmail(
  client: HubSpotClient,
  inputs: readonly ContactInput[],
  options: UpsertOptions = {},
): Promise<UpsertSummary> {
  const seen = new Set<string>();
  for (const input of inputs) {
    if (input.email !== input.email.toLowerCase())
      throw new Error(`email must be lower-case: ${input.email}`);
    if (seen.has(input.email)) throw new Error(`duplicate email in one run: ${input.email}`);
    seen.add(input.email);
  }

  const results: ContactResult[] = [];
  let upsertRequests = 0;
  for (const chunk of chunks(inputs, BATCH_LIMIT)) {
    const wanted = chunk.map((input) => ({
      ...input,
      properties: { email: input.email, ...input.properties },
    }));
    const propertyNames = [...new Set(wanted.flatMap((w) => Object.keys(w.properties)))].sort();

    const read = await client.request<BatchResponse>({
      method: "POST",
      path: READ_PATH,
      idempotentRead: true,
      body: {
        idProperty: "email",
        properties: propertyNames,
        propertiesWithHistory: [],
        inputs: wanted.map((w) => ({ id: w.email })),
      },
    });
    const existing = new Map<string, BatchObject>();
    for (const object of read.body.results ?? []) {
      const email = object.properties?.email?.toLowerCase();
      if (email) existing.set(email, object);
    }

    const toSend: {
      input: (typeof wanted)[number];
      changes: string[];
      predicted: "created" | "updated";
    }[] = [];
    for (const input of wanted) {
      const have = existing.get(input.email);
      const base = { email: input.email, label: input.label };
      if (!have) {
        toSend.push({ input, changes: Object.keys(input.properties), predicted: "created" });
        continue;
      }
      const changes = diffContact(input.properties, have.properties);
      if (changes.length === 0)
        results.push({ ...base, action: "unchanged", id: have.id, changes });
      else toSend.push({ input, changes, predicted: "updated" });
    }
    if (toSend.length === 0) continue;
    if (options.dryRun) {
      for (const { input, changes, predicted } of toSend) {
        results.push({
          email: input.email,
          label: input.label,
          action: predicted,
          id: existing.get(input.email)?.id,
          changes,
        });
      }
      continue;
    }

    upsertRequests++;
    let response: BatchResponse;
    try {
      response = (
        await client.request<BatchResponse>({
          method: "POST",
          path: UPSERT_PATH,
          body: {
            inputs: toSend.map(({ input }) => ({
              idProperty: "email",
              id: input.email,
              properties: input.properties,
            })),
          },
        })
      ).body;
    } catch (error) {
      const action: ContactAction =
        error instanceof HubSpotOutcomeUnknownError ? "unknown" : "failed";
      const message =
        error instanceof HubSpotApiError
          ? `${error.status} ${error.body}`
          : (error as Error).message;
      for (const { input, changes } of toSend) {
        results.push({ email: input.email, label: input.label, action, changes, error: message });
      }
      continue;
    }

    const byEmail = new Map<string, BatchObject>();
    for (const object of response.results ?? []) {
      const email = object.properties?.email?.toLowerCase();
      if (email) byEmail.set(email, object);
    }
    const batchErrors = (response.errors ?? []).map((e) => JSON.stringify(e)).join("; ");
    for (const { input, changes } of toSend) {
      const object = byEmail.get(input.email);
      if (!object) {
        // In the 207 errors, or simply absent: either way HubSpot didn't confirm this record.
        results.push({
          email: input.email,
          label: input.label,
          action: "failed",
          changes,
          error: batchErrors || "no result returned for this email",
        });
        continue;
      }
      results.push({
        email: input.email,
        label: input.label,
        action: object.new ? "created" : "updated",
        id: object.id,
        changes,
      });
    }
  }

  const order = new Map(inputs.map((input, i) => [input.email, i]));
  results.sort((a, b) => (order.get(a.email) ?? 0) - (order.get(b.email) ?? 0));
  const counts: Record<ContactAction, number> = {
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    unknown: 0,
  };
  for (const result of results) counts[result.action]++;
  return { results, counts, upsertRequests };
}
