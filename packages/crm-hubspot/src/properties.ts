import {
  HUBSPOT_API_VERSION,
  HubSpotApiError,
  type HubSpotClient,
  HubSpotOutcomeUnknownError,
} from "./api.ts";

/**
 * The contact properties this project owns, in a property group of its own, and `ensureContactProperties`,
 * which makes an account match them: read first, create what's missing, PATCH only the fields that
 * differ, and leave equal ones alone. It never deletes or duplicates anything.
 *
 * API (2026-09, read 2026-11-28):
 * - guide: https://developers.hubspot.com/docs/api-reference/latest/crm/properties/guide
 * - create: https://developers.hubspot.com/docs/api-reference/latest/crm/properties/create-property
 *   `POST /crm/properties/2026-09/{objectType}`, required `name, label, type, fieldType, groupName`;
 *   `options` (each `label, value, displayOrder, hidden`) is required for enumerations. 201 + Property.
 * - read one: https://developers.hubspot.com/docs/api-reference/latest/crm/properties/get-property
 * - update: https://developers.hubspot.com/docs/api-reference/latest/crm/properties/update-property
 *   `PATCH …/{objectType}/{propertyName}`; the body may not carry `name`.
 * - groups: https://developers.hubspot.com/docs/api-reference/latest/crm/properties/property-groups/create-property
 *   and …/property-groups/get-property: `POST …/{objectType}/groups` (`name, label, displayOrder`) and
 *   `GET …/groups/{groupName}`. The 2026-09 page for updating a group wasn't found; `PATCH …/groups/{name}`
 *   is the v3 shape and is assumed here (only used if someone renamed our group's label).
 * - scopes: crm.schemas.contacts.read and crm.schemas.contacts.write
 *   (https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/scopes).
 * The docs don't say what creating an existing name returns, so nothing here relies on it: a failed
 * create is followed by a read, and the property is compared if it turns out to exist.
 */

export const OBJECT_TYPE = "contacts";
export const PROPERTY_GROUP = { name: "lead_lifecycle_pipeline", label: "Lead lifecycle pipeline" };

export interface PropertyOption {
  label: string;
  value: string;
  displayOrder: number;
  hidden: boolean;
}

export interface PropertyDefinition {
  name: string;
  label: string;
  description: string;
  type: "string" | "number" | "enumeration" | "bool" | "datetime";
  fieldType: "text" | "number" | "select" | "booleancheckbox" | "date";
  groupName: string;
  formField: boolean;
  hidden: boolean;
  options: PropertyOption[];
}

function options(values: readonly string[]): PropertyOption[] {
  return values.map((value, displayOrder) => ({
    label: value,
    value,
    displayOrder,
    hidden: false,
  }));
}

function text(name: string, label: string, description: string): PropertyDefinition {
  return {
    name,
    label,
    description,
    type: "string",
    fieldType: "text",
    groupName: PROPERTY_GROUP.name,
    formField: false,
    hidden: false,
    options: [],
  };
}

function select(
  name: string,
  label: string,
  description: string,
  values: readonly string[],
): PropertyDefinition {
  return {
    ...text(name, label, description),
    type: "enumeration",
    fieldType: "select",
    options: options(values),
  };
}

export const TRIAGE_DISPOSITION_VALUES = [
  "qualified",
  "nurture",
  "spam",
  "duplicate",
  "needs_review",
] as const;
export const CONSENT_VALUES = ["granted", "denied", "unspecified"] as const;

