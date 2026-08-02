import { describe, expect, test } from "bun:test";
import { buildCandidateList, selectNoToken, selectPartner, tokenCandidate } from "../../src/selection/pairs";
import type { Candidate, SeedRow, SelectableNode, TokenRow } from "../../src/selection/types";

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

function seed(overrides: Partial<SeedRow> = {}): SeedRow {
  return { id: 1, text: "seed text", domain: "food", family: "food", ...overrides };
}

function exploitCandidate(overrides: Partial<SelectableNode> = {}, person: "a" | "b" = "a"): Candidate {
  const n = node({ person, ...overrides });
  return { person, lane: "exploit", node: n, seed: null, token: null, domain: n.domain, family: n.family };
}

function exploreCandidate(overrides: Partial<SeedRow> = {}, person: "a" | "b" = "a"): Candidate {
  const s = seed(overrides);
  return { person, lane: "explore", node: null, seed: s, token: null, domain: s.domain, family: s.family };
}

describe("buildCandidateList", () => {
  test("lane 1 nodes precede lane 2 seeds, truncated to candidateDepth", () => {
    const nodes = [node({ id: 1 }), node({ id: 2 })];
    const seeds = [seed({ id: 10 }), seed({ id: 11 })];
    const list = buildCandidateList("a", nodes, seeds, 3);
    expect(list.map((c) => (c.node ? `n${c.node.id}` : `s${c.seed!.id}`))).toEqual(["n1", "n2", "s10"]);
  });
});

describe("tokenCandidate", () => {
  test("carries the token's node's own domain/family", () => {
    const n = node({ id: 1, domain: "hobbies-interests", family: "play" });
    const t: TokenRow = { id: 5, nodeId: 1, eventDate: "2026-07-30", createdAt: "2026-07-30", spentAt: null };
    const c = tokenCandidate("a", t, new Map([[1, n]]));
    expect(c).toEqual({ person: "a", lane: "followup", node: n, seed: null, token: t, domain: "hobbies-interests", family: "play" });
  });
});

describe("selectPartner (one person holds a token)", () => {
  test("picks the partner's first non-colliding candidate", () => {
    const fixed = exploitCandidate({ id: 1, domain: "food", family: "food" });
    const partnerBest = exploitCandidate({ id: 2, domain: "work-school", family: "work-school" }, "b");
    const result = selectPartner(fixed, [partnerBest]);
    expect(result).toEqual({ candidate: partnerBest, relaxations: [] });
  });

  test("token-vs-partner collision: partner re-selects, never the token", () => {
    const fixed = exploitCandidate({ id: 1, domain: "food", family: "food" });
    const colliding = exploitCandidate({ id: 2, domain: "food", family: "nostalgia" }, "b"); // same-day domain
    const clean = exploitCandidate({ id: 3, domain: "work-school", family: "work-school" }, "b");
    const result = selectPartner(fixed, [colliding, clean]);
    expect(result).toEqual({ candidate: clean, relaxations: [] });
  });

  test("family-only collision is also dropped before relaxation", () => {
    const fixed = exploitCandidate({ id: 1, domain: "food", family: "nostalgia" });
    const colliding = exploitCandidate({ id: 2, domain: "work-school", family: "nostalgia" }, "b"); // same-day family
    const clean = exploitCandidate({ id: 3, domain: "work-school", family: "play" }, "b");
    const result = selectPartner(fixed, [colliding, clean]);
    expect(result).toEqual({ candidate: clean, relaxations: [] });
  });

  test("relaxes family first when every candidate collides on family", () => {
    const fixed = exploitCandidate({ id: 1, domain: "food", family: "nostalgia" });
    // both partner options share the family, but differ in domain
    const first = exploitCandidate({ id: 2, domain: "work-school", family: "nostalgia" }, "b");
    const second = exploitCandidate({ id: 3, domain: "play", family: "nostalgia" }, "b");
    const result = selectPartner(fixed, [first, second]);
    expect(result).toEqual({ candidate: first, relaxations: ["family"] });
  });

  test("relaxes domain too when everything collides on both", () => {
    const fixed = exploitCandidate({ id: 1, domain: "food", family: "food" });
    const only = exploitCandidate({ id: 2, domain: "food", family: "food" }, "b");
    const result = selectPartner(fixed, [only]);
    expect(result).toEqual({ candidate: only, relaxations: ["family", "domain"] });
  });

  test("two null families never collide", () => {
    const fixed = exploitCandidate({ id: 1, domain: "food", family: null });
    const partner = exploitCandidate({ id: 2, domain: "work-school", family: null }, "b");
    const result = selectPartner(fixed, [partner]);
    expect(result).toEqual({ candidate: partner, relaxations: [] });
  });
});

