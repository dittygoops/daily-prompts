import type { GenerationInput } from "../../../src/prompts/generationPrompt";
import type { NodeCandidate, PersonCandidates } from "../../../src/ontology/types";
import { ALL_DOMAINS } from "../../../src/ontology/types";
import { DEFAULT_ONTOLOGY_OPTIONS } from "../../../src/ontology/ledgerOntology";
import { isRich } from "../../../src/ontology/status";
import type { NodeDomain } from "../../../src/ledger/ledger";
import type { EnergySignal, PromptHistoryEntry } from "../../../src/prompts/history";

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

/** Record<NodeDomain, number> demands every one of the ten keys, and a
 * literal zero is meaningful here: it is exactly what makes a domain an
 * explore candidate below. Zero-fill first, then let the fixture override
 * only the domains it actually populates. */
const zeroDomainCounts = (over: Partial<Record<NodeDomain, number>> = {}): Record<NodeDomain, number> => {
  const zeroed = Object.fromEntries(ALL_DOMAINS.map((d) => [d, 0])) as Record<NodeDomain, number>;
  return { ...zeroed, ...over };
};

/** Builds one exploit-candidate node. `rich` and `timesAsked` are derived so
 * a fixture cannot drift them out of sync with the facts and lastAsked it
 * actually carries, and richness runs through the real isRich rule so no
 * fixture can present a state LedgerOntology would never produce (two facts
 * recorded on one day is thin, not rich). */
const node = (
  id: number,
  domain: NodeDomain,
  subdomain: string,
  summary: string,
  facts: { date: string; text: string }[],
  opts: { live?: boolean; lastAsked?: string | null; timesAsked?: number } = {},
): NodeCandidate => {
  const lastAsked = opts.lastAsked ?? null;
  return {
    id,
    domain,
    subdomain,
    summary,
    rich: isRich({ factCount: facts.length, distinctDays: new Set(facts.map((f) => f.date)).size }),
    live: opts.live ?? false,
    lastAsked,
    timesAsked: opts.timesAsked ?? (lastAsked === null ? 0 : 1),
    facts,
  };
};

/** The explore list the real ontology would offer for these counts: the
 * thinnest domains, ties broken by ALL_DOMAINS order, capped at the same
 * limit LedgerOntology uses. Derived rather than hand-written so no fixture
 * can offer a domain production would have withheld, which would make the
 * eval reward behaviour the live system never gets the chance to show. */
const thinnestDomains = (counts: Record<NodeDomain, number>): NodeDomain[] =>
  [...ALL_DOMAINS]
    .sort((x, y) => counts[x] - counts[y] || ALL_DOMAINS.indexOf(x) - ALL_DOMAINS.indexOf(y))
    .slice(0, DEFAULT_ONTOLOGY_OPTIONS.exploreCandidateLimit);

const candidates = (partial: Partial<PersonCandidates>): PersonCandidates => {
  const domainCounts = partial.domainCounts ?? zeroDomainCounts();
  return {
    domainCounts,
    exploit: partial.exploit ?? [],
    explore: partial.explore ?? thinnestDomains(domainCounts),
    offLimits: partial.offLimits ?? [],
  };
};

const answered = (chars: number) => ({ outcome: "answered" as const, responseLength: chars });
const skipped = { outcome: "skipped" as const, responseLength: null };
const noResponse = { outcome: "no_response" as const, responseLength: null };

/** Historical days predate per-person prompts, so both people's side of a
 * fixture day carries the same question. */
const shared = (date: string, text: string, a: EnergySignal, b: EnergySignal, stance: string | null = null): PromptHistoryEntry =>
  ({ date, stance, a: { ...a, text, stance }, b: { ...b, text, stance } });

