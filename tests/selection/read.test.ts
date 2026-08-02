import { beforeEach, describe, expect, test } from "bun:test";
import { Ledger } from "../../src/ledger/ledger";
import { buildSelectionInput } from "../../src/selection/read";
import type { SelectionConstants } from "../../src/selection/types";

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

let ledger: Ledger;

beforeEach(() => {
  ledger = Ledger.open(":memory:");
});

describe("buildSelectionInput", () => {
  test("reads both people's nodes via selectableNodes", () => {
    const nodeIdA = ledger.createNode({
      person: "a",
      domain: "hobbies-interests",
      subdomain: "guitar",
      summary: "learning guitar",
      eventDate: null,
      family: "play",
      at: "2026-07-01T00:00:00Z",
    });
    ledger.setNodeBudget(nodeIdA, 2, "2026-07-01T00:00:00Z");
    const nodeIdB = ledger.createNode({
      person: "b",
      domain: "career-academics",
      subdomain: "new job",
      summary: "new job at acme",
      eventDate: null,
      family: "work-school",
      at: "2026-07-01T00:00:00Z",
    });
    ledger.setNodeBudget(nodeIdB, 2, "2026-07-01T00:00:00Z");

    const input = buildSelectionInput(ledger, "2026-08-01", CONSTANTS);
    expect(input.nodes.a.map((n) => n.id)).toEqual([nodeIdA]);
    expect(input.nodes.b.map((n) => n.id)).toEqual([nodeIdB]);
    expect(input.today).toBe("2026-08-01");
    expect(input.constants).toEqual(CONSTANTS);
  });

  test("reads fireable tokens via the configured tokenWindowDays", () => {
    const nodeId = ledger.createNode({
      person: "a",
      domain: "hobbies-interests",
      subdomain: "concert",
      summary: "going to a concert",
      eventDate: "2026-07-30",
      family: "events-outings",
      at: "2026-07-25T00:00:00Z",
    });
    ledger.mintToken(nodeId, "2026-07-30", "2026-07-30T00:00:00Z");

    const input = buildSelectionInput(ledger, "2026-08-01", CONSTANTS);
    expect(input.tokens).toHaveLength(1);
    expect(input.tokens[0]!.nodeId).toBe(nodeId);
  });

  test("reads the seed bank via allSeeds", () => {
    ledger.replaceSeeds([
      { id: 1, text: "What's your favorite meal?", domain: "food", family: "food" },
      { id: 2, text: "What's a song you love?", domain: "media", family: "media" },
    ]);
    const input = buildSelectionInput(ledger, "2026-08-01", CONSTANTS);
    expect(input.seeds.map((s) => s.id)).toEqual([1, 2]);
  });

  test("reads used seed ids within seedReuseDays, per person", () => {
    const day = ledger.createDay("2026-07-15", "p1", "theme", "t");
    ledger.recordGeneration({
      date: "2026-07-15",
      promptId: "gen-1",
      promptText: "q",
      model: null,
      systemPrompt: null,
      userPrompt: null,
      rawResponse: null,
      rationale: null,
      stance: "explore",
      person: "a",
      targetNodeId: null,
      targetDomain: "food",
      topic: null,
      fellBack: false,
      fallbackReason: null,
      at: "2026-07-15T00:00:00Z",
      lane: "explore",
      seedId: 42,
      askDomain: "food",
      askFamily: "food",
    });
    void day;

    const input = buildSelectionInput(ledger, "2026-08-01", CONSTANTS);
    expect(input.usedSeedIds.a.has(42)).toBe(true);
    expect(input.usedSeedIds.b.has(42)).toBe(false);
  });

  test("used seed ids fall out of the window once seedReuseDays has passed", () => {
    ledger.createDay("2026-01-01", "p1", "theme", "t");
    ledger.recordGeneration({
      date: "2026-01-01",
      promptId: "gen-1",
      promptText: "q",
      model: null,
      systemPrompt: null,
      userPrompt: null,
      rawResponse: null,
      rationale: null,
      stance: "explore",
      person: "a",
      targetNodeId: null,
      targetDomain: "food",
      topic: null,
      fellBack: false,
      fallbackReason: null,
      at: "2026-01-01T00:00:00Z",
      lane: "explore",
      seedId: 42,
      askDomain: "food",
      askFamily: "food",
    });

    const input = buildSelectionInput(ledger, "2026-08-01", CONSTANTS); // far more than 90 days later
    expect(input.usedSeedIds.a.has(42)).toBe(false);
  });

  test("reads deduped ask history via recentAsks (fallback rows excluded)", () => {
    ledger.createDay("2026-07-30", "p1", "theme", "t");
    ledger.recordGeneration({
      date: "2026-07-30",
      promptId: "gen-1",
      promptText: "q",
      model: null,
      systemPrompt: null,
      userPrompt: null,
      rawResponse: null,
      rationale: null,
      stance: "exploit",
      person: "a",
      targetNodeId: 1,
      targetDomain: "hobbies-interests",
      topic: null,
      fellBack: false,
      fallbackReason: null,
      at: "2026-07-30T00:00:00Z",
      lane: "exploit",
      seedId: null,
      askDomain: "hobbies-interests",
      askFamily: "play",
    });
    ledger.recordGeneration({
      date: "2026-07-30",
      promptId: null,
      promptText: "fallback question",
      model: null,
      systemPrompt: null,
      userPrompt: null,
      rawResponse: null,
      rationale: null,
      stance: null,
      person: null,
      targetNodeId: null,
      targetDomain: null,
      topic: null,
      fellBack: true,
      fallbackReason: "generator failed",
      at: "2026-07-30T00:01:00Z",
      lane: null,
      seedId: null,
      askDomain: null,
      askFamily: null,
    });

    const input = buildSelectionInput(ledger, "2026-08-01", CONSTANTS);
    expect(input.asks).toHaveLength(1);
    expect(input.asks[0]!.person).toBe("a");
    expect(input.asks[0]!.askDomain).toBe("hobbies-interests");
  });
});
