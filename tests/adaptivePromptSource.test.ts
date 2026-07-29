import { describe, expect, test } from "bun:test";
import { AdaptivePromptSource } from "../src/prompts/adaptive";
import { Ledger, type NodeDomain } from "../src/ledger/ledger";
import { LedgerOntology } from "../src/ontology/ledgerOntology";
import type { OntologyView } from "../src/ontology/types";
import type { PersonId } from "../src/config";
import type { LlmClient } from "../src/llm/types";

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

/** The explore list is the thinnest domains, so for a person with no nodes at
 * all every domain ties at zero and ALL_DOMAINS order breaks the tie. This is
 * the first entry, hence always offered to an empty person. */
const OFFERED_DOMAIN = "career-academics";

/** A domain deliberately absent from an empty person's offered explore list
 * (which holds only the first three), for the unoffered-target cases. */
const UNOFFERED_DOMAIN = "health-body";

/** Exactly one target may be non-null and it must match the assigned stance,
 * so citing a node id clears the domain rather than leaving both set. */
const target = (nodeId: number | null | undefined, explore: string | null | undefined) =>
  nodeId != null
    ? { targetNodeId: nodeId, targetExplore: null }
    : { targetNodeId: null, targetExplore: explore === undefined ? OFFERED_DOMAIN : explore };

function okResponse(opts: {
  a: string;
  b: string;
  theme?: string | null;
  usedIdeaId?: number | null;
  stanceA?: string;
  stanceB?: string;
  topicA?: string;
  topicB?: string;
  targetNodeIdA?: number | null;
  targetNodeIdB?: number | null;
  targetExploreA?: string | null;
  targetExploreB?: string | null;
}) {
  const {
    a, b, theme = "shared theme", usedIdeaId = null,
    stanceA = "explore", stanceB = "explore",
    // Distinct by default so the topic-repeat guard does not fire on
    // fixtures that are not about topic repetition.
    topicA = "topic-a", topicB = "topic-b",
    targetNodeIdA, targetNodeIdB, targetExploreA, targetExploreB,
  } = opts;
  return JSON.stringify({
    theme,
    a: { prompt: a, stance: stanceA, topic: topicA, ...target(targetNodeIdA, targetExploreA) },
    b: { prompt: b, stance: stanceB, topic: topicB, ...target(targetNodeIdB, targetExploreB) },
    rationale: "test rationale",
    usedIdeaId,
  });
}

function makeSource(ledger: Ledger, client: LlmClient) {
  return new AdaptivePromptSource(new LedgerOntology(ledger), client, ledger, {
    model: "test-model",
    historyWindowDays: 14,
    feedbackWindowDays: 14,
    contextBudgetChars: 3000,
    names: { a: "Alex", b: "Sam" },
  });
}

/** An open node out of cooldown IS exploitability now, so seeding one is the
 * whole mechanism for making a person exploitable (it replaces seeding a
 * "thread" observation into a memory backend). */
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
  for (const f of opts.facts ?? [{ date: "2026-07-19", text: "Nervous about their defense in August." }]) {
    ledger.addNodeFact({ nodeId: id, kind: "fact", text: f.text, sourceDayId: 1, observedDate: f.date, at: "t" });
  }
  return id;
}