const base = (over: Partial<GenerationInput>): GenerationInput => ({
  today: "2026-07-20",
  stanceA: "explore",
  stanceB: "explore",
  names: { ...NAMES },
  candidatesA: candidates({}),
  candidatesB: candidates({}),
  moodsA: [],
  moodsB: [],
  prefsA: [],
  prefsB: [],
  history: [],
  feedbackA: [],
  feedbackB: [],
  ideasA: [],
  ideasB: [],
  recentTopicsA: [],
  recentTopicsB: [],
  recentThemes: [],
  ...over,
});

const dayOneEmpty: MemoryStateFixture = {
  name: "day-one-empty",
  description:
    "Both people's candidates are empty, every domain count is zero, no history. Broad easy exploration is the correct answer, not an apology for having no data.",
  // base()'s defaults ARE the day-one state, so there is nothing to override.
  input: base({}),
};

const oneSided: MemoryStateFixture = {
  name: "one-sided",
  description:
    "Alex has rich exploit candidates, Sam has nothing (just joined, never answers). The prompt must stay answerable for someone with zero history.",
  input: base({
    candidatesA: candidates({
      domainCounts: zeroDomainCounts({ childhood: 1, "daily-life": 1, "hobbies-interests": 2 }),
      exploit: [
        node(101, "childhood", "hometown", "Grew up in Portland", [
          { date: "2026-07-18", text: "Grew up in Portland and still misses the rain." },
        ]),
        node(102, "daily-life", "pets", "Deciding whether to adopt a second cat", [
          { date: "2026-07-19", text: "Deciding whether to adopt a second cat." },
        ]),
        node(103, "hobbies-interests", "baking", "Bakes sourdough most weekends", [
          { date: "2026-07-17", text: "Bakes sourdough most weekends." },
        ]),
        node(104, "hobbies-interests", "music", "Plays bass in a cover band", [
          { date: "2026-07-19", text: "Plays bass in a cover band." },
        ]),
      ],
    }),
    candidatesB: candidates({}),
    moodsA: ["[2026-07-19] Upbeat, joking a lot."],
    prefsA: ["Likes childhood-memory questions."],
    history: [
      shared("2026-07-19", "What's a smell that instantly takes you back somewhere?", answered(180), noResponse),
      shared("2026-07-18", "What's your ideal breakfast?", answered(95), noResponse),
    ],
  }),
};

const richBoth: MemoryStateFixture = {
  name: "rich-both",
  description:
    "Both people have many exploit candidates across several domains and a long history. Repetition is the main risk here.",
  input: base({
    candidatesA: candidates({
      domainCounts: zeroDomainCounts({ "career-academics": 1, family: 1, "health-body": 2, "hobbies-interests": 3 }),
      exploit: [
        node(201, "career-academics", "work", "Works as a pediatric nurse", [
          { date: "2026-07-18", text: "Works as a pediatric nurse on night shifts." },
        ]),
        node(202, "family", "siblings", "Talks to her younger brother every Sunday", [
          { date: "2026-07-15", text: "Has a younger brother she talks to every Sunday." },
        ]),
        node(203, "health-body", "allergies", "Allergic to shellfish", [
          { date: "2026-07-12", text: "Allergic to shellfish." },
        ]),
        node(204, "health-body", "fitness", "Training for a half marathon in October", [
          { date: "2026-07-19", text: "Training for a half marathon in October." },
        ]),
        node(205, "hobbies-interests", "crafts", "Trying to finish a two-year quilt project", [
          { date: "2026-07-17", text: "Trying to finish a quilt started two years ago." },
        ]),
        node(206, "hobbies-interests", "podcasts", "Loves true-crime podcasts", [
          { date: "2026-07-16", text: "Loves true-crime podcasts." },
        ]),
        node(207, "hobbies-interests", "collecting", "Collects vintage postcards", [
          { date: "2026-07-14", text: "Collects vintage postcards." },
        ]),
      ],
    }),
    candidatesB: candidates({
      domainCounts: zeroDomainCounts({ "career-academics": 1, "daily-life": 1, "plans-future": 1, "hobbies-interests": 3 }),
      exploit: [
        node(208, "career-academics", "work", "Teaches high school chemistry", [
          { date: "2026-07-18", text: "Teaches high school chemistry." },
        ]),
        node(209, "daily-life", "driving", "Learned to drive at 24, later than everyone he knew", [
          { date: "2026-07-13", text: "Learned to drive at 24, later than everyone he knew." },
        ]),
        node(210, "plans-future", "travel", "Planning a road trip along the coast for Labor Day", [
          { date: "2026-07-19", text: "Planning a road trip along the coast for Labor Day." },
        ]),
        node(211, "hobbies-interests", "bikes", "Rebuilding a bike he found at a garage sale", [
          { date: "2026-07-16", text: "Rebuilding a bike he found at a garage sale." },
        ]),
        node(212, "hobbies-interests", "food", "Deep into hot sauce and chili peppers", [
          { date: "2026-07-17", text: "Deep into hot sauce and chili peppers." },
        ]),
        node(213, "hobbies-interests", "motorsports", "Watches a lot of Formula 1", [
          { date: "2026-07-15", text: "Watches a lot of Formula 1." },
        ]),
      ],
    }),
    moodsA: ["[2026-07-19] Tired but cheerful."],
    prefsA: ["Prefers concrete questions over abstract ones."],
    moodsB: ["[2026-07-18] Restless, itching for a change of scene."],
    prefsB: ["Enjoyed the 'age 10' style of question."],
    history: [
      shared("2026-07-19", "What's the last thing that made you laugh out loud?", answered(140), answered(76)),
      shared("2026-07-18", "What were you obsessed with at age 10?", answered(220), answered(310)),
      shared("2026-07-17", "What's your go-to comfort show?", answered(60), answered(88)),
      shared("2026-07-16", "Best meal you've had this month?", answered(130), skipped),
      shared("2026-07-15", "Which app do you open first in the morning?", answered(45), answered(30)),
    ],
  }),
};

