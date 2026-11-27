import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRng,
  DISPOSITION_SCENARIOS,
  datasetHash,
  demoLeads,
  evalFixtures,
  generateDataset,
  SITES,
  type SyntheticLead,
  saasScenarioFromAnswers,
  serializeDataset,
  TRIAGE_DISPOSITIONS,
} from "../src/index.ts";

const SEEDS = [0, 1, 42, 7_777, 999_999];
const all = (seed: number) => [...demoLeads(seed), ...evalFixtures(seed)];

describe("determinism", () => {
  it("gives the same bytes for the same seed", () => {
    for (const seed of SEEDS) {
      expect(serializeDataset(generateDataset(seed))).toBe(serializeDataset(generateDataset(seed)));
    }
  });

  it("gives the same bytes in a fresh process (no module state, no clock)", () => {
    const pkg = path.resolve(import.meta.dirname, "..");
    const out = execFileSync(
      path.join(pkg, "node_modules/.bin/tsx"),
      ["src/cli/generate.ts", "--seed", "42"],
      {
        cwd: pkg,
        encoding: "utf8",
        env: { ...process.env, TZ: "Pacific/Chatham", LANG: "tr_TR.UTF-8" },
      },
    );
    expect(out).toBe(serializeDataset(generateDataset(42)));
  });

  it("matches the pinned hash for seed 42 (bump SYNTHETIC_VERSION when a change is intended)", () => {
    expect(datasetHash(generateDataset(42))).toBe(
      "14fdebd96f7a9ce02f30b809845da47703b759c552bd5ccac25b77766e2cc198",
    );
  });

  it("gives different people for different seeds, and the same scenarios", () => {
    const a = demoLeads(1);
    const b = demoLeads(2);
    expect(a.map((l) => l.person.email)).not.toEqual(b.map((l) => l.person.email));
    expect(a.map((l) => l.scenario).sort()).toEqual(b.map((l) => l.scenario).sort());
  });

  it("keeps forked streams independent of each other", () => {
    const one = createRng(42).fork("a");
    const two = createRng(42).fork("a");
    const other = createRng(42).fork("b");
    const draw = (rng: typeof one) => Array.from({ length: 5 }, () => rng.int(0, 1_000_000));
    expect(draw(one)).toEqual(draw(two));
    expect(draw(createRng(42).fork("a"))).not.toEqual(draw(other));
  });
});

// --- Reserved domains only ---------------------------------------------------------------------------

/** RFC 2606 / RFC 6761 names: example.com, example.org, example.net (and subdomains) and *.test. */
function isReservedDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return /(^|\.)example\.(com|org|net)$/.test(d) || /^([a-z0-9-]+\.)+test$/.test(d);
}

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+)/g;
const URL_HOST = /\bhttps?:\/\/([^/\s?#:]+)/gi;
/** A bare hostname in free text, e.g. "visit cheap-links.test". */
const BARE_HOST = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})\b/gi;

/** Every domain a dataset mentions: emails, URLs, `domain` fields, and hostnames in messages. */
function domainsIn(value: unknown, key = ""): string[] {
  if (typeof value === "string") {
    const found = [...value.matchAll(EMAIL)].map((m) => m[1] ?? "");
    found.push(...[...value.matchAll(URL_HOST)].map((m) => m[1] ?? ""));
    if (key === "domain") found.push(value);
    if (key === "message") found.push(...[...value.matchAll(BARE_HOST)].map((m) => m[1] ?? ""));
    return found;
  }
  if (Array.isArray(value)) return value.flatMap((item) => domainsIn(item, key));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => domainsIn(v, k));
  }
  return [];
}

describe("reserved domains only", () => {
  it("the checker itself rejects other domains", () => {
    expect(isReservedDomain("example.com")).toBe(true);
    expect(isReservedDomain("pk.saltmarsh.test")).toBe(true);
    for (const bad of [
      "example.co",
      "notexample.com",
      "mail.invalid",
      "test",
      "quillmark.test.io",
    ]) {
      expect(isReservedDomain(bad), bad).toBe(false);
    }
    expect(domainsIn({ message: "write to a@mail.invalid or see shop.invalid/x" })).toEqual([
      "mail.invalid",
      "mail.invalid",
      "shop.invalid",
    ]);
  });

  it("every email, URL, site, company and message hostname is reserved, for every seed", () => {
    for (const seed of SEEDS) {
      const dataset = JSON.parse(serializeDataset(generateDataset(seed))) as unknown;
      const domains = domainsIn(dataset);
      expect(domains.length).toBeGreaterThan(60);
      const bad = [...new Set(domains.filter((d) => !isReservedDomain(d)))];
      expect(bad, `seed ${seed}`).toEqual([]);
    }
  });

  it("emails are lower-case and unique within each set", () => {
    for (const seed of SEEDS) {
      for (const set of [demoLeads(seed), evalFixtures(seed)]) {
        const emails = set.map((l) => l.person.email);
        expect(new Set(emails).size).toBe(emails.length);
        for (const email of emails) expect(email).toBe(email.toLowerCase());
      }
    }
  });
});

