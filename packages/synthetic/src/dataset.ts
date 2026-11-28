import { createHash } from "node:crypto";
import { COMPANIES, SITES, type SyntheticCompany, type SyntheticSite } from "./catalog.ts";
import { demoLeads, evalFixtures, type SyntheticLead } from "./leads.ts";
import { ADS_ACCOUNT_TIME_ZONE, LEAD_TIME_ZONE, REPORT_TIME_ZONE } from "./time.ts";

/** Bump when a change to the generator is meant to change its output (the golden-hash test pins it). */
export const SYNTHETIC_VERSION = 3;

export interface SyntheticDataset {
  version: number;
  seed: number;
  timeZones: { leads: string; adsAccount: string; reports: string };
  sites: readonly SyntheticSite[];
  companies: readonly SyntheticCompany[];
  /** 20 leads for the `demo` HubSpot account. */
  demo: SyntheticLead[];
  /** 10 fixture leads for the `eval` HubSpot account. */
  eval: SyntheticLead[];
}

export function generateDataset(seed: number): SyntheticDataset {
  return {
    version: SYNTHETIC_VERSION,
    seed,
    timeZones: {
      leads: LEAD_TIME_ZONE,
      adsAccount: ADS_ACCOUNT_TIME_ZONE,
      reports: REPORT_TIME_ZONE,
    },
    sites: SITES,
    companies: COMPANIES,
    demo: demoLeads(seed),
    eval: evalFixtures(seed),
  };
}

/** Canonical JSON: same seed, same bytes. */
export function serializeDataset(dataset: SyntheticDataset): string {
  return `${JSON.stringify(dataset, null, 2)}\n`;
}

export function datasetHash(dataset: SyntheticDataset): string {
  return createHash("sha256").update(serializeDataset(dataset)).digest("hex");
}