describe("AdaptivePromptSource", () => {
  test("returns DailyPrompts with per-person ids and texts on success", async () => {
    const ledger = Ledger.open(":memory:");
    const { client } = scriptedLlm(() => okResponse({ a: "What made you smile today?", b: "What made you laugh today?" }));
    const source = makeSource(ledger, client);
    const result = await source.nextPrompts("2026-07-20");
    expect(result.prompts.a).toEqual({ id: "gen-2026-07-20-a", text: "What made you smile today?" });
    expect(result.prompts.b).toEqual({ id: "gen-2026-07-20-b", text: "What made you laugh today?" });
    expect(result.theme).toBe("shared theme");
  });

  test("one LLM call produces two different prompt texts for the two people", async () => {
    const ledger = Ledger.open(":memory:");
    const { client, calls } = scriptedLlm(() => okResponse({ a: "question for Alex", b: "question for Sam" }));
    const result = await makeSource(ledger, client).nextPrompts("2026-07-20");
    expect(calls.length).toBe(1);
    expect(result.prompts.a.text).not.toBe(result.prompts.b.text);
  });

  test("reads each person's candidates so their own node facts reach the prompt", async () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = seedNode(ledger, "a", { facts: [{ date: "2026-07-18", text: "Bakes sourdough most weekends." }] });
    const { client, calls } = scriptedLlm(() => okResponse({ a: "p", b: "q", targetNodeIdA: nodeId }));
    await makeSource(ledger, client).nextPrompts("2026-07-20");
    expect(calls[0]!.user).toContain("Bakes sourdough most weekends.");
    expect(calls[0]!.user).toContain(`[node ${nodeId}]`);
  });

  test("records two generation_log rows on success, one per person, sharing model/response/rationale", async () => {
    const ledger = Ledger.open(":memory:");
    const { client } = scriptedLlm(() => okResponse({ a: "What's a small win from today?", b: "What's a small win you saw someone else have?" }));
    const source = makeSource(ledger, client);
    await source.nextPrompts("2026-07-20");
    const rows = ledger.generationLogFor("2026-07-20");
    expect(rows.length).toBe(2);
    const rowA = rows.find((r) => r.person === "a")!;
    const rowB = rows.find((r) => r.person === "b")!;
    expect(rowA).toMatchObject({
      model: "test-model",
      promptId: "gen-2026-07-20-a",
      promptText: "What's a small win from today?",
      rationale: "test rationale",
      stance: "explore",
      fellBack: false,
    });
    expect(rowB).toMatchObject({
      model: "test-model",
      promptId: "gen-2026-07-20-b",
      promptText: "What's a small win you saw someone else have?",
      rationale: "test rationale",
      stance: "explore",
      fellBack: false,
    });
  });

  test("rejects a response with no declared stance for a person, so the ratio stays measurable", async () => {
    const ledger = Ledger.open(":memory:");
    const { client } = scriptedLlm(() =>
      JSON.stringify({
        theme: "t",
        a: { prompt: "What's a small win from today?", targetNodeId: null, targetExplore: OFFERED_DOMAIN },
        b: { prompt: "What's a small win you saw?", stance: "explore", topic: "t-b", targetNodeId: null, targetExplore: OFFERED_DOMAIN },
        rationale: "r",
        usedIdeaId: null,
      }),
    );
    await expect(makeSource(ledger, client).nextPrompts("2026-07-20")).rejects.toThrow();
  });

  test("rejects a stance outside explore/exploit rather than storing free text", async () => {
    const ledger = Ledger.open(":memory:");
    const { client } = scriptedLlm(() => okResponse({ a: "What's a small win?", b: "What's a small loss?", stanceA: "a bit of both" }));
    await expect(makeSource(ledger, client).nextPrompts("2026-07-20")).rejects.toThrow();
  });

  test("a malformed response missing the b prompt is rejected", async () => {
    const ledger = Ledger.open(":memory:");
    const { client } = scriptedLlm(() =>
      JSON.stringify({ theme: "t", a: { prompt: "qa", stance: "explore" }, rationale: "r", usedIdeaId: null }),
    );
    await expect(makeSource(ledger, client).nextPrompts("2026-07-20")).rejects.toThrow();
  });

  test("on an exploit day, a person with an exploit candidate is assigned exploit while a person with none is assigned explore", async () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = seedNode(ledger, "a");
    // Declares explore for both; the assigned per-person stance is what gets
    // recorded, so a disagreeing model cannot quietly reintroduce the
    // all-explore drift.
    const { client, calls } = scriptedLlm(() =>
      okResponse({ a: "How did the defense go?", b: "What's a small win from today?", targetNodeIdA: nodeId }),
    );
    await makeSource(ledger, client).nextPrompts("2026-07-20");
    const rows = ledger.generationLogFor("2026-07-20");
    expect(rows.find((r) => r.person === "a")!.stance).toBe("exploit");
    expect(rows.find((r) => r.person === "b")!.stance).toBe("explore");
    expect(calls[0]!.user).toContain("EXPLOIT");
  });

  test("assigns explore to both people when neither has an exploit candidate", async () => {
    const ledger = Ledger.open(":memory:");
    const { client } = scriptedLlm(() => okResponse({ a: "What's a small win from today?", b: "What's a small win from today?" }));
    await makeSource(ledger, client).nextPrompts("2026-07-20");
    const rows = ledger.generationLogFor("2026-07-20");
    expect(rows.find((r) => r.person === "a")!.stance).toBe("explore");
    expect(rows.find((r) => r.person === "b")!.stance).toBe("explore");
  });

  test("retries when person A's generated prompt near-duplicates one already sent to A", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-19", "p1", "What's an unexpected sound or noise you secretly enjoy?", "t");
    ledger.resolveDay(day.id, "resolved_shared", "t2");
    let call = 0;
    const { client } = scriptedLlm(() => {
      call++;
      return call === 1
        ? okResponse({ a: "What's an unexpected sound you secretly enjoy?", b: "What's your favorite drink?" })
        : okResponse({ a: "What's a place you keep meaning to visit?", b: "What's your favorite drink?" });
    });
    const result = await makeSource(ledger, client).nextPrompts("2026-07-20");
    expect(call).toBe(2);
    expect(result.prompts.a.text).toBe("What's a place you keep meaning to visit?");
  });

  test("does not retry when A's prompt only near-duplicates something B was asked", async () => {
    // The no-repeat rule is per person now: A has never seen B's question,
    // so reusing it for A is novel to the person who receives it.
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-19", "p1", "day theme", "t");
    ledger.setPersonPrompt(day.id, "a", "p1-a", "What's a book you keep meaning to finish?");
    ledger.setPersonPrompt(day.id, "b", "p1-b", "What's an unexpected sound or noise you secretly enjoy?");
    ledger.resolveDay(day.id, "resolved_shared", "t2");
    const { client, calls } = scriptedLlm(() =>
      okResponse({ a: "What's an unexpected sound you secretly enjoy?", b: "Which room in your place do you like best?" }),
    );
    const result = await makeSource(ledger, client).nextPrompts("2026-07-20");
    expect(calls.length).toBe(1);
    expect(result.prompts.a.text).toBe("What's an unexpected sound you secretly enjoy?");
  });

  test("throws when the LLM call itself rejects", async () => {
    const ledger = Ledger.open(":memory:");
    const client: LlmClient = { async complete() { throw new Error("network down"); } };
    const source = makeSource(ledger, client);
    await expect(source.nextPrompts("2026-07-20")).rejects.toThrow(/network down/);
  });

  test("throws when the LLM response is not valid JSON after retries are exhausted", async () => {
    const ledger = Ledger.open(":memory:");
    const { client } = scriptedLlm(() => "not json");
    const source = makeSource(ledger, client);
    await expect(source.nextPrompts("2026-07-20")).rejects.toThrow();
  });

  test("retries in-process on a single transient malformed response, then succeeds", async () => {
    let calls = 0;
    const client: LlmClient = {
      async complete() {
        calls++;
        if (calls < 2) return "not json";
        return okResponse({ a: "recovered prompt a", b: "recovered prompt b" });
      },
    };
    const ledger = Ledger.open(":memory:");
    const source = makeSource(ledger, client);
    const result = await source.nextPrompts("2026-07-20");
    expect(result.prompts.a.text).toBe("recovered prompt a");
    expect(calls).toBe(2);
  });

  test("propagates when the ontology read throws, rather than generating without candidates", async () => {
    const ledger = Ledger.open(":memory:");
    const brokenOntology: OntologyView = {
      candidates() { throw new Error("ontology read failed"); },
      nodeExists() { return false; },
    };
    const { client } = scriptedLlm(() => okResponse({ a: "p", b: "q" }));
    const source = new AdaptivePromptSource(brokenOntology, client, ledger, {
      model: "m", historyWindowDays: 14, feedbackWindowDays: 14, contextBudgetChars: 3000, names: { a: "Alex", b: "Sam" },
    });
    await expect(source.nextPrompts("2026-07-20")).rejects.toThrow(/ontology read failed/);
  });

  test("day 1 / empty graph for both people still produces a valid generated pair (pure exploration)", async () => {
    const ledger = Ledger.open(":memory:");
    const { client } = scriptedLlm(() => okResponse({ a: "What's something you're curious about lately?", b: "What's something you'd like to try?" }));
    const source = makeSource(ledger, client);
    const result = await source.nextPrompts("2026-07-20");
    expect(result.prompts.a.text).toBe("What's something you're curious about lately?");
    expect(result.prompts.b.text).toBe("What's something you'd like to try?");
  });

  test("recent prompt history passed to the LLM is capped at historyWindowDays, for each person", async () => {
    const ledger = Ledger.open(":memory:");
    for (let i = 1; i <= 20; i++) {
      ledger.createDay(`2026-06-${String(i).padStart(2, "0")}`, `p${i}`, `prompt ${i}`, "t");
    }
    const { client, calls } = scriptedLlm(() => okResponse({ a: "p", b: "q" }));
    const source = new AdaptivePromptSource(new LedgerOntology(ledger), client, ledger, {
      model: "m", historyWindowDays: 3, feedbackWindowDays: 14, contextBudgetChars: 3000, names: { a: "Alex", b: "Sam" },
    });
    await source.nextPrompts("2026-07-01");
    const user = calls[0]!.user;
    const alexSection = user.slice(user.indexOf("PERSON A:"), user.indexOf("PERSON B:"));
    const historyLines = alexSection.split("\n").filter((l) => l.trim().startsWith("["));
    expect(historyLines.length).toBe(3);
  });

  test("does not record a generation_log row when generation throws (log-on-success-only)", async () => {
    const ledger = Ledger.open(":memory:");
    const { client } = scriptedLlm(() => "not json");
    const source = makeSource(ledger, client);
    await expect(source.nextPrompts("2026-07-20")).rejects.toThrow();
    expect(ledger.generationLogFor("2026-07-20")).toEqual([]);
  });

  test("using an unconsumed prompt idea marks it consumed", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t");
    const ideaId = ledger.addPromptIdea("a", "ask about our Tokyo trip", day.id, "t1");
    const { client } = scriptedLlm(() => okResponse({ a: "How's Tokyo trip planning going?", b: "What's a trip you'd love to take?", usedIdeaId: ideaId }));
    const source = makeSource(ledger, client);
    await source.nextPrompts("2026-07-20");
    expect(ledger.unconsumedPromptIdeas("a")).toEqual([]);
  });

  test("an invalid usedIdeaId (not a real unconsumed idea) is ignored, not an error", async () => {
    const ledger = Ledger.open(":memory:");
    const { client } = scriptedLlm(() => okResponse({ a: "some prompt", b: "another prompt", usedIdeaId: 9999 }));
    const source = makeSource(ledger, client);
    await expect(source.nextPrompts("2026-07-20")).resolves.toBeDefined();
  });
});

