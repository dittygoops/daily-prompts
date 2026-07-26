import { describe, expect, test } from "bun:test";
import { ADAPTIVE_SYSTEM_PROMPT, buildGenerationUserPrompt } from "../src/prompts/generationPrompt";
import type { PersonContext } from "../src/memory/types";

const emptyContext: PersonContext = { facts: [], threads: [], interests: [], recentMoods: [], promptPreferences: [] };

const richContext: PersonContext = {
  facts: ["[2026-07-18] Enjoys birthday dinners at Tandoori Times."],
  threads: ["[2026-07-19] Nervous about their thesis defense in August."],
  interests: ["[2026-07-19] Enjoys League of Legends."],
  recentMoods: [],
  promptPreferences: ["[2026-07-18] Enjoyed the family-traditions style of question."],
};

const baseInput = {
  names: { a: "Alex", b: "Sam" } as const,
  contextA: emptyContext,
  contextB: emptyContext,
  coverageA: [] as string[],
  coverageB: [] as string[],
  history: [] as never[],
  feedbackA: [] as string[],
  feedbackB: [] as string[],
  ideasA: [] as { id: number; text: string }[],
  ideasB: [] as { id: number; text: string }[],
};

describe("ADAPTIVE_SYSTEM_PROMPT", () => {
  test("encodes the 15-30 second answerability bar", () => {
    const sys = ADAPTIVE_SYSTEM_PROMPT.toLowerCase();
    expect(sys).toContain("15");
    expect(sys).toContain("30");
  });

  test("encodes the explore-vs-exploit balancing instruction", () => {
    const sys = ADAPTIVE_SYSTEM_PROMPT.toLowerCase();
    expect(sys).toContain("explor");
    expect(sys).toContain("exploit");
  });

  test("encodes emotional-safety guidance for a couple's daily ritual", () => {
    const sys = ADAPTIVE_SYSTEM_PROMPT.toLowerCase();
    expect(sys).toMatch(/safe|hurtful|sensitiv/);
  });

  test("instructs against repeating or near-duplicating recent prompts", () => {
    const sys = ADAPTIVE_SYSTEM_PROMPT.toLowerCase();
    expect(sys).toMatch(/repeat|duplicat/);
  });

  test("requires strict JSON with prompt, rationale, and usedIdeaId fields", () => {
    expect(ADAPTIVE_SYSTEM_PROMPT).toContain('"prompt"');
    expect(ADAPTIVE_SYSTEM_PROMPT).toContain('"rationale"');
    expect(ADAPTIVE_SYSTEM_PROMPT).toContain("usedIdeaId");
  });

  test("instructs that both people always get the identical prompt", () => {
    const sys = ADAPTIVE_SYSTEM_PROMPT.toLowerCase();
    expect(sys).toMatch(/identical|same prompt|both/);
  });
});

describe("buildGenerationUserPrompt", () => {
  test("includes both people's real names", () => {
    const user = buildGenerationUserPrompt(baseInput);
    expect(user).toContain("Alex");
    expect(user).toContain("Sam");
  });

  test("includes facts, threads, interests, and prompt preferences for a person with rich context", () => {
    const user = buildGenerationUserPrompt({ ...baseInput, contextA: richContext });
    expect(user).toContain("Tandoori Times");
    expect(user).toContain("thesis defense");
    expect(user).toContain("League of Legends");
    expect(user).toContain("family-traditions style of question");
  });

  test("includes coverage-gap topics for both people", () => {
    const user = buildGenerationUserPrompt({ ...baseInput, coverageA: ["food", "gaming"], coverageB: ["sports"] });
    expect(user).toContain("food");
    expect(user).toContain("gaming");
    expect(user).toContain("sports");
  });

  test("includes recent prompt history with per-person outcome and response length", () => {
    const user = buildGenerationUserPrompt({
      ...baseInput,
      history: [
        {
          date: "2026-07-19",
          text: "What game could you play forever?",
          a: { outcome: "answered", responseLength: 120 },
          b: { outcome: "skipped", responseLength: null },
        },
      ] as never,
    });
    expect(user).toContain("What game could you play forever?");
    expect(user).toContain("answered");
    expect(user).toContain("skipped");
  });

  test("includes raw recent feedback text per person", () => {
    const user = buildGenerationUserPrompt({ ...baseInput, feedbackA: ["too long lately"], feedbackB: ["loved this one"] });
    expect(user).toContain("too long lately");
    expect(user).toContain("loved this one");
  });

  test("includes unconsumed prompt ideas with their ids, so the model can cite which it used", () => {
    const user = buildGenerationUserPrompt({
      ...baseInput,
      ideasA: [{ id: 7, text: "ask us about our Tokyo trip" }],
    });
    expect(user).toContain("7");
    expect(user).toContain("Tokyo trip");
  });

  test("handles fully empty context/coverage/history/feedback/ideas for both people without omitting structure (day-1 case)", () => {
    const user = buildGenerationUserPrompt(baseInput);
    expect(user).toContain("Alex");
    expect(user).toContain("Sam");
    expect(user.length).toBeGreaterThan(0);
  });
});
