import type { GenerationInput } from "../../../src/prompts/generationPrompt";
import type { PersonContext } from "../../../src/memory/types";
import type { PromptHistoryEntry } from "../../../src/prompts/history";

/** Synthetic memory states for evaluating adaptive generation offline.
 * These are DATA, not tests: both unit tests and the eval scripts import
 * them, so nothing here may touch the network, the real ledger, or real
 * personal data. Names and content are invented. */
export interface MemoryStateFixture {
  name: string;
  /** What this state puts the generator under pressure to get right. */
  description: string;
  input: GenerationInput;
}

const NAMES = { a: "Alex", b: "Sam" } as const;

const emptyContext = (): PersonContext => ({
  facts: [],
  threads: [],
  interests: [],
  recentMoods: [],
  promptPreferences: [],
});

/** Context entries carry their provenance date inline, matching what
 * SupermemoryMemory/FakeMemory actually hand the generator. Staleness is
 * only visible to the model through these prefixes. */
const ctx = (partial: Partial<PersonContext>): PersonContext => ({ ...emptyContext(), ...partial });

const answered = (chars: number) => ({ outcome: "answered" as const, responseLength: chars });
const skipped = { outcome: "skipped" as const, responseLength: null };
const noResponse = { outcome: "no_response" as const, responseLength: null };

const base = (over: Partial<GenerationInput>): GenerationInput => ({
  today: "2026-07-20",
  stance: "explore",
  names: { ...NAMES },
  contextA: emptyContext(),
  contextB: emptyContext(),
  coverageA: [],
  coverageB: [],
  history: [],
  feedbackA: [],
  feedbackB: [],
  ideasA: [],
  ideasB: [],
  ...over,
});

const dayOneEmpty: MemoryStateFixture = {
  name: "day-one-empty",
  description:
    "Both contexts empty, no coverage, no history. Broad easy exploration is the correct answer, not an apology for having no data.",
  input: base({}),
};

const oneSided: MemoryStateFixture = {
  name: "one-sided",
  description:
    "Alex has a rich context, Sam has nothing (just joined, never answers). The prompt must stay answerable for someone with zero history.",
  input: base({
    contextA: ctx({
      facts: ["[2026-07-18] Grew up in Portland and still misses the rain."],
      threads: ["[2026-07-19] Deciding whether to adopt a second cat."],
      interests: ["[2026-07-17] Bakes sourdough most weekends.", "[2026-07-19] Plays bass in a cover band."],
      recentMoods: ["[2026-07-19] Upbeat, joking a lot."],
      promptPreferences: ["[2026-07-18] Likes childhood-memory questions."],
    }),
    coverageA: ["childhood", "food", "music", "pets"],
    history: [
      { date: "2026-07-19", text: "What's a smell that instantly takes you back somewhere?", stance: null, a: answered(180), b: noResponse },
      { date: "2026-07-18", text: "What's your ideal breakfast?", stance: null, a: answered(95), b: noResponse },
    ] satisfies PromptHistoryEntry[],
  }),
};

const richBoth: MemoryStateFixture = {
  name: "rich-both",
  description:
    "Both people have many facts, threads and interests, long coverage and a long history. Repetition is the main risk here.",
  input: base({
    contextA: ctx({
      facts: [
        "[2026-07-18] Works as a pediatric nurse on night shifts.",
        "[2026-07-15] Has a younger brother she talks to every Sunday.",
        "[2026-07-12] Allergic to shellfish.",
      ],
      threads: [
        "[2026-07-19] Training for a half marathon in October.",
        "[2026-07-17] Trying to finish a quilt started two years ago.",
      ],
      interests: ["[2026-07-16] Loves true-crime podcasts.", "[2026-07-14] Collects vintage postcards."],
      recentMoods: ["[2026-07-19] Tired but cheerful."],
      promptPreferences: ["[2026-07-16] Prefers concrete questions over abstract ones."],
    }),
    contextB: ctx({
      facts: [
        "[2026-07-18] Teaches high school chemistry.",
        "[2026-07-13] Learned to drive at 24, later than everyone he knew.",
      ],
      threads: [
        "[2026-07-19] Planning a road trip along the coast for Labor Day.",
        "[2026-07-16] Rebuilding a bike he found at a garage sale.",
      ],
      interests: ["[2026-07-17] Deep into hot sauce and chili peppers.", "[2026-07-15] Watches a lot of Formula 1."],
      recentMoods: ["[2026-07-18] Restless, itching for a change of scene."],
      promptPreferences: ["[2026-07-17] Enjoyed the 'age 10' style of question."],
    }),
    coverageA: ["work", "family", "food", "fitness", "hobbies", "podcasts", "childhood", "travel"],
    coverageB: ["work", "driving", "travel", "food", "sports", "hobbies", "childhood"],
    history: [
      { date: "2026-07-19", text: "What's the last thing that made you laugh out loud?", stance: null, a: answered(140), b: answered(76) },
      { date: "2026-07-18", text: "What were you obsessed with at age 10?", stance: null, a: answered(220), b: answered(310) },
      { date: "2026-07-17", text: "What's your go-to comfort show?", stance: null, a: answered(60), b: answered(88) },
      { date: "2026-07-16", text: "Best meal you've had this month?", stance: null, a: answered(130), b: skipped },
      { date: "2026-07-15", text: "Which app do you open first in the morning?", stance: null, a: answered(45), b: answered(30) },
    ] satisfies PromptHistoryEntry[],
  }),
};

