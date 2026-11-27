// Seeded synthetic data. Synthetic only: no real people, no client data. Same seed, same bytes.
export {
  COMPANIES,
  COMPANY_SIZES,
  type CompanySize,
  companyByKey,
  PERSONAL_EMAIL_DOMAINS,
  SITES,
  type SyntheticCompany,
  type SyntheticSite,
  siteByKey,
  VERTICALS,
  type Vertical,
} from "./catalog.ts";
export {
  datasetHash,
  generateDataset,
  SYNTHETIC_VERSION,
  type SyntheticDataset,
  serializeDataset,
} from "./dataset.ts";
export {
  type Channel,
  type ConsentState,
  DEMO_WINDOW,
  demoLeads,
  evalFixtures,
  FICTIONAL_AREA_CODE,
  formatPhone,
  type LeadSet,
  type SyntheticClick,
  type SyntheticConsent,
  type SyntheticLead,
  type SyntheticPerson,
} from "./leads.ts";
export { createRng, type Rng } from "./random.ts";
export {
  AUTO_DQ_THRESHOLD,
  CORRECTIONS,
  type Correction,
  DISPOSITION_SCENARIOS,
  type IntendedLabel,
  intendedLabel,
  qualificationScore,
  type SalesOutcome,
  SCENARIOS,
  type Scenario,
  saasScenarioFromAnswers,
  TRIAGE_DISPOSITIONS,
  type TriageDisposition,
} from "./scenarios.ts";
export {
  ADS_ACCOUNT_TIME_ZONE,
  inZone,
  LEAD_TIME_ZONE,
  type LeadTimes,
  leadTimes,
  REPORT_TIME_ZONE,
  utcIso,
  type ZonedTime,
} from "./time.ts";
