// Fixed, fictional reference data. Every name here is invented for this repo, and every domain is
// reserved (RFC 2606): `<name>.example.com` for companies and sites, example.com / example.org / example.net
// for personal and bulk mail. Not `*.test` (RFC 6761): HubSpot rejects those emails as INVALID_EMAIL
// (live seed, 2026-11-28), so a test fails on any email outside example.com/org/net. Matching a company by
// domain must treat `example.com` as the suffix, the way a real matcher treats `.com`.
import { LEAD_TIME_ZONE } from "./time.ts";

export const VERTICALS = ["b2b_saas", "rehab", "clinic", "local_services"] as const;
export type Vertical = (typeof VERTICALS)[number];

export interface SyntheticSite {
  key: string;
  name: string;
  domain: string;
  vertical: Vertical;
  timeZone: string;
  /** Sensitive vertical: no health words in notes, Limited Data Use, no userData to ad platforms. */
  sensitive: boolean;
  /** Gets a demo site in Phase 9. The other verticals exist only as fixtures. */
  demoSite: boolean;
  /** Areas the business serves; a lead from anywhere else is out of area. Empty: no area rule. */
  serviceArea: readonly string[];
}

const KARACHI_AREAS = ["Clifton", "DHA", "Gulshan-e-Iqbal", "PECHS", "Saddar", "North Nazimabad"];

export const SITES: readonly SyntheticSite[] = [
  {
    key: "saas",
    name: "Quillmark",
    domain: "quillmark.example.com",
    vertical: "b2b_saas",
    timeZone: LEAD_TIME_ZONE,
    sensitive: false,
    demoSite: true,
    serviceArea: [],
  },
  {
    key: "rehab",
    name: "Harborlight Recovery",
    domain: "harborlight.example.com",
    vertical: "rehab",
    timeZone: LEAD_TIME_ZONE,
    sensitive: true,
    demoSite: true,
    serviceArea: [],
  },
  {
    key: "clinic",
    name: "Fernway Family Clinic",
    domain: "fernway-clinic.example.com",
    vertical: "clinic",
    timeZone: LEAD_TIME_ZONE,
    sensitive: false,
    demoSite: false,
    serviceArea: KARACHI_AREAS,
  },
  {
    key: "local_services",
    name: "Tidewell Home Services",
    domain: "tidewell.example.com",
    vertical: "local_services",
    timeZone: LEAD_TIME_ZONE,
    sensitive: false,
    demoSite: false,
    serviceArea: KARACHI_AREAS,
  },
];

export function siteByKey(key: string): SyntheticSite {
  const site = SITES.find((s) => s.key === key);
  if (!site) throw new Error(`unknown site ${key}`);
  return site;
}

export const COMPANY_SIZES = ["1-10", "11-50", "51-200", "201-1000", "1000+"] as const;
export type CompanySize = (typeof COMPANY_SIZES)[number];

export interface SyntheticCompany {
  key: string;
  name: string;
  domain: string;
  size: CompanySize;
  city: string;
  country: string;
  /** Set on a subsidiary: the parent company's key. */
  parentKey: string | null;
  /** Set on a duplicate record of the same real-world company (another spelling or domain). */
  duplicateOfKey: string | null;
}

