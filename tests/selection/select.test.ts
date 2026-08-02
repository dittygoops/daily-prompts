import { describe, expect, test } from "bun:test";
import { selectPair } from "../../src/selection/select";
import type { AskRow, SeedRow, SelectableNode, SelectionConstants, SelectionInput, TokenRow } from "../../src/selection/types";

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

function seed(overrides: Partial<SeedRow> = {}): SeedRow {
  return { id: 1, text: "seed text", domain: "food", family: "food", ...overrides };
}

function baseInput(overrides: Partial<SelectionInput> = {}): SelectionInput {
  return {
    nodes: {
      a: [node({ id: 1, person: "a" })],
      b: [node({ id: 2, person: "b", domain: "work-school", family: "work-school" })],
    },
    asks: [],
    seeds: [seed({ id: 100, domain: "money", family: "money" }), seed({ id: 101, domain: "media", family: "media" })],
    usedSeedIds: { a: new Set(), b: new Set() },
    tokens: [],
    constants: CONSTANTS,
    today: "2026-08-01",
    ...overrides,
  };
}

describe("selectPair basics", () => {
  test("no tokens: exploit fires for both when eligible", () => {
    const result = selectPair(baseInput());
    expect(result.a.lane).toBe("exploit");
    expect(result.b.lane).toBe("exploit");
    expect(result.a.node!.id).toBe(1);
    expect(result.b.node!.id).toBe(2);
    expect(result.relaxations).toEqual([]);
  });

  test("determinism: same input twice, identical output", () => {
    const input = baseInput();
    const r1 = selectPair(input);
    const r2 = selectPair(structuredClone(input));
    expect(r1).toEqual(r2);
  });
});

describe("token bypasses everything simultaneously", () => {
  test("a fireable token fires even with settling + cooldown + domain + family + run-cap + budget 0 all violated", () => {
    const asks: AskRow[] = [
      { id: 1, date: "2026-07-30", person: "a", targetNodeId: 1, askDomain: "hobbies-interests", askFamily: "play", lane: "exploit", seedId: null },
      { id: 2, date: "2026-07-31", person: "a", targetNodeId: 1, askDomain: "hobbies-interests", askFamily: "play", lane: "exploit", seedId: null },
    ];
    const troubledNode = node({
      id: 1,
      person: "a",
      budget: 0, // budget exhausted
      newestFactDate: "2026-08-01", // W1 settling
      lastAsked: "2026-08-01", // W2 subject cooldown
      domain: "hobbies-interests", // W3 (asked yesterday and day before)
      family: "play", // W4 (asked yesterday and day before)
    });
    const token: TokenRow = { id: 1, nodeId: 1, eventDate: "2026-07-30", createdAt: "2026-07-30", spentAt: null };
    const input = baseInput({
      nodes: { a: [troubledNode], b: [node({ id: 2, person: "b" })] },
      asks,
      tokens: [token],
    });
    const result = selectPair(input);
    expect(result.a.lane).toBe("followup");
    expect(result.a.token).toBe(token);
    expect(result.a.node!.id).toBe(1);
  });

  test("a spent token does not refire", () => {
    const troubledNode = node({ id: 1, person: "a", budget: 0 });
    const spent: TokenRow = { id: 1, nodeId: 1, eventDate: "2026-07-30", createdAt: "2026-07-30", spentAt: "2026-07-30T12:00:00Z" };
    const input = baseInput({
      nodes: { a: [troubledNode], b: [node({ id: 2, person: "b" })] },
      tokens: [spent],
    });
    // budget is 0 and no other lane 1/2 candidates besides seeds: expect explore, not followup
    const result = selectPair(input);
    expect(result.a.lane).not.toBe("followup");
  });

  test("double-token day: both fire with cross-person rules waived", () => {
    const nodeA = node({ id: 1, person: "a", domain: "food", family: "food" });
    const nodeB = node({ id: 2, person: "b", domain: "food", family: "food" }); // same domain+family: would collide without tokens
    const tokenA: TokenRow = { id: 1, nodeId: 1, eventDate: "2026-07-30", createdAt: "2026-07-30", spentAt: null };
    const tokenB: TokenRow = { id: 2, nodeId: 2, eventDate: "2026-07-31", createdAt: "2026-07-31", spentAt: null };
    const input = baseInput({
      nodes: { a: [nodeA], b: [nodeB] },
      tokens: [tokenA, tokenB],
    });
    const result = selectPair(input);
    expect(result.a.lane).toBe("followup");
    expect(result.b.lane).toBe("followup");
    expect(result.relaxations).toEqual([]);
  });

  test("token-vs-partner collision: the partner re-selects, never the token", () => {
    const tokenNode = node({ id: 1, person: "a", domain: "food", family: "food" });
    const collidingNode = node({ id: 2, person: "b", domain: "food", family: "food" }); // same domain+family as the token
    const cleanNode = node({ id: 3, person: "b", domain: "work-school", family: "work-school", timesAsked: 1, lastAsked: "2026-07-01" });
    const token: TokenRow = { id: 1, nodeId: 1, eventDate: "2026-07-30", createdAt: "2026-07-30", spentAt: null };
    const input = baseInput({
      nodes: { a: [tokenNode], b: [collidingNode, cleanNode] },
      tokens: [token],
    });
    const result = selectPair(input);
    expect(result.a.lane).toBe("followup");
    expect(result.a.node!.id).toBe(1); // never the token itself changes
    expect(result.b.node!.id).toBe(3); // partner skipped the colliding candidate
  });
});

