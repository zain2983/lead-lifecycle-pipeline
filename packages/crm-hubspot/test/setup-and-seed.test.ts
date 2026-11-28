import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubSpotClient } from "../src/api.ts";
import { upsertContactsByEmail } from "../src/contacts.ts";
import { CONTACT_PROPERTIES, ensureContactProperties, PROPERTY_GROUP } from "../src/properties.ts";
import {
  contactPropertiesFor,
  HUBSPOT_DEFAULT_PROPERTIES,
  leadsFor,
  SEED_NEVER_WRITES,
  seedInputs,
} from "../src/seed.ts";
import { type FakeHubSpot, startFakeHubSpot } from "../src/testing/index.ts";

const TOKEN = "synthetic-service-key-0001";
let fake: FakeHubSpot;
let client: HubSpotClient;

beforeEach(async () => {
  fake = await startFakeHubSpot({ token: TOKEN });
  client = new HubSpotClient({ token: TOKEN, baseUrl: fake.url, sleep: async () => {} });
});
afterEach(async () => {
  await fake.close();
});

function tally(actions: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const action of actions) counts[action] = (counts[action] ?? 0) + 1;
  return counts;
}

describe("hs:setup (ensureContactProperties)", () => {
  it("creates the group and every property, then a second run changes nothing", async () => {
    const first = await ensureContactProperties(client);
    expect(first.map((r) => r.action)).toEqual(
      Array(CONTACT_PROPERTIES.length + 1).fill("created"),
    );
    const afterFirst = fake.snapshot();
    const writesAfterFirst = fake.writes().length;
    expect(writesAfterFirst).toBe(CONTACT_PROPERTIES.length + 1);

    const second = await ensureContactProperties(client);
    expect(tally(second.map((r) => r.action))).toEqual({
      unchanged: CONTACT_PROPERTIES.length + 1,
    });
    expect(fake.writes().length).toBe(writesAfterFirst);
    expect(fake.snapshot()).toEqual(afterFirst);
  });

  it("creates the properties the plan names, in our own group", async () => {
    await ensureContactProperties(client);
    const props = fake.snapshot().properties.filter((p) => !p.hubspotDefined);
    expect(new Set(props.map((p) => p.groupName))).toEqual(new Set([PROPERTY_GROUP.name]));
    const disposition = props.find((p) => p.name === "triage_disposition");
    expect(disposition?.type).toBe("enumeration");
    expect(disposition?.options.map((o) => o.value)).toEqual([
      "qualified",
      "nurture",
      "spam",
      "duplicate",
      "needs_review",
    ]);
    expect(props.find((p) => p.name === "triage_confidence")?.type).toBe("number");
    for (const name of [
      "attribution_session_id",
      "click_gclid",
      "click_fbclid",
      "click_msclkid",
      "consent_ad_user_data",
      "consent_gpc",
    ]) {
      expect(props.map((p) => p.name)).toContain(name);
    }
  });

  it("repairs drift by patching only the fields that differ, and never duplicates", async () => {
    await ensureContactProperties(client);
    fake.mutate.property("triage_disposition", {
      label: "Renamed in the UI",
      options: [{ label: "qualified", value: "qualified", displayOrder: 0, hidden: false }],
    });
    const writesBefore = fake.writes().length;
    const repair = await ensureContactProperties(client);
    const changed = repair.filter((r) => r.action !== "unchanged");
    expect(changed).toEqual([
      {
        kind: "property",
        name: "triage_disposition",
        action: "updated",
        changes: ["label", "options"],
      },
    ]);
    const patch = fake.writes().slice(writesBefore);
    expect(patch).toHaveLength(1);
    expect(patch[0]?.method).toBe("PATCH");
    expect(Object.keys(patch[0]?.body as object).sort()).toEqual(["label", "options"]);
    const third = await ensureContactProperties(client);
    expect(third.every((r) => r.action === "unchanged")).toBe(true);
    expect(fake.snapshot().properties.filter((p) => p.name === "triage_disposition")).toHaveLength(
      1,
    );
  });

  it("reads again when a create fails because the property appeared meanwhile", async () => {
    await ensureContactProperties(client, { definitions: [] });
    const def = CONTACT_PROPERTIES[0];
    if (!def) throw new Error("no definitions");
    // Another run created it between our list and our create; the fake answers the create with 409.
    fake.failNext(
      { method: "GET", path: "/crm/properties/2026-09/contacts" },
      { status: 200, body: { results: [] } },
    );
    fake.mutate.addProperty({ ...def, hubspotDefined: false });
    const [, result] = await ensureContactProperties(client, { definitions: [def] });
    expect(result).toMatchObject({ name: def.name, action: "unchanged" });
  });

  it("refuses to touch a HubSpot-defined property with the same name", async () => {
    fake.mutate.addProperty({
      ...(CONTACT_PROPERTIES[2] as (typeof CONTACT_PROPERTIES)[number]),
      hubspotDefined: true,
    });
    const results = await ensureContactProperties(client);
    expect(results.find((r) => r.name === CONTACT_PROPERTIES[2]?.name)).toMatchObject({
      action: "failed",
    });
  });

  it("reports a timed-out create as unknown, and a re-run settles it", async () => {
    fake.failNext({ method: "POST", path: "/crm/properties/2026-09/contacts" }, "hang", 1);
    const slow = new HubSpotClient({
      token: TOKEN,
      baseUrl: fake.url,
      timeoutMs: 200,
      sleep: async () => {},
    });
    const first = await ensureContactProperties(slow);
    expect(first.filter((r) => r.action === "unknown").map((r) => r.name)).toEqual([
      CONTACT_PROPERTIES[0]?.name,
    ]);
    const second = await ensureContactProperties(slow);
    expect(second.filter((r) => r.action !== "unchanged").map((r) => [r.name, r.action])).toEqual([
      [CONTACT_PROPERTIES[0]?.name, "created"],
    ]);
  });

  it("writes nothing in a dry run", async () => {
    const plan = await ensureContactProperties(client, { dryRun: true });
    expect(plan.every((r) => r.action === "created")).toBe(true);
    expect(fake.writes()).toEqual([]);
  });
});

