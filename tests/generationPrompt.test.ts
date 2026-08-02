import { describe, expect, test } from "bun:test";
import { ADAPTIVE_SYSTEM_PROMPT, buildGenerationUserPrompt, type GenerationInput, type WriterPersonInput } from "../src/prompts/generationPrompt";

const nodeInput = (over: Partial<WriterPersonInput> = {}): WriterPersonInput => ({
  name: "Alex",
  lane: "exploit",
  target: {
    kind: "node",
    id: 14,
    domain: "hobbies-interests",
    family: "play",
    subdomain: "guitar",
    summary: "Learning guitar, practices most days.",
    facts: [
      { date: "2026-07-18", kind: "fact", text: "Started guitar lessons at Tempe Music." },
      { date: "2026-07-19", kind: "thread", text: "Played 'Wonderwall' cleanly for the first time." },
    ],
  },
  background: [],
  moods: [],
  prefs: [],
  feedback: [],
  ideas: [],
  ...over,
});

const seedInput = (over: Partial<WriterPersonInput> = {}): WriterPersonInput => ({
  name: "Sam",
  lane: "explore",
  target: { kind: "seed", id: 3, domain: "food", family: "food", text: "What's your favorite thing to cook?" },
  background: [],
  moods: [],
  prefs: [],
  feedback: [],
  ideas: [],
  ...over,
});

const baseInput = (over: Partial<GenerationInput> = {}): GenerationInput => ({
  today: "2026-07-20",
  a: nodeInput(),
  b: seedInput(),
  history: [],
  recentThemes: [],
  ...over,
});

describe("ADAPTIVE_SYSTEM_PROMPT", () => {
  test("encodes the 15-30 second answerability bar", () => {
    const sys = ADAPTIVE_SYSTEM_PROMPT.toLowerCase();
    expect(sys).toContain("15");
    expect(sys).toContain("30");
  });

  test("encodes emotional-safety guidance for a couple's daily ritual", () => {
    const sys = ADAPTIVE_SYSTEM_PROMPT.toLowerCase();
    expect(sys).toMatch(/safe|hurtful|sensitiv/);
  });

  test("instructs against repeating or near-duplicating recent prompts", () => {
    const sys = ADAPTIVE_SYSTEM_PROMPT.toLowerCase();
    expect(sys).toMatch(/repeat|duplicat/);
  });

  test("requires strict JSON with prompt, targetNodeId, seedId, rationale, and usedIdeaId fields", () => {
    expect(ADAPTIVE_SYSTEM_PROMPT).toContain('"prompt"');
    expect(ADAPTIVE_SYSTEM_PROMPT).toContain('"targetNodeId"');
    expect(ADAPTIVE_SYSTEM_PROMPT).toContain('"seedId"');
    expect(ADAPTIVE_SYSTEM_PROMPT).toContain('"rationale"');
    expect(ADAPTIVE_SYSTEM_PROMPT).toContain("usedIdeaId");
  });

  test("each person's question is built from their own assigned target, never the other's", () => {
    const sys = ADAPTIVE_SYSTEM_PROMPT.toLowerCase();
    expect(sys).toMatch(/their own assigned target/i);
    expect(sys).toMatch(/never ask one person about something only the other lived through/i);
  });

  test("requires the two questions to share a theme", () => {
    const sys = ADAPTIVE_SYSTEM_PROMPT.toLowerCase();
    expect(sys).toMatch(/theme/i);
    expect(ADAPTIVE_SYSTEM_PROMPT).toContain('"theme"');
  });

  test("forbids leaking one person's private thread into the other's question", () => {
    const sys = ADAPTIVE_SYSTEM_PROMPT.toLowerCase();
    expect(sys).toMatch(/leak|in confidence/i);
  });

  test("states the model does not choose the subject, code already assigned it", () => {
    expect(ADAPTIVE_SYSTEM_PROMPT).toMatch(/YOU DO NOT CHOOSE THE SUBJECT/);
    expect(ADAPTIVE_SYSTEM_PROMPT).toContain("ASSIGNED TARGET");
  });

  test("no stance-assignment or candidate-menu language survives", () => {
    // The old menu-based contract (EXPLOIT/EXPLORE CANDIDATES, OFF LIMITS,
    // a model-declared "stance") is fully replaced by the assigned-target
    // contract; the system prompt must not reference any of it.
    expect(ADAPTIVE_SYSTEM_PROMPT).not.toContain("EXPLOIT CANDIDATES");
    expect(ADAPTIVE_SYSTEM_PROMPT).not.toContain("EXPLORE CANDIDATES");
    expect(ADAPTIVE_SYSTEM_PROMPT).not.toContain("OFF LIMITS");
    expect(ADAPTIVE_SYSTEM_PROMPT).not.toContain('"stance"');
  });

  test("distinguishes a NODE target's dated kind-tagged facts from a SEED target's fixed subject", () => {
    expect(ADAPTIVE_SYSTEM_PROMPT).toMatch(/NODE target/);
    expect(ADAPTIVE_SYSTEM_PROMPT).toMatch(/SEED target/);
    expect(ADAPTIVE_SYSTEM_PROMPT).toMatch(/kind-tagged/);
  });

  test("forbids building a question on anything in a person's BACKGROUND list", () => {
    expect(ADAPTIVE_SYSTEM_PROMPT).toContain("BACKGROUND");
  });
});

