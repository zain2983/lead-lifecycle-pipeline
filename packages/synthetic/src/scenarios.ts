/**
 * What each synthetic lead is, and the label a correct triage should give it. Phase 6 turns these into
 * eval cases, so the label is the *intended* one, decided here, never something a model produced.
 */

/** The triage agent's label set (same values as the Prisma enum and the HubSpot property). */
export const TRIAGE_DISPOSITIONS = [
  "qualified",
  "nurture",
  "spam",
  "duplicate",
  "needs_review",
] as const;
export type TriageDisposition = (typeof TRIAGE_DISPOSITIONS)[number];

/** PLAN Phase 2.2's disposition cases, plus the two plain outcomes every set needs. */
export const SCENARIOS = [
  "qualified",
  "nurture",
  "spam",
  "test",
  "duplicate",
  "out_of_area",
  "auto_dq_score",
  "no_show",
  "partial_refund",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** The seven disposition cases PLAN Phase 2.2 names. */
export const DISPOSITION_SCENARIOS = [
  "spam",
  "test",
  "duplicate",
  "out_of_area",
  "auto_dq_score",
  "no_show",
  "partial_refund",
] as const satisfies readonly Scenario[];

/** PLAN Phase 12's correction paths. Provisional here: Phase 12 finalises the mapping. */
export const CORRECTIONS = ["keep", "deeper", "restate", "retract", "hold"] as const;
export type Correction = (typeof CORRECTIONS)[number];

export interface SalesOutcome {
  sqlAccepted: boolean;
  meetingBooked: boolean;
  /** Null when no meeting was booked. */
  showed: boolean | null;
  won: boolean;
  currency: "USD";
  /** Integer minor units (cents). */
  wonValueCents: number | null;
  refundedCents: number | null;
}

export interface IntendedLabel {
  triageDisposition: TriageDisposition;
  /** Machine-readable reason, stable across versions (eval reports group by it). */
  reasonCode: Scenario;
  /** One line a reviewer can check against the lead. No health words (rehab leads use it too). */
  rationale: string;
  /** Provisional until Phase 12. */
  correction: Correction;
  /** Recorded later by a person (the sales simulator in the demo); null when nothing happens after triage. */
  salesOutcome: SalesOutcome | null;
}

const LABELS: Record<Scenario, Omit<IntendedLabel, "reasonCode" | "salesOutcome">> = {
  qualified: {
    triageDisposition: "qualified",
    rationale: "Fits the target profile and asked for a meeting or a quote.",
    correction: "keep",
  },
  nurture: {
    triageDisposition: "nurture",
    rationale: "A real prospect who is only exploring: no budget or timeline yet.",
    correction: "keep",
  },
  spam: {
    triageDisposition: "spam",
    rationale:
      "Unsolicited promotion, not a prospect. Instructions inside the message are ignored.",
    correction: "retract",
  },
  test: {
    triageDisposition: "spam",
    rationale:
      "An internal test submission. The label set has no 'test', and a test lead must never count as a lead.",
    correction: "retract",
  },
  duplicate: {
    triageDisposition: "duplicate",
    rationale: "The same person as an earlier lead (name and phone match; the email differs).",
    correction: "retract",
  },
  out_of_area: {
    triageDisposition: "needs_review",
    rationale: "Outside the service area. A person decides whether to refer it; never qualified.",
    correction: "hold",
  },
  auto_dq_score: {
    triageDisposition: "nurture",
    rationale: "The qualification score is below the auto-DQ threshold.",
    correction: "keep",
  },
  no_show: {
    triageDisposition: "qualified",
    rationale: "Qualified at triage; booked a meeting and then did not show.",
    correction: "keep",
  },
  partial_refund: {
    triageDisposition: "qualified",
    rationale: "Qualified at triage; won, then part of the payment was refunded.",
    correction: "restate",
  },
};

export function intendedLabel(
  scenario: Scenario,
  salesOutcome: SalesOutcome | null = null,
): IntendedLabel {
  const label = LABELS[scenario];
  return {
    triageDisposition: label.triageDisposition,
    reasonCode: scenario,
    rationale: label.rationale,
    correction: label.correction,
    salesOutcome,
  };
}

// --- B2B qualification score -------------------------------------------------------------------------

export const SAAS_ANSWERS = {
  companySize: ["1-10", "11-50", "51-200", "201-1000", "1000+"],
  budget: ["none", "under_1k", "1k_10k", "over_10k"],
  timeline: ["exploring", "this_quarter", "this_month"],
} as const;

const SIZE_POINTS: Record<string, number> = {
  "1-10": 0,
  "11-50": 15,
  "51-200": 25,
  "201-1000": 30,
  "1000+": 30,
};
const BUDGET_POINTS: Record<string, number> = { none: 0, under_1k: 5, "1k_10k": 20, over_10k: 30 };
const TIMELINE_POINTS: Record<string, number> = { exploring: 0, this_quarter: 20, this_month: 25 };

/** Below this, a B2B lead is auto-disqualified (`auto_dq_score`). */
export const AUTO_DQ_THRESHOLD = 25;

/** Deterministic score from the B2B form's answers (0–85). */
export function qualificationScore(answers: Readonly<Record<string, string>>): number {
  return (
    (SIZE_POINTS[answers.companySize ?? ""] ?? 0) +
    (BUDGET_POINTS[answers.budget ?? ""] ?? 0) +
    (TIMELINE_POINTS[answers.timeline ?? ""] ?? 0)
  );
}

/**
 * The rule the B2B labels follow: below the threshold → auto-DQ; otherwise still exploring → nurture;
 * otherwise qualified. Spam, test and duplicate leads are labelled by what they are, whatever they score.
 */
export function saasScenarioFromAnswers(
  answers: Readonly<Record<string, string>>,
): "auto_dq_score" | "nurture" | "qualified" {
  if (qualificationScore(answers) < AUTO_DQ_THRESHOLD) return "auto_dq_score";
  if (answers.timeline === "exploring") return "nurture";
  return "qualified";
}
