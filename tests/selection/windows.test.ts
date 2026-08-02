import { describe, expect, test } from "bun:test";
import {
  daysSince,
  nodeWindowsPass,
  subtractDays,
  w1Settling,
  w2SubjectCooldown,
  w3DomainCooldown,
  w4FamilyCooldown,
  w5ExploitRunCap,
} from "../../src/selection/windows";
import type { AskRow, SelectableNode, SelectionConstants } from "../../src/selection/types";

const CONSTANTS: SelectionConstants = {
  settlingDays: 2,
  subjectCooldownDays: 14,
  domainCooldownDays: 4,
  familyCooldownDays: 7,
  tokenWindowDays: 3,
  exploitRunCap: 2,
  budgetCap: 3,
  candidateDepth: 8,
  seedReuseDays: 90,
  anchorMinSharedWords: 1,
};

function node(overrides: Partial<SelectableNode> = {}): SelectableNode {
  return {
    id: 1,
    person: "a",
    domain: "hobbies-interests",
    family: "play",
    subdomain: "guitar",
    summary: "learning guitar",
    budget: 3,
    lastAsked: null,
    timesAsked: 0,
    createdAt: "2026-07-01",
    newestFactDate: null,
    newestUnresolvedThreadDate: null,
    ...overrides,
  };
}

function ask(overrides: Partial<AskRow> = {}): AskRow {
  return {
    id: 1,
    date: "2026-07-20",
    person: "a",
    targetNodeId: null,
    askDomain: null,
    askFamily: null,
    lane: "exploit",
    seedId: null,
    ...overrides,
  };
}

describe("daysSince / subtractDays", () => {
  test("signed: future dates are negative, never abs", () => {
    expect(daysSince("2026-08-01", "2026-07-30")).toBe(2);
    expect(daysSince("2026-08-01", "2026-08-03")).toBe(-2);
    expect(daysSince("2026-08-01", "2026-08-01")).toBe(0);
  });

  test("subtractDays rolls across month boundaries", () => {
    expect(subtractDays("2026-08-01", 3)).toBe("2026-07-29");
  });
});

describe("W1 settling", () => {
  test("blocks within settlingDays, inclusive", () => {
    const n = node({ newestFactDate: "2026-07-29" });
    expect(w1Settling(n, "2026-07-31", 2)).toBe(true); // exactly 2 days
    expect(w1Settling(n, "2026-08-01", 2)).toBe(false); // 3 days: unfrozen
  });

  test("no facts at all never blocks", () => {
    expect(w1Settling(node({ newestFactDate: null }), "2026-08-01", 2)).toBe(false);
  });

  test("vetoes alone: everything else clean, W1 alone still blocks", () => {
    const n = node({ newestFactDate: "2026-08-01", lastAsked: null, family: null });
    expect(nodeWindowsPass(n, "2026-08-01", [], CONSTANTS)).toBe(false);
  });
});

describe("W2 subject cooldown", () => {
  test("blocks within subjectCooldownDays, inclusive", () => {
    const n = node({ lastAsked: "2026-07-18" }); // 14 days before 2026-08-01
    expect(w2SubjectCooldown(n, "2026-08-01", 14)).toBe(true);
    expect(w2SubjectCooldown(n, "2026-08-02", 14)).toBe(false);
  });

  test("never asked never blocks", () => {
    expect(w2SubjectCooldown(node({ lastAsked: null }), "2026-08-01", 14)).toBe(false);
  });

  test("vetoes alone", () => {
    const n = node({ lastAsked: "2026-08-01", family: null });
    expect(nodeWindowsPass(n, "2026-08-01", [], CONSTANTS)).toBe(false);
  });
});

describe("W3 domain cooldown", () => {
  test("blocks when this person used the domain within domainCooldownDays", () => {
    const asks = [ask({ person: "a", askDomain: "hobbies-interests", date: "2026-07-30" })];
    expect(w3DomainCooldown("hobbies-interests", "a", "2026-08-01", asks, 4)).toBe(true);
    expect(w3DomainCooldown("hobbies-interests", "a", "2026-08-05", asks, 4)).toBe(false);
  });

  test("does not cross people", () => {
    const asks = [ask({ person: "b", askDomain: "hobbies-interests", date: "2026-07-30" })];
    expect(w3DomainCooldown("hobbies-interests", "a", "2026-08-01", asks, 4)).toBe(false);
  });

  test("vetoes alone", () => {
    const asks = [ask({ person: "a", askDomain: "hobbies-interests", date: "2026-08-01" })];
    const n = node({ family: null });
    expect(nodeWindowsPass(n, "2026-08-01", asks, CONSTANTS)).toBe(false);
  });
});

