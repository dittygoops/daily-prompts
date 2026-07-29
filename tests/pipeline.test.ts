import { describe, expect, test } from "bun:test";
import { processPending } from "../src/extraction/pipeline";
import { Ledger } from "../src/ledger/ledger";
import type { LlmClient } from "../src/llm/types";

function scriptedLlm(
  behavior: (userPrompt: string) => string | Promise<string>,
) {
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

describe("processPending", () => {
  test("does nothing when the ledger has no pending work", async () => {
    const ledger = Ledger.open(":memory:");
    const { client } = scriptedLlm(() => okResponse("x"));
    const result = await processPending({ ledger, llm: client, log: () => {} });
    expect(result).toEqual({ processed: 0, failed: 0, filings: [] });
  });

  test("extracts a resolved_shared day for both persons, files facts as node facts, and marks both extractions done", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "What's your favorite family tradition?", "t0");
    ledger.finalizeResponse(day.id, "a", "pancakes", "t1");
    ledger.finalizeResponse(day.id, "b", "waffles", "t2");
    ledger.resolveDay(day.id, "resolved_shared", "t3");
    const { client } = scriptedLlm((user) => okResponse(user.includes("pancakes") ? "about a" : "about b"));

    const result = await processPending({ ledger, llm: client, log: () => {} });
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(0);
    const aNodes = ledger.nodesFor("a");
    const bNodes = ledger.nodesFor("b");
    expect(aNodes.length).toBe(1);
    expect(bNodes.length).toBe(1);
    expect(ledger.nodeFactsFor(aNodes[0]!.id)[0]!.text).toBe("about a");
    expect(ledger.nodeFactsFor(bNodes[0]!.id)[0]!.text).toBe("about b");
    expect(ledger.extractionFor(day.id, "a")).toMatchObject({ status: "done", observationCount: 1, attempts: 1 });
    expect(ledger.extractionFor(day.id, "b")).toMatchObject({ status: "done", observationCount: 1, attempts: 1 });
  });

  test("a skipped person yields zero facts and is marked done without an LLM call", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t0");
    ledger.markSkipped(day.id, "a", "t1");
    ledger.finalizeResponse(day.id, "b", "waffles", "t2");
    ledger.resolveDay(day.id, "resolved_partial", "t3");
    const { client, calls } = scriptedLlm(() => okResponse("about b"));

    const result = await processPending({ ledger, llm: client, log: () => {} });
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(0);
    expect(calls.length).toBe(1); // only for b
    expect(ledger.extractionFor(day.id, "a")).toMatchObject({ status: "done", observationCount: 0 });
    expect(ledger.nodesFor("a")).toEqual([]);
  });

  test("a person who never answered (resolved_partial, still awaiting) is treated as skipped with zero facts", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t0");
    ledger.finalizeResponse(day.id, "a", "pancakes", "t1");
    ledger.resolveDay(day.id, "resolved_partial", "t2"); // b never answered
    const { client, calls } = scriptedLlm(() => okResponse("about a"));

    const result = await processPending({ ledger, llm: client, log: () => {} });
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(0);
    expect(calls.length).toBe(1); // only for a; b never called (skipped, no feedback)
    expect(ledger.extractionFor(day.id, "b")).toMatchObject({ status: "done", observationCount: 0 });
  });

  test("includes only this day and this person's feedback, excluding other persons'/days' feedback", async () => {
    const ledger = Ledger.open(":memory:");
    const day1 = ledger.createDay("2026-07-18", "p1", "x", "t0");
    ledger.finalizeResponse(day1.id, "a", "pancakes", "t1");
    ledger.finalizeResponse(day1.id, "b", "waffles", "t2");
    ledger.resolveDay(day1.id, "resolved_shared", "t3");
    ledger.recordMessage({ dayId: day1.id, person: "a", direction: "in", kind: "feedback", text: "a's feedback", at: "t4" });
    ledger.recordMessage({ dayId: day1.id, person: "b", direction: "in", kind: "feedback", text: "b's decoy feedback", at: "t5" });

    const day2 = ledger.createDay("2026-07-19", "p2", "y", "t6");
    ledger.finalizeResponse(day2.id, "a", "other day", "t7");
    ledger.resolveDay(day2.id, "resolved_partial", "t8");
    ledger.recordMessage({ dayId: day2.id, person: "a", direction: "in", kind: "feedback", text: "wrong day feedback", at: "t9" });

    const { client, calls } = scriptedLlm(() => okResponse("x"));
    await processPending({ ledger, llm: client, log: () => {} });

    const aDay1Call = calls.find((c) => c.includes("pancakes"))!;
    expect(aDay1Call).toContain("a's feedback");
    expect(aDay1Call).not.toContain("b's decoy feedback");
    expect(aDay1Call).not.toContain("wrong day feedback");
  });

  test("one person's extraction failure does not block the other person in the same day", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t0");
    ledger.finalizeResponse(day.id, "a", "pancakes", "t1");
    ledger.finalizeResponse(day.id, "b", "waffles", "t2");
    ledger.resolveDay(day.id, "resolved_shared", "t3");
    const { client } = scriptedLlm((user) => {
      if (user.includes("pancakes")) throw new Error("LLM exploded for a");
      return okResponse("about b");
    });

    const result = await processPending({ ledger, llm: client, log: () => {} });
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
    expect(ledger.extractionFor(day.id, "a")).toMatchObject({ status: "failed", attempts: 1 });
    expect(ledger.extractionFor(day.id, "b")).toMatchObject({ status: "done" });
    expect(ledger.nodesFor("a")).toEqual([]);
    expect(ledger.nodesFor("b").length).toBe(1);
  });

  test("a failing day does not block a subsequent day in the same batch", async () => {
    const ledger = Ledger.open(":memory:");
    const day1 = ledger.createDay("2026-07-18", "p1", "bad day", "t0");
    ledger.finalizeResponse(day1.id, "a", "x1", "t1");
    ledger.finalizeResponse(day1.id, "b", "x2", "t2");
    ledger.resolveDay(day1.id, "resolved_shared", "t3");
    const day2 = ledger.createDay("2026-07-19", "p2", "good day", "t4");
    ledger.finalizeResponse(day2.id, "a", "y1", "t5");
    ledger.finalizeResponse(day2.id, "b", "y2", "t6");
    ledger.resolveDay(day2.id, "resolved_shared", "t7");

    const { client } = scriptedLlm((user) => {
      if (user.includes("bad day")) throw new Error("boom");
      return okResponse("ok");
    });

    const result = await processPending({ ledger, llm: client, log: () => {} });
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(2);
    expect(ledger.extractionFor(day2.id, "a")).toMatchObject({ status: "done" });
    expect(ledger.extractionFor(day2.id, "b")).toMatchObject({ status: "done" });
  });

  test("repeated failures accumulate attempts and eventually drop out of pending work", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t0");
    ledger.finalizeResponse(day.id, "a", "pancakes", "t1");
    ledger.finalizeResponse(day.id, "b", "waffles", "t2");
    ledger.resolveDay(day.id, "resolved_shared", "t3");
    const { client } = scriptedLlm(() => {
      throw new Error("always fails");
    });

    await processPending({ ledger, llm: client, log: () => {} });
    await processPending({ ledger, llm: client, log: () => {} });
    await processPending({ ledger, llm: client, log: () => {} });
    expect(ledger.extractionFor(day.id, "a")?.attempts).toBe(3);
    expect(ledger.unprocessedResolvedDays().some((p) => p.dayId === day.id && p.person === "a")).toBe(false);

    const result = await processPending({ ledger, llm: client, log: () => {} });
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
  });

  test("already-done extractions are never reprocessed (idempotent across calls)", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t0");
    ledger.finalizeResponse(day.id, "a", "pancakes", "t1");
    ledger.finalizeResponse(day.id, "b", "waffles", "t2");
    ledger.resolveDay(day.id, "resolved_shared", "t3");
    const { client, calls } = scriptedLlm(() => okResponse("x"));

    await processPending({ ledger, llm: client, log: () => {} });
    const callCountAfterFirst = calls.length;
    const nodeCountAfterFirst = ledger.nodesFor("a").length + ledger.nodesFor("b").length;

    const second = await processPending({ ledger, llm: client, log: () => {} });
    expect(second.processed).toBe(0);
    expect(second.failed).toBe(0);
    expect(calls.length).toBe(callCountAfterFirst);
    expect(ledger.nodesFor("a").length + ledger.nodesFor("b").length).toBe(nodeCountAfterFirst);
  });

  test("logs a loud, specific message on failure", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t0");
    ledger.finalizeResponse(day.id, "a", "pancakes", "t1");
    ledger.finalizeResponse(day.id, "b", "waffles", "t2");
    ledger.resolveDay(day.id, "resolved_shared", "t3");
    const { client } = scriptedLlm((user) => {
      if (user.includes("pancakes")) throw new Error("boom");
      return okResponse("ok");
    });
    const logs: string[] = [];

    await processPending({ ledger, llm: client, log: (m) => logs.push(m) });
    const failLine = logs.find((l) => l.includes("EXTRACTION FAILED"));
    expect(failLine).toBeDefined();
    expect(failLine).toContain(String(day.id));
    expect(failLine).toContain("a");
  });

  test("prompt ideas extracted from feedback are persisted to the ledger's idea queue", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t0");
    ledger.finalizeResponse(day.id, "a", "pancakes", "t1");
    ledger.finalizeResponse(day.id, "b", "waffles", "t2");
    ledger.resolveDay(day.id, "resolved_shared", "t3");
    ledger.recordMessage({ dayId: day.id, person: "a", direction: "in", kind: "feedback", text: "ask about our trip", at: "t4" });
    const { client } = scriptedLlm((user) =>
      JSON.stringify({
        observations: [],
        promptIdeas: user.includes("ask about our trip") ? ["ask us about our upcoming trip"] : [],
      }),
    );

    await processPending({ ledger, llm: client, log: () => {} });
    const ideas = ledger.unconsumedPromptIdeas("a");
    expect(ideas.length).toBe(1);
    expect(ideas[0]).toMatchObject({ person: "a", text: "ask us about our upcoming trip", suggestedDayId: day.id });
    expect(ledger.unconsumedPromptIdeas("b")).toEqual([]);
  });

  test("an optional person filter restricts processing to just that person", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t0");
    ledger.finalizeResponse(day.id, "a", "pancakes", "t1");
    ledger.finalizeResponse(day.id, "b", "waffles", "t2");
    ledger.resolveDay(day.id, "resolved_shared", "t3");
    const { client } = scriptedLlm(() => okResponse("x"));

    const result = await processPending({ ledger, llm: client, log: () => {}, person: "a" });
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(ledger.extractionFor(day.id, "a")).toMatchObject({ status: "done" });
    expect(ledger.extractionFor(day.id, "b")).toBeNull();
    expect(ledger.nodesFor("b")).toEqual([]);
  });

  test("returns accurate aggregate counts over a mixed batch of successes and failures", async () => {
    const ledger = Ledger.open(":memory:");
    const day1 = ledger.createDay("2026-07-18", "p1", "x", "t0");
    ledger.finalizeResponse(day1.id, "a", "ok1", "t1");
    ledger.finalizeResponse(day1.id, "b", "ok2", "t2");
    ledger.resolveDay(day1.id, "resolved_shared", "t3");
    const day2 = ledger.createDay("2026-07-19", "p2", "y", "t4");
    ledger.finalizeResponse(day2.id, "a", "fail-me", "t5");
    ledger.finalizeResponse(day2.id, "b", "ok3", "t6");
    ledger.resolveDay(day2.id, "resolved_shared", "t7");

    const { client } = scriptedLlm((user) => {
      if (user.includes("fail-me")) throw new Error("boom");
      return okResponse("ok");
    });

    const result = await processPending({ ledger, llm: client, log: () => {} });
    expect(result.processed).toBe(3);
    expect(result.failed).toBe(1);
  });
});

