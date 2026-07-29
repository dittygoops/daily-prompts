import { describe, expect, test } from "bun:test";
import { rebuildMemory } from "../src/rebuild/rebuild";
import { processPending } from "../src/extraction/pipeline";
import { Ledger } from "../src/ledger/ledger";
import type { LlmClient } from "../src/llm/types";

function scriptedLlm(behavior: (userPrompt: string) => string | Promise<string>) {
  const calls: string[] = [];
  const client: LlmClient = {
    async complete(_system, user) {
      calls.push(user);
      return behavior(user);
    },
  };
  return { client, calls };
}

const okResponse = (text: string) =>
  JSON.stringify({
    observations: [{ type: "fact", text, newNode: { domain: "daily-life", subdomain: "x", summary: "x" } }],
  });

function seedResolvedDay(ledger: Ledger, date: string, promptId: string) {
  const day = ledger.createDay(date, promptId, "x", "t0");
  ledger.finalizeResponse(day.id, "a", `a-${promptId}`, "t1");
  ledger.finalizeResponse(day.id, "b", `b-${promptId}`, "t2");
  ledger.resolveDay(day.id, "resolved_shared", "t3");
  return day;
}

describe("rebuildMemory", () => {
  test("restores the same graph as before a wipe, given the same ledger and a deterministic LLM", async () => {
    const ledger = Ledger.open(":memory:");
    seedResolvedDay(ledger, "2026-07-18", "p1");
    const { client } = scriptedLlm((u) => okResponse(u.includes("a-p1") ? "about a" : "about b"));

    await processPending({ ledger, llm: client, log: () => {} });
    const before = [...ledger.nodesFor("a"), ...ledger.nodesFor("b")]
      .map((n) => n.subdomain)
      .sort();

    const result = await rebuildMemory({ ledger, llm: client, log: () => {} });
    const after = [...ledger.nodesFor("a"), ...ledger.nodesFor("b")]
      .map((n) => n.subdomain)
      .sort();

    expect(result.processed).toBe(2);
    expect(result.failed).toBe(0);
    expect(after).toEqual(before);
  });

  test("after a prompt/code change, rebuild produces updated facts without duplicating old ones", async () => {
    const ledger = Ledger.open(":memory:");
    seedResolvedDay(ledger, "2026-07-18", "p1");
    const { client: v1 } = scriptedLlm(() => okResponse("old fact"));
    await processPending({ ledger, llm: v1, log: () => {} });

    const { client: v2 } = scriptedLlm(() => okResponse("new fact"));
    await rebuildMemory({ ledger, llm: v2, log: () => {} });

    const allFacts = [...ledger.nodesFor("a"), ...ledger.nodesFor("b")].flatMap((n) => ledger.nodeFactsFor(n.id));
    expect(allFacts.filter((f) => f.text === "new fact").length).toBe(2); // one per person
    expect(allFacts.filter((f) => f.text === "old fact").length).toBe(0);
  });

  test("rebuilding a single person doesn't touch the other person's graph or extraction bookkeeping", async () => {
    const ledger = Ledger.open(":memory:");
    const day = seedResolvedDay(ledger, "2026-07-18", "p1");
    const { client: v1 } = scriptedLlm(() => okResponse("v1"));
    await processPending({ ledger, llm: v1, log: () => {} });

    const bBefore = ledger.nodesFor("b").map((n) => ({ subdomain: n.subdomain, facts: ledger.nodeFactsFor(n.id) }));
    const bExtractionBefore = ledger.extractionFor(day.id, "b");

    const { client: v2 } = scriptedLlm(() => okResponse("rebuilt-a"));
    await rebuildMemory({ ledger, llm: v2, log: () => {} }, { person: "a" });

    const bAfter = ledger.nodesFor("b").map((n) => ({ subdomain: n.subdomain, facts: ledger.nodeFactsFor(n.id) }));
    expect(bAfter).toEqual(bBefore);
    expect(ledger.extractionFor(day.id, "b")).toEqual(bExtractionBefore);
    const aFacts = ledger.nodesFor("a").flatMap((n) => ledger.nodeFactsFor(n.id));
    expect(aFacts.every((f) => f.text === "rebuilt-a")).toBe(true);
  });

  test("rebuilding an empty ledger is a no-op that still wipes both people's graphs, without erroring", async () => {
    const ledger = Ledger.open(":memory:");
    const { client } = scriptedLlm(() => okResponse("x"));

    const result = await rebuildMemory({ ledger, llm: client, log: () => {} });
    expect(result.peopleWiped).toEqual(["a", "b"]);
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.attributed).toEqual([]);
    expect(result.declined).toEqual([]);
  });

  test("optional legacy memory.wipe is still called when a memory dep is supplied (harmless, keeps the old path clean)", async () => {
    const ledger = Ledger.open(":memory:");
    const wipedCalls: string[] = [];
    const memory = {
      add: async () => {},
      getContext: async () => ({ facts: [], threads: [], interests: [], recentMoods: [], promptPreferences: [] }),
      getCoverage: async () => [],
      wipe: async (p: "a" | "b") => {
        wipedCalls.push(p);
      },
    };
    const { client } = scriptedLlm(() => okResponse("x"));

    await rebuildMemory({ ledger, llm: client, memory, log: () => {} });
    expect(wipedCalls.sort()).toEqual(["a", "b"]);
  });

  test("dry-run makes no changes at all", async () => {
    const ledger = Ledger.open(":memory:");
    const day = seedResolvedDay(ledger, "2026-07-18", "p1");
    const { client } = scriptedLlm(() => okResponse("v1"));
    await processPending({ ledger, llm: client, log: () => {} });
    const nodesBefore = ledger.nodesFor("a");
    const extractionBefore = ledger.extractionFor(day.id, "a");

    const result = await rebuildMemory({ ledger, llm: client, log: () => {} }, { dryRun: true });
    expect(result.peopleWiped).toEqual([]);
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
    expect(ledger.nodesFor("a")).toEqual(nodesBefore);
    expect(ledger.extractionFor(day.id, "a")).toEqual(extractionBefore);
  });

  test("a partial failure during reprocess is isolated and reported, wipe/clear still happened", async () => {
    const ledger = Ledger.open(":memory:");
    const day = seedResolvedDay(ledger, "2026-07-18", "p1");
    const { client } = scriptedLlm((u) => {
      if (u.includes("a-p1")) throw new Error("boom");
      return okResponse("ok");
    });

    const result = await rebuildMemory({ ledger, llm: client, log: () => {} });
    expect(result.failed).toBe(1);
    expect(result.processed).toBe(1);
    expect(ledger.extractionFor(day.id, "a")).toMatchObject({ status: "failed" });
    expect(ledger.extractionFor(day.id, "b")).toMatchObject({ status: "done" });
  });
});

