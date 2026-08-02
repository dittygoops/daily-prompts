import type {
  AssignedNodeTarget,
  AssignedSeedTarget,
  GenerationInput,
  TargetFact,
  WriterPersonInput,
} from "../../../src/prompts/generationPrompt";
import type { EnergySignal, PromptHistoryEntry } from "../../../src/prompts/history";

/** Synthetic memory states for evaluating writer generation offline. These
 * are DATA, not tests: both unit tests and the eval scripts import them, so
 * nothing here may touch the network, the real ledger, or real personal
 * data. Names and content are invented.
 *
 * Reshaped for the 2026-08-02 synthesis design: selection (owned elsewhere)
 * already chose each person's ASSIGNED TARGET before the writer is ever
 * called, so a fixture is a WriterStateFixture over GenerationInput, not a
 * candidate menu. The nine scenario names and their original intents
 * survive; only the shape underneath changed. */
export interface WriterStateFixture {
  name: string;
  /** What this state puts the writer under pressure to get right. */
  description: string;
  input: GenerationInput;
}

/** Builds one node target: id, domain/family/subdomain, summary, and dated
 * kind-tagged facts, exactly the shape the writer's contract specifies. */
const nodeTarget = (
  id: number,
  domain: string,
  family: string | null,
  subdomain: string,
  summary: string,
  facts: TargetFact[],
): AssignedNodeTarget => ({ kind: "node", id, domain, family, subdomain, summary, facts });

/** Builds one seed target: a hand-written question whose subject is fixed,
 * phrasing left to the writer. */
const seedTarget = (id: number, domain: string, family: string, text: string): AssignedSeedTarget => ({
  kind: "seed",
  id,
  domain,
  family,
  text,
});

const fact = (date: string, text: string, kind: TargetFact["kind"] = "fact"): TargetFact => ({ date, kind, text });

const person = (
  over: Partial<WriterPersonInput> & Pick<WriterPersonInput, "name" | "lane" | "target">,
): WriterPersonInput => ({
  background: [],
  moods: [],
  prefs: [],
  feedback: [],
  ideas: [],
  ...over,
});

const answered = (chars: number): EnergySignal => ({ outcome: "answered", responseLength: chars });
const skipped: EnergySignal = { outcome: "skipped", responseLength: null };
const noResponse: EnergySignal = { outcome: "no_response", responseLength: null };

/** Historical days predate per-person prompts, so both people's side of a
 * fixture day carries the same question. */
const shared = (date: string, text: string, a: EnergySignal, b: EnergySignal): PromptHistoryEntry => ({
  date,
  a: { ...a, text },
  b: { ...b, text },
});

const defaultSeedA = seedTarget(1, "daily-life", "daily-mechanics", "What's something small that made today good?");
const defaultSeedB = seedTarget(2, "daily-life", "daily-mechanics", "What's something small that made today good?");

const base = (over: Partial<GenerationInput>): GenerationInput => ({
  today: "2026-07-20",
  a: person({ name: "Alex", lane: "explore", target: defaultSeedA }),
  b: person({ name: "Sam", lane: "explore", target: defaultSeedB }),
  history: [],
  recentThemes: [],
  ...over,
});

const dayOneEmpty: WriterStateFixture = {
  name: "day-one-empty",
  description:
    "Both people are assigned a seed target (nothing is known about either yet), no history, no background. Broad easy exploration is the correct answer, not an apology for having no data.",
  // base()'s defaults ARE the day-one state, so there is nothing to override.
  input: base({}),
};

const oneSided: WriterStateFixture = {
  name: "one-sided",
  description:
    "Alex is assigned a rich exploit node target with several dated facts; Sam (just joined, never answers) is assigned a seed. The prompt must stay answerable for someone with zero history.",
  input: base({
    a: person({
      name: "Alex",
      lane: "exploit",
      target: nodeTarget(101, "hobbies-interests", "play", "baking", "Bakes sourdough most weekends", [
        fact("2026-07-17", "Bakes sourdough most weekends."),
        fact("2026-07-19", "Tried a new rye starter and it collapsed.", "thread"),
      ]),
      moods: ["[2026-07-19] Upbeat, joking a lot."],
      prefs: ["Likes childhood-memory questions."],
    }),
    b: person({
      name: "Sam",
      lane: "explore",
      target: seedTarget(3, "daily-life", "daily-mechanics", "What's a small thing you're looking forward to?"),
    }),
    history: [
      shared("2026-07-19", "What's a smell that instantly takes you back somewhere?", answered(180), noResponse),
      shared("2026-07-18", "What's your ideal breakfast?", answered(95), noResponse),
    ],
  }),
};

