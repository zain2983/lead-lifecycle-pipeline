import { demoLeads, evalFixtures, type SyntheticLead } from "@repo/synthetic";
import type { ContactInput } from "./contacts.ts";

/** The two HubSpot developer test accounts. */
export const ACCOUNTS = ["demo", "eval"] as const;
export type Account = (typeof ACCOUNTS)[number];

/**
 * Properties the seed never writes, because something else owns them: the approved triage result (the
 * agent, after a person approves), and the stages a person or the sales simulator moves forward. Leaving
 * them out is what keeps a re-seed from undoing later work, and keeps "a second run changes nothing" true
 * after Phase 5 has written dispositions.
 */
export const SEED_NEVER_WRITES = [
  "triage_disposition",
  "triage_confidence",
  "lifecyclestage",
  "hs_lead_status",
] as const;

/** HubSpot's own contact properties the seed fills (standard, present in every account). */
export const HUBSPOT_DEFAULT_PROPERTIES = [
  "email",
  "firstname",
  "lastname",
  "phone",
  "company",
  "jobtitle",
  "city",
  "country",
  "message",
] as const;

/** One synthetic lead as HubSpot contact properties. Empty values are left out, never sent as "". */
export function contactPropertiesFor(lead: SyntheticLead): Record<string, string> {
  const { person, click, consent } = lead;
  const values: Record<string, string | null | undefined> = {
    firstname: person.firstName,
    lastname: person.lastName,
    phone: person.phone,
    company: lead.company?.name,
    jobtitle: person.jobTitle,
    city: person.city,
    country: person.country,
    message: lead.message,
    attribution_session_id: lead.sessionId,
    click_gclid: click?.gclid,
    click_fbclid: click?.fbclid,
    click_fbc: click?.fbc,
    click_fbp: click?.fbp,
    click_msclkid: click?.msclkid,
    consent_ad_user_data: consent.adUserData,
    consent_ad_personalization: consent.adPersonalization,
    consent_gpc: consent.gpc ? "true" : "false",
    fixture_key: lead.key,
  };
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value !== null && value !== undefined && value !== "") out[name] = value;
  }
  return out;
}

/** The leads an account gets: 20 demo leads, or the 10 eval fixtures. */
export function leadsFor(account: Account, seed: number): SyntheticLead[] {
  return account === "demo" ? demoLeads(seed) : evalFixtures(seed);
}

export function seedInputs(account: Account, seed: number): ContactInput[] {
  return leadsFor(account, seed).map((lead) => ({
    email: lead.person.email,
    properties: contactPropertiesFor(lead),
    label: lead.key,
  }));
}
