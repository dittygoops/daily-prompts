import { describe, expect, test } from "bun:test";
import { ADAPTIVE_SYSTEM_PROMPT, buildGenerationUserPrompt } from "../src/prompts/generationPrompt";
import { ALL_DOMAINS, type PersonCandidates } from "../src/ontology/types";

// Every domain key is required by PersonCandidates["domainCounts"], and a
// person with no nodes at all still renders a full counts line, so the
// zero-filled record has to cover every entry in ALL_DOMAINS.
const emptyCandidates = (): PersonCandidates => ({
  domainCounts: Object.fromEntries(ALL_DOMAINS.map((d) => [d, 0])) as PersonCandidates["domainCounts"],
  exploit: [],
  explore: ["career-academics", "childhood", "family"],
  offLimits: [],
});

const baseInput = {
  today: "2026-07-20",
  stanceA: "explore" as const,
  stanceB: "explore" as const,
  names: { a: "Alex", b: "Sam" },
  candidatesA: emptyCandidates(),
  candidatesB: emptyCandidates(),
  moodsA: [] as string[],
  moodsB: [] as string[],
  prefsA: [] as string[],
  prefsB: [] as string[],
  history: [] as never[],
  feedbackA: [] as string[],
  feedbackB: [] as string[],
  ideasA: [] as { id: number; text: string }[],
  ideasB: [] as { id: number; text: string }[],
  recentTopicsA: [] as string[],
  recentTopicsB: [] as string[],
  recentThemes: [] as string[],
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

  test("each person's question is built from their own memory, never the other's", () => {
    const sys = ADAPTIVE_SYSTEM_PROMPT.toLowerCase();
    expect(sys).toMatch(/their own memory/i);
    // "own threads" described the old facts/threads/interests buckets, which
    // are gone now that a person's memory is candidate nodes; the surviving
    // rule is the never-ask-about-the-other's-lived-experience one.
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

  test("the JSON shape carries a prompt and stance per person", () => {
    expect(ADAPTIVE_SYSTEM_PROMPT).toContain('"a":{"prompt"');
    expect(ADAPTIVE_SYSTEM_PROMPT).toContain('"b":{"prompt"');
  });

  test("exploit stance requires citing a targetNodeId from the EXPLOIT CANDIDATES list", () => {
    expect(ADAPTIVE_SYSTEM_PROMPT).toContain("EXPLOIT CANDIDATES");
    expect(ADAPTIVE_SYSTEM_PROMPT).toContain('"targetNodeId"');
  });

  test("explore stance requires citing a targetExplore from the EXPLORE CANDIDATES list", () => {
    expect(ADAPTIVE_SYSTEM_PROMPT).toContain("EXPLORE CANDIDATES");
    expect(ADAPTIVE_SYSTEM_PROMPT).toContain('"targetExplore"');
  });

  test("forbids building a question on anything in a person's OFF LIMITS list", () => {
    expect(ADAPTIVE_SYSTEM_PROMPT).toContain("OFF LIMITS");
  });
});

describe("explore/exploit stance", () => {
  test("requires the generator to declare a stance in its JSON output", () => {
    expect(ADAPTIVE_SYSTEM_PROMPT).toContain('"stance"');
    expect(ADAPTIVE_SYSTEM_PROMPT).toContain("exploit");
    expect(ADAPTIVE_SYSTEM_PROMPT).toContain("explore");
  });

  test("states the stance is assigned rather than the model's to choose", () => {
    // Live behaviour was 0/6 exploit while the model picked for itself, and
    // still 0/3 after being given an explicit ratio target, so the choice
    // moved into decideStance and arrives here as an instruction.
    expect(ADAPTIVE_SYSTEM_PROMPT).toMatch(/assigned to you|not yours to choose/i);
  });

  test("renders the assigned stance prominently in the user prompt", () => {
    // Asserting on the named per-person line, not the bare word: "EXPLOIT"
    // now also appears in every prompt as the EXPLOIT CANDIDATES heading, so
    // a looser check would pass even for an explore assignment.
    const user = buildGenerationUserPrompt({ ...baseInput, stanceA: "exploit" });
    expect(user).toContain("ASSIGNED STANCE FOR ALEX: EXPLOIT");
    expect(user).toContain("ASSIGNED STANCE FOR SAM: EXPLORE");
  });

  test("spells out that a broadly-answerable question does not count as an exploit", () => {
    // The exact failure seen live: it read the threads, then asked
    // "what are you looking forward to this week?" and called it exploit.
    expect(ADAPTIVE_SYSTEM_PROMPT).toMatch(/would make no sense asked of anybody else|by name/i);
  });

  test("shows the recent stance history so the generator can see its own drift", () => {
    const user = buildGenerationUserPrompt({
      ...baseInput,
      history: [
        {
          date: "2026-07-25",
          stance: "explore",
          a: { text: "What's one thing you're improving?", outcome: "answered", stance: null, responseLength: 40 },
          b: { text: "What's one thing you're improving?", outcome: "answered", stance: null, responseLength: 30 },
        },
        {
          date: "2026-07-24",
          stance: "explore",
          a: { text: "What's one thing you're learning?", outcome: "answered", stance: null, responseLength: 20 },
          b: { text: "What's one thing you're learning?", outcome: "skipped", stance: null, responseLength: null },
        },
      ],
    });
    expect(user).toMatch(/explore/i);
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
    const user = buildGenerationUserPrompt({ ...baseInput, today: "2026-07-26" });
    expect(user).toContain("2026-07-26");
  });

  test("system prompt instructs treating old threads and moods as possibly resolved", () => {
    const sys = ADAPTIVE_SYSTEM_PROMPT.toLowerCase();
    expect(sys).toMatch(/stale|old|no longer|already (happened|passed)/);
  });
});

describe("buildGenerationUserPrompt", () => {
  test("includes both people's real names", () => {
    const user = buildGenerationUserPrompt(baseInput);
    expect(user).toContain("Alex");
    expect(user).toContain("Sam");
  });

  test("renders an exploit candidate node's id, domain, subdomain, flags, summary, dated facts, and prompt preferences", () => {
    const candidatesA: PersonCandidates = {
      ...emptyCandidates(),
      exploit: [
        {
          id: 14,
          domain: "hobbies-interests",
          subdomain: "guitar",
          summary: "Learning guitar, practices most days.",
          rich: true,
          live: true,
          lastAsked: null,
          timesAsked: 0,
          facts: [
            { date: "2026-07-18", text: "Started guitar lessons at Tempe Music." },
            // Kept before baseInput's today: a fact dated in the prompt's own
            // future would be nonsense for the model to age against.
            { date: "2026-07-19", text: "Played 'Wonderwall' cleanly for the first time." },
          ],
        },
      ],
    };
    const user = buildGenerationUserPrompt({
      ...baseInput,
      candidatesA,
      prefsA: ["Enjoyed the family-traditions style of question."],
    });
    // Flag order is [rich/thin, asked/never asked, LIVE], read straight off
    // candidateLines rather than guessed.
    expect(user).toContain("[node 14] hobbies-interests / guitar (rich, never asked, LIVE): Learning guitar, practices most days.");
    expect(user).toContain("      - [2026-07-18] Started guitar lessons at Tempe Music.");
    expect(user).toContain("      - [2026-07-19] Played 'Wonderwall' cleanly for the first time.");
    expect(user).toContain("Enjoyed the family-traditions style of question.");
    expect(user).toContain('EXPLOIT CANDIDATES for Alex (exploit stance must cite one of these ids in "targetNodeId")');
  });

  test("renders each domain's open-node count on the domain-counts line", () => {
    const candidatesA: PersonCandidates = {
      ...emptyCandidates(),
      domainCounts: { ...emptyCandidates().domainCounts, childhood: 2, family: 1 },
    };
    const user = buildGenerationUserPrompt({ ...baseInput, candidatesA });
    expect(user).toContain("childhood: 2");
    expect(user).toContain("family: 1");
  });

  test("lists the offered explore domains and names the targetExplore field they get cited in", () => {
    const user = buildGenerationUserPrompt(baseInput);
    expect(user).toContain("career-academics | childhood | family");
    expect(user).toContain('EXPLORE CANDIDATES for Alex (explore stance must cite one of these domains in "targetExplore")');
  });

  test("renders off-limits entries with domain, subdomain, and reason", () => {
    const candidatesA: PersonCandidates = {
      ...emptyCandidates(),
      offLimits: [{ domain: "health-body", subdomain: "sleep", reason: "asked yesterday" }],
    };
    const user = buildGenerationUserPrompt({ ...baseInput, candidatesA });
    expect(user).toContain("OFF LIMITS today (do not build a question on any of these):");
    expect(user).toContain("health-body / sleep (asked yesterday)");
  });

  test("omits the OFF LIMITS heading when a person has no off-limits topics", () => {
    const user = buildGenerationUserPrompt(baseInput);
    expect(user).not.toContain("OFF LIMITS today");
  });

  test("includes recent prompt history with per-person outcome and response length, under each person's own section", () => {
    const user = buildGenerationUserPrompt({
      ...baseInput,
      history: [
        {
          date: "2026-07-19",
          stance: null,
          a: { text: "What game could you play forever?", outcome: "answered", stance: null, responseLength: 120 },
          b: { text: "What show would you rewatch forever?", outcome: "skipped", stance: null, responseLength: null },
        },
      ],
    });
    expect(user).toContain("What game could you play forever?");
    expect(user).toContain("What show would you rewatch forever?");
    expect(user).toContain("answered");
    expect(user).toContain("skipped");
    const alexSection = user.slice(user.indexOf("PERSON A:"), user.indexOf("PERSON B:"));
    expect(alexSection).toContain("What game could you play forever?");
    expect(alexSection).not.toContain("What show would you rewatch forever?");
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

  test("handles fully empty candidates/moods/prefs/history/feedback/ideas for both people without omitting structure (day-1 case)", () => {
    const user = buildGenerationUserPrompt(baseInput);
    expect(user).toContain("Alex");
    expect(user).toContain("Sam");
    expect(user.length).toBeGreaterThan(0);
  });
});

describe("question shape", () => {
  test("requires every question to carry its own subject", () => {
    // Live pair, same theme, same day: one person was asked "what's an area
    // of growth you're interested in" (he supplies the subject) while the
    // other got "how is your reading going" (subject named, she reports).
    const sys = ADAPTIVE_SYSTEM_PROMPT.toLowerCase();
    expect(sys).toMatch(/must carry its own subject/);
    expect(sys).toMatch(/nominate a category/);
  });

  test("forbids abstracting upward when a subject is used up", () => {
    const sys = ADAPTIVE_SYSTEM_PROMPT.toLowerCase();
    expect(sys).toMatch(/change subject/);
    expect(sys).toMatch(/vaguer version/);
  });
});
