import { describe, expect, test } from "bun:test";
import { AdaptivePromptSource, type SelectionDeps } from "../src/prompts/adaptive";
import { Ledger, type NodeDomain } from "../src/ledger/ledger";
import type { PersonId } from "../src/config";
import type { LlmClient } from "../src/llm/types";
import type { Candidate, Selection, SelectionConstants, SelectionInput, SeedRow } from "../src/selection/types";

function scriptedLlm(behavior: (userPrompt: string) => string | Promise<string>) {
  const calls: { system: string; user: string }[] = [];
  const client: LlmClient = {
    async complete(system, user) {
      calls.push({ system, user });
      return behavior(user);
    },
  };
  return { client, calls };
}

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

const emptySelectionInput = (today: string): SelectionInput => ({
  nodes: { a: [], b: [] },
  asks: [],
  seeds: [],
  usedSeedIds: { a: new Set(), b: new Set() },
  tokens: [],
  constants: CONSTANTS,
  today,
});

const emptyBackground: Selection["background"] = { a: [], b: [] };

/** Builds an "exploit" (lane 1) candidate from a node already filed in the
 * ledger, reading it back through the real selectableNodes shape so tests
 * exercise the exact fields production reads. */
function exploitCandidate(ledger: Ledger, person: PersonId, nodeId: number): Candidate {
  const node = ledger.selectableNodes(person).find((n) => n.id === nodeId)!;
  return { person, lane: "exploit", node, seed: null, token: null, domain: node.domain, family: node.family };
}

/** Builds a "followup" (lane 0) candidate: mints a real token in the ledger
 * and reads it back via fireableTokens, matching Candidate's own contract
 * that a followup candidate carries a token, not a SelectableNode. */
function followupCandidate(
  ledger: Ledger,
  person: PersonId,
  nodeId: number,
  eventDate: string,
  today: string,
): Candidate {
  ledger.mintToken(nodeId, eventDate, "t0");
  const token = ledger.fireableTokens(today, CONSTANTS.tokenWindowDays).find((t) => t.nodeId === nodeId)!;
  const node = ledger.selectableNodes(person).find((n) => n.id === nodeId)!;
  return { person, lane: "followup", node: null, seed: null, token, domain: node.domain, family: node.family };
}

function exploreCandidate(person: PersonId, seed: SeedRow): Candidate {
  return { person, lane: "explore", node: null, seed, token: null, domain: seed.domain, family: seed.family };
}

function seedNode(
  ledger: Ledger,
  person: PersonId,
  opts: { domain?: NodeDomain; subdomain?: string; summary?: string; facts?: { date: string; text: string }[] } = {},
): number {
  const id = ledger.createNode({
    person,
    domain: opts.domain ?? "career-academics",
    subdomain: opts.subdomain ?? "thesis-defense",
    summary: opts.summary ?? "Thesis defense coming up in August.",
    eventDate: null,
    at: "t",
  });
  for (const f of opts.facts ?? [{ date: "2026-07-10", text: "Nervous about their defense in August." }]) {
    ledger.addNodeFact({ nodeId: id, kind: "fact", text: f.text, sourceDayId: 1, observedDate: f.date, at: "t" });
  }
  return id;
}

function makeSeed(ledger: Ledger, id: number, text: string, domain: string, family: string): SeedRow {
  ledger.replaceSeeds([{ id, text, domain, family }]);
  return ledger.allSeeds().find((s) => s.id === id)!;
}

function expectedFields(c: Candidate): { targetNodeId: number | null; seedId: number | null } {
  if (c.lane === "explore") return { targetNodeId: null, seedId: c.seed!.id };
  const nodeId = c.node?.id ?? c.token?.nodeId ?? null;
  return { targetNodeId: nodeId, seedId: null };
}

