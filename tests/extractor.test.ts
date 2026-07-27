import { describe, expect, test } from "bun:test";
import { extractObservations, type ExtractionInput } from "../src/extraction/extractor";
import { EXTRACTION_SYSTEM_PROMPT } from "../src/extraction/prompt";
import type { LlmClient } from "../src/llm/types";

function fakeLlm(response: string | (() => string)) {
  const calls: { system: string; user: string }[] = [];
  const client: LlmClient = {
    async complete(system, user) {
      calls.push({ system, user });
      return typeof response === "function" ? response() : response;
    },
  };
  return { client, calls };
}

const baseInput: ExtractionInput = {
  dayId: 1,
  date: "2026-07-19",
  promptText: "What's your favorite family tradition?",
  person: "a",
  response: "Birthday dinners at Tandoori Times with family.",
  skipped: false,
  feedback: [],
};

describe("temporal grounding", () => {
  test("tells the extractor what date the answer was given", async () => {
    const { client, calls } = fakeLlm('{"observations":[]}');
    await extractObservations({ ...baseInput, date: "2026-07-19" }, client);
    expect(calls[0]!.user).toContain("2026-07-19");
  });

  test("system prompt requires resolving relative time references to absolute dates", () => {
    const sys = EXTRACTION_SYSTEM_PROMPT.toLowerCase();
    // Without this, "going to Sedona this weekend" is stored verbatim and
    // still reads as upcoming months later.
    expect(sys).toMatch(/this weekend|tomorrow|relative/);
    expect(sys).toMatch(/absolute|actual date|resolve/);
  });
});

