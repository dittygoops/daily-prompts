// Golden fixtures for the filing eval (scripts/eval-filing.ts).
//
// These are NOT verbatim answers pulled from the couple's ledger. The
// deliverable that asked for this file was explicit: "do NOT put verbatim
// answers in the repo" even though the couple's own names already live in
// ledger.db, and this project's own constraints forbid touching ledger.db
// at all in this task. So instead of reading real rows, every fixture below
// is hand-written to match the SHAPES the ee-synthesis-design spec and this
// wave's extractor changes actually need to be measured against: a
// multi-subject event answer (the spec's own psychic-party example), a
// settled-preference answer, a thread-heavy answer, a short flat answer,
// plus a few more covering event dates, an existing-node update, and a
// habit that must NOT get an eventDate. Names used below are invented, not
// the participants' real ones.
import type { PersonId } from "../../../src/config";
import type { Family } from "../../../src/selection/types";
import type { ExistingNode } from "../../../src/extraction/extractor";

export interface FilingFixture {
  id: string;
  label: string;
  person: PersonId;
  date: string;
  promptText: string;
  response: string;
  /** The closed vocabulary this fixture's extraction call is given, so a
   * fixture can exercise "cites an existing node" as well as "creates a new
   * one". Empty for fixtures that should create everything fresh. */
  existingNodes: ExistingNode[];
  expected: {
    /** Subdomains (post-normalizeSubdomain) that should end up filed on,
     * primary or secondary home, new or existing. */
    subjects: string[];
    /** The set of fact kinds the answer should produce at least one of. */
    kinds: ("fact" | "thread" | "interest")[];
    /** Families expected among the filed facts. `null` is a legal member,
     * meaning "at least one fact is expected to land with no family". */
    families: (Family | null)[];
    /** Whether at least one fact is expected to carry alsoAbout entries
     * (secondary homes). */
    multiHomes: boolean;
    /** Absolute dates (YYYY-MM-DD) expected to show up as some fact's
     * eventDate. Empty when nothing in the answer is a dated occurrence. */
    eventDates: string[];
  };
}

const carNode: ExistingNode = {
  id: 101,
  domain: "daily-life",
  subdomain: "car",
  summary: "Owns a car that occasionally needs repairs.",
};

const gymNode: ExistingNode = {
  id: 102,
  domain: "health-body",
  subdomain: "gym",
  summary: "Goes to the gym regularly and lifts weights.",
};

const readingGoalNode: ExistingNode = {
  id: 103,
  domain: "plans-future",
  subdomain: "reading-goal",
  summary: "Working toward a yearly reading goal.",
};