const heavyThread: MemoryStateFixture = {
  name: "heavy-thread",
  description:
    "Sam has a fresh, heavy open thread (a layoff). The generator must not build the day's prompt around it, and must not force levity onto it either.",
  input: base({
    contextA: ctx({
      facts: ["[2026-07-18] Works from home three days a week."],
      interests: ["[2026-07-17] Into houseplants."],
    }),
    contextB: ctx({
      facts: ["[2026-07-10] Worked at the same company for nine years."],
      threads: [
        "[2026-07-19] Was laid off on Friday and has not told his parents yet.",
        "[2026-07-19] Worried about health insurance running out.",
      ],
      interests: ["[2026-07-14] Plays chess online most evenings."],
      recentMoods: ["[2026-07-19] Flat, short replies, clearly rattled."],
    }),
    coverageA: ["work", "home", "plants"],
    coverageB: ["work", "games", "family"],
    history: [
      { date: "2026-07-19", text: "What's a small thing that went right today?", stance: null, a: answered(110), b: answered(12) },
      { date: "2026-07-18", text: "What's your favorite thing to cook?", stance: null, a: answered(150), b: skipped },
    ] satisfies PromptHistoryEntry[],
  }),
};

const privateAsymmetry: MemoryStateFixture = {
  name: "private-asymmetry",
  description:
    "Alex holds a thread Sam demonstrably does not know about. Since both people receive the identical prompt, referencing it would out Alex.",
  input: base({
    contextA: ctx({
      facts: ["[2026-07-12] Has been at the same agency for four years."],
      threads: [
        "[2026-07-19] Quietly interviewing at another company; has not told Sam yet.",
        "[2026-07-18] Considering therapy but has not mentioned it to anyone.",
      ],
      interests: ["[2026-07-15] Runs early most mornings."],
    }),
    contextB: ctx({
      facts: ["[2026-07-16] Just started a pottery class."],
      threads: ["[2026-07-19] Excited about a friend's wedding next month."],
      interests: ["[2026-07-14] Reads a lot of sci-fi."],
    }),
    coverageA: ["work", "fitness"],
    coverageB: ["hobbies", "friends", "books"],
    history: [
      { date: "2026-07-19", text: "What's a skill you'd download Matrix-style right now if you could?", stance: null, a: answered(70), b: answered(95) },
    ] satisfies PromptHistoryEntry[],
  }),
};

const feedbackConstrained: MemoryStateFixture = {
  name: "feedback-constrained",
  description:
    "Standing 'too long' feedback from both, plus one unconsumed prompt idea. Length is a hard constraint and the idea should be used if it fits.",
  input: base({
    contextA: ctx({
      interests: ["[2026-07-16] Big fan of horror movies."],
      promptPreferences: ["[2026-07-19] Wants shorter questions."],
    }),
    contextB: ctx({
      interests: ["[2026-07-15] Plays pickup basketball on Sundays."],
    }),
    coverageA: ["movies"],
    coverageB: ["sports"],
    feedbackA: ["these are getting too long, keep them short"],
    feedbackB: ["yeah shorter please"],
    ideasA: [{ id: 41, text: "ask us about the worst haircut we ever had" }],
    history: [
      {
        date: "2026-07-19",
        text: "If you had to describe your ideal Sunday from the moment you wake up to the moment you fall asleep, what would every part of it look like?",
        stance: null,
        a: answered(20),
        b: skipped,
      },
    ] satisfies PromptHistoryEntry[],
  }),
};