export const COMPANIES: readonly SyntheticCompany[] = [
  {
    key: "kestrel-group",
    name: "Kestrel Group",
    domain: "kestrelgroup.example.com",
    size: "1000+",
    city: "Karachi",
    country: "Pakistan",
    parentKey: null,
    duplicateOfKey: null,
  },
  {
    key: "kestrel-freight",
    name: "Kestrel Freight",
    domain: "kestrelfreight.example.com",
    size: "201-1000",
    city: "Karachi",
    country: "Pakistan",
    parentKey: "kestrel-group",
    duplicateOfKey: null,
  },
  {
    key: "kestrel-freight-ltd",
    name: "Kestrel Freight Ltd.",
    domain: "kestrel-freight.example.com",
    size: "201-1000",
    city: "Karachi",
    country: "Pakistan",
    parentKey: "kestrel-group",
    duplicateOfKey: "kestrel-freight",
  },
  {
    key: "kestrel-cold-chain",
    name: "Kestrel Cold Chain",
    domain: "kestrelcoldchain.example.com",
    size: "51-200",
    city: "Lahore",
    country: "Pakistan",
    parentKey: "kestrel-group",
    duplicateOfKey: null,
  },
  {
    key: "saltmarsh-robotics",
    name: "Saltmarsh Robotics",
    domain: "saltmarsh.example.com",
    size: "201-1000",
    city: "Rotterdam",
    country: "Netherlands",
    parentKey: null,
    duplicateOfKey: null,
  },
  {
    key: "saltmarsh-robotics-pk",
    name: "Saltmarsh Robotics Pakistan",
    domain: "pk.saltmarsh.example.com",
    size: "11-50",
    city: "Karachi",
    country: "Pakistan",
    parentKey: "saltmarsh-robotics",
    duplicateOfKey: null,
  },
  {
    key: "bluefin-textiles",
    name: "Bluefin Textiles",
    domain: "bluefintextiles.example.com",
    size: "51-200",
    city: "Faisalabad",
    country: "Pakistan",
    parentKey: null,
    duplicateOfKey: null,
  },
  {
    key: "bluefin-textiles-pvt",
    name: "BLUEFIN TEXTILES (PVT) LTD",
    domain: "bluefintextiles.example.com",
    size: "51-200",
    city: "Faisalabad",
    country: "Pakistan",
    parentKey: null,
    duplicateOfKey: "bluefin-textiles",
  },
  {
    key: "indus-ledger",
    name: "Indus Ledger Works",
    domain: "indusledger.example.com",
    size: "11-50",
    city: "Karachi",
    country: "Pakistan",
    parentKey: null,
    duplicateOfKey: null,
  },
  {
    key: "margalla-data",
    name: "Margalla Data Systems",
    domain: "margalladata.example.com",
    size: "51-200",
    city: "Islamabad",
    country: "Pakistan",
    parentKey: null,
    duplicateOfKey: null,
  },
  {
    key: "cobalt-harbor",
    name: "Cobalt Harbor Logistics",
    domain: "cobaltharbor.example.com",
    size: "201-1000",
    city: "Dubai",
    country: "United Arab Emirates",
    parentKey: null,
    duplicateOfKey: null,
  },
  {
    key: "juniper-fold",
    name: "Juniper Fold Studio",
    domain: "juniperfold.example.com",
    size: "1-10",
    city: "Karachi",
    country: "Pakistan",
    parentKey: null,
    duplicateOfKey: null,
  },
];

export function companyByKey(key: string): SyntheticCompany {
  const company = COMPANIES.find((c) => c.key === key);
  if (!company) throw new Error(`unknown company ${key}`);
  return company;
}

/** Companies a qualified B2B lead may come from (not the duplicates, not the 1-10 studio). */
export const QUALIFIED_COMPANY_KEYS = [
  "kestrel-freight",
  "kestrel-cold-chain",
  "saltmarsh-robotics",
  "saltmarsh-robotics-pk",
  "bluefin-textiles",
  "indus-ledger",
  "margalla-data",
  "cobalt-harbor",
] as const;

export const FIRST_NAMES = [
  "Ayesha",
  "Bilal",
  "Hamza",
  "Fatima",
  "Zara",
  "Omar",
  "Sana",
  "Usman",
  "Hira",
  "Imran",
  "Maryam",
  "Danish",
  "Noor",
  "Faisal",
  "Amna",
  "Kamran",
  "Mehwish",
  "Saad",
  "Rabia",
  "Tariq",
  "Elena",
  "Marcus",
  "Priya",
  "Diego",
  "Hannah",
  "Kenji",
  "Lucia",
  "Samuel",
  "Ingrid",
  "Tomas",
] as const;

export const LAST_NAMES = [
  "Khan",
  "Siddiqui",
  "Qureshi",
  "Malik",
  "Sheikh",
  "Raza",
  "Hussain",
  "Mirza",
  "Abbasi",
  "Chaudhry",
  "Ahmed",
  "Iqbal",
  "Farooq",
  "Javed",
  "Rehman",
  "Novak",
  "Okafor",
  "Lindqvist",
  "Moreau",
  "Tanaka",
  "Alvarez",
  "Brennan",
] as const;

export const JOB_TITLES = [
  "Finance Manager",
  "Head of Finance",
  "Accounts Payable Lead",
  "Controller",
  "CFO",
  "Operations Director",
  "Financial Analyst",
] as const;

/** Stand-ins for personal mailbox providers (the "personal email domain" eval category). */
export const PERSONAL_EMAIL_DOMAINS = ["example.com", "example.org"] as const;
