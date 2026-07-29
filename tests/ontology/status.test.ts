import { describe, expect, test } from "bun:test";
import { isRich, shouldDeplete, shouldClose, reopensOnFact } from "../../src/ontology/status";

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

describe("shouldClose", () => {
  // The psychic-party regression: the follow-up must be asked AND answered
  // before the event node closes, and its facts live on in other nodes.
  test("event passed but follow-up not yet asked stays open", () => {
    expect(shouldClose({ eventDate: "2026-07-26", today: "2026-07-27", followUpAsked: false, followUpAnswered: false })).toBe(false);
  });

  test("follow-up asked but unanswered stays open", () => {
    expect(shouldClose({ eventDate: "2026-07-26", today: "2026-07-27", followUpAsked: true, followUpAnswered: false })).toBe(false);
  });

  test("event passed, follow-up asked and answered closes", () => {
    expect(shouldClose({ eventDate: "2026-07-26", today: "2026-07-28", followUpAsked: true, followUpAnswered: true })).toBe(true);
  });

  test("no event date never closes", () => {
    expect(shouldClose({ eventDate: null, today: "2026-07-28", followUpAsked: true, followUpAnswered: true })).toBe(false);
  });

  test("future event never closes", () => {
    expect(shouldClose({ eventDate: "2026-08-15", today: "2026-07-28", followUpAsked: false, followUpAnswered: false })).toBe(false);
  });
});

describe("reopensOnFact", () => {
  test("a new fact reopens a depleted node", () => {
    // Depletion is a claim about the past; new evidence beats it.
    expect(reopensOnFact("depleted")).toBe(true);
  });

  test("a new fact reopens a closed node", () => {
    expect(reopensOnFact("closed")).toBe(true);
  });

  test("an open node stays open", () => {
    expect(reopensOnFact("open")).toBe(false);
  });
});
