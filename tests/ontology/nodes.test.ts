import { beforeEach, describe, expect, test } from "bun:test";
import { Ledger } from "../../src/ledger/ledger";

let ledger: Ledger;

beforeEach(() => {
  ledger = Ledger.open(":memory:");
});

const gen = (date: string, person: "a" | "b", targetNodeId: number | null) => ({
  date, promptId: `gen-${date}-${person}`, promptText: "q", model: "m",
  systemPrompt: "s", userPrompt: "u", rawResponse: "{}", rationale: "r",
  stance: "exploit", person, topic: null, targetNodeId, targetDomain: null,
  fellBack: false, fallbackReason: null, at: "t",
});

describe("nodes", () => {
  test("createNode + nodesFor round-trips", () => {
    const id = ledger.createNode({
      person: "a", domain: "hobbies-interests", subdomain: "guitar",
      summary: "Learning guitar, wants to street-perform.", eventDate: null, at: "t",
    });
    const nodes = ledger.nodesFor("a");
    expect(nodes).toHaveLength(1);
    // budget is null until something grants it (grantBudget, or a rebuild's
    // replay); createNode alone never sets it.
    expect(nodes[0]).toMatchObject({ id, subdomain: "guitar", budget: null, family: null, timesAsked: 0 });
  });

  test("the same subdomain cannot exist twice for one person, even under different domains", () => {
    // The real car answer produced daily-life/transportation,
    // plans-future/car-2027 and family/family-car as three legal nodes under
    // a per-domain key. A subject has one identity per person.
    ledger.createNode({ person: "b", domain: "daily-life", subdomain: "car-2027", summary: "s", eventDate: null, at: "t" });
    expect(() =>
      ledger.createNode({ person: "b", domain: "plans-future", subdomain: "car-2027", summary: "s2", eventDate: null, at: "t" }),
    ).toThrow();
  });

  test("subdomains are normalized before the uniqueness check", () => {
    ledger.createNode({ person: "b", domain: "health-body", subdomain: "fitness-goals", summary: "s", eventDate: null, at: "t" });
    expect(() =>
      ledger.createNode({ person: "b", domain: "health-body", subdomain: "Fitness Goal", summary: "s", eventDate: null, at: "t" }),
    ).toThrow();
  });

  test("the 11th domain (tastes-preferences) is legal", () => {
    const id = ledger.createNode({ person: "a", domain: "tastes-preferences", subdomain: "coffee-order", summary: "s", eventDate: null, at: "t" });
    expect(ledger.nodesFor("a").find((n) => n.id === id)?.domain).toBe("tastes-preferences");
  });
});

describe("addNodeFact + fact_subjects", () => {
  test("returns the new fact's id and writes the primary fact_subjects row", () => {
    const nodeId = ledger.createNode({ person: "a", domain: "hobbies-interests", subdomain: "guitar", summary: "s", eventDate: null, at: "t" });
    const factId = ledger.addNodeFact({ nodeId, kind: "fact", text: "Practices daily.", sourceDayId: 1, observedDate: "2026-08-01", at: "t" });
    expect(typeof factId).toBe("number");
    expect(ledger.subjectsForFact(factId)).toEqual([nodeId]);
  });

  test("addFactSubject adds a secondary home without disturbing the primary", () => {
    const primary = ledger.createNode({ person: "a", domain: "hobbies-interests", subdomain: "guitar", summary: "s", eventDate: null, at: "t" });
    const secondary = ledger.createNode({ person: "a", domain: "daily-life", subdomain: "busking", summary: "s", eventDate: null, at: "t" });
    const factId = ledger.addNodeFact({ nodeId: primary, kind: "fact", text: "Wants to busk downtown.", sourceDayId: 1, observedDate: "2026-08-01", at: "t" });
    ledger.addFactSubject(factId, secondary);
    expect(ledger.subjectsForFact(factId)).toEqual([primary, secondary].sort((a, b) => a - b));
  });

  test("addFactSubject is idempotent: re-filing the same home is a no-op, not a throw", () => {
    const nodeId = ledger.createNode({ person: "a", domain: "hobbies-interests", subdomain: "guitar", summary: "s", eventDate: null, at: "t" });
    const factId = ledger.addNodeFact({ nodeId, kind: "fact", text: "x", sourceDayId: 1, observedDate: "2026-08-01", at: "t" });
    expect(() => ledger.addFactSubject(factId, nodeId)).not.toThrow();
    expect(ledger.subjectsForFact(factId)).toEqual([nodeId]);
  });
});