describe("phones", () => {
  it("are +1 555-01xx or empty", () => {
    for (const seed of SEEDS) {
      for (const lead of all(seed)) {
        if (lead.person.phone !== null) expect(lead.person.phone).toMatch(/^\+1 555-01\d{2}$/);
      }
    }
  });

  it("are unique per person, and shared only by a duplicate and its original", () => {
    for (const seed of SEEDS) {
      for (const set of [demoLeads(seed), evalFixtures(seed)]) {
        const byKey = new Map(set.map((l) => [l.key, l]));
        const owners = new Map<string, string>();
        for (const lead of set) {
          const phone = lead.person.phone;
          if (phone === null) continue;
          const owner = lead.duplicateOfKey ?? lead.key;
          if (lead.duplicateOfKey) expect(byKey.get(lead.duplicateOfKey)?.person.phone).toBe(phone);
          expect(owners.get(phone) ?? owner, `${seed} ${phone}`).toBe(owner);
          owners.set(phone, owner);
        }
      }
    }
  });
});

// --- Labels and scenarios ----------------------------------------------------------------------------

describe("sets, verticals and labels", () => {
  const demo = demoLeads(42);
  const fixtures = evalFixtures(42);

  it("has 20 demo leads on the two demo sites and 10 eval fixtures", () => {
    expect(demo).toHaveLength(20);
    expect(fixtures).toHaveLength(10);
    const demoSites = new Set(SITES.filter((s) => s.demoSite).map((s) => s.key));
    expect(demoSites).toEqual(new Set(["saas", "rehab"]));
    for (const lead of demo) expect(demoSites.has(lead.siteKey)).toBe(true);
    expect(new Set(fixtures.map((l) => l.siteKey))).toEqual(
      new Set(["saas", "rehab", "clinic", "local_services"]),
    );
  });

  it("marks only the rehab vertical sensitive", () => {
    for (const site of SITES) expect(site.sensitive).toBe(site.vertical === "rehab");
    for (const lead of [...demo, ...fixtures])
      expect(lead.sensitive).toBe(lead.vertical === "rehab");
  });

  it("covers every disposition case and every triage label, each with its intended label", () => {
    const scenarios = new Set([...demo, ...fixtures].map((l) => l.scenario));
    for (const scenario of DISPOSITION_SCENARIOS) expect(scenarios).toContain(scenario);
    expect(new Set(fixtures.map((l) => l.scenario))).toEqual(
      new Set([...DISPOSITION_SCENARIOS, "qualified", "nurture"]),
    );
    expect(new Set(fixtures.map((l) => l.intended.triageDisposition))).toEqual(
      new Set(TRIAGE_DISPOSITIONS),
    );
    for (const lead of [...demo, ...fixtures]) {
      expect(lead.intended.reasonCode).toBe(lead.scenario);
      expect(lead.intended.rationale.length).toBeGreaterThan(10);
    }
  });

  it("labels B2B leads by the score rule", () => {
    for (const lead of [...demoLeads(7), ...evalFixtures(7)]) {
      if (lead.vertical !== "b2b_saas") continue;
      expect(lead.qualification?.score).toBeTypeOf("number");
      if (["qualified", "nurture", "auto_dq_score"].includes(lead.scenario)) {
        expect(saasScenarioFromAnswers(lead.answers)).toBe(lead.scenario);
      }
    }
  });

  it("gives the no-show and partial-refund cases a sales outcome", () => {
    const outcome = (s: string) => fixtures.find((l) => l.scenario === s)?.intended.salesOutcome;
    expect(outcome("no_show")).toMatchObject({ meetingBooked: true, showed: false, won: false });
    const refund = outcome("partial_refund");
    expect(refund?.won).toBe(true);
    expect(refund?.refundedCents).toBeGreaterThan(0);
    expect(refund?.refundedCents).toBeLessThan(refund?.wonValueCents ?? 0);
    expect(fixtures.find((l) => l.scenario === "partial_refund")?.intended.correction).toBe(
      "restate",
    );
  });

  it("points each duplicate at an earlier lead by the same person, with another email", () => {
    for (const set of [demo, fixtures]) {
      const dups = set.filter((l) => l.scenario === "duplicate");
      expect(dups.length).toBeGreaterThan(0);
      for (const dup of dups) {
        const original = set.find((l) => l.key === dup.duplicateOfKey) as SyntheticLead;
        expect(original.person.firstName).toBe(dup.person.firstName);
        expect(original.person.lastName).toBe(dup.person.lastName);
        expect(original.person.email).not.toBe(dup.person.email);
        expect(original.submittedAt.utc < dup.submittedAt.utc).toBe(true);
      }
    }
  });

  it("includes a subsidiary and a duplicate company record", () => {
    const eval1 = fixtures[0];
    const eval2 = fixtures[1];
    expect(eval1?.company?.parentKey).toBe("kestrel-group");
    expect(eval2?.company?.duplicateOfKey).toBe(eval1?.company?.key);
  });

  it("never reveals the scenario in a key (keys reach HubSpot)", () => {
    for (const lead of [...demo, ...fixtures]) {
      expect(lead.key).toMatch(/^s42-(demo|eval)-\d{2}$/);
    }
  });
});