const richBoth: WriterStateFixture = {
  name: "rich-both",
  description:
    "Both people are assigned an exploit node target and carry a long history. Repetition is the main risk here, not a shortage of material.",
  input: base({
    a: person({
      name: "Alex",
      lane: "exploit",
      target: nodeTarget(201, "career-academics", "work-school", "work", "Works as a pediatric nurse", [
        fact("2026-07-18", "Works as a pediatric nurse on night shifts."),
        fact("2026-07-19", "Picked up an extra shift covering for a coworker.", "thread"),
      ]),
      moods: ["[2026-07-19] Tired but cheerful."],
      prefs: ["Prefers concrete questions over abstract ones."],
    }),
    b: person({
      name: "Sam",
      lane: "exploit",
      target: nodeTarget(208, "plans-future", "plans", "travel", "Planning a road trip along the coast for Labor Day", [
        fact("2026-07-19", "Planning a road trip along the coast for Labor Day."),
        fact("2026-07-13", "Learned to drive at 24, later than everyone he knew."),
      ]),
      moods: ["[2026-07-18] Restless, itching for a change of scene."],
      prefs: ["Enjoyed the 'age 10' style of question."],
    }),
    history: [
      shared("2026-07-19", "What's the last thing that made you laugh out loud?", answered(140), answered(76)),
      shared("2026-07-18", "What were you obsessed with at age 10?", answered(220), answered(310)),
      shared("2026-07-17", "What's your go-to comfort show?", answered(60), answered(88)),
      shared("2026-07-16", "Best meal you've had this month?", answered(130), skipped),
      shared("2026-07-15", "Which app do you open first in the morning?", answered(45), answered(30)),
    ],
  }),
};

const heavyThread: WriterStateFixture = {
  name: "heavy-thread",
  description:
    "Sam's assigned exploit target IS the fresh, heavy node (a layoff, a thread-kind fact). Selection already chose it; the writer must ask about it gently, without forcing levity or avoiding it.",
  input: base({
    a: person({
      name: "Alex",
      lane: "explore",
      target: seedTarget(4, "home", "daily-mechanics", "What's one small thing about your place you love?"),
    }),
    b: person({
      name: "Sam",
      lane: "exploit",
      target: nodeTarget(
        304,
        "career-academics",
        "work-school",
        "job-loss",
        "Was just laid off",
        [
          fact("2026-07-19", "Was laid off on Friday and has not told his parents yet.", "thread"),
          fact("2026-07-19", "Worried about health insurance running out.", "thread"),
        ],
      ),
      moods: ["[2026-07-19] Flat, short replies, clearly rattled."],
    }),
    history: [
      shared("2026-07-19", "What's a small thing that went right today?", answered(110), answered(12)),
      shared("2026-07-18", "What's your favorite thing to cook?", answered(150), skipped),
    ],
  }),
};

const privateAsymmetry: WriterStateFixture = {
  name: "private-asymmetry",
  description:
    "Alex's assigned target is a node Sam demonstrably does not know about. Separate per-person writer inputs must not leak it into Sam's section.",
  input: base({
    a: person({
      name: "Alex",
      lane: "exploit",
      target: nodeTarget(
        402,
        "career-academics",
        "work-school",
        "job-search",
        "Interviewing at another company, in secret",
        [fact("2026-07-19", "Quietly interviewing at another company; has not told Sam yet.", "thread")],
      ),
    }),
    b: person({
      name: "Sam",
      lane: "exploit",
      target: nodeTarget(405, "hobbies-interests", "play", "crafts", "Just started a pottery class", [
        fact("2026-07-16", "Just started a pottery class."),
      ]),
    }),
    history: [
      shared("2026-07-19", "What's a skill you'd download Matrix-style right now if you could?", answered(70), answered(95)),
    ],
  }),
};