describe("budget lifecycle", () => {
  test("grantBudget: only fact kinds grants 1, any interest grants 2, any thread grants 3, never 0", () => {
    const factOnly = ledger.createNode({ person: "a", domain: "daily-life", subdomain: "cooking", summary: "s", eventDate: null, at: "t" });
    const withInterest = ledger.createNode({ person: "a", domain: "daily-life", subdomain: "reading", summary: "s", eventDate: null, at: "t" });
    const withThread = ledger.createNode({ person: "a", domain: "daily-life", subdomain: "car-2027", summary: "s", eventDate: null, at: "t" });
    ledger.grantBudget(factOnly, ["fact"], 3, "t");
    ledger.grantBudget(withInterest, ["fact", "interest"], 3, "t");
    ledger.grantBudget(withThread, ["fact", "thread"], 3, "t");
    const nodes = ledger.nodesFor("a");
    expect(nodes.find((n) => n.id === factOnly)?.budget).toBe(1);
    expect(nodes.find((n) => n.id === withInterest)?.budget).toBe(2);
    expect(nodes.find((n) => n.id === withThread)?.budget).toBe(3);
  });

  test("grantBudget caps at the given cap even when a thread would otherwise grant more", () => {
    const id = ledger.createNode({ person: "a", domain: "daily-life", subdomain: "car-2027", summary: "s", eventDate: null, at: "t" });
    ledger.grantBudget(id, ["thread"], 2, "t");
    expect(ledger.nodesFor("a")[0]!.budget).toBe(2);
  });

  test("recordAsk decrements budget, floors at 0, and bumps times_asked/last_asked in one call", () => {
    const id = ledger.createNode({ person: "a", domain: "daily-life", subdomain: "car-2027", summary: "s", eventDate: null, at: "t" });
    ledger.grantBudget(id, ["fact"], 3, "t");
    ledger.recordAsk(id, "2026-08-01", "t1");
    let node = ledger.nodesFor("a")[0]!;
    expect(node).toMatchObject({ budget: 0, timesAsked: 1, lastAsked: "2026-08-01" });
    ledger.recordAsk(id, "2026-08-02", "t2");
    node = ledger.nodesFor("a")[0]!;
    expect(node).toMatchObject({ budget: 0, timesAsked: 2 }); // floors, never negative
  });

  test("resolveOpenThreads stamps resolved_at on open threads (via any home) and zeroes budget in one transaction", () => {
    const primary = ledger.createNode({ person: "a", domain: "daily-life", subdomain: "car-2027", summary: "s", eventDate: null, at: "t" });
    const secondary = ledger.createNode({ person: "a", domain: "plans-future", subdomain: "roadtrip", summary: "s", eventDate: null, at: "t" });
    ledger.grantBudget(primary, ["thread"], 3, "t");
    const factId = ledger.addNodeFact({ nodeId: primary, kind: "thread", text: "Deciding between two dealers.", sourceDayId: 1, observedDate: "2026-08-01", at: "t" });
    ledger.addFactSubject(factId, secondary); // multi-homed: resolving via secondary's home must still find it

    const resolvedCount = ledger.resolveOpenThreads(secondary, "t2");
    expect(resolvedCount).toBe(1);
    expect(ledger.nodesFor("a").find((n) => n.id === secondary)?.budget).toBe(0);
    // primary's own budget is untouched: resolution zeroes only the node it was called on.
    expect(ledger.nodesFor("a").find((n) => n.id === primary)?.budget).toBe(3);
  });

  test("refillBudget = min(cap, max(budget, 0) + 1)", () => {
    const id = ledger.createNode({ person: "a", domain: "daily-life", subdomain: "car-2027", summary: "s", eventDate: null, at: "t" });
    ledger.setNodeBudget(id, 0, "t");
    ledger.refillBudget(id, "t1", 3);
    expect(ledger.nodesFor("a")[0]!.budget).toBe(1);
    ledger.setNodeBudget(id, 3, "t");
    ledger.refillBudget(id, "t2", 3); // already at cap, does not overflow
    expect(ledger.nodesFor("a")[0]!.budget).toBe(3);
  });
});