function responseFor(
  sel: Selection,
  opts: {
    aPrompt: string;
    bPrompt: string;
    theme?: string | null;
    usedIdeaId?: number | null;
    aTargetNodeId?: number | null;
    aSeedId?: number | null;
    bTargetNodeId?: number | null;
    bSeedId?: number | null;
  },
): string {
  const expectedA = expectedFields(sel.a);
  const expectedB = expectedFields(sel.b);
  return JSON.stringify({
    theme: opts.theme === undefined ? "shared theme" : opts.theme,
    a: {
      prompt: opts.aPrompt,
      targetNodeId: opts.aTargetNodeId !== undefined ? opts.aTargetNodeId : expectedA.targetNodeId,
      seedId: opts.aSeedId !== undefined ? opts.aSeedId : expectedA.seedId,
    },
    b: {
      prompt: opts.bPrompt,
      targetNodeId: opts.bTargetNodeId !== undefined ? opts.bTargetNodeId : expectedB.targetNodeId,
      seedId: opts.bSeedId !== undefined ? opts.bSeedId : expectedB.seedId,
    },
    rationale: "test rationale",
    usedIdeaId: opts.usedIdeaId ?? null,
  });
}

function makeSource(
  ledger: Ledger,
  client: LlmClient,
  sel: Selection,
  overrides: Partial<SelectionDeps> = {},
): AdaptivePromptSource {
  const deps: SelectionDeps = {
    buildSelectionInput: (date) => emptySelectionInput(date),
    selectPair: () => sel,
    checkAnchor: () => true,
    ...overrides,
  };
  return new AdaptivePromptSource(deps, client, ledger, {
    model: "test-model",
    historyWindowDays: 14,
    feedbackWindowDays: 14,
    names: { a: "Alex", b: "Sam" },
    constants: CONSTANTS,
  });
}

describe("AdaptivePromptSource happy path", () => {
  test("an exploit/explore pair produces DailyPrompts and echoes the assigned target ids", async () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = seedNode(ledger, "a");
    const seed = makeSeed(ledger, 1, "What's your favorite way to spend a lazy Sunday?", "daily-life", "plans");
    const sel: Selection = { a: exploitCandidate(ledger, "a", nodeId), b: exploreCandidate("b", seed), relaxations: [], background: emptyBackground };

    const { client, calls } = scriptedLlm(() => responseFor(sel, { aPrompt: "How did the defense go?", bPrompt: "What's your favorite lazy Sunday?" }));
    const result = await makeSource(ledger, client, sel).nextPrompts("2026-07-20");

    expect(calls.length).toBe(1);
    expect(result.prompts.a).toEqual({ id: "gen-2026-07-20-a", text: "How did the defense go?" });
    expect(result.prompts.b).toEqual({ id: "gen-2026-07-20-b", text: "What's your favorite lazy Sunday?" });
    expect(result.theme).toBe("shared theme");
  });

  test("a followup (lane 0) target is built from the token's node and echoed as targetNodeId", async () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = seedNode(ledger, "a", { summary: "Cora's psychic party was last weekend." });
    const seed = makeSeed(ledger, 2, "What's a small ritual you love?", "daily-mechanics", "home");
    const sel: Selection = {
      a: followupCandidate(ledger, "a", nodeId, "2026-07-19", "2026-07-20"),
      b: exploreCandidate("b", seed),
      relaxations: [],
      background: emptyBackground,
    };
    const { client, calls } = scriptedLlm(() => responseFor(sel, { aPrompt: "How did the psychic party go?", bPrompt: "What's a small ritual you love?" }));
    const result = await makeSource(ledger, client, sel).nextPrompts("2026-07-20");
    expect(result.prompts.a.text).toBe("How did the psychic party go?");
    expect(calls[0]!.user).toContain(`[node ${nodeId}]`);
  });

  test("the writer prompt renders the node's dated kind-tagged facts, not a candidate menu", async () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = seedNode(ledger, "a", { facts: [{ date: "2026-07-10", text: "Bakes sourdough most weekends." }] });
    const seed = makeSeed(ledger, 3, "What's a place you keep meaning to visit?", "plans", "plans");
    const sel: Selection = { a: exploitCandidate(ledger, "a", nodeId), b: exploreCandidate("b", seed), relaxations: [], background: emptyBackground };
    const { client, calls } = scriptedLlm(() => responseFor(sel, { aPrompt: "How's the sourdough going?", bPrompt: "Anywhere you'd love to visit?" }));
    await makeSource(ledger, client, sel).nextPrompts("2026-07-20");
    expect(calls[0]!.user).toContain("[2026-07-10] (fact) Bakes sourdough most weekends.");
    expect(calls[0]!.user).not.toContain("EXPLOIT CANDIDATES");
    expect(calls[0]!.user).not.toContain("EXPLORE CANDIDATES");
    expect(calls[0]!.user).not.toContain("OFF LIMITS");
  });
});