export const CONTACT_PROPERTIES: readonly PropertyDefinition[] = [
  select(
    "triage_disposition",
    "Triage disposition",
    "Approved triage label. Written only after a person approves the proposal.",
    TRIAGE_DISPOSITION_VALUES,
  ),
  {
    ...text(
      "triage_confidence",
      "Triage confidence",
      "Confidence of the approved triage proposal, 0 to 1.",
    ),
    type: "number",
    fieldType: "number",
  },
  text(
    "attribution_session_id",
    "Attribution session ID",
    "First-party session handle from the site that captured the lead.",
  ),
  text("click_gclid", "Click ID: gclid", "Google Ads click ID from the landing URL."),
  text("click_gbraid", "Click ID: gbraid", "Google Ads app-to-web click ID."),
  text("click_wbraid", "Click ID: wbraid", "Google Ads web-to-app click ID."),
  text("click_fbclid", "Click ID: fbclid", "Meta click ID from the landing URL, case kept."),
  text("click_fbc", "Meta fbc", "Meta _fbc value (fb.1.<ms>.<fbclid>)."),
  text("click_fbp", "Meta fbp", "Meta _fbp browser ID."),
  text("click_msclkid", "Click ID: msclkid", "Microsoft Advertising click ID."),
  select(
    "consent_ad_user_data",
    "Consent: ad_user_data",
    "Consent Mode v2 ad_user_data at submission.",
    CONSENT_VALUES,
  ),
  select(
    "consent_ad_personalization",
    "Consent: ad_personalization",
    "Consent Mode v2 ad_personalization at submission.",
    CONSENT_VALUES,
  ),
  {
    ...text(
      "consent_gpc",
      "Consent: GPC",
      "Global Privacy Control signal at submission (true or false).",
    ),
    type: "bool",
    fieldType: "booleancheckbox",
    options: [
      { label: "Yes", value: "true", displayOrder: 0, hidden: false },
      { label: "No", value: "false", displayOrder: 1, hidden: false },
    ],
  },
  text(
    "fixture_key",
    "Synthetic fixture key",
    "Key of the synthetic record that created this contact (pnpm hs:seed).",
  ),
];

export type SetupAction = "created" | "updated" | "unchanged" | "failed" | "unknown";

export interface SetupResult {
  kind: "group" | "property";
  name: string;
  action: SetupAction;
  /** Fields that differed (updated), or would be sent (dry run). */
  changes: string[];
  /** HubSpot's error exactly as returned, for failed and unknown results. */
  error?: string;
}

export interface EnsureOptions {
  /** Read and compare only; report what would change and write nothing. */
  dryRun?: boolean;
  definitions?: readonly PropertyDefinition[];
}

const BASE = `/crm/properties/${HUBSPOT_API_VERSION}/${OBJECT_TYPE}`;

interface RemoteProperty {
  name: string;
  label?: string;
  description?: string;
  type?: string;
  fieldType?: string;
  groupName?: string;
  formField?: boolean;
  hidden?: boolean;
  hubspotDefined?: boolean;
  options?: { label?: string; value?: string; displayOrder?: number; hidden?: boolean }[];
}

/** The fields of a definition that differ from what HubSpot holds. */
export function diffProperty(want: PropertyDefinition, have: RemoteProperty): string[] {
  const changed: string[] = [];
  for (const field of [
    "label",
    "description",
    "type",
    "fieldType",
    "groupName",
    "formField",
    "hidden",
  ] as const) {
    if ((have[field] ?? (typeof want[field] === "boolean" ? false : "")) !== want[field])
      changed.push(field);
  }
  const haveOptions = [...(have.options ?? [])]
    .map((o) => ({
      label: o.label ?? "",
      value: o.value ?? "",
      displayOrder: o.displayOrder ?? -1,
      hidden: o.hidden ?? false,
    }))
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  const wantOptions = [...want.options].sort((a, b) =>
    a.value < b.value ? -1 : a.value > b.value ? 1 : 0,
  );
  if (JSON.stringify(haveOptions) !== JSON.stringify(wantOptions)) changed.push("options");
  return changed;
}

