import { describe, expect, test } from "bun:test";
import { AdaptivePromptSource } from "../src/prompts/adaptive";
import { Ledger } from "../src/ledger/ledger";
import { FakeMemory } from "../src/memory/fake";
import type { LlmClient } from "../src/llm/types";
import type { Observation } from "../src/memory/types";

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

function okResponse(opts: {
  a: string;
  b: string;
  theme?: string | null;
  usedIdeaId?: number | null;
  stanceA?: string;
  stanceB?: string;
}) {
  const { a, b, theme = "shared theme", usedIdeaId = null, stanceA = "explore", stanceB = "explore" } = opts;
  return JSON.stringify({
    theme,
    a: { prompt: a, stance: stanceA },
    b: { prompt: b, stance: stanceB },
    rationale: "test rationale",
    usedIdeaId,
  });
}

function makeSource(ledger: Ledger, memory: FakeMemory, client: LlmClient) {
  return new AdaptivePromptSource(memory, client, ledger, {
    model: "test-model",
    historyWindowDays: 14,
    feedbackWindowDays: 14,
    contextBudgetChars: 3000,
    names: { a: "Alex", b: "Sam" },
  });
}

describe("AdaptivePromptSource", () => {
  test("returns DailyPrompts with per-person ids and texts on success", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() => okResponse({ a: "What made you smile today?", b: "What made you laugh today?" }));
    const source = makeSource(ledger, memory, client);
    const result = await source.nextPrompts("2026-07-20");
    expect(result.prompts.a).toEqual({ id: "gen-2026-07-20-a", text: "What made you smile today?" });
    expect(result.prompts.b).toEqual({ id: "gen-2026-07-20-b", text: "What made you laugh today?" });
    expect(result.theme).toBe("shared theme");
  });

  test("one LLM call produces two different prompt texts for the two people", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const { client, calls } = scriptedLlm(() => okResponse({ a: "question for Alex", b: "question for Sam" }));
    const result = await makeSource(ledger, memory, client).nextPrompts("2026-07-20");
    expect(calls.length).toBe(1);
    expect(result.prompts.a.text).not.toBe(result.prompts.b.text);
  });

  test("calls memory.getContext and getCoverage for both people", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const obs: Observation = {
      type: "fact", text: "x", topic: "t", person: "a",
      provenance: { dayId: 1, date: "2026-07-18", snippet: "s" },
    };
    await memory.add([obs]);
    const { client, calls } = scriptedLlm(() => okResponse({ a: "p", b: "q" }));
    const source = makeSource(ledger, memory, client);
    await source.nextPrompts("2026-07-20");
    expect(calls[0]!.user).toContain("x"); // context made it into the prompt
  });

  test("records two generation_log rows on success, one per person, sharing model/response/rationale", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() => okResponse({ a: "What's a small win from today?", b: "What's a small win you saw someone else have?" }));
    const source = makeSource(ledger, memory, client);
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
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() =>
      JSON.stringify({
        theme: "t",
        a: { prompt: "What's a small win from today?" },
        b: { prompt: "What's a small win you saw?", stance: "explore" },
        rationale: "r",
        usedIdeaId: null,
      }),
    );
    await expect(makeSource(ledger, memory, client).nextPrompts("2026-07-20")).rejects.toThrow();
  });

  test("rejects a stance outside explore/exploit rather than storing free text", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() => okResponse({ a: "What's a small win?", b: "What's a small loss?", stanceA: "a bit of both" }));
    await expect(makeSource(ledger, memory, client).nextPrompts("2026-07-20")).rejects.toThrow();
  });

  test("a malformed response missing the b prompt is rejected", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() =>
      JSON.stringify({ theme: "t", a: { prompt: "qa", stance: "explore" }, rationale: "r", usedIdeaId: null }),
    );
    await expect(makeSource(ledger, memory, client).nextPrompts("2026-07-20")).rejects.toThrow();
  });

  test("on an exploit day, a person with threads is assigned exploit while a person with no threads is assigned explore", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    await memory.add([{
      type: "thread", text: "Nervous about their defense in August.", topic: "thesis",
      person: "a", provenance: { dayId: 1, date: "2026-07-19", snippet: "s" },
    }]);
    // Declares explore for both; the assigned per-person stance is what gets
    // recorded, so a disagreeing model cannot quietly reintroduce the
    // all-explore drift.
    const { client, calls } = scriptedLlm(() => okResponse({ a: "How did the defense go?", b: "What's a small win from today?" }));
    await makeSource(ledger, memory, client).nextPrompts("2026-07-20");
    const rows = ledger.generationLogFor("2026-07-20");
    expect(rows.find((r) => r.person === "a")!.stance).toBe("exploit");
    expect(rows.find((r) => r.person === "b")!.stance).toBe("explore");
    expect(calls[0]!.user).toContain("EXPLOIT");
  });

  test("assigns explore to both people when there is no thread to follow up on", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() => okResponse({ a: "What's a small win from today?", b: "What's a small win from today?" }));
    await makeSource(ledger, memory, client).nextPrompts("2026-07-20");
    const rows = ledger.generationLogFor("2026-07-20");
    expect(rows.find((r) => r.person === "a")!.stance).toBe("explore");
    expect(rows.find((r) => r.person === "b")!.stance).toBe("explore");
  });

  test("retries when person A's generated prompt near-duplicates one already sent to A", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-19", "p1", "What's an unexpected sound or noise you secretly enjoy?", "t");
    ledger.resolveDay(day.id, "resolved_shared", "t2");
    const memory = new FakeMemory();
    let call = 0;
    const { client } = scriptedLlm(() => {
      call++;
      return call === 1
        ? okResponse({ a: "What's an unexpected sound you secretly enjoy?", b: "What's your favorite drink?" })
        : okResponse({ a: "What's a place you keep meaning to visit?", b: "What's your favorite drink?" });
    });
    const result = await makeSource(ledger, memory, client).nextPrompts("2026-07-20");
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
    const memory = new FakeMemory();
    const { client, calls } = scriptedLlm(() =>
      okResponse({ a: "What's an unexpected sound you secretly enjoy?", b: "Which room in your place do you like best?" }),
    );
    const result = await makeSource(ledger, memory, client).nextPrompts("2026-07-20");
    expect(calls.length).toBe(1);
    expect(result.prompts.a.text).toBe("What's an unexpected sound you secretly enjoy?");
  });

  test("throws when the LLM call itself rejects", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const client: LlmClient = { async complete() { throw new Error("network down"); } };
    const source = makeSource(ledger, memory, client);
    await expect(source.nextPrompts("2026-07-20")).rejects.toThrow(/network down/);
  });

  test("throws when the LLM response is not valid JSON after retries are exhausted", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() => "not json");
    const source = makeSource(ledger, memory, client);
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
    const memory = new FakeMemory();
    const source = makeSource(ledger, memory, client);
    const result = await source.nextPrompts("2026-07-20");
    expect(result.prompts.a.text).toBe("recovered prompt a");
    expect(calls).toBe(2);
  });

  test("propagates when memory.getContext rejects", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const throwingMemory = {
      add: memory.add.bind(memory),
      getContext: async () => { throw new Error("supermemory down"); },
      getCoverage: memory.getCoverage.bind(memory),
      wipe: memory.wipe.bind(memory),
    };
    const { client } = scriptedLlm(() => okResponse({ a: "p", b: "q" }));
    const source = new AdaptivePromptSource(throwingMemory as unknown as FakeMemory, client, ledger, {
      model: "m", historyWindowDays: 14, feedbackWindowDays: 14, contextBudgetChars: 3000, names: { a: "Alex", b: "Sam" },
    });
    await expect(source.nextPrompts("2026-07-20")).rejects.toThrow(/supermemory down/);
  });

  test("day 1 / empty memory for both people still produces a valid generated pair (pure exploration)", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() => okResponse({ a: "What's something you're curious about lately?", b: "What's something you'd like to try?" }));
    const source = makeSource(ledger, memory, client);
    const result = await source.nextPrompts("2026-07-20");
    expect(result.prompts.a.text).toBe("What's something you're curious about lately?");
    expect(result.prompts.b.text).toBe("What's something you'd like to try?");
  });

  test("recent prompt history passed to the LLM is capped at historyWindowDays, for each person", async () => {
    const ledger = Ledger.open(":memory:");
    for (let i = 1; i <= 20; i++) {
      ledger.createDay(`2026-06-${String(i).padStart(2, "0")}`, `p${i}`, `prompt ${i}`, "t");
    }
    const memory = new FakeMemory();
    const { client, calls } = scriptedLlm(() => okResponse({ a: "p", b: "q" }));
    const source = new AdaptivePromptSource(memory, client, ledger, {
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
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() => "not json");
    const source = makeSource(ledger, memory, client);
    await expect(source.nextPrompts("2026-07-20")).rejects.toThrow();
    expect(ledger.generationLogFor("2026-07-20")).toEqual([]);
  });

  test("using an unconsumed prompt idea marks it consumed", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t");
    const ideaId = ledger.addPromptIdea("a", "ask about our Tokyo trip", day.id, "t1");
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() => okResponse({ a: "How's Tokyo trip planning going?", b: "What's a trip you'd love to take?", usedIdeaId: ideaId }));
    const source = makeSource(ledger, memory, client);
    await source.nextPrompts("2026-07-20");
    expect(ledger.unconsumedPromptIdeas("a")).toEqual([]);
  });

  test("an invalid usedIdeaId (not a real unconsumed idea) is ignored, not an error", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() => okResponse({ a: "some prompt", b: "another prompt", usedIdeaId: 9999 }));
    const source = makeSource(ledger, memory, client);
    await expect(source.nextPrompts("2026-07-20")).resolves.toBeDefined();
  });
});
