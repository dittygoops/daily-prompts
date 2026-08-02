import { describe, expect, test } from "bun:test";
import { renderGraph } from "../scripts/print-graph";
import { Ledger } from "../src/ledger/ledger";

describe("renderGraph", () => {
  test("renders an empty graph with zero totals, no domain sections, and a seeds line", () => {
    const ledger = Ledger.open(":memory:");
    const out = renderGraph(ledger, "a", "2026-07-29");
    expect(out).toContain("=== person a ===");
    expect(out).toContain("signals:");
    expect(out).toContain("totals: 0 nodes across 0 domains, 0 facts, 0 signals");
    expect(out).toContain("seeds: 0 loaded, 0 used by a");
  });

  test("groups nodes by domain (sorted), sorts nodes by subdomain, and lists facts in date order", () => {
    const ledger = Ledger.open(":memory:");
    const gymId = ledger.createNode({
      person: "a", domain: "hobbies-interests", subdomain: "gym", summary: "Goes to the gym.", eventDate: null, at: "t0",
    });
    const backId = ledger.createNode({
      person: "a", domain: "health-body", subdomain: "back-pain", summary: "Has back pain.", eventDate: null, at: "t0",
    });
    ledger.addNodeFact({ nodeId: backId, kind: "thread", text: "Has back pain from bench pressing.", sourceDayId: 1, observedDate: "2026-07-28", at: "t1" });
    ledger.addNodeFact({ nodeId: backId, kind: "thread", text: "Plans to try dead hangs and stretching.", sourceDayId: 1, observedDate: "2026-07-28", at: "t2" });
    ledger.addNodeFact({ nodeId: gymId, kind: "fact", text: "Lifts weights.", sourceDayId: 1, observedDate: "2026-07-20", at: "t3" });
    ledger.recordAsked(gymId, "2026-07-20", "t4");

    const out = renderGraph(ledger, "a", "2026-07-29");
    const healthIdx = out.indexOf("health-body");
    const hobbiesIdx = out.indexOf("hobbies-interests");
    expect(healthIdx).toBeGreaterThan(-1);
    expect(hobbiesIdx).toBeGreaterThan(-1);
    expect(healthIdx).toBeLessThan(hobbiesIdx); // alphabetical domain order

    expect(out).toContain(`[${backId}] back-pain  budget=-  family=-  last_asked=-  asked=0  facts=2`);
    expect(out).toContain(`last_asked=2026-07-20`); // gym, via recordAsked (only last_asked moves; times_asked is a finalization-time write, owned elsewhere)
    expect(out).toContain(`facts=2`);
    expect(out).toContain("- [2026-07-28] Has back pain from bench pressing.");
    expect(out).toContain("- [2026-07-28] Plans to try dead hangs and stretching.");

    expect(out).toContain(`totals: 2 nodes across 2 domains, 3 facts, 0 signals`);
  });

  test("renders budget and family as - when null and as their value when present", () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = ledger.createNode({
      person: "a", domain: "daily-life", subdomain: "cooking", summary: "Likes to cook.", eventDate: null, at: "t0",
    });
    let out = renderGraph(ledger, "a", "2026-07-29");
    expect(out).toContain("budget=-");
    expect(out).toContain("family=-");

    ledger.setNodeBudget(nodeId, 2, "t1");
    out = renderGraph(ledger, "a", "2026-07-29");
    expect(out).toContain("budget=2");
  });

  test("marks a multi-homed fact with the other nodes it is homed on", () => {
    const ledger = Ledger.open(":memory:");
    const primaryId = ledger.createNode({
      person: "a", domain: "daily-life", subdomain: "cooking", summary: "s", eventDate: null, at: "t0",
    });
    const secondaryId = ledger.createNode({
      person: "a", domain: "hobbies-interests", subdomain: "baking", summary: "s", eventDate: null, at: "t0",
    });
    const factId = ledger.addNodeFact({ nodeId: primaryId, kind: "fact", text: "Bakes bread on weekends.", sourceDayId: 1, observedDate: "2026-07-20", at: "t1" });
    ledger.addFactSubject(factId, secondaryId);

    const out = renderGraph(ledger, "a", "2026-07-29");
    expect(out).toContain(`- [2026-07-20] Bakes bread on weekends. [+nodes ${secondaryId}]`);
  });

  test("marks a resolved thread fact with its resolution date", () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = ledger.createNode({
      person: "a", domain: "daily-life", subdomain: "cooking", summary: "s", eventDate: null, at: "t0",
    });
    ledger.addNodeFact({ nodeId, kind: "thread", text: "Trying a new recipe next week.", sourceDayId: 1, observedDate: "2026-07-20", at: "t1" });
    ledger.resolveOpenThreads(nodeId, "2026-07-25");

    const out = renderGraph(ledger, "a", "2026-07-29");
    expect(out).toContain("- [2026-07-20] Trying a new recipe next week. [resolved 2026-07-25]");
  });

  test("renders a tokens section with pending, spent, and expired buckets", () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = ledger.createNode({
      person: "a", domain: "daily-life", subdomain: "gym", summary: "s", eventDate: null, at: "t0",
    });
    // Pending: unspent, inside the fireable window relative to "today".
    ledger.mintToken(nodeId, "2026-07-28", "t1");
    // Spent: fired already.
    ledger.mintToken(nodeId, "2026-07-10", "t2");
    const spentToken = ledger.tokensForNode(nodeId).find((t) => t.eventDate === "2026-07-10");
    ledger.spendToken(spentToken!.id, "t3");
    // Expired: unspent and older than the default 3-day token window.
    ledger.mintToken(nodeId, "2026-07-01", "t4");

    const out = renderGraph(ledger, "a", "2026-07-29");
    expect(out).toContain("tokens:");
    expect(out).toContain(`[${nodeId}] pending 2026-07-28`);
    expect(out).toContain(`[${nodeId}] spent 2026-07-10`);
    expect(out).toContain(`[${nodeId}] expired 2026-07-01`);
  });

  test("lists mood_signal signals before prompt_preference signals, each in their own date order", () => {
    const ledger = Ledger.open(":memory:");
    ledger.addSignal({ person: "a", kind: "prompt_preference", text: "Enjoyed the family-traditions style of question.", observedDate: "2026-07-22", at: "t1" });
    ledger.addSignal({ person: "a", kind: "mood_signal", text: "Seems tired this week.", observedDate: "2026-07-25", at: "t2" });

    const out = renderGraph(ledger, "a", "2026-07-29");
    const moodIdx = out.indexOf("[mood_signal 2026-07-25]");
    const prefIdx = out.indexOf("[prompt_preference 2026-07-22]");
    expect(moodIdx).toBeGreaterThan(-1);
    expect(prefIdx).toBeGreaterThan(-1);
    expect(moodIdx).toBeLessThan(prefIdx);
    expect(out).toContain("totals: 0 nodes across 0 domains, 0 facts, 2 signals");
  });

  test("does not touch the other person's data", () => {
    const ledger = Ledger.open(":memory:");
    ledger.createNode({ person: "b", domain: "family", subdomain: "cora", summary: "Cora.", eventDate: null, at: "t0" });
    const out = renderGraph(ledger, "a", "2026-07-29");
    expect(out).not.toContain("cora");
    expect(out).toContain("totals: 0 nodes across 0 domains, 0 facts, 0 signals");
  });

  test("the trailing seeds line reports loaded count and this person's used count", () => {
    const ledger = Ledger.open(":memory:");
    ledger.replaceSeeds([
      { id: 1, text: "seed one", domain: "food", family: "nostalgia" },
      { id: 2, text: "seed two", domain: "money", family: "plans" },
    ]);
    ledger.recordGeneration({
      date: "2026-07-20", promptId: "g1", promptText: "seed one", model: "m", systemPrompt: "s", userPrompt: "u",
      rawResponse: "{}", rationale: "r", stance: "explore", person: "a", topic: null, targetNodeId: null,
      targetDomain: null, fellBack: false, fallbackReason: null, at: "t", lane: "explore", seedId: 1,
      askDomain: "food", askFamily: "nostalgia",
    });

    const out = renderGraph(ledger, "a", "2026-07-29");
    expect(out).toContain("seeds: 2 loaded, 1 used by a");
  });
});