describe("bookkeeping", () => {
  test("records lane, target ids, seedId, askDomain, askFamily and stance backward-compat values on both rows", async () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = seedNode(ledger, "a", { domain: "career-academics" });
    const seed = makeSeed(ledger, 4, "What's your comfort food?", "food", "food");
    const sel: Selection = { a: exploitCandidate(ledger, "a", nodeId), b: exploreCandidate("b", seed), relaxations: [], background: emptyBackground };
    const { client } = scriptedLlm(() => responseFor(sel, { aPrompt: "How did the defense go?", bPrompt: "What's your comfort food?" }));
    await makeSource(ledger, client, sel).nextPrompts("2026-07-20");

    const rows = ledger.generationLogFor("2026-07-20");
    const rowA = rows.find((r) => r.person === "a")!;
    const rowB = rows.find((r) => r.person === "b")!;
    expect(rowA).toMatchObject({ lane: "exploit", targetNodeId: nodeId, seedId: null, askDomain: "career-academics", stance: "exploit" });
    expect(rowB).toMatchObject({ lane: "explore", targetNodeId: null, seedId: seed.id, askDomain: "food", askFamily: "food", stance: "explore" });
  });

  test("a followup lane row records stance exploit (the two-way backward-compat label) with lane followup", async () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = seedNode(ledger, "a");
    const seed = makeSeed(ledger, 5, "What's a book on your shelf you haven't read?", "media", "media");
    const sel: Selection = {
      a: followupCandidate(ledger, "a", nodeId, "2026-07-19", "2026-07-20"),
      b: exploreCandidate("b", seed),
      relaxations: [],
      background: emptyBackground,
    };
    const { client } = scriptedLlm(() => responseFor(sel, { aPrompt: "How did it go?", bPrompt: "What book is next?" }));
    await makeSource(ledger, client, sel).nextPrompts("2026-07-20");
    const rowA = ledger.generationLogFor("2026-07-20").find((r) => r.person === "a")!;
    expect(rowA.lane).toBe("followup");
    expect(rowA.stance).toBe("exploit");
  });

  test("an exploit (lane 1) target decrements budget and records last_asked via recordAsk", async () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = seedNode(ledger, "a");
    ledger.setNodeBudget(nodeId, 2, "t");
    const seed = makeSeed(ledger, 6, "What's your favorite smell?", "nostalgia", "nostalgia");
    const sel: Selection = { a: exploitCandidate(ledger, "a", nodeId), b: exploreCandidate("b", seed), relaxations: [], background: emptyBackground };
    const { client } = scriptedLlm(() => responseFor(sel, { aPrompt: "How did the defense go?", bPrompt: "What's your favorite smell?" }));
    await makeSource(ledger, client, sel).nextPrompts("2026-07-20");
    const node = ledger.nodesFor("a").find((n) => n.id === nodeId)!;
    expect(node.lastAsked).toBe("2026-07-20");
    expect(node.budget).toBe(1);
  });

  test("a followup (lane 0) target spends the token and skips recordAsk entirely, so budget does not move", async () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = seedNode(ledger, "a");
    ledger.setNodeBudget(nodeId, 2, "t");
    const seed = makeSeed(ledger, 7, "What's a scent that brings back a memory?", "nostalgia", "nostalgia");
    const followup = followupCandidate(ledger, "a", nodeId, "2026-07-19", "2026-07-20");
    const sel: Selection = { a: followup, b: exploreCandidate("b", seed), relaxations: [], background: emptyBackground };
    const { client } = scriptedLlm(() => responseFor(sel, { aPrompt: "How did it go?", bPrompt: "What scent takes you back?" }));
    await makeSource(ledger, client, sel).nextPrompts("2026-07-20");

    const node = ledger.nodesFor("a").find((n) => n.id === nodeId)!;
    // Budget and last_asked are untouched: recordAsk was never called.
    expect(node.budget).toBe(2);
    expect(node.lastAsked).toBeNull();
    const spent = ledger.fireableTokens("2026-07-23", 10).find((t) => t.id === followup.token!.id);
    expect(spent).toBeUndefined(); // fireableTokens only returns unspent tokens
  });

  test("using an unconsumed prompt idea marks it consumed", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t");
    const ideaId = ledger.addPromptIdea("a", "ask about our Tokyo trip", day.id, "t1");
    const nodeId = seedNode(ledger, "a");
    const seed = makeSeed(ledger, 8, "What's a trip you'd love to take?", "plans", "plans");
    const sel: Selection = { a: exploitCandidate(ledger, "a", nodeId), b: exploreCandidate("b", seed), relaxations: [], background: emptyBackground };
    const { client } = scriptedLlm(() => responseFor(sel, { aPrompt: "How's Tokyo trip planning going?", bPrompt: "What's a trip you'd love?", usedIdeaId: ideaId }));
    await makeSource(ledger, client, sel).nextPrompts("2026-07-20");
    expect(ledger.unconsumedPromptIdeas("a")).toEqual([]);
  });
});