export const FILING_FIXTURES: FilingFixture[] = [
  {
    id: "multi-subject-event",
    label: "multi-subject event answer (spec's psychic-party shape: one fact, three subjects)",
    person: "a",
    date: "2026-08-01",
    promptText: "Anything fun happen this week?",
    response:
      "We went to Mara's birthday party on 2026-08-15 and a psychic there told her the car she's been fighting with all year is about to give out for good, which got a whole conversation going.",
    existingNodes: [],
    expected: {
      subjects: ["mara", "psychic-reading", "car"],
      kinds: ["fact"],
      families: ["people"],
      multiHomes: true,
      eventDates: ["2026-08-15"],
    },
  },
  {
    id: "settled-preference",
    label: "settled-preference answer (one durable fact, no thread, no date)",
    person: "b",
    date: "2026-08-02",
    promptText: "Any food you could eat every day and never get tired of?",
    response: "Honestly plain buttered noodles. I could eat that forever, no question.",
    existingNodes: [],
    expected: {
      subjects: ["buttered-noodles"],
      kinds: ["fact"],
      families: ["food"],
      multiHomes: false,
      eventDates: [],
    },
  },
  {
    id: "thread-heavy",
    label: "thread-heavy answer (multiple open threads, one dated)",
    person: "a",
    date: "2026-08-03",
    promptText: "What's on your plate right now?",
    response:
      "Work has been a lot - we're mid-migration on the API and I keep finding edge cases, so that's still very open. Separately I've got a dentist appointment on 2026-08-20 I'm dreading.",
    existingNodes: [],
    expected: {
      subjects: ["api-migration", "dentist-appointment"],
      kinds: ["thread"],
      families: ["work-school", "body"],
      multiHomes: false,
      eventDates: ["2026-08-20"],
    },
  },
  {
    id: "short-flat",
    label: "short flat answer (little to nothing extractable)",
    person: "b",
    date: "2026-08-04",
    promptText: "How was today?",
    response: "Fine, pretty normal day, nothing much to report.",
    existingNodes: [],
    expected: {
      subjects: [],
      kinds: [],
      families: [],
      multiHomes: false,
      eventDates: [],
    },
  },
  {
    id: "existing-node-update-no-date",
    label: "cites an existing node, continuing a habit - must NOT carry an eventDate",
    person: "a",
    date: "2026-08-05",
    promptText: "How's the gym going?",
    response: "Still going most mornings before work, feeling stronger honestly.",
    existingNodes: [gymNode],
    expected: {
      subjects: ["gym"],
      kinds: ["fact"],
      families: ["body"],
      multiHomes: false,
      eventDates: [],
    },
  },
  {
    id: "existing-node-new-event-date",
    label: "cites an existing node with a genuinely new dated occurrence",
    person: "a",
    date: "2026-08-06",
    promptText: "Any car updates?",
    response: "Yeah, finally booked the repair - it's going in on 2026-08-22.",
    existingNodes: [carNode],
    expected: {
      subjects: ["car"],
      kinds: ["thread"],
      families: ["daily-mechanics"],
      multiHomes: false,
      eventDates: ["2026-08-22"],
    },
  },
  {
    id: "self-improvement",
    label: "self-improvement register (spec's motivating family example, one of the four)",
    person: "b",
    date: "2026-08-07",
    promptText: "How's the reading goal coming along?",
    response: "Behind schedule but I'm not stressed about it, picked a shorter book to catch up.",
    existingNodes: [readingGoalNode],
    expected: {
      subjects: ["reading-goal"],
      kinds: ["fact"],
      families: ["self-improvement"],
      multiHomes: false,
      eventDates: [],
    },
  },
  {
    id: "romance-event",
    label: "a planned date night - dated occurrence, romance/events register",
    person: "b",
    date: "2026-08-08",
    promptText: "Anything nice planned for the two of you?",
    response: "We booked a dinner reservation for our anniversary on 2026-09-01, really looking forward to it.",
    existingNodes: [],
    expected: {
      subjects: ["anniversary-dinner"],
      kinds: ["thread"],
      families: ["romance", "events-outings"],
      multiHomes: false,
      eventDates: ["2026-09-01"],
    },
  },
  {
    id: "money-preference",
    label: "a settled money-register preference",
    person: "a",
    date: "2026-08-09",
    promptText: "How do you feel about your current budgeting approach?",
    response: "I like keeping a strict weekly budget, it's the only thing that's ever actually worked for me.",
    existingNodes: [],
    expected: {
      subjects: ["budgeting"],
      kinds: ["fact"],
      families: ["money"],
      multiHomes: false,
      eventDates: [],
    },
  },
  {
    id: "people-daily-mechanics-mix",
    label: "a logistics call with a family member (people vs daily-mechanics ambiguity)",
    person: "b",
    date: "2026-08-10",
    promptText: "Talk to your mom recently?",
    response: "Yeah, we spent an hour on the phone sorting out who's hosting Thanksgiving this year.",
    existingNodes: [],
    expected: {
      subjects: ["mom", "thanksgiving-hosting"],
      kinds: ["fact"],
      families: ["people", "plans"],
      multiHomes: false,
      eventDates: [],
    },
  },
];