const heavyThread: MemoryStateFixture = {
  name: "heavy-thread",
  description:
    "Sam has a fresh, heavy open node (a layoff, flagged live). The generator must not build the day's prompt around it, and must not force levity onto it either.",
  input: base({
    candidatesA: candidates({
      domainCounts: zeroDomainCounts({ "daily-life": 1, "hobbies-interests": 1 }),
      exploit: [
        node(301, "daily-life", "work-from-home", "Works from home three days a week", [
          { date: "2026-07-18", text: "Works from home three days a week." },
        ]),
        node(302, "hobbies-interests", "plants", "Into houseplants", [
          { date: "2026-07-17", text: "Into houseplants." },
        ]),
      ],
    }),
    candidatesB: candidates({
      domainCounts: zeroDomainCounts({ "career-academics": 2, "hobbies-interests": 1 }),
      exploit: [
        node(303, "career-academics", "work-history", "Worked at the same company for nine years", [
          { date: "2026-07-10", text: "Worked at the same company for nine years." },
        ]),
        node(
          304,
          "career-academics",
          "job-loss",
          "Was just laid off",
          [
            { date: "2026-07-19", text: "Was laid off on Friday and has not told his parents yet." },
            { date: "2026-07-19", text: "Worried about health insurance running out." },
          ],
          { live: true },
        ),
        node(305, "hobbies-interests", "games", "Plays chess online most evenings", [
          { date: "2026-07-14", text: "Plays chess online most evenings." },
        ]),
      ],
    }),
    moodsB: ["[2026-07-19] Flat, short replies, clearly rattled."],
    history: [
      shared("2026-07-19", "What's a small thing that went right today?", answered(110), answered(12)),
      shared("2026-07-18", "What's your favorite thing to cook?", answered(150), skipped),
    ],
  }),
};

