import type { TRIAGE_DISPOSITION_VALUES } from "./properties.ts";

/**
 * DRAFT (PLAN Phase 3.5). HubSpot stage and disposition changes → conversion action, primary or
 * secondary. Phase 8.2 (`docs/signal-design.md`) replaces this table; nothing sends conversions before
 * Part C, so no code consumes it yet except its tests.
 *
 * The rules that are not draft, because the plan fixes them:
 * - **The agent never sets a primary action.** `triage_disposition` is written only by the approved triage
 *   proposal, so it maps to a secondary action at most, whoever HubSpot says made the change.
 * - **Primary = a sales outcome a person recorded.** A rule marked primary applies only when
 *   `changeSource` is one of `PERSON_CHANGE_SOURCES`. Anything else (our integration, an API key, a
 *   workflow, an import, or no `changeSource` at all) gets no action: the table fails closed.
 * - Confirmed spam and duplicates are correction candidates (Phase 12), never conversions.
 *
 * UNVERIFIED (live check pending): HubSpot's `changeSource` values. The webhooks guide lists the field
 * but no complete set; `CRM_UI` appears in its examples. The names below are the ones HubSpot's property
 * history uses for people in the UI and mobile apps. The demo's sales simulator writes through the API,
 * so Phase 8.2 must decide how its writes count as "a person" (for example a dedicated credential whose
 * `sourceId` is listed here); until then they never map to a primary action.
 */
export const CONVERSION_MAPPING_STATUS = "draft" as const;

export const PERSON_CHANGE_SOURCES = [
  "CRM_UI",
  "CRM_UI_BULK_ACTION",
  "MOBILE_IOS",
  "MOBILE_ANDROID",
] as const;

export type ConversionTier = "primary" | "secondary";

/** Our names for the actions (Phase 8.2 finalises them, with values, currency and windows). */
export type ConversionAction = "mql" | "sql_accepted" | "showed" | "closed_won";

export type MappingOutcome =
  | { type: "conversion"; action: ConversionAction; tier: ConversionTier }
  | { type: "correction_candidate"; reason: "spam" | "duplicate" }
  | { type: "none"; reason: string };

export interface MappingRule {
  objectType: "contact" | "deal";
  propertyName: string;
  value: string;
  outcome: MappingOutcome;
  /** Who may trigger it. `agent` rules can never be primary (a test checks the table). */
  setBy: "agent" | "person";
}

const disposition = (
  value: (typeof TRIAGE_DISPOSITION_VALUES)[number],
  outcome: MappingOutcome,
): MappingRule => ({
  objectType: "contact",
  propertyName: "triage_disposition",
  value,
  outcome,
  setBy: "agent",
});

export const CONVERSION_MAPPING: readonly MappingRule[] = [
  // The agent's approved disposition: secondary at most.
  disposition("qualified", { type: "conversion", action: "mql", tier: "secondary" }),
  disposition("nurture", { type: "none", reason: "nurture is not a conversion" }),
  disposition("spam", { type: "correction_candidate", reason: "spam" }),
  disposition("duplicate", { type: "correction_candidate", reason: "duplicate" }),
  disposition("needs_review", { type: "none", reason: "waiting for a person" }),
  // A person moving the lifecycle stage.
  {
    objectType: "contact",
    propertyName: "lifecyclestage",
    value: "marketingqualifiedlead",
    outcome: { type: "conversion", action: "mql", tier: "secondary" },
    setBy: "person",
  },
  {
    objectType: "contact",
    propertyName: "lifecyclestage",
    value: "salesqualifiedlead",
    outcome: { type: "conversion", action: "sql_accepted", tier: "primary" },
    setBy: "person",
  },
  // HubSpot's default deal pipeline. "Showed" has no default stage: Phase 8.2 picks one (a custom stage
  // or a meeting outcome), so it is not mapped yet.
  {
    objectType: "deal",
    propertyName: "dealstage",
    value: "closedwon",
    outcome: { type: "conversion", action: "closed_won", tier: "primary" },
    setBy: "person",
  },
];

export interface CrmChange {
  /** From the webhook's `subscriptionType` (`contact.propertyChange` → contact). */
  objectType: "contact" | "deal";
  propertyName: string;
  propertyValue: string;
  changeSource?: string | null;
}

export function isPersonChange(changeSource: string | null | undefined): boolean {
  return (PERSON_CHANGE_SOURCES as readonly string[]).includes(changeSource ?? "");
}

/** What one property change means for conversions (draft; see the top of this file). */
export function mapCrmChange(change: CrmChange): MappingOutcome {
  const rule = CONVERSION_MAPPING.find(
    (candidate) =>
      candidate.objectType === change.objectType &&
      candidate.propertyName === change.propertyName &&
      candidate.value === change.propertyValue,
  );
  if (!rule) return { type: "none", reason: "no rule for this change" };
  const { outcome } = rule;
  if (outcome.type !== "conversion" || outcome.tier !== "primary") return outcome;
  if (rule.setBy === "agent") {
    // Unreachable while the table passes its test; kept so a bad edit fails closed too.
    return { type: "none", reason: "the agent never sets a primary action" };
  }
  if (!isPersonChange(change.changeSource)) {
    return {
      type: "none",
      reason: `a primary action needs a person's change (changeSource ${change.changeSource ?? "missing"})`,
    };
  }
  return outcome;
}
