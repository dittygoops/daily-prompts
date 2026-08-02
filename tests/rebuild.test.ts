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
    // avg_yield_chars/depletion are gone with nodes.status (2026-08-02
    // synthesis design). Argmax attribution's surviving job is recordAsk:
    // the node's creating filing grants budget 1 (fact-kind facts only, no
    // thread/interest), and the same filing's argmax win immediately spends
    // it, same as a live dispatch/answer on day one would.
    expect(node.budget).toBe(0);
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

  test("attribution is interleaved with the replay, and a plain fact never refills a spent budget", async () => {
    // The discriminating case for interleaved vs second-pass attribution
    // survives from the old status system, but its ending changed: nodes.
    // status is gone, and addNodeFact no longer reopens anything on a new
    // fact (spec "Budget": only a THREAD-kind fact refills). So two argmax
    // wins spend the node's budget to 0 and a later plain fact-kind mention
    // must NOT bring it back, unlike the old reopensOnFact behavior this
    // test used to assert.
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
    // Budget granted 1 on 07-18 (fact-kind only), spent by that day's own
    // argmax win, spent again (floored at 0) by 07-19's win. 07-23's g3 is a
    // fact, not a thread, so it does not refill: budget stays 0.
    expect(gym.budget).toBe(0);
  });
});