describe("strict-equality target validation", () => {
  test("a mismatched targetNodeId is rejected and retried with the reason in the next attempt", async () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = seedNode(ledger, "a");
    const seed = makeSeed(ledger, 9, "What did you cook this week?", "food", "food");
    const sel: Selection = { a: exploitCandidate(ledger, "a", nodeId), b: exploreCandidate("b", seed), relaxations: [], background: emptyBackground };
    let call = 0;
    const { client, calls } = scriptedLlm(() => {
      call++;
      return call === 1
        ? responseFor(sel, { aPrompt: "How did the defense go?", bPrompt: "What did you cook?", aTargetNodeId: 4242 })
        : responseFor(sel, { aPrompt: "How did the defense go?", bPrompt: "What did you cook?" });
    });
    const result = await makeSource(ledger, client, sel).nextPrompts("2026-07-20");
    expect(call).toBe(2);
    expect(result.prompts.a.text).toBe("How did the defense go?");
    expect(calls[1]!.user).toContain("PREVIOUS ATTEMPT WAS REJECTED");
    expect(calls[1]!.user).toContain("declared targetNodeId 4242");
  });

  test("a FINAL-attempt target mismatch throws instead of shipping unattributed", async () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = seedNode(ledger, "a");
    const seed = makeSeed(ledger, 10, "What's a good song right now?", "media", "media");
    const sel: Selection = { a: exploitCandidate(ledger, "a", nodeId), b: exploreCandidate("b", seed), relaxations: [], background: emptyBackground };
    const { client, calls } = scriptedLlm(() =>
      responseFor(sel, { aPrompt: "How did the defense go?", bPrompt: "Favorite song?", aTargetNodeId: 4242 }),
    );
    await expect(makeSource(ledger, client, sel).nextPrompts("2026-07-20")).rejects.toThrow(/FINAL-attempt target mismatch/);
    expect(calls.length).toBe(4); // MAX_ATTEMPTS: the miss burns every retry before throwing
    // Nothing was recorded: the caller (FallbackPromptSource) is what
    // degrades, and it must see no partial generation_log row.
    expect(ledger.generationLogFor("2026-07-20")).toEqual([]);
  });

  test("declaring both targetNodeId and seedId is rejected", async () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = seedNode(ledger, "a");
    const seed = makeSeed(ledger, 11, "What's your go-to snack?", "food", "food");
    const sel: Selection = { a: exploitCandidate(ledger, "a", nodeId), b: exploreCandidate("b", seed), relaxations: [], background: emptyBackground };
    let call = 0;
    const { client } = scriptedLlm(() => {
      call++;
      return call === 1
        ? responseFor(sel, { aPrompt: "How did the defense go?", bPrompt: "Go-to snack?", aSeedId: 999 })
        : responseFor(sel, { aPrompt: "How did the defense go?", bPrompt: "Go-to snack?" });
    });
    await makeSource(ledger, client, sel).nextPrompts("2026-07-20");
    expect(call).toBe(2);
  });
});