const feedbackConstrained: WriterStateFixture = {
  name: "feedback-constrained",
  description:
    "Standing 'too long' feedback from both, plus one unconsumed prompt idea. Length is a hard constraint and the idea should be used if it fits the assigned target.",
  input: base({
    a: person({
      name: "Alex",
      lane: "exploit",
      target: nodeTarget(501, "hobbies-interests", "play", "movies", "Big fan of horror movies", [
        fact("2026-07-16", "Big fan of horror movies."),
      ]),
      prefs: ["Wants shorter questions."],
      feedback: ["these are getting too long, keep them short"],
      ideas: [{ id: 41, text: "ask us about the worst haircut we ever had" }],
    }),
    b: person({
      name: "Sam",
      lane: "exploit",
      target: nodeTarget(502, "hobbies-interests", "play", "sports", "Plays pickup basketball on Sundays", [
        fact("2026-07-15", "Plays pickup basketball on Sundays."),
      ]),
      feedback: ["yeah shorter please"],
    }),
    history: [
      shared(
        "2026-07-19",
        "If you had to describe your ideal Sunday from the moment you wake up to the moment you fall asleep, what would every part of it look like?",
        answered(20),
        skipped,
      ),
    ],
  }),
};

const staleThreads: WriterStateFixture = {
  name: "stale-threads",
  description:
    "Both assigned exploit targets carry only weeks-old facts against a mid-August generation date. Treating a stale target as still-live is the failure mode.",
  input: base({
    today: "2026-08-14",
    a: person({
      name: "Alex",
      lane: "exploit",
      target: nodeTarget(
        602,
        "career-academics",
        "work-school",
        "conference-talk",
        "Waiting to hear back about a conference talk submission",
        [fact("2026-06-14", "Waiting to hear back about a conference talk submission.")],
      ),
      background: [{ domain: "daily-life", subdomain: "small-pleasures" }],
    }),
    b: person({
      name: "Sam",
      lane: "exploit",
      target: nodeTarget(
        605,
        "health-body",
        "body",
        "fitness",
        "Deciding whether to run a 10K at the end of the month",
        [fact("2026-06-12", "Deciding whether to run a 10K at the end of the month.")],
      ),
      background: [{ domain: "daily-life", subdomain: "small-pleasures" }],
    }),
    history: [
      shared("2026-06-20", "What's a tiny thing that always makes your day a little better?", answered(85), answered(64)),
    ],
  }),
};

const lowEnergyHistory: WriterStateFixture = {
  name: "low-energy-history",
  description:
    "Both are assigned rich exploit targets but the last week of prompts landed badly (skips and one-word answers). The energy signal, not the target, is what should change the question's tone.",
  input: base({
    a: person({
      name: "Alex",
      lane: "exploit",
      target: nodeTarget(701, "career-academics", "self-improvement", "exams", "Studying for the bar exam, barely sleeping", [
        fact("2026-07-18", "Studying for the bar exam."),
        fact("2026-07-18", "Two weeks out from the exam and barely sleeping.", "thread"),
      ]),
      moods: ["[2026-07-19] Stretched thin."],
    }),
    b: person({
      name: "Sam",
      lane: "exploit",
      target: nodeTarget(703, "career-academics", "work-school", "work", "Picking up extra shifts at the restaurant", [
        fact("2026-07-17", "Picking up extra shifts at the restaurant."),
      ]),
      moods: ["[2026-07-19] Exhausted."],
    }),
    history: [
      shared("2026-07-19", "What's the best thing you ate this week?", skipped, answered(4)),
      shared("2026-07-18", "What's your go-to comfort show?", answered(6), skipped),
      shared("2026-07-17", "What's a small purchase that genuinely improved your life?", noResponse, skipped),
    ],
  }),
};

const conflictingPreferences: WriterStateFixture = {
  name: "conflicting-preferences",
  description:
    "Alex asks for deeper questions while Sam asks for lighter ones. Each person's own question has to respect their own preference even though both are assigned an exploit target.",
  input: base({
    a: person({
      name: "Alex",
      lane: "exploit",
      target: nodeTarget(801, "beliefs-values", "values-beliefs", "philosophy", "Reads philosophy for fun", [
        fact("2026-07-16", "Reads philosophy for fun."),
      ]),
      prefs: ["Wants questions with more depth."],
      feedback: ["can we get something with a bit more substance"],
    }),
    b: person({
      name: "Sam",
      lane: "exploit",
      target: nodeTarget(802, "hobbies-interests", "media", "tv", "Watches a lot of reality TV", [
        fact("2026-07-15", "Watches a lot of reality TV."),
      ]),
      prefs: ["Wants questions that stay light and silly."],
      feedback: ["these are fine but keep them fun, i don't want homework"],
    }),
    history: [shared("2026-07-19", "Who was your first celebrity crush?", answered(25), answered(210))],
  }),
};

export const memoryStates: WriterStateFixture[] = [
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

export function memoryState(name: string): WriterStateFixture {
  const found = memoryStates.find((s) => s.name === name);
  if (!found) throw new Error(`memoryState: no fixture named "${name}"`);
  return found;
}