describe("budget 0 exclusion", () => {
  test("a budget-0 node is not selected for exploit, and appears in background", () => {
    const zeroBudget = node({ id: 1, person: "a", budget: 0, domain: "hobbies-interests", subdomain: "guitar" });
    const input = baseInput({ nodes: { a: [zeroBudget], b: [node({ id: 2, person: "b" })] } });
    const result = selectPair(input);
    expect(result.a.lane).toBe("explore"); // falls through to lane 2
    expect(result.background.a).toContainEqual({ domain: "hobbies-interests", subdomain: "guitar" });
  });
});

describe("thread-first ordering surfaces through selectPair", () => {
  test("a threaded node outranks a never-asked richer node", () => {
    const threaded = node({ id: 1, person: "a", budget: 1, newestUnresolvedThreadDate: "2026-07-20" });
    const rich = node({ id: 2, person: "a", budget: 3, domain: "food", family: "food" });
    const bNode = node({ id: 3, person: "b", domain: "money", family: "money" }); // no collision with either
    const input = baseInput({ nodes: { a: [threaded, rich], b: [bNode] } });
    const result = selectPair(input);
    expect(result.a.node!.id).toBe(1);
  });
});

describe("relaxation order recorded family-then-domain", () => {
  test("when every pair collides on both, relaxations record family then domain", () => {
    const nodeA = node({ id: 1, person: "a", domain: "food", family: "food" });
    const nodeB = node({ id: 2, person: "b", domain: "food", family: "food" });
    const input = baseInput({
      nodes: { a: [nodeA], b: [nodeB] },
      seeds: [], // force node-only candidates so both lists are single-element
    });
    const result = selectPair(input);
    expect(result.relaxations).toEqual(["family", "domain"]);
  });
});

describe("lexicographic beats sum", () => {
  test("selectPair prefers the exploit/exploit pair over an earlier-indexed explore/explore pair", () => {
    const aExploit = node({ id: 1, person: "a", domain: "hobbies-interests", family: "play" });
    const bExploit = node({ id: 2, person: "b", domain: "work-school", family: "work-school" });
    const input = baseInput({
      nodes: { a: [aExploit], b: [bExploit] },
      seeds: [
        seed({ id: 100, domain: "money", family: "money" }),
        seed({ id: 101, domain: "movies", family: "media" }),
      ],
    });
    const result = selectPair(input);
    expect(result.a.lane).toBe("exploit");
    expect(result.b.lane).toBe("exploit");
  });
});
