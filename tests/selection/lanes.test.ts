import { describe, expect, test } from "bun:test";
import { lane0Tokens, lane1Candidates, lane2Candidates } from "../../src/selection/lanes";
import type { AskRow, SeedRow, SelectableNode, SelectionConstants, TokenRow } from "../../src/selection/types";

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
    newestFactDate: "2026-06-01",
    newestUnresolvedThreadDate: null,
    ...overrides,
  };
}

function token(overrides: Partial<TokenRow> = {}): TokenRow {
  return { id: 1, nodeId: 1, eventDate: "2026-07-30", createdAt: "2026-07-30", spentAt: null, ...overrides };
}

describe("lane0Tokens", () => {
  test("eligible: unspent, event_date in [today - windowDays, today)", () => {
    const n = node({ id: 1, person: "a" });
    const nodesById = new Map([[1, n]]);
    const t = token({ nodeId: 1, eventDate: "2026-07-30" });
    expect(lane0Tokens([t], nodesById, "a", "2026-08-01", 3)).toEqual([t]);
  });

  test("excludes spent tokens", () => {
    const n = node({ id: 1, person: "a" });
    const nodesById = new Map([[1, n]]);
    const t = token({ nodeId: 1, eventDate: "2026-07-30", spentAt: "2026-07-30T12:00:00Z" });
    expect(lane0Tokens([t], nodesById, "a", "2026-08-01", 3)).toEqual([]);
  });

  test("excludes future events (signed, never abs)", () => {
    const n = node({ id: 1, person: "a" });
    const nodesById = new Map([[1, n]]);
    // event two days in the future: abs(diff) = 2 <= windowDays(3) would
    // wrongly fire this early under an unsigned comparison.
    const t = token({ nodeId: 1, eventDate: "2026-08-03" });
    expect(lane0Tokens([t], nodesById, "a", "2026-08-01", 3)).toEqual([]);
  });

  test("excludes today's own event date (half-open on the right)", () => {
    const n = node({ id: 1, person: "a" });
    const nodesById = new Map([[1, n]]);
    const t = token({ nodeId: 1, eventDate: "2026-08-01" });
    expect(lane0Tokens([t], nodesById, "a", "2026-08-01", 3)).toEqual([]);
  });

  test("excludes events older than the window", () => {
    const n = node({ id: 1, person: "a" });
    const nodesById = new Map([[1, n]]);
    const t = token({ nodeId: 1, eventDate: "2026-07-27" }); // 5 days before
    expect(lane0Tokens([t], nodesById, "a", "2026-08-01", 3)).toEqual([]);
  });

  test("filters to this person's own nodes only", () => {
    const nodesById = new Map([
      [1, node({ id: 1, person: "a" })],
      [2, node({ id: 2, person: "b" })],
    ]);
    const t = token({ nodeId: 2, eventDate: "2026-07-30" });
    expect(lane0Tokens([t], nodesById, "a", "2026-08-01", 3)).toEqual([]);
    expect(lane0Tokens([t], nodesById, "b", "2026-08-01", 3)).toEqual([t]);
  });

  test("orders oldest event first, then id", () => {
    const n = node({ id: 1, person: "a" });
    const nodesById = new Map([[1, n]]);
    const older = token({ id: 2, nodeId: 1, eventDate: "2026-07-29" });
    const newer = token({ id: 1, nodeId: 1, eventDate: "2026-07-31" });
    expect(lane0Tokens([newer, older], nodesById, "a", "2026-08-01", 3)).toEqual([older, newer]);
  });
});