describe("template variation", () => {
  test("system prompt forbids reusing a recent sentence frame", () => {
    const sys = ADAPTIVE_SYSTEM_PROMPT.toLowerCase();
    expect(sys).toMatch(/sentence (frame|structure)|template|phrasing|opening/);
  });
});

describe("temporal grounding", () => {
  test("tells the generator today's date so it can age the dated context lines", () => {
    const user = buildGenerationUserPrompt(baseInput({ today: "2026-07-26" }));
    expect(user).toContain("2026-07-26");
  });

  test("system prompt instructs treating old threads and moods as possibly resolved", () => {
    const sys = ADAPTIVE_SYSTEM_PROMPT.toLowerCase();
    expect(sys).toMatch(/stale|old|no longer|already (happened|passed)/);
  });
});

describe("question shape", () => {
  test("requires every question to carry its own subject", () => {
    const sys = ADAPTIVE_SYSTEM_PROMPT.toLowerCase();
    expect(sys).toMatch(/must carry its own subject/);
    expect(sys).toMatch(/nominate a category/);
  });

  test("forbids abstracting upward when a subject is used up", () => {
    const sys = ADAPTIVE_SYSTEM_PROMPT.toLowerCase();
    expect(sys).toMatch(/vaguer category/);
  });
});

describe("buildGenerationUserPrompt", () => {
  test("includes both people's real names", () => {
    const user = buildGenerationUserPrompt(baseInput());
    expect(user).toContain("Alex");
    expect(user).toContain("Sam");
  });

  test("renders exactly one ASSIGNED TARGET block per person, no menus", () => {
    const user = buildGenerationUserPrompt(baseInput());
    expect(user.split("ASSIGNED TARGET").length - 1).toBe(2);
    expect(user).not.toContain("CANDIDATES");
  });

  test("a node target renders id, domain/subdomain, family, summary, and dated kind-tagged facts", () => {
    const user = buildGenerationUserPrompt(baseInput());
    expect(user).toContain("[node 14] hobbies-interests / guitar (family: play): Learning guitar, practices most days.");
    expect(user).toContain("[2026-07-18] (fact) Started guitar lessons at Tempe Music.");
    expect(user).toContain("[2026-07-19] (thread) Played 'Wonderwall' cleanly for the first time.");
  });

  test("a seed target renders its id, domain/family, and full text", () => {
    const user = buildGenerationUserPrompt(baseInput());
    expect(user).toContain('[seed 3] food / food: "What\'s your favorite thing to cook?"');
  });

  test("a node with no family renders 'family: none' rather than a blank", () => {
    const noFamilyTarget = { ...(nodeInput().target as Extract<WriterPersonInput["target"], { kind: "node" }>), family: null };
    const user = buildGenerationUserPrompt(baseInput({ a: nodeInput({ target: noFamilyTarget }) }));
    expect(user).toContain("(family: none)");
  });

  test("background nodes render as not-targetable, distinct from the target", () => {
    const user = buildGenerationUserPrompt(
      baseInput({ a: nodeInput({ background: [{ domain: "childhood", subdomain: "hometown" }] }) }),
    );
    expect(user).toContain("BACKGROUND (do not target):");
    expect(user).toContain("childhood / hometown");
  });

  test("a person with no background renders the none placeholder", () => {
    const user = buildGenerationUserPrompt(baseInput());
    expect(user).toContain("BACKGROUND (do not target): (none)");
  });

  test("includes recent prompt history with per-person outcome and response length, under each person's own section", () => {
    const user = buildGenerationUserPrompt(
      baseInput({
        history: [
          {
            date: "2026-07-19",
            a: { text: "What game could you play forever?", outcome: "answered", responseLength: 120 },
            b: { text: "What show would you rewatch forever?", outcome: "skipped", responseLength: null },
          },
        ],
      }),
    );
    expect(user).toContain("What game could you play forever?");
    expect(user).toContain("What show would you rewatch forever?");
    const alexSection = user.slice(user.indexOf("PERSON A:"), user.indexOf("PERSON B:"));
    expect(alexSection).toContain("What game could you play forever?");
    expect(alexSection).not.toContain("What show would you rewatch forever?");
  });

  test("includes raw recent feedback text per person", () => {
    const user = buildGenerationUserPrompt(
      baseInput({ a: nodeInput({ feedback: ["too long lately"] }), b: seedInput({ feedback: ["loved this one"] }) }),
    );
    expect(user).toContain("too long lately");
    expect(user).toContain("loved this one");
  });

  test("includes unconsumed prompt ideas with their ids, so the model can cite which it used", () => {
    const user = buildGenerationUserPrompt(baseInput({ a: nodeInput({ ideas: [{ id: 7, text: "ask us about our Tokyo trip" }] }) }));
    expect(user).toContain("7");
    expect(user).toContain("Tokyo trip");
  });

  test("day-one case: empty history/moods/prefs/feedback/ideas/background still renders full structure", () => {
    const user = buildGenerationUserPrompt(baseInput());
    expect(user).toContain("this may be day one");
    expect(user).toContain("Recent moods (time-bound, never durable): (none)");
    expect(user).toContain("Prompt preferences (durable, from feedback): (none yet)");
    expect(user.length).toBeGreaterThan(0);
  });
});