function describeError(error: unknown): string {
  if (error instanceof HubSpotApiError) return `${error.status} ${error.body}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

async function readOrNull<T>(client: HubSpotClient, path: string): Promise<T | null> {
  try {
    return (await client.request<T>({ method: "GET", path })).body;
  } catch (error) {
    if (error instanceof HubSpotApiError && error.status === 404) return null;
    throw error;
  }
}

/** Run one write and turn its outcome into a result. */
async function write(
  base: Omit<SetupResult, "action" | "error">,
  action: "created" | "updated",
  send: () => Promise<unknown>,
): Promise<SetupResult> {
  try {
    await send();
    return { ...base, action };
  } catch (error) {
    if (error instanceof HubSpotOutcomeUnknownError) {
      return { ...base, action: "unknown", error: error.message };
    }
    return { ...base, action: "failed", error: describeError(error) };
  }
}

async function ensureGroup(client: HubSpotClient, dryRun: boolean): Promise<SetupResult> {
  const base = { kind: "group" as const, name: PROPERTY_GROUP.name };
  const path = `${BASE}/groups/${PROPERTY_GROUP.name}`;
  const have = await readOrNull<{ label?: string }>(client, path);
  if (have === null) {
    if (dryRun) return { ...base, action: "created", changes: ["name", "label"] };
    const created = await write({ ...base, changes: ["name", "label"] }, "created", () =>
      client.request({ method: "POST", path: `${BASE}/groups`, body: PROPERTY_GROUP }),
    );
    if (created.action !== "failed") return created;
    // A create can fail because the group appeared meanwhile: look again before reporting it.
    const again = await readOrNull<{ label?: string }>(client, path);
    if (again === null) return created;
    return compareGroup(client, base, again, dryRun);
  }
  return compareGroup(client, base, have, dryRun);
}

async function compareGroup(
  client: HubSpotClient,
  base: { kind: "group"; name: string },
  have: { label?: string },
  dryRun: boolean,
): Promise<SetupResult> {
  if (have.label === PROPERTY_GROUP.label) return { ...base, action: "unchanged", changes: [] };
  if (dryRun) return { ...base, action: "updated", changes: ["label"] };
  return write({ ...base, changes: ["label"] }, "updated", () =>
    client.request({
      method: "PATCH",
      path: `${BASE}/groups/${PROPERTY_GROUP.name}`,
      body: { label: PROPERTY_GROUP.label },
    }),
  );
}

async function ensureProperty(
  client: HubSpotClient,
  want: PropertyDefinition,
  have: RemoteProperty | undefined,
  dryRun: boolean,
): Promise<SetupResult> {
  const base = { kind: "property" as const, name: want.name };
  if (!have) {
    const fields = Object.keys(want);
    if (dryRun) return { ...base, action: "created", changes: fields };
    const created = await write({ ...base, changes: fields }, "created", () =>
      client.request({ method: "POST", path: BASE, body: want }),
    );
    if (created.action !== "failed") return created;
    const again = await readOrNull<RemoteProperty>(client, `${BASE}/${want.name}`);
    if (again === null) return created;
    return ensureProperty(client, want, again, dryRun);
  }
  if (have.hubspotDefined) {
    return {
      ...base,
      action: "failed",
      changes: [],
      error: `"${want.name}" is a HubSpot-defined property in this account; refusing to change it`,
    };
  }
  const changes = diffProperty(want, have);
  if (changes.length === 0) return { ...base, action: "unchanged", changes };
  if (dryRun) return { ...base, action: "updated", changes };
  const patch: Record<string, unknown> = {};
  for (const field of changes) patch[field] = want[field as keyof PropertyDefinition];
  return write({ ...base, changes }, "updated", () =>
    client.request({ method: "PATCH", path: `${BASE}/${want.name}`, body: patch }),
  );
}

/**
 * Make the account's contact properties match `CONTACT_PROPERTIES`. One list request reads every
 * property; then one write per missing or drifted property. Results come back in definition order,
 * group first.
 */
export async function ensureContactProperties(
  client: HubSpotClient,
  options: EnsureOptions = {},
): Promise<SetupResult[]> {
  const dryRun = options.dryRun ?? false;
  const definitions = options.definitions ?? CONTACT_PROPERTIES;
  const group = await ensureGroup(client, dryRun);
  const results: SetupResult[] = [group];
  if (group.action === "failed" || group.action === "unknown") {
    // Properties need the group; report them as not attempted rather than failing each one.
    for (const def of definitions) {
      results.push({
        kind: "property",
        name: def.name,
        action: group.action,
        changes: [],
        error: "property group not confirmed",
      });
    }
    return results;
  }
  const list = await client.request<{ results?: RemoteProperty[] }>({ method: "GET", path: BASE });
  const existing = new Map((list.body.results ?? []).map((p) => [p.name, p]));
  for (const def of definitions) {
    results.push(await ensureProperty(client, def, existing.get(def.name), dryRun));
  }
  return results;
}