describe("followup tokens", () => {
  test("mintToken is idempotent per (node, event_date); spendToken is guarded against double-spend", () => {
    const id = ledger.createNode({ person: "a", domain: "daily-life", subdomain: "car-2027", summary: "s", eventDate: null, at: "t" });
    ledger.mintToken(id, "2026-08-05", "t1");
    ledger.mintToken(id, "2026-08-05", "t2"); // same event date: no second row
    const fireable = ledger.fireableTokens("2026-08-06", 3);
    expect(fireable).toHaveLength(1);
    const token = fireable[0]!;
    ledger.spendToken(token.id, "t3");
    expect(ledger.fireableTokens("2026-08-06", 3)).toEqual([]);
    expect(() => ledger.spendToken(token.id, "t4")).not.toThrow(); // double-spend is a no-op
  });

  test("fireableTokens uses the signed window [today - windowDays, today): a future event never looks passed", () => {
    const id = ledger.createNode({ person: "a", domain: "daily-life", subdomain: "car-2027", summary: "s", eventDate: null, at: "t" });
    ledger.mintToken(id, "2026-08-10", "t1"); // future relative to today
    expect(ledger.fireableTokens("2026-08-06", 3)).toEqual([]);
  });

  test("expiredUnspentTokens surfaces tokens older than the window, still unspent (audit A5)", () => {
    const id = ledger.createNode({ person: "a", domain: "daily-life", subdomain: "car-2027", summary: "s", eventDate: null, at: "t" });
    ledger.mintToken(id, "2026-08-01", "t1");
    expect(ledger.expiredUnspentTokens("2026-08-10", 3)).toHaveLength(1);
    expect(ledger.fireableTokens("2026-08-10", 3)).toEqual([]); // expired, not fireable
  });
});

describe("seeds", () => {
  test("replaceSeeds wipes and reloads the bank; allSeeds reads it back by id", () => {
    ledger.replaceSeeds([
      { id: 1, text: "What's a meal you'd never get tired of?", domain: "daily-life", family: "food" },
      { id: 2, text: "What's a smell that takes you back?", domain: "childhood", family: "nostalgia" },
    ]);
    expect(ledger.allSeeds()).toEqual([
      { id: 1, text: "What's a meal you'd never get tired of?", domain: "daily-life", family: "food" },
      { id: 2, text: "What's a smell that takes you back?", domain: "childhood", family: "nostalgia" },
    ]);
    ledger.replaceSeeds([{ id: 5, text: "different bank", domain: "daily-life", family: "food" }]);
    expect(ledger.allSeeds()).toEqual([{ id: 5, text: "different bank", domain: "daily-life", family: "food" }]);
  });

  test("usedSeedIdsWithin reads seed_id off generation_log, scoped to person and window", () => {
    ledger.recordGeneration({ ...gen("2026-08-01", "a", null), seedId: 5 });
    ledger.recordGeneration({ ...gen("2026-08-01", "b", null), seedId: 6 });
    ledger.recordGeneration({ ...gen("2026-07-01", "a", null), seedId: 9 }); // outside window
    expect(ledger.usedSeedIdsWithin("a", "2026-07-15")).toEqual(new Set([5]));
  });
});