describe("hs:seed (upsertContactsByEmail)", () => {
  beforeEach(async () => {
    await ensureContactProperties(client);
  });

  for (const [account, count] of [
    ["demo", 20],
    ["eval", 10],
  ] as const) {
    it(`${account}: creates ${count} contacts, then a second run sends nothing and changes nothing`, async () => {
      const inputs = seedInputs(account, 42);
      expect(inputs).toHaveLength(count);
      const first = await upsertContactsByEmail(client, inputs);
      expect(first.counts).toEqual({
        created: count,
        updated: 0,
        unchanged: 0,
        failed: 0,
        unknown: 0,
      });
      expect(first.upsertRequests).toBe(1);
      const afterFirst = fake.snapshot();
      const writes = fake.writes().length;

      const second = await upsertContactsByEmail(client, inputs);
      expect(second.counts).toEqual({
        created: 0,
        updated: 0,
        unchanged: count,
        failed: 0,
        unknown: 0,
      });
      expect(second.upsertRequests).toBe(0);
      expect(fake.writes().length).toBe(writes);
      expect(fake.snapshot()).toEqual(afterFirst);
      expect(second.results.map((r) => r.id)).toEqual(first.results.map((r) => r.id));
    });
  }

  it("updates only the contact someone edited, and only its changed field", async () => {
    const inputs = seedInputs("demo", 42);
    await upsertContactsByEmail(client, inputs);
    const target = inputs[3];
    if (!target) throw new Error("no input");
    fake.mutate.contact(target.email, { firstname: "Edited" });
    const again = await upsertContactsByEmail(client, inputs);
    expect(again.counts).toMatchObject({ updated: 1, unchanged: 19 });
    expect(again.results.find((r) => r.action === "updated")).toMatchObject({
      label: target.label,
      changes: ["firstname"],
    });
  });

  it("leaves fields it doesn't own alone (a later approved disposition survives a re-seed)", async () => {
    const inputs = seedInputs("eval", 42);
    await upsertContactsByEmail(client, inputs);
    const first = inputs[0];
    if (!first) throw new Error("no input");
    fake.mutate.contact(first.email, {
      triage_disposition: "qualified",
      lifecyclestage: "marketingqualifiedlead",
    });
    const again = await upsertContactsByEmail(client, inputs);
    expect(again.counts.unchanged).toBe(10);
    const stored = fake.snapshot().contacts.find((c) => c.properties.email === first.email);
    expect(stored?.properties.triage_disposition).toBe("qualified");
  });

  it("reports a timed-out upsert as unknown for every contact in it, and a re-run settles it", async () => {
    const inputs = seedInputs("eval", 42);
    fake.failNext({ method: "POST", path: /batch\/upsert$/ }, "hang", 1);
    const slow = new HubSpotClient({
      token: TOKEN,
      baseUrl: fake.url,
      timeoutMs: 200,
      sleep: async () => {},
    });
    const first = await upsertContactsByEmail(slow, inputs);
    expect(first.counts).toMatchObject({ unknown: 10, created: 0, failed: 0 });
    const second = await upsertContactsByEmail(slow, inputs);
    expect(second.counts).toMatchObject({ created: 10, unknown: 0 });
  });

  it("reports HubSpot's 4xx body as it came, as failed", async () => {
    const inputs = seedInputs("eval", 42);
    fake.failNext(
      { method: "POST", path: /batch\/upsert$/ },
      {
        status: 400,
        body: {
          status: "error",
          category: "VALIDATION_ERROR",
          message: "Property values were not valid",
        },
      },
    );
    const result = await upsertContactsByEmail(client, inputs);
    expect(result.counts.failed).toBe(10);
    expect(result.results[0]?.error).toContain("Property values were not valid");
  });

  it("only sends properties that exist, with valid option values", async () => {
    // The fake rejects unknown properties and invalid enumeration values, like HubSpot.
    const all = [...seedInputs("demo", 7), ...seedInputs("eval", 7)];
    const result = await upsertContactsByEmail(client, all);
    expect(result.counts.created).toBe(30);
  });

  it("dry run reads and writes nothing", async () => {
    const plan = await upsertContactsByEmail(client, seedInputs("demo", 42), { dryRun: true });
    expect(plan.counts.created).toBe(20);
    expect(fake.writes().filter((w) => w.path.includes("/objects/"))).toEqual([]);
  });
});