describe("W4 family cooldown", () => {
  test("blocks when this person used the family within familyCooldownDays", () => {
    const asks = [ask({ person: "a", askFamily: "play", date: "2026-07-28" })];
    expect(w4FamilyCooldown("play", "a", "2026-08-01", asks, 7)).toBe(true);
    expect(w4FamilyCooldown("play", "a", "2026-08-05", asks, 7)).toBe(false);
  });

  test("null family passes and never sets: it never blocks", () => {
    expect(w4FamilyCooldown(null, "a", "2026-08-01", [], 7)).toBe(false);
  });

  test("null family never sets the cooldown for anyone else", () => {
    const asks = [ask({ person: "a", askFamily: null, date: "2026-08-01" })];
    expect(w4FamilyCooldown("play", "a", "2026-08-01", asks, 7)).toBe(false);
  });

  test("vetoes alone", () => {
    const asks = [ask({ person: "a", askFamily: "play", date: "2026-08-01" })];
    const n = node();
    expect(nodeWindowsPass(n, "2026-08-01", asks, CONSTANTS)).toBe(false);
  });
});

describe("W5 exploit run cap", () => {
  test("blocks after exploitRunCap consecutive lane-bearing followup/exploit asks", () => {
    const asks = [
      ask({ id: 1, person: "a", lane: "exploit", date: "2026-07-30" }),
      ask({ id: 2, person: "a", lane: "followup", date: "2026-07-31" }),
    ];
    expect(w5ExploitRunCap("a", "2026-08-01", asks, 2)).toBe(true);
  });

  test("does not block when fewer than exploitRunCap asks exist", () => {
    const asks = [ask({ id: 1, person: "a", lane: "exploit", date: "2026-07-31" })];
    expect(w5ExploitRunCap("a", "2026-08-01", asks, 2)).toBe(false);
  });

  test("does not block when an explore day breaks the run", () => {
    const asks = [
      ask({ id: 1, person: "a", lane: "explore", date: "2026-07-30" }),
      ask({ id: 2, person: "a", lane: "exploit", date: "2026-07-31" }),
    ];
    expect(w5ExploitRunCap("a", "2026-08-01", asks, 2)).toBe(false);
  });

  test("fallback/null-lane days are invisible: skipped days don't break or extend a run", () => {
    // Two real exploit days, one lane-null (fallback) day in between: the
    // null day must not count as the "break" that resets the run, so the
    // two real exploit days are still seen as adjacent for the cap.
    const asks = [
      ask({ id: 1, person: "a", lane: "exploit", date: "2026-07-29" }),
      ask({ id: 2, person: "a", lane: null, date: "2026-07-30" }),
      ask({ id: 3, person: "a", lane: "exploit", date: "2026-07-31" }),
    ];
    expect(w5ExploitRunCap("a", "2026-08-01", asks, 2)).toBe(true);
  });

  test("does not cross people", () => {
    const asks = [
      ask({ id: 1, person: "b", lane: "exploit", date: "2026-07-30" }),
      ask({ id: 2, person: "b", lane: "followup", date: "2026-07-31" }),
    ];
    expect(w5ExploitRunCap("a", "2026-08-01", asks, 2)).toBe(false);
  });

  test("vetoes alone", () => {
    const asks = [
      ask({ id: 1, person: "a", lane: "exploit", date: "2026-07-30" }),
      ask({ id: 2, person: "a", lane: "followup", date: "2026-07-31" }),
    ];
    const n = node({ family: null });
    expect(nodeWindowsPass(n, "2026-08-01", asks, CONSTANTS)).toBe(false);
  });
});

describe("nodeWindowsPass composition", () => {
  test("passes when nothing vetoes", () => {
    const n = node({ newestFactDate: "2026-07-01", lastAsked: "2026-07-01", family: null });
    expect(nodeWindowsPass(n, "2026-08-01", [], CONSTANTS)).toBe(true);
  });
});