describe("selectableNodes", () => {
  test("carries newestFactDate and newestUnresolvedThreadDate across all homes", () => {
    const primary = ledger.createNode({ person: "a", domain: "daily-life", subdomain: "car-2027", summary: "s", eventDate: null, at: "t" });
    const secondary = ledger.createNode({ person: "a", domain: "plans-future", subdomain: "roadtrip", summary: "s", eventDate: null, at: "t" });
    ledger.addNodeFact({ nodeId: primary, kind: "fact", text: "Test drove a Civic.", sourceDayId: 1, observedDate: "2026-07-20", at: "t" });
    const threadFact = ledger.addNodeFact({ nodeId: primary, kind: "thread", text: "Deciding between two dealers.", sourceDayId: 1, observedDate: "2026-08-01", at: "t" });
    ledger.addFactSubject(threadFact, secondary);

    const nodes = ledger.selectableNodes("a");
    const secondaryNode = nodes.find((n) => n.id === secondary)!;
    expect(secondaryNode.newestFactDate).toBe("2026-08-01");
    expect(secondaryNode.newestUnresolvedThreadDate).toBe("2026-08-01");
    const primaryNode = nodes.find((n) => n.id === primary)!;
    expect(primaryNode.newestFactDate).toBe("2026-08-01");
  });

  test("newestUnresolvedThreadDate is null once the thread resolves", () => {
    const id = ledger.createNode({ person: "a", domain: "daily-life", subdomain: "car-2027", summary: "s", eventDate: null, at: "t" });
    ledger.addNodeFact({ nodeId: id, kind: "thread", text: "Deciding between two dealers.", sourceDayId: 1, observedDate: "2026-08-01", at: "t" });
    ledger.resolveOpenThreads(id, "t2");
    expect(ledger.selectableNodes("a")[0]!.newestUnresolvedThreadDate).toBeNull();
  });
});

// The old "recordYield" describe block tested nodes.status and
// nodes.avg_yield_chars, both dropped by the 2026-08-02 synthesis design's
// rebuild (budget replaces them). recordYield/recordYieldForNode are kept in
// ledger.ts, UNCHANGED, only so other packages' still-existing call sites
// keep compiling this wave; they throw at runtime against this schema, so
// there is nothing left here worth testing. Budget's own lifecycle
// (grantBudget/recordAsk/resolveOpenThreads/refillBudget) is covered above.

describe("signals", () => {
  test("moods are windowed, preferences are durable", () => {
    ledger.addSignal({ person: "a", kind: "mood_signal", text: "tired", observedDate: "2026-07-01", at: "t" });
    ledger.addSignal({ person: "a", kind: "mood_signal", text: "upbeat", observedDate: "2026-07-28", at: "t" });
    ledger.addSignal({ person: "a", kind: "prompt_preference", text: "likes short questions", observedDate: "2026-07-01", at: "t" });
    const moods = ledger.recentSignals("a", "mood_signal", 7, "2026-07-29");
    expect(moods.map((s) => s.text)).toEqual(["upbeat"]);
    const prefs = ledger.recentSignals("a", "prompt_preference", null, "2026-07-29");
    expect(prefs.map((s) => s.text)).toEqual(["likes short questions"]);
  });
});

describe("personMedianAnswerChars", () => {
  test("returns the median answer length for that person only", () => {
    for (const [date, len] of [["2026-08-01", 100], ["2026-08-02", 300], ["2026-08-03", 500]] as const) {
      const day = ledger.createDay(date, "p", "t", "t");
      ledger.finalizeResponse(day.id, "a", "x".repeat(len), "t1");
      ledger.finalizeResponse(day.id, "b", "y".repeat(50), "t1");
    }
    expect(ledger.personMedianAnswerChars("a")).toBe(300);
    expect(ledger.personMedianAnswerChars("b")).toBe(50);
  });

  test("returns null with no answers yet", () => {
    expect(ledger.personMedianAnswerChars("a")).toBeNull();
  });
});