describe("per-person extraction input", () => {
  test("the extractor is told the question THIS person was asked, not the day's theme", async () => {
    // Live bug: after per-person prompts, days.prompt_text holds the theme
    // ("Current self-improvement efforts"), and the extractor was told that
    // was the question, corrupting its reading of every answer.
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-28", "gen-a", "Current self-improvement efforts", "t", "Current self-improvement efforts");
    ledger.setPersonPrompt(day.id, "a", "gen-a", "How is the guitar practice going?");
    ledger.finalizeResponse(day.id, "a", "slowly but well", "t1");
    ledger.resolveDay(day.id, "resolved_partial", "t2");
    const calls: { user: string }[] = [];
    const llm: LlmClient = {
      async complete(_s, user) {
        calls.push({ user });
        return JSON.stringify({ observations: [], promptIdeas: [] });
      },
    };
    await processPending({ ledger, llm, log: () => {} });
    const aCall = calls.find((c) => c.user.includes("slowly but well"))!;
    expect(aCall.user).toContain("How is the guitar practice going?");
    expect(aCall.user).not.toContain("Current self-improvement efforts");
  });

  test("the closed-vocabulary node list passed to the extractor comes from ledger.nodesFor(person)", async () => {
    const ledger = Ledger.open(":memory:");
    const day0 = ledger.createDay("2026-07-17", "p0", "x", "t0");
    ledger.finalizeResponse(day0.id, "a", "seed", "t1");
    ledger.resolveDay(day0.id, "resolved_partial", "t2");
    const { client: seedClient } = scriptedLlm(() =>
      JSON.stringify({
        observations: [{ type: "fact", text: "seed fact", newNode: { domain: "hobbies-interests", subdomain: "guitar", summary: "Plays guitar." } }],
      }),
    );
    await processPending({ ledger, llm: seedClient, log: () => {}, person: "a" });
    const nodeId = ledger.nodesFor("a")[0]!.id;

    const day1 = ledger.createDay("2026-07-18", "p1", "x", "t0");
    ledger.finalizeResponse(day1.id, "a", "next", "t1");
    ledger.resolveDay(day1.id, "resolved_partial", "t2");
    const calls: string[] = [];
    const llm: LlmClient = {
      async complete(_s, user) {
        calls.push(user);
        return JSON.stringify({ observations: [] });
      },
    };
    await processPending({ ledger, llm, log: () => {}, person: "a" });
    expect(calls[0]).toContain(`[node ${nodeId}]`);
  });
});

