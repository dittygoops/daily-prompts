import { describe, expect, test } from "bun:test";
import { generateHighlight, HIGHLIGHT_SYSTEM_PROMPT } from "../../src/recap/highlight";
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

describe("per-person week layout", () => {
  test("shows each person their own question alongside their own answer", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-13", "p1", "looking back", "t");
    ledger.setPersonPrompt(day.id, "a", "gen-a", "How is the guitar going?");
    ledger.setPersonPrompt(day.id, "b", "gen-b", "How did the party go?");
    ledger.finalizeResponse(day.id, "a", "slowly but surely", "t1");
    ledger.finalizeResponse(day.id, "b", "it was great", "t2");
    const { client, calls } = scriptedLlm(() => okResponse("h"));
    await generateHighlight(ledger, "2026-07-13", "2026-07-19", names, client, "m");
    const user = calls[0]!.user;
    // Without pairing, two answers to two unseen questions are uninterpretable.
    expect(user).toContain("Alex was asked: How is the guitar going?");
    expect(user).toContain("Alex said: slowly but surely");
    expect(user).toContain("Sam was asked: How did the party go?");
    expect(user).toContain("Sam said: it was great");
  });

  test("labels the day's theme as context and does not quote it like a question", async () => {
    // The old format printed the day-level text in quotes, which now invites
    // the model to treat a 2-to-6 word label as something someone was asked.
    const ledger = Ledger.open(":memory:");
    ledger.createDay("2026-07-13", "p1", "looking back", "t");
    const { client, calls } = scriptedLlm(() => okResponse("h"));
    await generateHighlight(ledger, "2026-07-13", "2026-07-19", names, client, "m");
    expect(calls[0]!.user).toContain("shared angle: looking back");
    expect(calls[0]!.user).not.toContain('"looking back"');
  });

  test("a non-answer shows the state, and still shows what they were asked", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-13", "p1", "looking back", "t");
    ledger.setPersonPrompt(day.id, "a", "gen-a", "How is the guitar going?");
    ledger.markSkipped(day.id, "a", "t1");
    const { client, calls } = scriptedLlm(() => okResponse("h"));
    await generateHighlight(ledger, "2026-07-13", "2026-07-19", names, client, "m");
    expect(calls[0]!.user).toContain("Alex was asked: How is the guitar going?");
    expect(calls[0]!.user).toContain("Alex said: (skipped)");
  });
});

describe("different-questions instruction", () => {
  test("frames differing questions as making an echo stronger, not as a hazard only", () => {
    // The rewrite exists because contrast-hunting across two different
    // questions can manufacture a difference that is an artifact of the
    // questions rather than anything true about the couple.
    expect(HIGHLIGHT_SYSTEM_PROMPT).toMatch(/different routes|more striking/i);
    expect(HIGHLIGHT_SYSTEM_PROMPT).toMatch(/only say they were asked the same question when/i);
    expect(HIGHLIGHT_SYSTEM_PROMPT).toMatch(/just follows from their two questions being different/i);
  });

  test("no example implies the two people answered one identical question", () => {
    expect(HIGHLIGHT_SYSTEM_PROMPT).not.toContain("the comfort food question");
  });
});

describe("voice guards added after a live dry run", () => {
  test("bans typecasting an individual, not just the couple in aggregate", () => {
    // A dry run produced "someone's got a knack for showing up exactly where
    // they're not expected", aimed at one person, which the aggregate-only
    // wording did not cover.
    expect(HIGHLIGHT_SYSTEM_PROMPT).toMatch(/one of them as a type of person/i);
  });

  test("bans joking about something with a sting in it", () => {
    expect(HIGHLIGHT_SYSTEM_PROMPT).toMatch(/sting|left out|overlooked/i);
  });

  test("requires complete sentences", () => {
    expect(HIGHLIGHT_SYSTEM_PROMPT).toMatch(/complete sentences|subject and a verb/i);
  });

  test("caps topics at four and asks for neutral labels", () => {
    expect(HIGHLIGHT_SYSTEM_PROMPT).toMatch(/between 2 and 4 items, never more/i);
  });
});

describe("transition-week correctness", () => {
  test("permits saying the question was shared when it genuinely was", () => {
    // Days before per-person prompts really did ask both people the same
    // question, and a blanket ban forbade stating a true fact about them.
    expect(HIGHLIGHT_SYSTEM_PROMPT).toMatch(/only say they were asked the same question when/i);
  });

  test("bans em dashes in the outgoing text", () => {
    expect(HIGHLIGHT_SYSTEM_PROMPT).toMatch(/never use an em dash/i);
  });
});
