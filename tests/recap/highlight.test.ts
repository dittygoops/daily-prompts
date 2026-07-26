import { describe, expect, test } from "bun:test";
import { generateHighlight } from "../../src/recap/highlight";
import { Ledger } from "../../src/ledger/ledger";
import type { LlmClient } from "../../src/llm/types";

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

const names = { a: "Alex", b: "Sam" } as const;
const okResponse = (highlight: string, topics = "food, traditions") => JSON.stringify({ topics, highlight });

describe("generateHighlight", () => {
  test("returns the LLM's topics and highlight text on success", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-13", "p1", "What's your favorite tradition?", "t");
    ledger.finalizeResponse(day.id, "a", "Tandoori Times for birthdays", "t1");
    ledger.finalizeResponse(day.id, "b", "Naturals ice cream in India", "t2");
    const { client } = scriptedLlm(() => okResponse("A warm week of food traditions."));
    const result = await generateHighlight(ledger, "2026-07-13", "2026-07-19", names, client, "test-model");
    expect(result.highlight).toBe("A warm week of food traditions.");
    expect(result.topics).toBe("food, traditions");
  });

  test("includes the week's real answers in the prompt sent to the LLM", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-13", "p1", "x", "t");
    ledger.finalizeResponse(day.id, "a", "unique answer text here", "t1");
    const { client, calls } = scriptedLlm(() => okResponse("h"));
    await generateHighlight(ledger, "2026-07-13", "2026-07-19", names, client, "test-model");
    expect(calls[0]!.user).toContain("unique answer text here");
  });

  test("parses a response wrapped in markdown code fences (claude models do this)", async () => {
    const ledger = Ledger.open(":memory:");
    ledger.createDay("2026-07-13", "p1", "x", "t");
    const { client } = scriptedLlm(() => "```json\n" + okResponse("Fenced but fine.") + "\n```");
    const result = await generateHighlight(ledger, "2026-07-13", "2026-07-19", names, client, "m");
    expect(result.highlight).toBe("Fenced but fine.");
  });

  test("throws when the LLM call rejects", async () => {
    const ledger = Ledger.open(":memory:");
    const client: LlmClient = { async complete() { throw new Error("outage"); } };
    await expect(generateHighlight(ledger, "2026-07-13", "2026-07-19", names, client, "m")).rejects.toThrow(/outage/);
  });

  test("throws after exhausting retries on malformed JSON", async () => {
    const { client } = scriptedLlm(() => "not json");
    const ledger = Ledger.open(":memory:");
    await expect(generateHighlight(ledger, "2026-07-13", "2026-07-19", names, client, "m")).rejects.toThrow();
  });
});