describe("declared-target validation", () => {
  test("an exploit citing a node id that was not offered is rejected and retried", async () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = seedNode(ledger, "a");
    let call = 0;
    const { client } = scriptedLlm(() => {
      call++;
      // 4242 is not in A's candidate list, so the attribution would be a
      // fabrication: the whole generation is thrown away instead.
      return call === 1
        ? okResponse({ a: "How did the defense go?", b: "What did you cook?", targetNodeIdA: 4242 })
        : okResponse({ a: "How did the defense go?", b: "What did you cook?", targetNodeIdA: nodeId });
    });
    const result = await makeSource(ledger, client).nextPrompts("2026-07-20");
    expect(call).toBe(2);
    expect(result.prompts.a.text).toBe("How did the defense go?");
    expect(ledger.generationLogFor("2026-07-20").find((r) => r.person === "a")!.targetNodeId).toBe(nodeId);
  });

  test("an explore citing a domain that was not offered is rejected and retried", async () => {
    const ledger = Ledger.open(":memory:");
    let call = 0;
    const { client } = scriptedLlm(() => {
      call++;
      return call === 1
        ? okResponse({ a: "What's your favorite thing to cook?", b: "When did you last swim?", targetExploreA: UNOFFERED_DOMAIN })
        : okResponse({ a: "What's your favorite thing to cook?", b: "When did you last swim?", targetExploreA: OFFERED_DOMAIN });
    });
    await makeSource(ledger, client).nextPrompts("2026-07-20");
    expect(call).toBe(2);
    expect(ledger.generationLogFor("2026-07-20").find((r) => r.person === "a")!.targetDomain).toBe(OFFERED_DOMAIN);
  });

  test("on the final attempt an invalid target ships the question with a null recorded target", async () => {
    // The question itself is probably fine; blocking dispatch over the
    // bookkeeping would cost the day's ritual, so the row records no target.
    const ledger = Ledger.open(":memory:");
    seedNode(ledger, "a");
    const { client, calls } = scriptedLlm(() =>
      okResponse({ a: "How did the defense go?", b: "When did you last swim?", targetNodeIdA: 4242 }),
    );
    const result = await makeSource(ledger, client).nextPrompts("2026-07-20");
    expect(calls.length).toBe(4); // MAX_ATTEMPTS: the miss burns every retry before shipping
    expect(result.prompts.a.text).toBe("How did the defense go?");
    const rowA = ledger.generationLogFor("2026-07-20").find((r) => r.person === "a")!;
    expect(rowA.targetNodeId).toBeNull();
    expect(rowA.targetDomain).toBeNull();
    // Nothing was asked about, so nothing may go into cooldown either.
    expect(ledger.nodesFor("a")[0]!.lastAsked).toBeNull();
  });

  test("a valid exploit records the target and moves that node's last_asked at dispatch", async () => {
    const ledger = Ledger.open(":memory:");
    const nodeId = seedNode(ledger, "a");
    const { client } = scriptedLlm(() =>
      okResponse({ a: "How did the defense go?", b: "When did you last swim?", targetNodeIdA: nodeId }),
    );
    await makeSource(ledger, client).nextPrompts("2026-07-20");
    const rowA = ledger.generationLogFor("2026-07-20").find((r) => r.person === "a")!;
    expect(rowA.targetNodeId).toBe(nodeId);
    expect(rowA.targetDomain).toBeNull();
    const node = ledger.nodesFor("a").find((n) => n.id === nodeId)!;
    expect(node.lastAsked).toBe("2026-07-20");
    // times_asked deliberately waits for finalization so the count cannot
    // drift ahead of the answers behind the yield mean.
    expect(node.timesAsked).toBe(0);
  });
});

