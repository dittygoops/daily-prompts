import { describe, expect, test } from "bun:test";
import { processPending } from "../src/extraction/pipeline";
import { Ledger } from "../src/ledger/ledger";
import { FakeMemory } from "../src/memory/fake";
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
  JSON.stringify({ observations: [{ type: "fact", text, topic: "t" }] });

describe("processPending", () => {
  test("does nothing when the ledger has no pending work", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() => okResponse("x"));
    const result = await processPending({ ledger, llm: client, memory, log: () => {} });
    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(memory.stored).toEqual([]);
  });

  test("extracts a resolved_shared day for both persons and marks both extractions done", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "What's your favorite family tradition?", "t0");
    ledger.finalizeResponse(day.id, "a", "pancakes", "t1");
    ledger.finalizeResponse(day.id, "b", "waffles", "t2");
    ledger.resolveDay(day.id, "resolved_shared", "t3");
    const memory = new FakeMemory();
    const { client } = scriptedLlm((user) => okResponse(user.includes("pancakes") ? "about a" : "about b"));

    const result = await processPending({ ledger, llm: client, memory, log: () => {} });
    expect(result).toEqual({ processed: 2, failed: 0 });
    expect(memory.stored.length).toBe(2);
    expect(memory.stored.find((o) => o.person === "a")?.text).toBe("about a");
    expect(memory.stored.find((o) => o.person === "b")?.text).toBe("about b");
    expect(ledger.extractionFor(day.id, "a")).toMatchObject({ status: "done", observationCount: 1, attempts: 1 });
    expect(ledger.extractionFor(day.id, "b")).toMatchObject({ status: "done", observationCount: 1, attempts: 1 });
  });

  test("a skipped person yields zero observations and is marked done without an LLM call", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t0");
    ledger.markSkipped(day.id, "a", "t1");
    ledger.finalizeResponse(day.id, "b", "waffles", "t2");
    ledger.resolveDay(day.id, "resolved_partial", "t3");
    const memory = new FakeMemory();
    const { client, calls } = scriptedLlm(() => okResponse("about b"));

    const result = await processPending({ ledger, llm: client, memory, log: () => {} });
    expect(result).toEqual({ processed: 2, failed: 0 });
    expect(calls.length).toBe(1); // only for b
    expect(ledger.extractionFor(day.id, "a")).toMatchObject({ status: "done", observationCount: 0 });
  });

  test("a person who never answered (resolved_partial, still awaiting) is treated as skipped with zero observations", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t0");
    ledger.finalizeResponse(day.id, "a", "pancakes", "t1");
    ledger.resolveDay(day.id, "resolved_partial", "t2"); // b never answered
    const memory = new FakeMemory();
    const { client, calls } = scriptedLlm(() => okResponse("about a"));

    const result = await processPending({ ledger, llm: client, memory, log: () => {} });
    expect(result).toEqual({ processed: 2, failed: 0 });
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

    const memory = new FakeMemory();
    const { client, calls } = scriptedLlm(() => okResponse("x"));
    await processPending({ ledger, llm: client, memory, log: () => {} });

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
    const memory = new FakeMemory();
    const { client } = scriptedLlm((user) => {
      if (user.includes("pancakes")) throw new Error("LLM exploded for a");
      return okResponse("about b");
    });

    const result = await processPending({ ledger, llm: client, memory, log: () => {} });
    expect(result).toEqual({ processed: 1, failed: 1 });
    expect(ledger.extractionFor(day.id, "a")).toMatchObject({ status: "failed", attempts: 1 });
    expect(ledger.extractionFor(day.id, "b")).toMatchObject({ status: "done" });
    expect(memory.stored.find((o) => o.person === "a")).toBeUndefined();
    expect(memory.stored.find((o) => o.person === "b")).toBeDefined();
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

    const memory = new FakeMemory();
    const { client } = scriptedLlm((user) => {
      if (user.includes("bad day")) throw new Error("boom");
      return okResponse("ok");
    });

    const result = await processPending({ ledger, llm: client, memory, log: () => {} });
    expect(result).toEqual({ processed: 2, failed: 2 });
    expect(ledger.extractionFor(day2.id, "a")).toMatchObject({ status: "done" });
    expect(ledger.extractionFor(day2.id, "b")).toMatchObject({ status: "done" });
  });

  test("repeated failures accumulate attempts and eventually drop out of pending work", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t0");
    ledger.finalizeResponse(day.id, "a", "pancakes", "t1");
    ledger.finalizeResponse(day.id, "b", "waffles", "t2");
    ledger.resolveDay(day.id, "resolved_shared", "t3");
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() => {
      throw new Error("always fails");
    });

    await processPending({ ledger, llm: client, memory, log: () => {} });
    await processPending({ ledger, llm: client, memory, log: () => {} });
    await processPending({ ledger, llm: client, memory, log: () => {} });
    expect(ledger.extractionFor(day.id, "a")?.attempts).toBe(3);
    expect(ledger.unprocessedResolvedDays().some((p) => p.dayId === day.id && p.person === "a")).toBe(false);

    const result = await processPending({ ledger, llm: client, memory, log: () => {} });
    expect(result).toEqual({ processed: 0, failed: 0 }); // nothing left to attempt
  });

  test("already-done extractions are never reprocessed (idempotent across calls)", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t0");
    ledger.finalizeResponse(day.id, "a", "pancakes", "t1");
    ledger.finalizeResponse(day.id, "b", "waffles", "t2");
    ledger.resolveDay(day.id, "resolved_shared", "t3");
    const memory = new FakeMemory();
    const { client, calls } = scriptedLlm(() => okResponse("x"));

    await processPending({ ledger, llm: client, memory, log: () => {} });
    const callCountAfterFirst = calls.length;
    const storedCountAfterFirst = memory.stored.length;

    const second = await processPending({ ledger, llm: client, memory, log: () => {} });
    expect(second).toEqual({ processed: 0, failed: 0 });
    expect(calls.length).toBe(callCountAfterFirst);
    expect(memory.stored.length).toBe(storedCountAfterFirst);
  });

  test("logs a loud, specific message on failure", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t0");
    ledger.finalizeResponse(day.id, "a", "pancakes", "t1");
    ledger.finalizeResponse(day.id, "b", "waffles", "t2");
    ledger.resolveDay(day.id, "resolved_shared", "t3");
    const memory = new FakeMemory();
    const { client } = scriptedLlm((user) => {
      if (user.includes("pancakes")) throw new Error("boom");
      return okResponse("ok");
    });
    const logs: string[] = [];

    await processPending({ ledger, llm: client, memory, log: (m) => logs.push(m) });
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
    const memory = new FakeMemory();
    const { client } = scriptedLlm((user) =>
      JSON.stringify({
        observations: [],
        promptIdeas: user.includes("ask about our trip") ? ["ask us about our upcoming trip"] : [],
      }),
    );

    await processPending({ ledger, llm: client, memory, log: () => {} });
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
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() => okResponse("x"));

    const result = await processPending({ ledger, llm: client, memory, log: () => {}, person: "a" });
    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(ledger.extractionFor(day.id, "a")).toMatchObject({ status: "done" });
    expect(ledger.extractionFor(day.id, "b")).toBeNull();
    expect(memory.stored.every((o) => o.person === "a")).toBe(true);
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

    const memory = new FakeMemory();
    const { client } = scriptedLlm((user) => {
      if (user.includes("fail-me")) throw new Error("boom");
      return okResponse("ok");
    });

    const result = await processPending({ ledger, llm: client, memory, log: () => {} });
    expect(result).toEqual({ processed: 3, failed: 1 });
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
    await processPending({ ledger, llm, memory: new FakeMemory(), log: () => {} });
    const aCall = calls.find((c) => c.user.includes("slowly but well"))!;
    expect(aCall.user).toContain("How is the guitar practice going?");
    expect(aCall.user).not.toContain("Current self-improvement efforts");
  });
});