describe("argmax yield attribution", () => {
  test("a day where one node gets 3 facts and the rest get fewer attributes to that node", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t0");
    ledger.finalizeResponse(day.id, "a", "a fairly long answer about the gym", "t1");
    ledger.resolveDay(day.id, "resolved_partial", "t2");
    const { client } = scriptedLlm(() =>
      JSON.stringify({
        observations: [
          { type: "fact", text: "f1", newNode: { domain: "health-body", subdomain: "gym", summary: "Goes to the gym." } },
          { type: "fact", text: "f2", newNode: { domain: "health-body", subdomain: "gym", summary: "Goes to the gym." } },
          { type: "fact", text: "f3", newNode: { domain: "health-body", subdomain: "gym", summary: "Goes to the gym." } },
        ],
      }),
    );

    const result = await rebuildMemory({ ledger, llm: client, log: () => {} }, { person: "a" });
    expect(result.attributed.length).toBe(1);
    const node = ledger.nodesFor("a")[0]!;
    expect(result.attributed[0]).toMatchObject({ nodeId: node.id, facts: 3, date: "2026-07-18", person: "a" });
    expect(node.timesAsked).toBe(1);
    expect(node.lastAsked).toBe("2026-07-18");
    expect(node.avgYieldChars).toBe("a fairly long answer about the gym".length);
  });

  test("a 2-2 tie declines attribution", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t0");
    ledger.finalizeResponse(day.id, "a", "answer", "t1");
    ledger.resolveDay(day.id, "resolved_partial", "t2");
    const { client } = scriptedLlm(() =>
      JSON.stringify({
        observations: [
          { type: "fact", text: "f1", newNode: { domain: "health-body", subdomain: "gym", summary: "s" } },
          { type: "fact", text: "f2", newNode: { domain: "health-body", subdomain: "gym", summary: "s" } },
          { type: "fact", text: "f3", newNode: { domain: "hobbies-interests", subdomain: "guitar", summary: "s" } },
          { type: "fact", text: "f4", newNode: { domain: "hobbies-interests", subdomain: "guitar", summary: "s" } },
        ],
      }),
    );

    const result = await rebuildMemory({ ledger, llm: client, log: () => {} }, { person: "a" });
    expect(result.attributed).toEqual([]);
    expect(result.declined.length).toBe(1);
    expect(result.declined[0]!.reason).toContain("tie");
    for (const node of ledger.nodesFor("a")) {
      expect(node.timesAsked).toBe(0);
      expect(node.lastAsked).toBeNull();
    }
  });

  test("a 1-1-1 day (a three-way tie at a single fact each) declines attribution", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t0");
    ledger.finalizeResponse(day.id, "a", "answer", "t1");
    ledger.resolveDay(day.id, "resolved_partial", "t2");
    const { client } = scriptedLlm(() =>
      JSON.stringify({
        observations: [
          { type: "fact", text: "f1", newNode: { domain: "health-body", subdomain: "gym", summary: "s" } },
          { type: "fact", text: "f2", newNode: { domain: "hobbies-interests", subdomain: "guitar", summary: "s" } },
          { type: "fact", text: "f3", newNode: { domain: "family", subdomain: "cora", summary: "s" } },
        ],
      }),
    );

    const result = await rebuildMemory({ ledger, llm: client, log: () => {} }, { person: "a" });
    expect(result.attributed).toEqual([]);
    expect(result.declined.length).toBe(1);
    expect(result.declined[0]!.reason).toContain("tie");
  });

  test("a single node with exactly one fact (no competing node) declines as a single-fact max", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t0");
    ledger.finalizeResponse(day.id, "a", "answer", "t1");
    ledger.resolveDay(day.id, "resolved_partial", "t2");
    const { client } = scriptedLlm(() =>
      JSON.stringify({
        observations: [{ type: "fact", text: "f1", newNode: { domain: "health-body", subdomain: "gym", summary: "s" } }],
      }),
    );

    const result = await rebuildMemory({ ledger, llm: client, log: () => {} }, { person: "a" });
    expect(result.attributed).toEqual([]);
    expect(result.declined.length).toBe(1);
    expect(result.declined[0]!.reason).toContain("single-fact max");
  });

  test("a day with no facts declines with a reason", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t0");
    ledger.markSkipped(day.id, "a", "t1");
    ledger.resolveDay(day.id, "resolved_skipped", "t2");
    const { client } = scriptedLlm(() => JSON.stringify({ observations: [] }));

    const result = await rebuildMemory({ ledger, llm: client, log: () => {} }, { person: "a" });
    expect(result.attributed).toEqual([]);
    expect(result.declined.length).toBe(1);
    expect(result.declined[0]!.reason).toContain("no facts");
  });

  test("attribution is interleaved with the replay: a depletion is reopened by a later day's fact", async () => {
    // The discriminating case for interleaved vs second-pass attribution.
    // Attribution can deplete a node, and addNodeFact reopens a depleted one.
    // Attributing only after every day was filed would strand this node
    // depleted, because the reopening fact would already have been written
    // before the depletion happened. Replay must behave like living the days.
    const ledger = Ledger.open(":memory:");
    const gymFact = (text: string) => ({
      type: "fact",
      text,
      newNode: { domain: "health-body", subdomain: "gym", summary: "Goes to the gym." },
    });
    const otherFact = (text: string) => ({
      type: "fact",
      text,
      newNode: { domain: "daily-life", subdomain: "commute", summary: "Drives to work." },
    });
    const long = "x".repeat(400);
    const seed = (date: string, answer: string) => {
      const day = ledger.createDay(date, `p-${date}`, "x", "t0");
      ledger.finalizeResponse(day.id, "a", answer, "t1");
      ledger.resolveDay(day.id, "resolved_partial", "t2");
    };
    // Two short gym days win argmax twice, so times_asked reaches the
    // depletion minimum with an average well under half the 400-char median.
    seed("2026-07-18", "short gym answer");
    seed("2026-07-19", "short gym answer");
    seed("2026-07-20", long);
    seed("2026-07-21", `${long}y`);
    seed("2026-07-22", `${long}z`);
    seed("2026-07-23", "one more gym note");
    const { client } = scriptedLlm((user) => {
      if (user.includes("short gym answer")) {
        return JSON.stringify({ observations: [gymFact("g1"), gymFact("g2")] });
      }
      if (user.includes("one more gym note")) {
        return JSON.stringify({ observations: [gymFact("g3")] });
      }
      return JSON.stringify({ observations: [otherFact("o1")] });
    });

    const result = await rebuildMemory({ ledger, llm: client, log: () => {} }, { person: "a" });
    const gym = ledger.nodesFor("a").find((n) => n.subdomain === "gym")!;
    expect(result.attributed.length).toBe(2);
    expect(gym.timesAsked).toBe(2);
    // Depleted on 07-19, then reopened by the 07-23 fact.
    expect(gym.status).toBe("open");
  });
});