describe("anchor check", () => {
  test("an anchor miss on an exploit target retries with a reason, and passes once the anchor check returns true", async () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = seedNode(ledger, "a");
    const seed = makeSeed(ledger, 12, "What's a hobby you'd like to pick up?", "play", "play");
    const sel: Selection = { a: exploitCandidate(ledger, "a", nodeId), b: exploreCandidate("b", seed), relaxations: [], background: emptyBackground };
    let anchorCalls = 0;
    const checkAnchor = () => {
      anchorCalls++;
      return anchorCalls > 1; // fails once, then passes
    };
    const { client, calls } = scriptedLlm(() => responseFor(sel, { aPrompt: "How did the defense go?", bPrompt: "New hobby?" }));
    const result = await makeSource(ledger, client, sel, { checkAnchor }).nextPrompts("2026-07-20");
    expect(calls.length).toBe(2);
    expect(calls[1]!.user).toContain("shares no content word");
    expect(result.prompts.a.text).toBe("How did the defense go?");
  });

  test("the anchor check is never called for an explore (seed) target, which is anchored by construction", async () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = seedNode(ledger, "a");
    const seed = makeSeed(ledger, 13, "What's a smell that takes you back?", "nostalgia", "nostalgia");
    // Both people explore this time, so no node target exists to anchor.
    const seedB = makeSeed(ledger, 14, "What's your comfort show?", "media", "media");
    const sel: Selection = { a: exploreCandidate("a", seed), b: exploreCandidate("b", seedB), relaxations: [], background: emptyBackground };
    let anchorCalls = 0;
    const { client } = scriptedLlm(() => responseFor(sel, { aPrompt: "What's a smell that takes you back?", bPrompt: "Comfort show?" }));
    await makeSource(ledger, client, sel, { checkAnchor: () => { anchorCalls++; return true; } }).nextPrompts("2026-07-20");
    expect(anchorCalls).toBe(0);
  });

  test("an anchor miss on the final attempt still ships (bypass, like the other wording guards)", async () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = seedNode(ledger, "a");
    const seed = makeSeed(ledger, 15, "What's a small treat you love?", "food", "food");
    const sel: Selection = { a: exploitCandidate(ledger, "a", nodeId), b: exploreCandidate("b", seed), relaxations: [], background: emptyBackground };
    const { client, calls } = scriptedLlm(() => responseFor(sel, { aPrompt: "How did the defense go?", bPrompt: "Small treat?" }));
    const result = await makeSource(ledger, client, sel, { checkAnchor: () => false }).nextPrompts("2026-07-20");
    expect(calls.length).toBe(4);
    expect(result.prompts.a.text).toBe("How did the defense go?");
  });
});

describe("wording guards survive", () => {
  test("retries when person A's generated prompt near-duplicates one already sent to A", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-19", "p1", "What's an unexpected sound or noise you secretly enjoy?", "t");
    ledger.resolveDay(day.id, "resolved_shared", "t2");
    const nodeId = seedNode(ledger, "a");
    const seed = makeSeed(ledger, 16, "What's your favorite drink?", "food", "food");
    const sel: Selection = { a: exploitCandidate(ledger, "a", nodeId), b: exploreCandidate("b", seed), relaxations: [], background: emptyBackground };
    let call = 0;
    const { client } = scriptedLlm(() => {
      call++;
      return call === 1
        ? responseFor(sel, { aPrompt: "What's an unexpected sound you secretly enjoy?", bPrompt: "What's your favorite drink?" })
        : responseFor(sel, { aPrompt: "How did the defense go?", bPrompt: "What's your favorite drink?" });
    });
    const result = await makeSource(ledger, client, sel).nextPrompts("2026-07-20");
    expect(call).toBe(2);
    expect(result.prompts.a.text).toBe("How did the defense go?");
  });

  test("retries when a prompt reuses the opening frame of a recent question", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-19", "p1", "theme", "t");
    ledger.setPersonPrompt(day.id, "a", "g", "What's one thing you're improving?");
    ledger.resolveDay(day.id, "resolved_shared", "t2");
    const nodeId = seedNode(ledger, "a");
    const seed = makeSeed(ledger, 17, "How was the show?", "media", "media");
    const sel: Selection = { a: exploitCandidate(ledger, "a", nodeId), b: exploreCandidate("b", seed), relaxations: [], background: emptyBackground };
    let call = 0;
    const { client } = scriptedLlm(() => {
      call++;
      return call === 1
        ? responseFor(sel, { aPrompt: "What's one thing you're avoiding?", bPrompt: "How was the show?" })
        : responseFor(sel, { aPrompt: "When did you last surprise yourself?", bPrompt: "How was the show?" });
    });
    const result = await makeSource(ledger, client, sel).nextPrompts("2026-07-20");
    expect(call).toBe(2);
    expect(result.prompts.a.text).toBe("When did you last surprise yourself?");
  });

  test("retries when the day's shared angle repeats a recent one", async () => {
    const ledger = Ledger.open(":memory:");
    ledger.createDay("2026-07-19", "p1", "label", "t", "personal growth and improvement");
    const nodeId = seedNode(ledger, "a");
    const seed = makeSeed(ledger, 18, "What did you cook?", "food", "food");
    const sel: Selection = { a: exploitCandidate(ledger, "a", nodeId), b: exploreCandidate("b", seed), relaxations: [], background: emptyBackground };
    let call = 0;
    const { client } = scriptedLlm(() => {
      call++;
      return call === 1
        ? responseFor(sel, { aPrompt: "How are you growing?", bPrompt: "What are you learning?", theme: "personal improvement journey" })
        : responseFor(sel, { aPrompt: "How did the defense go?", bPrompt: "What did you cook?", theme: "food and eating out" });
    });
    const result = await makeSource(ledger, client, sel).nextPrompts("2026-07-20");
    expect(call).toBe(2);
    expect(result.theme).toBe("food and eating out");
  });
});