describe("transactional filing", () => {
  test("filing is atomic: a throw deep in the transaction leaves no nodes, facts, signals, and the day still pending", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t0");
    ledger.finalizeResponse(day.id, "a", "pancakes", "t1");
    ledger.resolveDay(day.id, "resolved_partial", "t2");
    const { client } = scriptedLlm(() =>
      JSON.stringify({
        observations: [
          { type: "fact", text: "f1", newNode: { domain: "daily-life", subdomain: "x", summary: "x" } },
          { type: "mood_signal", text: "seems tired" },
        ],
      }),
    );

    const original = ledger.markExtraction.bind(ledger);
    let calls = 0;
    (ledger as unknown as { markExtraction: typeof ledger.markExtraction }).markExtraction = (...args) => {
      calls++;
      // Throw only on the first call (inside the filing transaction). The
      // pipeline's catch block calls markExtraction again to record the
      // failure, and that call must succeed normally.
      if (calls === 1) throw new Error("simulated crash mid-transaction");
      return original(...(args as Parameters<typeof original>));
    };

    const result = await processPending({ ledger, llm: client, log: () => {} });
    (ledger as unknown as { markExtraction: typeof ledger.markExtraction }).markExtraction = original;

    expect(result.failed).toBe(1);
    expect(ledger.nodesFor("a")).toEqual([]);
    expect(ledger.recentSignals("a", "mood_signal", null, "2026-07-19")).toEqual([]);
    expect(ledger.unprocessedResolvedDays().some((p) => p.dayId === day.id && p.person === "a")).toBe(true);
  });
});

