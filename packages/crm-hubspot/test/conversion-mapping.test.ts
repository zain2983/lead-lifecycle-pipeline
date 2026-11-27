import { describe, expect, it } from "vitest";
import {
  CONVERSION_MAPPING,
  CONVERSION_MAPPING_STATUS,
  mapCrmChange,
  PERSON_CHANGE_SOURCES,
} from "../src/conversion-mapping.ts";
import { TRIAGE_DISPOSITION_VALUES } from "../src/properties.ts";

/** Every changeSource we can think of, including ones a person uses, plus none at all. */
const CHANGE_SOURCES = [
  ...PERSON_CHANGE_SOURCES,
  "INTEGRATION",
  "API",
  "WORKFLOWS",
  "IMPORT",
  "AUTOMATION_PLATFORM",
  "SALES",
  "",
  undefined,
];

describe("conversion mapping (draft until Phase 8.2)", () => {
  it("says it is a draft", () => {
    expect(CONVERSION_MAPPING_STATUS).toBe("draft");
  });

  it("never maps the agent's disposition to a primary action, whoever HubSpot says changed it", () => {
    for (const value of TRIAGE_DISPOSITION_VALUES) {
      for (const changeSource of CHANGE_SOURCES) {
        const outcome = mapCrmChange({
          objectType: "contact",
          propertyName: "triage_disposition",
          propertyValue: value,
          changeSource,
        });
        expect(
          outcome.type === "conversion" && outcome.tier === "primary",
          `${value} via ${changeSource}`,
        ).toBe(false);
      }
    }
    // And in the table itself: no agent rule is primary.
    for (const rule of CONVERSION_MAPPING.filter((r) => r.setBy === "agent")) {
      expect(rule.outcome.type === "conversion" && rule.outcome.tier, rule.value).not.toBe(
        "primary",
      );
    }
    expect(CONVERSION_MAPPING.filter((r) => r.propertyName === "triage_disposition")).toHaveLength(
      TRIAGE_DISPOSITION_VALUES.length,
    );
    expect(
      CONVERSION_MAPPING.filter((r) => r.propertyName === "triage_disposition").every(
        (r) => r.setBy === "agent",
      ),
    ).toBe(true);
  });

  it("maps an approved 'qualified' to a secondary MQL, and spam or duplicate to correction candidates", () => {
    const disposition = (propertyValue: string) =>
      mapCrmChange({
        objectType: "contact",
        propertyName: "triage_disposition",
        propertyValue,
        changeSource: "INTEGRATION",
      });
    expect(disposition("qualified")).toEqual({
      type: "conversion",
      action: "mql",
      tier: "secondary",
    });
    expect(disposition("spam")).toEqual({ type: "correction_candidate", reason: "spam" });
    expect(disposition("duplicate")).toEqual({ type: "correction_candidate", reason: "duplicate" });
    expect(disposition("nurture").type).toBe("none");
  });

  it("gives a primary action only for a person's change, and fails closed otherwise", () => {
    const sql = (changeSource?: string) =>
      mapCrmChange({
        objectType: "contact",
        propertyName: "lifecyclestage",
        propertyValue: "salesqualifiedlead",
        changeSource,
      });
    expect(sql("CRM_UI")).toEqual({ type: "conversion", action: "sql_accepted", tier: "primary" });
    // Our integration (an agent-approved lifecycle move), an API key, a workflow, or nothing at all.
    for (const source of ["INTEGRATION", "API", "WORKFLOWS", undefined]) {
      expect(sql(source).type, String(source)).toBe("none");
    }
    expect(
      mapCrmChange({
        objectType: "deal",
        propertyName: "dealstage",
        propertyValue: "closedwon",
        changeSource: "CRM_UI",
      }),
    ).toEqual({ type: "conversion", action: "closed_won", tier: "primary" });
  });

  it("maps nothing it has no rule for", () => {
    expect(
      mapCrmChange({
        objectType: "contact",
        propertyName: "hs_lead_status",
        propertyValue: "IN_PROGRESS",
        changeSource: "CRM_UI",
      }),
    ).toEqual({ type: "none", reason: "no rule for this change" });
  });
});