describe("time zones", () => {
  const fixtures = evalFixtures(42);

  it("stamps leads in Asia/Karachi, the Ads account in America/New_York, reports in UTC", () => {
    for (const lead of [...demoLeads(42), ...fixtures]) {
      expect(lead.submittedAt.site.timeZone).toBe("Asia/Karachi");
      expect(lead.submittedAt.site.local).toMatch(/\+05:00$/);
      expect(lead.submittedAt.adsAccount.timeZone).toBe("America/New_York");
      expect(lead.submittedAt.adsAccount.local).toMatch(/-0[45]:00$/);
      expect(lead.submittedAt.reportDate).toBe(lead.submittedAt.utc.slice(0, 10));
      if (lead.click) expect(lead.click.clickedAt.utc <= lead.submittedAt.utc).toBe(true);
    }
  });

  it("pins the date-boundary traps in the eval set", () => {
    const sub = fixtures.map((l) => l.submittedAt);
    expect(sub.some((t) => t.site.date !== t.reportDate)).toBe(true);
    expect(sub.some((t) => t.adsAccount.date !== t.reportDate)).toBe(true);
    expect(sub.some((t) => t.site.local.includes("T00:00:00"))).toBe(true);
    // 01:30 happens twice in New York on 2026-11-01 (EDT, then EST).
    const clicks = fixtures.flatMap((l) => (l.click ? [l.click.clickedAt.adsAccount.local] : []));
    expect(clicks).toContain("2026-11-01T01:30:00-04:00");
    expect(clicks).toContain("2026-11-01T01:30:00-05:00");
  });

  it("puts demo leads on both sides of the US DST change", () => {
    const offsets = new Set(demoLeads(42).map((l) => l.submittedAt.adsAccount.local.slice(-6)));
    expect(offsets).toEqual(new Set(["-04:00", "-05:00"]));
  });
});

describe("click IDs", () => {
  it("carry the channel's own click ID only, labelled synthetic, in the landing URL", () => {
    for (const lead of all(42)) {
      const click = lead.click;
      if (!click) continue;
      const ids = { gclid: click.gclid, fbclid: click.fbclid, msclkid: click.msclkid };
      const expected = { google: "gclid", meta: "fbclid", microsoft: "msclkid" }[click.channel];
      for (const [name, value] of Object.entries(ids)) {
        expect(value !== null, `${lead.key} ${name}`).toBe(name === expected);
      }
      if (click.gclid) expect(click.gclid).toMatch(/^synthetic-gclid-[0-9a-f]{24}$/);
      if (click.fbclid) {
        expect(click.fbc).toBe(`fb.1.${Date.parse(click.clickedAt.utc)}.${click.fbclid}`);
        expect(click.fbp).toMatch(/^fb\.1\.\d{13}\.\d{10}$/);
      }
      if (click.msclkid) expect(click.msclkid).toMatch(/^[0-9a-f]{32}$/);
      const url = new URL(click.landingUrl);
      expect(url.searchParams.get(expected)).toBe(ids[expected as keyof typeof ids]);
    }
  });
});
