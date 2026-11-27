import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * An in-process stand-in for the HubSpot endpoints `hs:setup` and `hs:seed` call, for tests and offline
 * evidence only. **Nothing it returns is a HubSpot response.** It follows the documented 2026-09 shapes
 * (see properties.ts and contacts.ts for the URLs). Where the docs are silent, it makes a choice, and
 * the code under test must not depend on that choice:
 * - creating a property or group that exists answers 409 `OBJECT_ALREADY_EXISTS`;
 * - a batch read answers 207 with an `OBJECT_NOT_FOUND` error listing missing emails;
 * - a batch upsert with any invalid input rejects the whole batch with 400 `VALIDATION_ERROR` (one
 *   reading of "partial upserts are not supported when using email as the idProperty");
 * - `updatedAt` changes only when a value actually changes.
 * Every response carries `x-fake-hubspot: 1`, so it can't be mistaken for the real API in a transcript.
 */

export interface FakeProperty {
  name: string;
  label: string;
  description: string;
  type: string;
  fieldType: string;
  groupName: string;
  formField: boolean;
  hidden: boolean;
  hubspotDefined: boolean;
  options: { label: string; value: string; displayOrder: number; hidden: boolean }[];
  createdAt: string;
  updatedAt: string;
}

export interface FakeContact {
  id: string;
  properties: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface FakeRequest {
  method: string;
  path: string;
  body: unknown;
  authorized: boolean;
}

export type FakeAnswer =
  | { status: number; body: unknown; headers?: Record<string, string> }
  | "hang";

interface Fault {
  method?: string;
  path: string | RegExp;
  answer: FakeAnswer;
  remaining: number;
}

export interface FakeHubSpotOptions {
  /** The service key the fake accepts as `Authorization: Bearer <token>`. */
  token: string;
  /** Burst limit the fake enforces itself (default 100 per 10 s, the lowest documented tier). */
  rateLimit?: { maxRequests: number; windowMs: number };
  /** Clock for timestamps (default: a fixed start that ticks 1 s per write, so state is reproducible). */
  now?: () => Date;
}

const API = "2026-09";
const PROPS = `/crm/properties/${API}/contacts`;
const OBJECTS = `/crm/objects/${API}/contacts`;

function stage(values: string[]) {
  return values.map((value, displayOrder) => ({
    label: value,
    value,
    displayOrder,
    hidden: false,
  }));
}

function defaultProperties(at: string): FakeProperty[] {
  const base = (
    name: string,
    label: string,
    type = "string",
    fieldType = "text",
  ): FakeProperty => ({
    name,
    label,
    description: "",
    type,
    fieldType,
    groupName: "contactinformation",
    formField: true,
    hidden: false,
    hubspotDefined: true,
    options: [],
    createdAt: at,
    updatedAt: at,
  });
  return [
    base("email", "Email"),
    base("firstname", "First Name"),
    base("lastname", "Last Name"),
    { ...base("phone", "Phone Number"), fieldType: "phonenumber" },
    base("company", "Company Name"),
    base("jobtitle", "Job Title"),
    base("city", "City"),
    base("country", "Country/Region"),
    { ...base("message", "Message"), fieldType: "textarea" },
    {
      ...base("lifecyclestage", "Lifecycle Stage", "enumeration", "radio"),
      options: stage([
        "subscriber",
        "lead",
        "marketingqualifiedlead",
        "salesqualifiedlead",
        "opportunity",
        "customer",
        "evangelist",
        "other",
      ]),
    },
    {
      ...base("hs_lead_status", "Lead Status", "enumeration", "radio"),
      options: stage([
        "NEW",
        "OPEN",
        "IN_PROGRESS",
        "OPEN_DEAL",
        "UNQUALIFIED",
        "ATTEMPTED_TO_CONTACT",
      ]),
    },
  ];
}

const error = (status: number, category: string, message: string, extra: object = {}) => ({
  status,
  body: {
    status: "error",
    message,
    category,
    correlationId: "00000000-fake-0000-0000-000000000000",
    ...extra,
  },
});

export async function startFakeHubSpot(options: FakeHubSpotOptions) {
  let tick = 0;
  const now = options.now ?? (() => new Date(Date.parse("2026-11-28T00:00:00Z") + tick++ * 1000));
  const rateLimit = options.rateLimit ?? { maxRequests: 100, windowMs: 10_000 };
  const start = now().toISOString();

  const groups = new Map<
    string,
    { name: string; label: string; displayOrder: number; archived: false }
  >([
    [
      "contactinformation",
      {
        name: "contactinformation",
        label: "Contact information",
        displayOrder: 0,
        archived: false,
      },
    ],
  ]);
  const properties = new Map<string, FakeProperty>(
    defaultProperties(start).map((p) => [p.name, p]),
  );
  const contacts = new Map<string, FakeContact>();
  let nextId = 1001;
  const requests: FakeRequest[] = [];
  const faults: Fault[] = [];
  const hanging: ServerResponse[] = [];
  const sent: number[] = [];

  function validateValue(name: string, value: unknown): string | null {
    const property = properties.get(name);
    if (!property) return `Property "${name}" does not exist`;
    if (typeof value !== "string") return `Property "${name}" value must be a string`;
    if (property.type === "enumeration" || property.type === "bool") {
      if (value !== "" && !property.options.some((o) => o.value === value)) {
        return `${value} was not one of the allowed options for "${name}"`;
      }
    }
    if (property.type === "number" && value !== "" && !Number.isFinite(Number(value))) {
      return `${value} is not a valid number for "${name}"`;
    }
    return null;
  }

  function contactByEmail(email: string): FakeContact | undefined {
    for (const contact of contacts.values()) {
      if (contact.properties.email === email) return contact;
    }
    return undefined;
  }

  function contactView(contact: FakeContact, names: readonly string[] | null) {
    const props: Record<string, string | null> = {
      createdate: contact.createdAt,
      hs_object_id: contact.id,
      lastmodifieddate: contact.updatedAt,
    };
    for (const name of names ?? Object.keys(contact.properties))
      props[name] = contact.properties[name] ?? null;
    return {
      id: contact.id,
      properties: props,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
      archived: false,
    };
  }

  function route(method: string, path: string, body: unknown): { status: number; body: unknown } {
    const b = (body ?? {}) as Record<string, unknown>;

    // --- Property groups ---
    if (path === `${PROPS}/groups` && method === "POST") {
      const name = String(b.name ?? "");
      if (!name || !b.label) return error(400, "VALIDATION_ERROR", "name and label are required");
      if (groups.has(name))
        return error(409, "OBJECT_ALREADY_EXISTS", `Group ${name} already exists`);
      const group = {
        name,
        label: String(b.label),
        displayOrder: Number(b.displayOrder ?? -1),
        archived: false as const,
      };
      groups.set(name, group);
      return { status: 201, body: group };
    }
    const groupMatch = new RegExp(`^${PROPS}/groups/([^/]+)$`).exec(path);
    if (groupMatch) {
      const group = groups.get(decodeURIComponent(groupMatch[1] ?? ""));
      if (!group) return error(404, "OBJECT_NOT_FOUND", "Group not found");
      if (method === "GET") return { status: 200, body: group };
      if (method === "PATCH") {
        if (typeof b.label === "string") group.label = b.label;
        return { status: 200, body: group };
      }
    }

    // --- Properties ---
    if (path === PROPS && method === "GET") {
      return { status: 200, body: { results: [...properties.values()] } };
    }
    if (path === PROPS && method === "POST") {
      for (const field of ["name", "label", "type", "fieldType", "groupName"]) {
        if (!b[field]) return error(400, "VALIDATION_ERROR", `${field} is required`);
      }
      const name = String(b.name);
      if (properties.has(name))
        return error(409, "OBJECT_ALREADY_EXISTS", `Property named '${name}' already exists.`);
      if (!groups.has(String(b.groupName)))
        return error(400, "VALIDATION_ERROR", `group ${String(b.groupName)} does not exist`);
      const opts = Array.isArray(b.options) ? (b.options as FakeProperty["options"]) : [];
      if (b.type === "enumeration" && opts.length === 0)
        return error(400, "VALIDATION_ERROR", "options are required for enumerations");
      const at = now().toISOString();
      const property: FakeProperty = {
        name,
        label: String(b.label),
        description: String(b.description ?? ""),
        type: String(b.type),
        fieldType: String(b.fieldType),
        groupName: String(b.groupName),
        formField: Boolean(b.formField),
        hidden: Boolean(b.hidden),
        hubspotDefined: false,
        options: opts.map((o) => ({
          label: o.label,
          value: o.value,
          displayOrder: o.displayOrder,
          hidden: Boolean(o.hidden),
        })),
        createdAt: at,
        updatedAt: at,
      };
      properties.set(name, property);
      return { status: 201, body: property };
    }
    const propMatch = new RegExp(`^${PROPS}/([^/]+)$`).exec(path);
    if (propMatch) {
      const property = properties.get(decodeURIComponent(propMatch[1] ?? ""));
      if (!property) return error(404, "OBJECT_NOT_FOUND", "Property not found");
      if (method === "GET") return { status: 200, body: property };
      if (method === "PATCH") {
        if ("name" in b) return error(400, "VALIDATION_ERROR", "name can't be changed");
        if (property.hubspotDefined)
          return error(400, "VALIDATION_ERROR", "HubSpot-defined property");
        for (const field of [
          "label",
          "description",
          "type",
          "fieldType",
          "groupName",
          "formField",
          "hidden",
          "options",
        ] as const) {
          if (field in b) (property as unknown as Record<string, unknown>)[field] = b[field];
        }
        property.updatedAt = now().toISOString();
        return { status: 200, body: property };
      }
    }

    // --- Contacts, batch ---
    if (path === `${OBJECTS}/batch/read` && method === "POST") {
      if (b.idProperty !== "email")
        return error(400, "VALIDATION_ERROR", "fake supports idProperty email only");
      const inputs = (Array.isArray(b.inputs) ? b.inputs : []) as { id: string }[];
      if (inputs.length > 100) return error(400, "VALIDATION_ERROR", "batch limit is 100");
      const names = Array.isArray(b.properties) ? (b.properties as string[]) : [];
      const results = [];
      const missing: string[] = [];
      for (const { id } of inputs) {
        const contact = contactByEmail(String(id).toLowerCase());
        if (contact) results.push(contactView(contact, names));
        else missing.push(String(id));
      }
      const at = now().toISOString();
      if (missing.length === 0)
        return {
          status: 200,
          body: { status: "COMPLETE", results, startedAt: at, completedAt: at },
        };
      return {
        status: 207,
        body: {
          status: "COMPLETE",
          results,
          numErrors: 1,
          errors: [
            {
              status: "error",
              category: "OBJECT_NOT_FOUND",
              message: "Could not get some CONTACT objects",
              context: { ids: missing },
            },
          ],
          startedAt: at,
          completedAt: at,
        },
      };
    }
    if (path === `${OBJECTS}/batch/upsert` && method === "POST") {
      const inputs = (Array.isArray(b.inputs) ? b.inputs : []) as {
        idProperty?: string;
        id?: string;
        properties?: Record<string, unknown>;
      }[];
      if (inputs.length > 100) return error(400, "VALIDATION_ERROR", "batch limit is 100");
      const problems: string[] = [];
      for (const input of inputs) {
        if (input.idProperty !== "email" || !input.id)
          problems.push("idProperty email and id are required");
        for (const [name, value] of Object.entries(input.properties ?? {})) {
          const problem = validateValue(name, value);
          if (problem) problems.push(problem);
        }
      }
      if (problems.length > 0) return error(400, "VALIDATION_ERROR", problems.join("; "));
      const at = now().toISOString();
      const results = inputs.map((input) => {
        const email = String(input.id).toLowerCase();
        const values = { ...(input.properties as Record<string, string>), email };
        const existing = contactByEmail(email);
        if (!existing) {
          const contact: FakeContact = {
            id: String(nextId++),
            properties: values,
            createdAt: at,
            updatedAt: at,
          };
          contacts.set(contact.id, contact);
          return { ...contactView(contact, null), new: true };
        }
        const changed = Object.entries(values).some(([k, v]) => existing.properties[k] !== v);
        if (changed) {
          Object.assign(existing.properties, values);
          existing.updatedAt = at;
        }
        return { ...contactView(existing, null), new: false };
      });
      return { status: 200, body: { status: "COMPLETE", results, startedAt: at, completedAt: at } };
    }

    return error(404, "OBJECT_NOT_FOUND", `fake HubSpot has no route for ${method} ${path}`);
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const method = req.method ?? "";
    const path = (req.url ?? "").split("?")[0] ?? "";
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const authorized = req.headers.authorization === `Bearer ${options.token}`;
    requests.push({ method, path, body, authorized });

    const nowMs = Date.now();
    while (sent.length > 0 && (sent[0] ?? 0) <= nowMs - rateLimit.windowMs) sent.shift();
    const rateHeaders = () => ({
      "x-hubspot-ratelimit-max": String(rateLimit.maxRequests),
      "x-hubspot-ratelimit-remaining": String(Math.max(0, rateLimit.maxRequests - sent.length)),
      "x-hubspot-ratelimit-interval-milliseconds": String(rateLimit.windowMs),
    });
    const reply = (answer: { status: number; body: unknown; headers?: Record<string, string> }) => {
      res.writeHead(answer.status, {
        "content-type": "application/json",
        "x-fake-hubspot": "1",
        ...rateHeaders(),
        ...answer.headers,
      });
      res.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
    };

    const fault = faults.find(
      (f) =>
        f.remaining > 0 &&
        (!f.method || f.method === method) &&
        (typeof f.path === "string" ? f.path === path : f.path.test(path)),
    );
    if (fault) {
      fault.remaining--;
      if (fault.answer === "hang") {
        hanging.push(res);
        return;
      }
      reply(fault.answer);
      return;
    }
    if (!authorized) {
      reply(error(401, "INVALID_AUTHENTICATION", "Authentication credentials not found."));
      return;
    }
    if (sent.length >= rateLimit.maxRequests) {
      reply({
        status: 429,
        body: {
          status: "error",
          message: "You have reached your ten_secondly_rolling limit.",
          errorType: "RATE_LIMIT",
          correlationId: "00000000-fake-0000-0000-000000000000",
          policyName: "TEN_SECONDLY_ROLLING",
        },
      });
      return;
    }
    sent.push(nowMs);
    reply(route(method, path, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    /** Answer the next `times` matching requests with `answer` instead of the fake's own logic. */
    failNext(match: { method?: string; path: string | RegExp }, answer: FakeAnswer, times = 1) {
      faults.push({ ...match, answer, remaining: times });
    },
    /** Change state behind the client's back (a person editing in HubSpot's UI). */
    mutate: {
      property(name: string, change: Partial<FakeProperty>) {
        const property = properties.get(name);
        if (!property) throw new Error(`fake: no property ${name}`);
        Object.assign(property, change);
      },
      contact(email: string, change: Record<string, string>) {
        const contact = contactByEmail(email);
        if (!contact) throw new Error(`fake: no contact ${email}`);
        Object.assign(contact.properties, change);
      },
      addProperty(property: Omit<FakeProperty, "createdAt" | "updatedAt">) {
        properties.set(property.name, { ...property, createdAt: start, updatedAt: start });
      },
    },
    /** Everything the fake holds, as plain JSON (deep-equal two of these to compare end states). */
    snapshot() {
      return structuredClone({
        groups: [...groups.values()],
        properties: [...properties.values()],
        contacts: [...contacts.values()],
      });
    },
    /** Requests that would change state if they succeeded. */
    writes() {
      return requests.filter(
        (r) => r.method === "PATCH" || (r.method === "POST" && !r.path.endsWith("/batch/read")),
      );
    },
    async close() {
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type FakeHubSpot = Awaited<ReturnType<typeof startFakeHubSpot>>;
