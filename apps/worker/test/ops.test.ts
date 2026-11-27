import { describe, expect, it } from "vitest";
import { parseSweepArgs } from "../src/ops/sweep.ts";

describe("ops sweep arguments", () => {
  it("requires --once and defaults the budget to 240 s", () => {
    expect(parseSweepArgs(["--once"])).toEqual({ budgetSeconds: 240 });
    expect(parseSweepArgs(["--once", "--budget", "30"])).toEqual({ budgetSeconds: 30 });
    expect(() => parseSweepArgs([])).toThrow(/--once/);
  });

  it("rejects a bad budget and unknown flags", () => {
    expect(() => parseSweepArgs(["--once", "--budget", "0"])).toThrow(/--budget/);
    expect(() => parseSweepArgs(["--once", "--budget", "1.5"])).toThrow(/--budget/);
    expect(() => parseSweepArgs(["--once", "--loop"])).toThrow();
    expect(() => parseSweepArgs(["--once", "extra"])).toThrow(/unexpected/);
  });
});