describe("selectNoToken (neither person holds a token)", () => {
  test("picks the lexicographically best non-colliding pair", () => {
    const a1 = exploitCandidate({ id: 1, domain: "food", family: "food" });
    const b1 = exploitCandidate({ id: 2, domain: "work-school", family: "work-school" }, "b");
    const result = selectNoToken([a1], [b1]);
    expect(result).toEqual({ a: a1, b: b1, relaxations: [] });
  });

  test("drops a same-day domain collision", () => {
    const a1 = exploitCandidate({ id: 1, domain: "food", family: "food" });
    const bColliding = exploitCandidate({ id: 2, domain: "food", family: "nostalgia" }, "b");
    const bClean = exploreCandidate({ id: 10, domain: "work-school", family: "work-school" }, "b");
    const result = selectNoToken([a1], [bColliding, bClean]);
    expect(result).toEqual({ a: a1, b: bClean, relaxations: [] });
  });

  test("lexicographic beats sum: a worse-best-lane pair is never chosen over a better-best-lane pair, even if a sum would tie or favor it", () => {
    // Pair 1: (exploit, exploit) -> best=exploit(1), worse=exploit(1). Sum-of-ranks = 2.
    // Pair 2: (followup is impossible here since no tokens; use exploit,explore) best=exploit(1), worse=explore(2). Sum = 3.
    // A sum-based comparator with a big enough index penalty could prefer pair2's earlier
    // indices over pair1's later indices even though pair1's best/worse lanes are strictly
    // better. Construct exactly that: pair1 candidates sit at high indices, pair2 at index 0.
    const aExploitLate = exploitCandidate({ id: 1, domain: "food", family: "food" }); // index 1
    const aExploreEarly = exploreCandidate({ id: 20, domain: "food", family: "food" }); // index 0
    const bExploitLate = exploitCandidate({ id: 2, domain: "work-school", family: "work-school" }, "b"); // index 1
    const bExploreEarly = exploreCandidate({ id: 21, domain: "work-school", family: "work-school" }, "b"); // index 0

    const listA = [aExploreEarly, aExploitLate]; // index 0 = explore, index 1 = exploit
    const listB = [bExploreEarly, bExploitLate]; // index 0 = explore, index 1 = exploit

    // Lexicographic winner: (exploit, exploit) at (ai=1, bi=1) has best=exploit,
    // worse=exploit, strictly better than any pair touching an explore candidate,
    // regardless of index. A sum comparator using rank+index might instead prefer
    // (explore, explore) at (0,0) since its indices are lower.
    const result = selectNoToken(listA, listB);
    expect(result).toEqual({ a: aExploitLate, b: bExploitLate, relaxations: [] });
  });

  test("prefers lower index within an equal best/worse lane tier", () => {
    const aFirst = exploitCandidate({ id: 1, domain: "food", family: "food" });
    const aSecond = exploitCandidate({ id: 2, domain: "food", family: "food" });
    const b = exploitCandidate({ id: 3, domain: "work-school", family: "work-school" }, "b");
    const result = selectNoToken([aFirst, aSecond], [b]);
    expect(result.a).toEqual(aFirst);
  });

  test("relaxes family then domain, recorded in order, when every pair collides", () => {
    const a1 = exploitCandidate({ id: 1, domain: "food", family: "food" });
    const b1 = exploitCandidate({ id: 2, domain: "food", family: "food" }, "b");
    const result = selectNoToken([a1], [b1]);
    expect(result.relaxations).toEqual(["family", "domain"]);
  });

  test("throws when a person has no candidates at all (feasibility violation)", () => {
    const a1 = exploitCandidate({ id: 1 });
    expect(() => selectNoToken([a1], [])).toThrow();
  });
});