describe("failure handling", () => {
  test("throws when the LLM call itself rejects", async () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = seedNode(ledger, "a");
    const seed = makeSeed(ledger, 19, "What's your ideal breakfast?", "food", "food");
    const sel: Selection = { a: exploitCandidate(ledger, "a", nodeId), b: exploreCandidate("b", seed), relaxations: [], background: emptyBackground };
    const client: LlmClient = { async complete() { throw new Error("network down"); } };
    await expect(makeSource(ledger, client, sel).nextPrompts("2026-07-20")).rejects.toThrow(/network down/);
  });

  test("throws when the LLM response is not valid JSON after retries are exhausted", async () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = seedNode(ledger, "a");
    const seed = makeSeed(ledger, 20, "What's your ideal breakfast?", "food", "food");
    const sel: Selection = { a: exploitCandidate(ledger, "a", nodeId), b: exploreCandidate("b", seed), relaxations: [], background: emptyBackground };
    const { client } = scriptedLlm(() => "not json");
    await expect(makeSource(ledger, client, sel).nextPrompts("2026-07-20")).rejects.toThrow();
  });

  test("does not record a generation_log row when generation throws (log-on-success-only)", async () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = seedNode(ledger, "a");
    const seed = makeSeed(ledger, 21, "What's your ideal breakfast?", "food", "food");
    const sel: Selection = { a: exploitCandidate(ledger, "a", nodeId), b: exploreCandidate("b", seed), relaxations: [], background: emptyBackground };
    const { client } = scriptedLlm(() => "not json");
    await expect(makeSource(ledger, client, sel).nextPrompts("2026-07-20")).rejects.toThrow();
    expect(ledger.generationLogFor("2026-07-20")).toEqual([]);
  });

  test("propagates when buildSelectionInput throws", async () => {
    const ledger = Ledger.open(":memory:");
    const { client } = scriptedLlm(() => "irrelevant");
    const deps: SelectionDeps = {
      buildSelectionInput: () => { throw new Error("selection read failed"); },
      selectPair: () => { throw new Error("unreachable"); },
      checkAnchor: () => true,
    };
    const source = new AdaptivePromptSource(deps, client, ledger, {
      model: "m", historyWindowDays: 14, feedbackWindowDays: 14, names: { a: "Alex", b: "Sam" }, constants: CONSTANTS,
    });
    await expect(source.nextPrompts("2026-07-20")).rejects.toThrow(/selection read failed/);
  });
});

describe("background rendering", () => {
  test("a person's background nodes render as not-targetable and appear in their own section only", async () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = seedNode(ledger, "a");
    const seed = makeSeed(ledger, 22, "What's your favorite room in your place?", "home", "home");
    const sel: Selection = {
      a: exploitCandidate(ledger, "a", nodeId),
      b: exploreCandidate("b", seed),
      relaxations: [],
      background: { a: [{ domain: "childhood", subdomain: "hometown" }], b: [] },
    };
    const { client, calls } = scriptedLlm(() => responseFor(sel, { aPrompt: "How did the defense go?", bPrompt: "Favorite room?" }));
    await makeSource(ledger, client, sel).nextPrompts("2026-07-20");
    const alexSection = calls[0]!.user.slice(calls[0]!.user.indexOf("PERSON A:"), calls[0]!.user.indexOf("PERSON B:"));
    expect(alexSection).toContain("BACKGROUND (do not target):");
    expect(alexSection).toContain("childhood / hometown");
  });
});