describe("repetition guards", () => {
  test("retries when a person's topic repeats one of their recent subjects", async () => {
    // The live failure: four self-improvement questions in six days, each
    // sharing almost no vocabulary with the last, so Jaccard saw nothing.
    const ledger = Ledger.open(":memory:");
    ledger.recordGeneration({
      date: "2026-07-19", promptId: "g", promptText: "q", model: "m", systemPrompt: "s",
      userPrompt: "u", rawResponse: "{}", rationale: "r", stance: "explore",
      person: "a", topic: "self-improvement", targetNodeId: null, targetDomain: null, fellBack: false, fallbackReason: null, at: "t",
    });
    let call = 0;
    const { client } = scriptedLlm(() => {
      call++;
      return call === 1
        ? okResponse({ a: "How are you growing lately?", b: "What did you read?", topicA: "self-improvement" })
        : okResponse({ a: "What's the last thing you cooked?", b: "What did you read?", topicA: "cooking" });
    });
    const result = await makeSource(ledger, client).nextPrompts("2026-07-20");
    expect(call).toBe(2);
    expect(result.prompts.a.text).toBe("What's the last thing you cooked?");
    expect(ledger.generationLogFor("2026-07-20").find((r) => r.person === "a")!.topic).toBe("cooking");
  });

  test("retries when a prompt reuses the opening frame of a recent question", async () => {
    // Eight of nine live questions opened "What's a/an/one...". openingStem
    // existed for exactly this and only ran in the offline report.
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-19", "p1", "theme", "t");
    ledger.setPersonPrompt(day.id, "a", "g", "What's one thing you're improving?");
    ledger.resolveDay(day.id, "resolved_shared", "t2");
    let call = 0;
    const { client } = scriptedLlm(() => {
      call++;
      return call === 1
        ? okResponse({ a: "What's one thing you're avoiding?", b: "How was the show?" })
        : okResponse({ a: "When did you last surprise yourself?", b: "How was the show?" });
    });
    const result = await makeSource(ledger, client).nextPrompts("2026-07-20");
    expect(call).toBe(2);
    expect(result.prompts.a.text).toBe("When did you last surprise yourself?");
  });

  test("retries when both people are handed the same sentence frame today", async () => {
    const ledger = Ledger.open(":memory:");
    let call = 0;
    const { client } = scriptedLlm(() => {
      call++;
      return call === 1
        ? okResponse({ a: "What's one thing you're proud of?", b: "What's one thing you're avoiding?" })
        : okResponse({ a: "What's one thing you're proud of?", b: "When did you last laugh hard?" });
    });
    await makeSource(ledger, client).nextPrompts("2026-07-20");
    expect(call).toBe(2);
  });
});