describe("summary rewrite trigger", () => {
  test("the 3rd fact filed on a node triggers exactly one summary rewrite", async () => {
    const ledger = Ledger.open(":memory:");
    let rewriteCalls = 0;
    const summaryLlm: LlmClient = {
      async complete() {
        rewriteCalls++;
        return "Rewritten durable summary.";
      },
    };
    let nodeId: number | undefined;

    for (let i = 1; i <= 3; i++) {
      const day = ledger.createDay(`2026-07-${17 + i}`, `p${i}`, "x", "t0");
      ledger.finalizeResponse(day.id, "a", `answer ${i}`, "t1");
      ledger.resolveDay(day.id, "resolved_partial", "t2");
      const target = nodeId === undefined
        ? { newNode: { domain: "daily-life", subdomain: "cooking", summary: "Likes to cook." } }
        : { nodeId };
      const { client } = scriptedLlm(() =>
        JSON.stringify({ observations: [{ type: "fact", text: `fact ${i}`, ...target }] }),
      );
      await processPending({ ledger, llm: client, summaryLlm, log: () => {}, person: "a" });
      nodeId = ledger.nodesFor("a")[0]!.id;
      if (i < 3) expect(rewriteCalls).toBe(0);
    }

    expect(rewriteCalls).toBe(1);
    expect(ledger.nodesFor("a")[0]!.summary).toBe("Rewritten durable summary.");
  });

  test("an over-140-char reply is retried once, then the old summary is kept with a loud log", async () => {
    const ledger = Ledger.open(":memory:");
    const longReply = "x".repeat(200);
    const summaryLlm: LlmClient = {
      async complete() {
        return longReply;
      },
    };
    let nodeId: number | undefined;
    const logs: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const day = ledger.createDay(`2026-07-${17 + i}`, `p${i}`, "x", "t0");
      ledger.finalizeResponse(day.id, "a", `answer ${i}`, "t1");
      ledger.resolveDay(day.id, "resolved_partial", "t2");
      const target = nodeId === undefined
        ? { newNode: { domain: "daily-life", subdomain: "cooking", summary: "Likes to cook." } }
        : { nodeId };
      const { client } = scriptedLlm(() =>
        JSON.stringify({ observations: [{ type: "fact", text: `fact ${i}`, ...target }] }),
      );
      await processPending({ ledger, llm: client, summaryLlm, log: (m) => logs.push(m), person: "a" });
      nodeId = ledger.nodesFor("a")[0]!.id;
    }
    expect(ledger.nodesFor("a")[0]!.summary).toBe("Likes to cook.");
    expect(logs.some((l) => l.includes("SUMMARY REWRITE"))).toBe(true);
  });

  test("a thrown summary LLM error does not fail the already-committed extraction", async () => {
    const ledger = Ledger.open(":memory:");
    const summaryLlm: LlmClient = {
      async complete() {
        throw new Error("summary llm exploded");
      },
    };
    let nodeId: number | undefined;
    for (let i = 1; i <= 3; i++) {
      const day = ledger.createDay(`2026-07-${17 + i}`, `p${i}`, "x", "t0");
      ledger.finalizeResponse(day.id, "a", `answer ${i}`, "t1");
      ledger.resolveDay(day.id, "resolved_partial", "t2");
      const target = nodeId === undefined
        ? { newNode: { domain: "daily-life", subdomain: "cooking", summary: "Likes to cook." } }
        : { nodeId };
      const { client } = scriptedLlm(() =>
        JSON.stringify({ observations: [{ type: "fact", text: `fact ${i}`, ...target }] }),
      );
      const result = await processPending({ ledger, llm: client, summaryLlm, log: () => {}, person: "a" });
      expect(result.failed).toBe(0);
      nodeId = ledger.nodesFor("a")[0]!.id;
    }
    expect(ledger.nodesFor("a")[0]!.summary).toBe("Likes to cook.");
  });
});