// 2026-08-02 synthesis design: budget/token dynamics (grantBudget, mintToken,
// refillBudget, resolveOpenThreads) run inside fileExtraction itself
// (src/extraction/pipeline.ts, not owned by this package), in the same
// transaction as the day's facts, for every caller of processPending - the
// live daemon and this rebuild's replay alike. These tests exist to VERIFY
// that replay actually exercises that mechanism correctly (per the spec's
// own migration note), not to reimplement it here.
describe("2026-08-02 synthesis design: replay's budget/token dynamics", () => {
  test("budget is granted only on a node's creating filing, then refilled by a later thread", async () => {
    const ledger = Ledger.open(":memory:");
    seedResolvedDay(ledger, "2026-08-01", "p1");
    seedResolvedDay(ledger, "2026-08-03", "p3");
    const { client } = scriptedLlm((u) => {
      if (u.includes("a-p1")) {
        // Day one: a single fact-kind observation creates the node. Kept to
        // one fact so argmax's single-fact-max rule declines attribution on
        // this day, isolating the grant from recordAsk's budget decrement.
        return JSON.stringify({
          observations: [
            { type: "fact", text: "planning a trip", newNode: { domain: "daily-life", subdomain: "trip", summary: "Planning a trip." } },
          ],
        });
      }
      if (u.includes("a-p3")) {
        // Day three: a thread-kind observation lands on the SAME node. The
        // extractor resolves a repeated newNode proposal (identical
        // normalized subdomain) to the existing node, not a second one.
        // Also kept to one fact so this day's attribution declines too.
        return JSON.stringify({
          observations: [
            { type: "thread", text: "still deciding where to go", newNode: { domain: "daily-life", subdomain: "trip", summary: "Planning a trip." } },
          ],
        });
      }
      return JSON.stringify({ observations: [] });
    });

    const result = await rebuildMemory({ ledger, llm: client, log: () => {} }, { person: "a" });
    expect(result.declined.length).toBe(2); // both days: single-fact max
    const nodes = ledger.nodesFor("a").filter((n) => n.subdomain === "trip");
    expect(nodes.length).toBe(1); // never a second grant: one node, not two
    const trip = nodes[0]!;
    // Grant from day one: fact-kind only -> budget 1. Refill from day
    // three's thread landing on the already-existing node -> +1 -> 2.
    expect(trip.budget).toBe(2);
    expect(trip.timesAsked).toBe(0); // both days declined argmax attribution
  });

  test("replay mints a follow-up token for an event date discovered during replay", async () => {
    const ledger = Ledger.open(":memory:");
    seedResolvedDay(ledger, "2026-08-01", "p1");
    const { client } = scriptedLlm(() =>
      JSON.stringify({
        observations: [
          {
            type: "fact",
            text: "friend's party is next Saturday",
            newNode: {
              domain: "relationships-friends",
              subdomain: "friend-party",
              summary: "A friend's party is coming up.",
              eventDate: "2026-08-08",
            },
          },
        ],
      }),
    );

    await rebuildMemory({ ledger, llm: client, log: () => {} }, { person: "a" });
    const node = ledger.nodesFor("a").find((n) => n.subdomain === "friend-party")!;
    expect(node.eventDate).toBe("2026-08-08");
    // Fireable window: [today - windowDays, today). 2026-08-11 is 3 days
    // after the event, still inside a 3-day tokenWindowDays.
    const tokens = ledger.fireableTokens("2026-08-11", 3);
    expect(tokens.some((t) => t.nodeId === node.id && t.eventDate === "2026-08-08")).toBe(true);
  });

  test("a rebuilt graph's budgets and tokens match a lived sequence", async () => {
    // Same days, same scripted answers, run twice against two independent
    // ledgers: once by calling processPending directly (as close to "living
    // the days" as a test can get without a real dispatch loop), once via
    // rebuildMemory's wipe-then-replay. Both paths route through the exact
    // same fileExtraction transaction, so budgets and tokens should match
    // exactly node-for-node (matched by subdomain, since insertion order,
    // and therefore ids, should but need not coincide for this to hold).
    const buildLlm = () =>
      scriptedLlm((u) => {
        if (u.includes("a-p1")) {
          return JSON.stringify({
            observations: [
              {
                type: "fact",
                text: "hiking trip this weekend",
                newNode: { domain: "hobbies-interests", subdomain: "hiking", summary: "Likes hiking.", eventDate: "2026-08-08" },
              },
            ],
          });
        }
        if (u.includes("a-p2")) {
          return JSON.stringify({
            observations: [
              { type: "thread", text: "deciding on the trail", newNode: { domain: "hobbies-interests", subdomain: "hiking", summary: "Likes hiking." } },
            ],
          });
        }
        return JSON.stringify({ observations: [] });
      });

    const ledgerLive = Ledger.open(":memory:");
    seedResolvedDay(ledgerLive, "2026-08-01", "p1");
    seedResolvedDay(ledgerLive, "2026-08-02", "p2");
    await processPending({ ledger: ledgerLive, llm: buildLlm().client, log: () => {} });

    const ledgerReplay = Ledger.open(":memory:");
    seedResolvedDay(ledgerReplay, "2026-08-01", "p1");
    seedResolvedDay(ledgerReplay, "2026-08-02", "p2");
    await rebuildMemory({ ledger: ledgerReplay, llm: buildLlm().client, log: () => {} });

    const byBudgetAndTokens = (ledger: Ledger) =>
      ledger
        .nodesFor("a")
        .map((n) => ({
          subdomain: n.subdomain,
          budget: n.budget,
          eventDate: n.eventDate,
          tokenEventDates: ledger.fireableTokens("2026-08-11", 3).filter((t) => t.nodeId === n.id).map((t) => t.eventDate),
        }))
        .sort((a, b) => a.subdomain.localeCompare(b.subdomain));

    // last_asked/times_asked are deliberately excluded from this diff:
    // argmax attribution (recordAsk) is a rebuild-only backfill for the
    // absence of real dispatch records, not something living the days
    // through a bare processPending call (no dispatch loop) would ever do,
    // so those two fields are expected to differ and are not part of the
    // "matches a lived sequence" claim - budget/tokens are.
    expect(byBudgetAndTokens(ledgerReplay)).toEqual(byBudgetAndTokens(ledgerLive));
  });

  test("replay's resolution zeroes budget when a real dispatch target got no new thread back", async () => {
    const ledger = Ledger.open(":memory:");
    seedResolvedDay(ledger, "2026-08-01", "p1");
    const { client: v1 } = scriptedLlm(() =>
      JSON.stringify({
        observations: [
          { type: "thread", text: "wondering about a career change", newNode: { domain: "career-academics", subdomain: "career-change", summary: "Considering a change." } },
        ],
      }),
    );
    // Living day one creates the node with a thread -> budget 3 (grant),
    // via a real (non-rebuild) processPending call. Scoped to person "a" so
    // no node is ever created for "b": below, the rebuild wipes only "a"'s
    // nodes and this test relies on the SAME node id being reused on
    // recreation (plain INTEGER PRIMARY KEY, no AUTOINCREMENT, so SQLite
    // reuses the lowest free rowid) - true only if "a" is the sole person
    // who ever touched the nodes table in this ledger.
    await processPending({ ledger, llm: v1, log: () => {}, person: "a" });
    const node = ledger.nodesFor("a").find((n) => n.subdomain === "career-change")!;
    expect(node.budget).toBe(3);

    // A real dispatch record: day two's question targeted this node.
    seedResolvedDay(ledger, "2026-08-02", "p2");
    ledger.recordGeneration({
      date: "2026-08-02", promptId: "p2", promptText: "How's the career change thinking going?",
      model: null, systemPrompt: null, userPrompt: null, rawResponse: null, rationale: null,
      stance: "exploit", person: "a", targetNodeId: node.id, targetDomain: null, topic: null,
      fellBack: false, fallbackReason: null, at: "t9", lane: "exploit", seedId: null, askDomain: null, askFamily: null,
    });

    // Day two's answer gives a plain fact, no new thread: resolution should
    // fire and zero the node's budget, per fileExtraction's own resolution
    // check (spec "Budget": "if no new thread-kind fact landed on N ...
    // budget drops to 0"). A rebuild must replay this exactly, since
    // wipeGraph never touches generation_log.
    const { client: v2 } = scriptedLlm(() =>
      JSON.stringify({
        observations: [
          { type: "fact", text: "still thinking it over", newNode: { domain: "career-academics", subdomain: "career-change", summary: "Considering a change." } },
        ],
      }),
    );
    await rebuildMemory({ ledger, llm: v2, log: () => {} }, { person: "a" });
    const rebuilt = ledger.nodesFor("a").find((n) => n.subdomain === "career-change")!;
    expect(rebuilt.budget).toBe(0);
  });
});