const staleThreads: MemoryStateFixture = {
  name: "stale-threads",
  description:
    "Every thread's provenance is weeks old against a mid-August generation date. Treating a stale thread as still-live is the failure mode.",
  input: base({
    today: "2026-08-14",
    contextA: ctx({
      facts: ["[2026-06-02] Lives two blocks from a farmers market."],
      threads: ["[2026-06-14] Waiting to hear back about a conference talk submission."],
      interests: ["[2026-06-10] Learning to play the ukulele."],
    }),
    contextB: ctx({
      facts: ["[2026-06-05] Commutes 45 minutes each way."],
      threads: ["[2026-06-12] Deciding whether to run a 10K at the end of the month."],
      interests: ["[2026-06-08] Getting into birdwatching."],
    }),
    coverageA: ["food", "music", "work"],
    coverageB: ["commute", "fitness", "nature"],
    history: [
      { date: "2026-06-20", text: "What's a tiny thing that always makes your day a little better?", stance: null, a: answered(85), b: answered(64) },
    ] satisfies PromptHistoryEntry[],
  }),
};

const lowEnergyHistory: MemoryStateFixture = {
  name: "low-energy-history",
  description:
    "Rich context but the last week of prompts landed badly (skips and one-word answers). The energy signal, not the context, is what should change the prompt.",
  input: base({
    contextA: ctx({
      facts: ["[2026-07-18] Studying for the bar exam."],
      threads: ["[2026-07-18] Two weeks out from the exam and barely sleeping."],
      interests: ["[2026-07-12] Likes long walks with podcasts."],
      recentMoods: ["[2026-07-19] Stretched thin."],
    }),
    contextB: ctx({
      facts: ["[2026-07-17] Picking up extra shifts at the restaurant."],
      interests: ["[2026-07-13] Into cold brew and coffee gear."],
      recentMoods: ["[2026-07-19] Exhausted."],
    }),
    coverageA: ["school", "wellbeing", "hobbies"],
    coverageB: ["work", "food"],
    history: [
      { date: "2026-07-19", text: "What's the best thing you ate this week?", stance: null, a: skipped, b: answered(4) },
      { date: "2026-07-18", text: "What's your go-to comfort show?", stance: null, a: answered(6), b: skipped },
      { date: "2026-07-17", text: "What's a small purchase that genuinely improved your life?", stance: null, a: noResponse, b: skipped },
    ] satisfies PromptHistoryEntry[],
  }),
};

const conflictingPreferences: MemoryStateFixture = {
  name: "conflicting-preferences",
  description:
    "Alex asks for deeper questions while Sam asks for lighter ones. One identical prompt has to satisfy both, so neither preference can be followed absolutely.",
  input: base({
    contextA: ctx({
      interests: ["[2026-07-16] Reads philosophy for fun."],
      promptPreferences: ["[2026-07-19] Wants questions with more depth."],
    }),
    contextB: ctx({
      interests: ["[2026-07-15] Watches a lot of reality TV."],
      promptPreferences: ["[2026-07-19] Wants questions that stay light and silly."],
    }),
    coverageA: ["books", "ideas"],
    coverageB: ["tv", "humor"],
    feedbackA: ["can we get something with a bit more substance"],
    feedbackB: ["these are fine but keep them fun, i don't want homework"],
    history: [
      { date: "2026-07-19", text: "Who was your first celebrity crush?", stance: null, a: answered(25), b: answered(210) },
    ] satisfies PromptHistoryEntry[],
  }),
};

export const memoryStates: MemoryStateFixture[] = [
  dayOneEmpty,
  oneSided,
  richBoth,
  heavyThread,
  privateAsymmetry,
  feedbackConstrained,
  staleThreads,
  lowEnergyHistory,
  conflictingPreferences,
];

export function memoryState(name: string): MemoryStateFixture {
  const found = memoryStates.find((s) => s.name === name);
  if (!found) throw new Error(`memoryState: no fixture named "${name}"`);
  return found;
}
