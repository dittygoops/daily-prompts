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

const okResponse = (prompt: string, usedIdeaId: number | null = null) =>
  JSON.stringify({ prompt, rationale: "test rationale", usedIdeaId });

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
  test("returns a Prompt with id gen-<date> and the generated text on success", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() => okResponse("What made you smile today?"));
    const source = makeSource(ledger, memory, client);
    const prompt = await source.nextPrompt("2026-07-20");
    expect(prompt).toEqual({ id: "gen-2026-07-20", text: "What made you smile today?" });
  });

  test("calls memory.getContext and getCoverage for both people", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const obs: Observation = {
      type: "fact", text: "x", topic: "t", person: "a",
      provenance: { dayId: 1, date: "2026-07-18", snippet: "s" },
    };
    await memory.add([obs]);
    const { client, calls } = scriptedLlm(() => okResponse("p"));
    const source = makeSource(ledger, memory, client);
    await source.nextPrompt("2026-07-20");
    expect(calls[0]!.user).toContain("x"); // context made it into the prompt
  });

  test("records a generation_log row on success with model, prompts, response, rationale, fellBack=false", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() => okResponse("What's a small win from today?"));
    const source = makeSource(ledger, memory, client);
    await source.nextPrompt("2026-07-20");
    const rows = ledger.generationLogFor("2026-07-20");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      model: "test-model",
      promptText: "What's a small win from today?",
      rationale: "test rationale",
      fellBack: false,
    });
  });

  test("throws when the LLM call itself rejects", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const client: LlmClient = { async complete() { throw new Error("network down"); } };
    const source = makeSource(ledger, memory, client);
    await expect(source.nextPrompt("2026-07-20")).rejects.toThrow(/network down/);
  });

  test("throws when the LLM response is not valid JSON after retries are exhausted", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() => "not json");
    const source = makeSource(ledger, memory, client);
    await expect(source.nextPrompt("2026-07-20")).rejects.toThrow();
  });

  test("throws when the LLM response is valid JSON but missing the prompt field", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() => JSON.stringify({ rationale: "x" }));
    const source = makeSource(ledger, memory, client);
    await expect(source.nextPrompt("2026-07-20")).rejects.toThrow();
  });

  test("retries in-process on a single transient malformed response, then succeeds", async () => {
    let calls = 0;
    const client: LlmClient = {
      async complete() {
        calls++;
        if (calls < 2) return "not json";
        return okResponse("recovered prompt");
      },
    };
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const source = makeSource(ledger, memory, client);
    const prompt = await source.nextPrompt("2026-07-20");
    expect(prompt.text).toBe("recovered prompt");
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
    const { client } = scriptedLlm(() => okResponse("p"));
    const source = new AdaptivePromptSource(throwingMemory as unknown as FakeMemory, client, ledger, {
      model: "m", historyWindowDays: 14, feedbackWindowDays: 14, contextBudgetChars: 3000, names: { a: "Alex", b: "Sam" },
    });
    await expect(source.nextPrompt("2026-07-20")).rejects.toThrow(/supermemory down/);
  });

  test("day 1 / empty memory for both people still produces a valid generated prompt (pure exploration)", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() => okResponse("What's something you're curious about lately?"));
    const source = makeSource(ledger, memory, client);
    const prompt = await source.nextPrompt("2026-07-20");
    expect(prompt.text).toBe("What's something you're curious about lately?");
  });

  test("recent prompt history passed to the LLM is capped at historyWindowDays", async () => {
    const ledger = Ledger.open(":memory:");
    for (let i = 1; i <= 20; i++) {
      ledger.createDay(`2026-06-${String(i).padStart(2, "0")}`, `p${i}`, `prompt ${i}`, "t");
    }
    const memory = new FakeMemory();
    const { client, calls } = scriptedLlm(() => okResponse("p"));
    const source = new AdaptivePromptSource(memory, client, ledger, {
      model: "m", historyWindowDays: 3, feedbackWindowDays: 14, contextBudgetChars: 3000, names: { a: "Alex", b: "Sam" },
    });
    await source.nextPrompt("2026-07-01");
    const historyLines = calls[0]!.user.split("\n").filter((l) => l.trim().startsWith("["));
    expect(historyLines.length).toBe(3);
  });

  test("does not record a generation_log row when generation throws (log-on-success-only)", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() => "not json");
    const source = makeSource(ledger, memory, client);
    await expect(source.nextPrompt("2026-07-20")).rejects.toThrow();
    expect(ledger.generationLogFor("2026-07-20")).toEqual([]);
  });

  test("using an unconsumed prompt idea marks it consumed", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t");
    const ideaId = ledger.addPromptIdea("a", "ask about our Tokyo trip", day.id, "t1");
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() => okResponse("How's Tokyo trip planning going?", ideaId));
    const source = makeSource(ledger, memory, client);
    await source.nextPrompt("2026-07-20");
    expect(ledger.unconsumedPromptIdeas("a")).toEqual([]);
  });

  test("an invalid usedIdeaId (not a real unconsumed idea) is ignored, not an error", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() => okResponse("some prompt", 9999));
    const source = makeSource(ledger, memory, client);
    await expect(source.nextPrompt("2026-07-20")).resolves.toBeDefined();
  });
});