describe("extractObservations", () => {
  test("a skipped day with no feedback never calls the LLM", async () => {
    const { client, calls } = fakeLlm('{"observations":[]}');
    const result = await extractObservations(
      { ...baseInput, response: null, skipped: true },
      client,
    );
    expect(result.observations).toEqual([]);
    expect(result.promptIdeas).toEqual([]);
    expect(calls.length).toBe(0);
  });

  test("parses valid observations and forces the requested person + provenance", async () => {
    const { client } = fakeLlm(
      JSON.stringify({
        observations: [
          {
            type: "fact",
            text: "Enjoys birthday dinners at a favorite restaurant with family.",
            topic: "family-traditions",
            person: "WRONG_PERSON",
          },
        ],
      }),
    );
    const result = await extractObservations(baseInput, client);
    expect(result.observations.length).toBe(1);
    expect(result.observations[0]).toMatchObject({
      type: "fact",
      topic: "family-traditions",
      person: "a", // forced, never trusts the LLM's own person field
    });
    expect(result.observations[0]!.provenance).toEqual({
      dayId: 1,
      date: "2026-07-19",
      snippet: "Birthday dinners at Tandoori Times with family.",
    });
  });

  test("drops individually malformed observations but keeps valid ones", async () => {
    const { client } = fakeLlm(
      JSON.stringify({
        observations: [
          { type: "not-a-real-type", text: "bogus", topic: "x" },
          { type: "interest", text: "Likes Indian food traditions.", topic: "food" },
        ],
      }),
    );
    const result = await extractObservations(baseInput, client);
    expect(result.observations.length).toBe(1);
    expect(result.observations[0]!.type).toBe("interest");
  });

  test("retries in-process on transient malformed output, then succeeds", async () => {
    let calls = 0;
    const client: LlmClient = {
      async complete() {
        calls++;
        if (calls < 3) return "not json at all"; // simulate intermittent truncation
        return '{"observations":[{"type":"fact","text":"ok","topic":"t"}]}';
      },
    };
    const result = await extractObservations(baseInput, client);
    expect(calls).toBe(3);
    expect(result.observations.length).toBe(1);
  });

  test("throws after exhausting retries on persistently unparseable output", async () => {
    const { client, calls } = fakeLlm("not json at all");
    await expect(extractObservations(baseInput, client)).rejects.toThrow();
    expect(calls.length).toBe(3); // the retry cap, not an infinite loop
  });

  test("a skipped day with feedback still calls the LLM (for prompt_preference)", async () => {
    const { client, calls } = fakeLlm('{"observations":[]}');
    await extractObservations(
      { ...baseInput, response: null, skipped: true, feedback: ["today's question was too heavy"] },
      client,
    );
    expect(calls.length).toBe(1);
    expect(calls[0]!.user).toContain("too heavy");
  });

  test("the user prompt includes the day's question, the response, and feedback", async () => {
    const { client, calls } = fakeLlm('{"observations":[]}');
    await extractObservations({ ...baseInput, feedback: ["loved this one"] }, client);
    expect(calls[0]!.user).toContain("family tradition");
    expect(calls[0]!.user).toContain("Tandoori Times");
    expect(calls[0]!.user).toContain("loved this one");
  });

  test("the system prompt instructs conservative, non-invented, hedge-or-drop extraction", async () => {
    const { client, calls } = fakeLlm('{"observations":[]}');
    await extractObservations(baseInput, client);
    const sys = calls[0]!.system.toLowerCase();
    expect(sys).toContain("never invent");
    expect(sys).toContain("json");
  });

  describe("prompt_preference guard", () => {
    test("drops a prompt_preference observation from the model when no feedback was given, even if the model returns one", async () => {
      const { client } = fakeLlm(
        JSON.stringify({
          observations: [
            {
              type: "prompt_preference",
              text: "They enjoyed the question about family traditions.",
              topic: "family-traditions",
            },
          ],
        }),
      );
      const result = await extractObservations(baseInput, client); // baseInput has feedback: []
      expect(result.observations).toEqual([]);
    });

    test("keeps a prompt_preference observation from the model when feedback was given", async () => {
      const { client } = fakeLlm(
        JSON.stringify({
          observations: [
            { type: "prompt_preference", text: "Enjoyed this style of question.", topic: "family-traditions" },
          ],
        }),
      );
      const result = await extractObservations({ ...baseInput, feedback: ["that was fun"] }, client);
      expect(result.observations.length).toBe(1);
      expect(result.observations[0]!.type).toBe("prompt_preference");
    });

    test("drops only the prompt_preference item and keeps other valid observations in the same response when there is no feedback", async () => {
      const { client } = fakeLlm(
        JSON.stringify({
          observations: [
            { type: "fact", text: "Enjoys birthday dinners at Tandoori Times.", topic: "family-traditions" },
            { type: "prompt_preference", text: "Enjoyed this question.", topic: "family-traditions" },
          ],
        }),
      );
      const result = await extractObservations(baseInput, client);
      expect(result.observations.length).toBe(1);
      expect(result.observations[0]!.type).toBe("fact");
    });

    test("the system prompt explicitly warns against inferring prompt_preference from the answer alone", async () => {
      const { client, calls } = fakeLlm('{"observations":[]}');
      await extractObservations(baseInput, client);
      const sys = calls[0]!.system.toLowerCase();
      expect(sys).toContain("prompt_preference");
      expect(sys).toContain("must not produce");
    });

    test("an explicit 'no feedback was given' line appears in the user prompt when feedback is empty", async () => {
      const { client, calls } = fakeLlm('{"observations":[]}');
      await extractObservations(baseInput, client); // feedback: []
      expect(calls[0]!.user.toLowerCase()).toContain("no feedback was given");
    });
  });

  describe("promptIdeas", () => {
    test("parses explicit prompt-idea suggestions from feedback", async () => {
      const { client } = fakeLlm(
        JSON.stringify({ observations: [], promptIdeas: ["ask us about our upcoming Tokyo trip"] }),
      );
      const result = await extractObservations({ ...baseInput, feedback: ["you should ask about our Tokyo trip"] }, client);
      expect(result.promptIdeas).toEqual(["ask us about our upcoming Tokyo trip"]);
    });

    test("drops promptIdeas when no feedback was given, even if the model returns some (same zero-trust guard as prompt_preference)", async () => {
      const { client } = fakeLlm(JSON.stringify({ observations: [], promptIdeas: ["an invented idea"] }));
      const result = await extractObservations(baseInput, client); // feedback: []
      expect(result.promptIdeas).toEqual([]);
    });

    test("missing promptIdeas field in the response defaults to an empty array, not an error", async () => {
      const { client } = fakeLlm('{"observations":[]}');
      const result = await extractObservations({ ...baseInput, feedback: ["loved it"] }, client);
      expect(result.promptIdeas).toEqual([]);
    });

    test("non-string or malformed promptIdeas entries are dropped individually", async () => {
      const { client } = fakeLlm(JSON.stringify({ observations: [], promptIdeas: ["good idea", 42, ""] }));
      const result = await extractObservations({ ...baseInput, feedback: ["x"] }, client);
      expect(result.promptIdeas).toEqual(["good idea"]);
    });
  });
});
