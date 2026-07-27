import type { PersonId } from "../config";
import type { Ledger } from "../ledger/ledger";

export type ResponseOutcome = "answered" | "skipped" | "no_response";

export interface EnergySignal {
  outcome: ResponseOutcome;
  responseLength: number | null;
}

/** One person's side of a past day: the question THEY were asked plus how
 * they answered it. Per person because the two now differ. */
export interface PersonPromptHistory extends EnergySignal {
  text: string;
  /** The stance assigned to THIS person that day. Person-level because the
   * two can differ: stanceForPerson downgrades an exploit to explore for a
   * person with no open threads. */
  stance: string | null;
}

export interface PromptHistoryEntry {
  date: string;
  /** The day's stance, which is what decideStance reads back to drive the
   * 1-in-3 cadence. A day counts as an exploit day if EITHER person
   * exploited, since stanceForPerson only ever downgrades. Null for days
   * predating the stance field or served by the static-bank fallback. */
  stance: string | null;
  a: PersonPromptHistory;
  b: PersonPromptHistory;
}

function personHistoryFor(
  ledger: Ledger,
  dayId: number,
  person: PersonId,
  dayPromptText: string,
  stance: string | null,
): PersonPromptHistory {
  const pd = ledger.personDay(dayId, person);
  // person_days is seeded from the day at creation time, so the fallback to
  // dayPromptText only matters for rows written before that seeding existed.
  const text = pd.prompt_text ?? dayPromptText;
  if (pd.state === "answered") {
    return { text, stance, outcome: "answered", responseLength: pd.response_text?.length ?? 0 };
  }
  if (pd.state === "skipped") {
    return { text, stance, outcome: "skipped", responseLength: null };
  }
  return { text, stance, outcome: "no_response", responseLength: null };
}

/** Recent dispatched prompts before `date`, most-recent first, with each
 * person's own question text and a per-person answered/skipped/no_response
 * + response-length energy signal. Feeds the generator's non-repetition and
 * "what landed" context, per person. */
export function recentPromptHistory(
  ledger: Ledger,
  date: string,
  windowDays: number,
): PromptHistoryEntry[] {
  return ledger.recentDays(date, windowDays).map((day) => {
    const rows = ledger.generationLogFor(day.date);
    // A row with no person predates per-person generation and applies to
    // both; taking rows[0] blindly would label B's question with A's stance.
    const legacy = rows.find((r) => r.person === null)?.stance ?? null;
    const stanceFor = (person: PersonId) =>
      rows.find((r) => r.person === person)?.stance ?? legacy;
    return {
      date: day.date,
      stance: rows.some((r) => r.stance === "exploit") ? "exploit" : (rows.find((r) => r.stance)?.stance ?? null),
      a: personHistoryFor(ledger, day.id, "a", day.prompt_text, stanceFor("a")),
      b: personHistoryFor(ledger, day.id, "b", day.prompt_text, stanceFor("b")),
    };
  });
}