const privateAsymmetry: MemoryStateFixture = {
  name: "private-asymmetry",
  description:
    "Alex holds a node Sam demonstrably does not know about. Separate per-person candidates must not leak it into Sam's section.",
  input: base({
    candidatesA: candidates({
      domainCounts: zeroDomainCounts({ "career-academics": 2, "health-body": 2 }),
      exploit: [
        node(401, "career-academics", "work-history", "Has been at the same agency for four years", [
          { date: "2026-07-12", text: "Has been at the same agency for four years." },
        ]),
        node(402, "career-academics", "job-search", "Interviewing at another company, in secret", [
          { date: "2026-07-19", text: "Quietly interviewing at another company; has not told Sam yet." },
        ]),
        node(403, "health-body", "mental-health", "Considering therapy, hasn't told anyone", [
          { date: "2026-07-18", text: "Considering therapy but has not mentioned it to anyone." },
        ]),
        node(404, "health-body", "fitness", "Runs early most mornings", [
          { date: "2026-07-15", text: "Runs early most mornings." },
        ]),
      ],
    }),
    candidatesB: candidates({
      domainCounts: zeroDomainCounts({ "hobbies-interests": 2, "relationships-friends": 1 }),
      exploit: [
        node(405, "hobbies-interests", "crafts", "Just started a pottery class", [
          { date: "2026-07-16", text: "Just started a pottery class." },
        ]),
        node(406, "relationships-friends", "friends", "Excited about a friend's wedding next month", [
          { date: "2026-07-19", text: "Excited about a friend's wedding next month." },
        ]),
        node(407, "hobbies-interests", "reading", "Reads a lot of sci-fi", [
          { date: "2026-07-14", text: "Reads a lot of sci-fi." },
        ]),
      ],
    }),
    history: [
      shared("2026-07-19", "What's a skill you'd download Matrix-style right now if you could?", answered(70), answered(95)),
    ],
  }),
};

