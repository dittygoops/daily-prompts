import { describe, expect, test } from "bun:test";
import { extractObservations, type ExistingNode, type ExtractionInput } from "../src/extraction/extractor";
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
  existingNodes: [],
};

const gymNode: ExistingNode = {
  id: 14,
  domain: "hobbies-interests",
  subdomain: "gym",
  summary: "Goes to the gym regularly and lifts weights.",
};

describe("temporal grounding", () => {
  test("tells the extractor what date the answer was given", async () => {
    const { client, calls } = fakeLlm('{"observations":[]}');
    await extractObservations({ ...baseInput, date: "2026-07-19" }, client);
    expect(calls[0]!.user).toContain("2026-07-19");
  });

  test("the system prompt states the consolidation contract that the first live rebuild lacked", () => {
    // The first live rebuild fragmented one answer into ten nodes (the
    // psychic-party day) because nothing told the model a node is a subject
    // area rather than a fact. These lines are the fix; losing them silently
    // reintroduces a graph of one-fact nodes that argmax can never attribute.
    const sys = EXTRACTION_SYSTEM_PROMPT;
    expect(sys).toContain("SUBJECT AREA");
    expect(sys).toContain("belong to the SAME node");
    expect(sys).toContain("Never invent a \"nodeId\"");
    expect(sys).toContain("IDENTICAL \"newNode\" object");
  });

  test("system prompt requires resolving relative time references to absolute dates", () => {
    const sys = EXTRACTION_SYSTEM_PROMPT.toLowerCase();
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
    expect(result.facts).toEqual([]);
    expect(result.signals).toEqual([]);
    expect(result.promptIdeas).toEqual([]);
    expect(calls.length).toBe(0);
  });

  test("parses a fact that cites an existing node id", async () => {
    const { client } = fakeLlm(
      JSON.stringify({
        observations: [
          { type: "fact", text: "Enjoys birthday dinners at a favorite restaurant with family.", nodeId: 14 },
        ],
      }),
    );
    const result = await extractObservations({ ...baseInput, existingNodes: [gymNode] }, client);
    expect(result.facts.length).toBe(1);
    expect(result.facts[0]).toEqual({
      kind: "fact",
      text: "Enjoys birthday dinners at a favorite restaurant with family.",
      target: { nodeId: 14 },
    });
  });

  test("parses a fact that creates a new node", async () => {
    const { client } = fakeLlm(
      JSON.stringify({
        observations: [
          {
            type: "thread",
            text: "Has back pain from bench pressing.",
            newNode: { domain: "health-body", subdomain: "back-pain", summary: "Has occasional lower back pain." },
          },
        ],
      }),
    );
    const result = await extractObservations(baseInput, client);
    expect(result.facts.length).toBe(1);
    expect(result.facts[0]!.target).toEqual({
      newNode: { domain: "health-body", subdomain: "back-pain", summary: "Has occasional lower back pain." },
    });
  });

  test("drops individually malformed observations but keeps valid ones", async () => {
    const { client } = fakeLlm(
      JSON.stringify({
        observations: [
          { type: "not-a-real-type", text: "bogus", nodeId: 14 },
          { type: "interest", text: "Likes Indian food traditions.", nodeId: 14 },
        ],
      }),
    );
    const result = await extractObservations({ ...baseInput, existingNodes: [gymNode] }, client);
    expect(result.facts.length).toBe(1);
    expect(result.facts[0]!.kind).toBe("interest");
  });

  test("ignores an extra legacy topic key rather than failing the item", async () => {
    const { client } = fakeLlm(
      JSON.stringify({ observations: [{ type: "fact", text: "x", nodeId: 14, topic: "leftover" }] }),
    );
    const result = await extractObservations({ ...baseInput, existingNodes: [gymNode] }, client);
    expect(result.facts.length).toBe(1);
  });

  test("retries in-process on transient malformed output, then succeeds", async () => {
    let calls = 0;
    const client: LlmClient = {
      async complete() {
        calls++;
        if (calls < 3) return "not json at all"; // simulate intermittent truncation
        return '{"observations":[{"type":"fact","text":"ok","nodeId":14}]}';
      },
    };
    const result = await extractObservations({ ...baseInput, existingNodes: [gymNode] }, client);
    expect(calls).toBe(3);
    expect(result.facts.length).toBe(1);
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

  describe("closed vocabulary in the user prompt", () => {
    test("renders existing nodes with their ids", async () => {
      const { client, calls } = fakeLlm('{"observations":[]}');
      await extractObservations({ ...baseInput, existingNodes: [gymNode] }, client);
      expect(calls[0]!.user).toContain("[node 14]");
      expect(calls[0]!.user).toContain("hobbies-interests/gym");
    });

    test("says explicitly when there are no existing nodes", async () => {
      const { client, calls } = fakeLlm('{"observations":[]}');
      await extractObservations(baseInput, client);
      expect(calls[0]!.user.toLowerCase()).toContain("no subjects on record yet");
    });
  });

  describe("nodeId guards", () => {
    test("drops an item citing an unknown nodeId, logging loudly with id, person and date", async () => {
      const { client } = fakeLlm(JSON.stringify({ observations: [{ type: "fact", text: "x", nodeId: 999 }] }));
      const logs: string[] = [];
      const result = await extractObservations(baseInput, client, (m) => logs.push(m));
      expect(result.facts).toEqual([]);
      const line = logs.find((l) => l.includes("999"));
      expect(line).toBeDefined();
      expect(line).toContain("a");
      expect(line).toContain("2026-07-19");
    });

    test("never coerces an unknown nodeId into a newNode creation", async () => {
      const { client } = fakeLlm(JSON.stringify({ observations: [{ type: "fact", text: "x", nodeId: 999 }] }));
      const result = await extractObservations(baseInput, client);
      expect(result.facts).toEqual([]);
    });

    test("both nodeId and newNode present keeps nodeId and ignores newNode", async () => {
      const { client } = fakeLlm(
        JSON.stringify({
          observations: [
            {
              type: "fact",
              text: "x",
              nodeId: 14,
              newNode: { domain: "hobbies-interests", subdomain: "guitar", summary: "Plays guitar." },
            },
          ],
        }),
      );
      const result = await extractObservations({ ...baseInput, existingNodes: [gymNode] }, client);
      expect(result.facts.length).toBe(1);
      expect(result.facts[0]!.target).toEqual({ nodeId: 14 });
    });
  });

  describe("newNode near-duplicate and exact-key resolution", () => {
    test("a near-duplicate newNode attaches to the existing matching node instead of creating", async () => {
      const { client } = fakeLlm(
        JSON.stringify({
          observations: [
            {
              type: "fact",
              text: "Lifts weights three times a week.",
              newNode: { domain: "health-body", subdomain: "Fitness", summary: "Goes to the gym regularly and lifts weights." },
            },
          ],
        }),
      );
      const result = await extractObservations({ ...baseInput, existingNodes: [gymNode] }, client);
      expect(result.facts.length).toBe(1);
      expect(result.facts[0]!.target).toEqual({ nodeId: 14 });
    });

    test("a genuinely different newNode creates rather than attaching", async () => {
      const { client } = fakeLlm(
        JSON.stringify({
          observations: [
            {
              type: "interest",
              text: "Practices guitar toward playing and singing at will.",
              newNode: { domain: "hobbies-interests", subdomain: "guitar", summary: "Practices guitar toward playing and singing at will." },
            },
          ],
        }),
      );
      const result = await extractObservations({ ...baseInput, existingNodes: [gymNode] }, client);
      expect(result.facts.length).toBe(1);
      expect(result.facts[0]!.target).toEqual({
        newNode: { domain: "hobbies-interests", subdomain: "guitar", summary: "Practices guitar toward playing and singing at will." },
      });
    });

    test("an exact normalized-subdomain collision with an existing node attaches immediately, bypassing similarity", async () => {
      const { client } = fakeLlm(
        JSON.stringify({
          observations: [
            {
              type: "fact",
              text: "totally unrelated wording",
              newNode: { domain: "health-body", subdomain: "Gym", summary: "Completely different summary text here." },
            },
          ],
        }),
      );
      const result = await extractObservations({ ...baseInput, existingNodes: [gymNode] }, client);
      expect(result.facts[0]!.target).toEqual({ nodeId: 14 });
    });

    test("two near-identical newNode proposals in the same response collapse onto one virtual node", async () => {
      const { client } = fakeLlm(
        JSON.stringify({
          observations: [
            {
              type: "fact",
              text: "Started dead hangs.",
              newNode: { domain: "health-body", subdomain: "back-pain", summary: "Has back pain from bench pressing." },
            },
            {
              type: "thread",
              text: "Plans to try stretching too.",
              newNode: { domain: "health-body", subdomain: "Back Pain", summary: "Has back pain from bench pressing." },
            },
          ],
        }),
      );
      const result = await extractObservations(baseInput, client);
      expect(result.facts.length).toBe(2);
      expect(result.facts[0]!.target).toEqual(result.facts[1]!.target);
      expect(result.facts[0]!.target).toEqual({
        newNode: { domain: "health-body", subdomain: "back-pain", summary: "Has back pain from bench pressing." },
      });
    });

    test("an overlong newNode summary is clamped to 140 chars at a word boundary, not dropped", async () => {
      // sqlite has no CHECK on nodes.summary's length, so the "one sentence,
      // <= 140 chars" invariant only holds if the extractor enforces it.
      const longSummary = `Practices guitar ${"very ".repeat(40)}seriously.`;
      const { client } = fakeLlm(
        JSON.stringify({
          observations: [
            {
              type: "interest",
              text: "Practices guitar.",
              newNode: { domain: "hobbies-interests", subdomain: "guitar", summary: longSummary },
            },
          ],
        }),
      );
      const logs: string[] = [];
      const result = await extractObservations(baseInput, client, (m) => logs.push(m));
      expect(result.facts.length).toBe(1);
      const target = result.facts[0]!.target as { newNode: { summary: string } };
      expect(target.newNode.summary.length).toBeLessThanOrEqual(140);
      expect(target.newNode.summary.endsWith(" ")).toBe(false);
      expect(logs.some((l) => l.includes("clamped"))).toBe(true);
    });
  });

  describe("newNode domain guard", () => {
    test("an invalid domain triggers one validation retry, and the retry's valid domain is used", async () => {
      let calls = 0;
      const client: LlmClient = {
        async complete() {
          calls++;
          if (calls === 1) {
            return JSON.stringify({
              observations: [{ type: "fact", text: "x", newNode: { domain: "not-a-domain", subdomain: "y", summary: "z" } }],
            });
          }
          return JSON.stringify({
            observations: [{ type: "fact", text: "x", newNode: { domain: "hobbies-interests", subdomain: "y", summary: "z" } }],
          });
        },
      };
      const result = await extractObservations(baseInput, client);
      expect(calls).toBe(2);
      expect(result.facts.length).toBe(1);
      expect(result.facts[0]!.target).toEqual({ newNode: { domain: "hobbies-interests", subdomain: "y", summary: "z" } });
    });

    test("an invalid domain that persists through the retry is dropped with a loud log, other items kept", async () => {
      const client: LlmClient = {
        async complete() {
          return JSON.stringify({
            observations: [
              { type: "fact", text: "bad", newNode: { domain: "not-a-domain", subdomain: "y", summary: "z" } },
              { type: "fact", text: "good", nodeId: 14 },
            ],
          });
        },
      };
      const logs: string[] = [];
      const result = await extractObservations({ ...baseInput, existingNodes: [gymNode] }, client, (m) => logs.push(m));
      expect(result.facts.length).toBe(1);
      expect(result.facts[0]!.text).toBe("good");
      expect(logs.some((l) => l.includes("not-a-domain"))).toBe(true);
    });

    test("does not spend the domain-validation retry when all domains are already valid", async () => {
      let calls = 0;
      const client: LlmClient = {
        async complete() {
          calls++;
          return JSON.stringify({ observations: [{ type: "fact", text: "x", nodeId: 14 }] });
        },
      };
      await extractObservations({ ...baseInput, existingNodes: [gymNode] }, client);
      expect(calls).toBe(1);
    });
  });

  describe("signals (mood_signal, prompt_preference) never carry node targets", () => {
    test("a mood_signal item is filed as a signal even if the model attaches a nodeId", async () => {
      const { client } = fakeLlm(
        JSON.stringify({ observations: [{ type: "mood_signal", text: "Seems tired this week.", nodeId: 14 }] }),
      );
      const result = await extractObservations({ ...baseInput, existingNodes: [gymNode] }, client);
      expect(result.signals).toEqual([{ kind: "mood_signal", text: "Seems tired this week." }]);
      expect(result.facts).toEqual([]);
    });

    test("a prompt_preference item with feedback given is filed as a signal", async () => {
      const { client } = fakeLlm(
        JSON.stringify({ observations: [{ type: "prompt_preference", text: "Enjoyed this style of question." }] }),
      );
      const result = await extractObservations({ ...baseInput, feedback: ["that was fun"] }, client);
      expect(result.signals).toEqual([{ kind: "prompt_preference", text: "Enjoyed this style of question." }]);
    });
  });

  describe("prompt_preference guard", () => {
    test("drops a prompt_preference observation from the model when no feedback was given, even if the model returns one", async () => {
      const { client } = fakeLlm(
        JSON.stringify({
          observations: [{ type: "prompt_preference", text: "They enjoyed the question about family traditions." }],
        }),
      );
      const result = await extractObservations(baseInput, client); // baseInput has feedback: []
      expect(result.signals).toEqual([]);
    });

    test("keeps a prompt_preference observation from the model when feedback was given", async () => {
      const { client } = fakeLlm(
        JSON.stringify({ observations: [{ type: "prompt_preference", text: "Enjoyed this style of question." }] }),
      );
      const result = await extractObservations({ ...baseInput, feedback: ["that was fun"] }, client);
      expect(result.signals.length).toBe(1);
      expect(result.signals[0]!.kind).toBe("prompt_preference");
    });

    test("drops only the prompt_preference item and keeps other valid observations in the same response when there is no feedback", async () => {
      const { client } = fakeLlm(
        JSON.stringify({
          observations: [
            { type: "fact", text: "Enjoys birthday dinners at Tandoori Times.", nodeId: 14 },
            { type: "prompt_preference", text: "Enjoyed this question." },
          ],
        }),
      );
      const result = await extractObservations({ ...baseInput, existingNodes: [gymNode] }, client);
      expect(result.facts.length).toBe(1);
      expect(result.signals).toEqual([]);
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