describe("lane1Candidates", () => {
  test("excludes budget 0 or null", () => {
    const nodes = [node({ id: 1, budget: 0 }), node({ id: 2, budget: null }), node({ id: 3, budget: 1 })];
    const result = lane1Candidates(nodes, "a", "2026-08-01", [], CONSTANTS);
    expect(result.map((n) => n.id)).toEqual([3]);
  });

  test("excludes nodes that fail any window", () => {
    const nodes = [node({ id: 1, newestFactDate: "2026-08-01" })]; // W1 settling
    expect(lane1Candidates(nodes, "a", "2026-08-01", [], CONSTANTS)).toEqual([]);
  });

  test("thread nodes come first, newest thread date first", () => {
    const nodes = [
      node({ id: 1, newestUnresolvedThreadDate: "2026-07-20" }),
      node({ id: 2, newestUnresolvedThreadDate: "2026-07-25" }),
      node({ id: 3 }), // no thread
    ];
    const result = lane1Candidates(nodes, "a", "2026-08-01", [], CONSTANTS);
    expect(result.map((n) => n.id)).toEqual([2, 1, 3]);
  });

  test("never-asked-without-thread ordered richest (highest budget) first", () => {
    const nodes = [
      node({ id: 1, budget: 1, timesAsked: 0 }),
      node({ id: 2, budget: 3, timesAsked: 0 }),
      node({ id: 3, budget: 2, timesAsked: 0 }),
    ];
    const result = lane1Candidates(nodes, "a", "2026-08-01", [], CONSTANTS);
    expect(result.map((n) => n.id)).toEqual([2, 3, 1]);
  });

  test("previously-asked-without-thread ordered stalest (oldest lastAsked) first", () => {
    const nodes = [
      node({ id: 1, timesAsked: 1, lastAsked: "2026-07-10" }),
      node({ id: 2, timesAsked: 2, lastAsked: "2026-07-01" }),
      node({ id: 3, timesAsked: 1, lastAsked: "2026-07-15" }),
    ];
    const result = lane1Candidates(nodes, "a", "2026-08-01", [], CONSTANTS);
    expect(result.map((n) => n.id)).toEqual([2, 1, 3]);
  });

  test("full precedence: threaded > never-asked-rich > asked-stale", () => {
    const nodes = [
      node({ id: 1, timesAsked: 1, lastAsked: "2026-07-01" }), // bucket 3
      node({ id: 2, budget: 3, timesAsked: 0 }), // bucket 2
      node({ id: 3, newestUnresolvedThreadDate: "2026-07-20" }), // bucket 1
    ];
    const result = lane1Candidates(nodes, "a", "2026-08-01", [], CONSTANTS);
    expect(result.map((n) => n.id)).toEqual([3, 2, 1]);
  });

  test("filters to this person's own nodes only", () => {
    const nodes = [node({ id: 1, person: "a" }), node({ id: 2, person: "b" })];
    expect(lane1Candidates(nodes, "a", "2026-08-01", [], CONSTANTS).map((n) => n.id)).toEqual([1]);
  });
});

describe("lane2Candidates", () => {
  function seed(overrides: Partial<SeedRow> = {}): SeedRow {
    return { id: 1, text: "seed text", domain: "food", family: "food", ...overrides };
  }

  test("excludes seeds used by this person within seedReuseDays (pre-filtered set)", () => {
    const seeds = [seed({ id: 1 }), seed({ id: 2 })];
    const used = new Set([1]);
    const result = lane2Candidates(seeds, "a", "2026-08-01", [], used, CONSTANTS);
    expect(result.map((s) => s.id)).toEqual([2]);
  });

  test("excludes seeds whose domain fails W3", () => {
    const seeds = [seed({ id: 1, domain: "food" })];
    const asks: AskRow[] = [
      { id: 1, date: "2026-07-31", person: "a", targetNodeId: null, askDomain: "food", askFamily: null, lane: "explore", seedId: 5 },
    ];
    expect(lane2Candidates(seeds, "a", "2026-08-01", asks, new Set(), CONSTANTS)).toEqual([]);
  });

  test("excludes seeds whose family fails W4", () => {
    const seeds = [seed({ id: 1, family: "nostalgia" })];
    const asks: AskRow[] = [
      { id: 1, date: "2026-07-31", person: "a", targetNodeId: null, askDomain: null, askFamily: "nostalgia", lane: "explore", seedId: 5 },
    ];
    expect(lane2Candidates(seeds, "a", "2026-08-01", asks, new Set(), CONSTANTS)).toEqual([]);
  });

  test("orders by id", () => {
    const seeds = [seed({ id: 3 }), seed({ id: 1 }), seed({ id: 2 })];
    const result = lane2Candidates(seeds, "a", "2026-08-01", [], new Set(), CONSTANTS);
    expect(result.map((s) => s.id)).toEqual([1, 2, 3]);
  });
});