describe("seed mapping", () => {
  const defined = new Set<string>([
    ...HUBSPOT_DEFAULT_PROPERTIES,
    ...CONTACT_PROPERTIES.map((p) => p.name),
  ]);

  it("never writes the fields the agent or a person owns", () => {
    for (const account of ["demo", "eval"] as const) {
      for (const lead of leadsFor(account, 42)) {
        const props = contactPropertiesFor(lead);
        for (const owned of SEED_NEVER_WRITES) expect(props).not.toHaveProperty(owned);
        for (const name of Object.keys(props)) expect(defined.has(name), name).toBe(true);
        expect(Object.values(props)).not.toContain("");
        expect(props.fixture_key).toBe(lead.key);
      }
    }
  });
});

describe("the CLIs, end to end against the fake", () => {
  const pkg = path.resolve(import.meta.dirname, "..");
  const run = promisify(execFile);
  const cli = (script: string, args: string[]) =>
    run(path.join(pkg, "node_modules/.bin/tsx"), [`src/cli/${script}.ts`, ...args], {
      cwd: pkg,
      env: {
        PATH: process.env.PATH,
        HUBSPOT_API_BASE_URL: fake.url,
        HUBSPOT_SERVICE_KEY_DEMO: TOKEN,
        // Set (empty) so the CLI's repo-root `.env` loader, where set variables win, can't fill in a real key
        // on a laptop that has one. Without this, the missing-key test sent the real eval key to the fake and
        // printed it in the assertion diff.
        HUBSPOT_SERVICE_KEY_EVAL: "",
      },
    }).then(
      (r) => ({ code: 0, out: r.stdout }),
      (e: { code: number; stdout: string }) => ({ code: e.code, out: e.stdout }),
    );

  it("hs:setup twice, then hs:seed twice: the second runs report no changes", async () => {
    const setup1 = await cli("setup", ["--account", "demo"]);
    expect(setup1.code).toBe(0);
    expect(setup1.out).toContain("NOT HubSpot");
    expect(setup1.out).toMatch(
      /summary {3}created 15 {2}updated 0 {2}unchanged 0 {2}failed 0 {2}unknown 0/,
    );
    const setup2 = await cli("setup", ["--account", "demo"]);
    expect(setup2.out).toMatch(
      /summary {3}created 0 {2}updated 0 {2}unchanged 15 {2}failed 0 {2}unknown 0/,
    );

    const seed1 = await cli("seed", ["--account", "demo", "--seed", "42"]);
    expect(seed1.code).toBe(0);
    expect(seed1.out).toMatch(/created 20 {2}updated 0 {2}unchanged 0/);
    const state = fake.snapshot();
    const seed2 = await cli("seed", ["--account", "demo", "--seed", "42"]);
    expect(seed2.out).toMatch(/created 0 {2}updated 0 {2}unchanged 20 {2}failed 0 {2}unknown 0/);
    expect(seed2.out).toContain("upserts 0");
    expect(fake.snapshot()).toEqual(state);
    // Fixture keys and IDs only: no email ever reaches the output.
    expect(`${seed1.out}${seed2.out}`).not.toMatch(/@/);
  }, 60_000);

  it("refuses to run without the chosen account's key", async () => {
    const result = await cli("setup", ["--account", "eval"]);
    expect(result.code).not.toBe(0);
    expect(fake.requests).toEqual([]);
  }, 30_000);
});