describe("theme repetition guard", () => {
  test("retries when the day's shared angle repeats a recent one", async () => {
    // Live symptom: "personal growth and improvement" followed by "personal
    // improvement journey". Every per-person topic tag differed, so only the
    // theme could catch it.
    const ledger = Ledger.open(":memory:");
    ledger.createDay("2026-07-19", "p1", "label", "t", "personal growth and improvement");
    let call = 0;
    const { client } = scriptedLlm(() => {
      call++;
      return call === 1
        ? okResponse({ a: "How are you growing?", b: "What are you learning?", theme: "personal improvement journey" })
        : okResponse({ a: "Where did you eat last?", b: "What did you cook?", theme: "food and eating out" });
    });
    const result = await makeSource(ledger, client).nextPrompts("2026-07-20");
    expect(call).toBe(2);
    expect(result.theme).toBe("food and eating out");
  });
});

describe("retry feedback", () => {
  test("a rejected attempt tells the model why before it answers again", async () => {
    // Observed live: four consecutive misses citing the same unoffered
    // domain, because the retry reused the identical prompt.
    const ledger = Ledger.open(":memory:");
    let call = 0;
    const { client, calls } = scriptedLlm(() => {
      call++;
      return call === 1
        ? okResponse({ a: "p", b: "q", targetExploreA: UNOFFERED_DOMAIN })
        : okResponse({ a: "p2", b: "q", targetExploreA: OFFERED_DOMAIN });
    });
    await makeSource(ledger, client).nextPrompts("2026-07-20");
    expect(calls.length).toBe(2);
    expect(calls[0]!.user).not.toContain("REJECTED");
    expect(calls[1]!.user).toContain("PREVIOUS ATTEMPT WAS REJECTED");
    expect(calls[1]!.user).toContain(UNOFFERED_DOMAIN);
  });
});
