import { describe, expect, test } from "bun:test";
import { renderGraph } from "../scripts/print-graph";
import { Ledger } from "../src/ledger/ledger";

describe("renderGraph", () => {
  test("renders an empty graph with zero totals and no domain sections", () => {
    const ledger = Ledger.open(":memory:");
    const out = renderGraph(ledger, "a", "2026-07-29");
    expect(out).toContain("=== person a ===");
    expect(out).toContain("signals:");
    expect(out).toContain("totals: 0 nodes across 0 domains, 0 facts, 0 signals");
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

    expect(out).toContain(`[${backId}] back-pain  status=open  last_asked=-`);
    expect(out).toContain(`last_asked=2026-07-20`); // gym, via recordAsked
    expect(out).toContain(`facts=2`);
    expect(out).toContain("- [2026-07-28] Has back pain from bench pressing.");
    expect(out).toContain("- [2026-07-28] Plans to try dead hangs and stretching.");

    expect(out).toContain(`totals: 2 nodes across 2 domains, 3 facts, 0 signals`);
  });

  test("renders yield as - when null and as a rounded number when present", () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = ledger.createNode({
      person: "a", domain: "daily-life", subdomain: "cooking", summary: "Likes to cook.", eventDate: null, at: "t0",
    });
    let out = renderGraph(ledger, "a", "2026-07-29");
    expect(out).toContain("yield=-");

    ledger.recordYieldForNode(nodeId, "a", "2026-07-20", 342);
    out = renderGraph(ledger, "a", "2026-07-29");
    expect(out).toContain("yield=342");
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
});
