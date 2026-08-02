import { describe, expect, test } from "bun:test";
import { isRich, shouldDeplete } from "../../src/ontology/status";

describe("isRich", () => {
  test("three facts on one day is rich", () => {
    expect(isRich({ factCount: 3, distinctDays: 1 })).toBe(true);
  });

  test("two facts across two days is rich", () => {
    // Returning to a subject on a second day is itself evidence of depth.
    expect(isRich({ factCount: 2, distinctDays: 2 })).toBe(true);
  });

  test("one fact is thin", () => {
    expect(isRich({ factCount: 1, distinctDays: 1 })).toBe(false);
  });

  test("two facts same day is thin", () => {
    expect(isRich({ factCount: 2, distinctDays: 1 })).toBe(false);
  });
});

describe("shouldDeplete", () => {
  // Live medians at design time: 306 (a) and 377 (b). The rule is relative
  // because no real answer has ever been under 84 chars, so any absolute
  // threshold below that is dead code.
  test("two short answers against the person's median depletes", () => {
    expect(
      shouldDeplete({ timesAsked: 2, avgYieldChars: 84, personMedianChars: 306, depletionRatio: 0.5, depletionMinAskings: 2 }),
    ).toBe(true);
  });

  test("a normal-length answer never depletes", () => {
    expect(
      shouldDeplete({ timesAsked: 2, avgYieldChars: 342, personMedianChars: 377, depletionRatio: 0.5, depletionMinAskings: 2 }),
    ).toBe(false);
  });

  test("one asking is never enough, however short", () => {
    // A single shy answer is not evidence the well is dry.
    expect(
      shouldDeplete({ timesAsked: 1, avgYieldChars: 20, personMedianChars: 306, depletionRatio: 0.5, depletionMinAskings: 2 }),
    ).toBe(false);
  });

  test("null yield never depletes", () => {
    expect(
      shouldDeplete({ timesAsked: 3, avgYieldChars: null, personMedianChars: 306, depletionRatio: 0.5, depletionMinAskings: 2 }),
    ).toBe(false);
  });
});

// shouldClose and reopensOnFact are deleted along with their tests: the
// 2026-08-02 synthesis design drops nodes.status (budget replaces
// open/depleted/closed), and both functions lost their only caller
// (ledgerOntology.ts) in the same rebuild.