const feedbackConstrained: MemoryStateFixture = {
  name: "feedback-constrained",
  description:
    "Standing 'too long' feedback from both, plus one unconsumed prompt idea. Length is a hard constraint and the idea should be used if it fits.",
  input: base({
    candidatesA: candidates({
      domainCounts: zeroDomainCounts({ "hobbies-interests": 1 }),
      exploit: [
        node(501, "hobbies-interests", "movies", "Big fan of horror movies", [
          { date: "2026-07-16", text: "Big fan of horror movies." },
        ]),
      ],
    }),
    candidatesB: candidates({
      domainCounts: zeroDomainCounts({ "hobbies-interests": 1 }),
      exploit: [
        node(502, "hobbies-interests", "sports", "Plays pickup basketball on Sundays", [
          { date: "2026-07-15", text: "Plays pickup basketball on Sundays." },
        ]),
      ],
    }),
    prefsA: ["Wants shorter questions."],
    feedbackA: ["these are getting too long, keep them short"],
    feedbackB: ["yeah shorter please"],
    ideasA: [{ id: 41, text: "ask us about the worst haircut we ever had" }],
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

const staleThreads: MemoryStateFixture = {
  name: "stale-threads",
  description:
    "Every exploit node's facts and lastAsked are weeks old against a mid-August generation date. Treating a stale node as still-live is the failure mode.",
  input: base({
    today: "2026-08-14",
    candidatesA: candidates({
      domainCounts: zeroDomainCounts({ "daily-life": 1, "career-academics": 1, "hobbies-interests": 1 }),
      exploit: [
        node(601, "daily-life", "farmers-market", "Lives two blocks from a farmers market", [
          { date: "2026-06-02", text: "Lives two blocks from a farmers market." },
        ]),
        node(
          602,
          "career-academics",
          "conference-talk",
          "Waiting to hear back about a conference talk submission",
          [{ date: "2026-06-14", text: "Waiting to hear back about a conference talk submission." }],
          { lastAsked: "2026-06-20" },
        ),
        node(603, "hobbies-interests", "ukulele", "Learning to play the ukulele", [
          { date: "2026-06-10", text: "Learning to play the ukulele." },
        ]),
      ],
      offLimits: [{ domain: "daily-life", subdomain: "small-pleasures", reason: "depleted" }],
    }),
    candidatesB: candidates({
      domainCounts: zeroDomainCounts({ "daily-life": 1, "health-body": 1, "hobbies-interests": 1 }),
      exploit: [
        node(604, "daily-life", "commute", "Commutes 45 minutes each way", [
          { date: "2026-06-05", text: "Commutes 45 minutes each way." },
        ]),
        node(
          605,
          "health-body",
          "fitness",
          "Deciding whether to run a 10K at the end of the month",
          [{ date: "2026-06-12", text: "Deciding whether to run a 10K at the end of the month." }],
          { lastAsked: "2026-06-20" },
        ),
        node(606, "hobbies-interests", "birdwatching", "Getting into birdwatching", [
          { date: "2026-06-08", text: "Getting into birdwatching." },
        ]),
      ],
      offLimits: [{ domain: "daily-life", subdomain: "small-pleasures", reason: "depleted" }],
    }),
    history: [
      shared("2026-06-20", "What's a tiny thing that always makes your day a little better?", answered(85), answered(64)),
    ],
  }),
};

const lowEnergyHistory: MemoryStateFixture = {
  name: "low-energy-history",
  description:
    "Rich exploit candidates but the last week of prompts landed badly (skips and one-word answers). The energy signal, not the candidates, is what should change the prompt.",
  input: base({
    candidatesA: candidates({
      domainCounts: zeroDomainCounts({ "career-academics": 1, "hobbies-interests": 1 }),
      exploit: [
        node(701, "career-academics", "exams", "Studying for the bar exam, barely sleeping", [
          { date: "2026-07-18", text: "Studying for the bar exam." },
          { date: "2026-07-18", text: "Two weeks out from the exam and barely sleeping." },
        ]),
        node(702, "hobbies-interests", "walking", "Likes long walks with podcasts", [
          { date: "2026-07-12", text: "Likes long walks with podcasts." },
        ]),
      ],
    }),
    candidatesB: candidates({
      domainCounts: zeroDomainCounts({ "career-academics": 1, "hobbies-interests": 1 }),
      exploit: [
        node(703, "career-academics", "work", "Picking up extra shifts at the restaurant", [
          { date: "2026-07-17", text: "Picking up extra shifts at the restaurant." },
        ]),
        node(704, "hobbies-interests", "coffee", "Into cold brew and coffee gear", [
          { date: "2026-07-13", text: "Into cold brew and coffee gear." },
        ]),
      ],
    }),
    moodsA: ["[2026-07-19] Stretched thin."],
    moodsB: ["[2026-07-19] Exhausted."],
    history: [
      shared("2026-07-19", "What's the best thing you ate this week?", skipped, answered(4)),
      shared("2026-07-18", "What's your go-to comfort show?", answered(6), skipped),
      shared("2026-07-17", "What's a small purchase that genuinely improved your life?", noResponse, skipped),
    ],
  }),
};

const conflictingPreferences: MemoryStateFixture = {
  name: "conflicting-preferences",
  description:
    "Alex asks for deeper questions while Sam asks for lighter ones. Each person's own question has to respect their own preference.",
  input: base({
    candidatesA: candidates({
      domainCounts: zeroDomainCounts({ "beliefs-values": 1 }),
      exploit: [
        node(801, "beliefs-values", "philosophy", "Reads philosophy for fun", [
          { date: "2026-07-16", text: "Reads philosophy for fun." },
        ]),
      ],
    }),
    candidatesB: candidates({
      domainCounts: zeroDomainCounts({ "hobbies-interests": 1 }),
      exploit: [
        node(802, "hobbies-interests", "tv", "Watches a lot of reality TV", [
          { date: "2026-07-15", text: "Watches a lot of reality TV." },
        ]),
      ],
    }),
    prefsA: ["Wants questions with more depth."],
    prefsB: ["Wants questions that stay light and silly."],
    feedbackA: ["can we get something with a bit more substance"],
    feedbackB: ["these are fine but keep them fun, i don't want homework"],
    history: [
      shared("2026-07-19", "Who was your first celebrity crush?", answered(25), answered(210)),
    ],
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
