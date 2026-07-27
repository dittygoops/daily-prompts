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
}

export interface PromptHistoryEntry {
  date: string;
  /** The stance the generator declared that day, so it can see its own
   * drift toward one side. Null for days predating the stance field or
   * served by the static-bank fallback. */
  stance: string | null;
  a: PersonPromptHistory;
  b: PersonPromptHistory;
}

function personHistoryFor(ledger: Ledger, dayId: number, person: PersonId, dayPromptText: string): PersonPromptHistory {
  const pd = ledger.personDay(dayId, person);
  // person_days is seeded from the day at creation time, so the fallback to
  // dayPromptText only matters for rows written before that seeding existed.
  const text = pd.prompt_text ?? dayPromptText;
  if (pd.state === "answered") {
    return { text, outcome: "answered", responseLength: pd.response_text?.length ?? 0 };
  }
  if (pd.state === "skipped") {
    return { text, outcome: "skipped", responseLength: null };
  }
  return { text, outcome: "no_response", responseLength: null };
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
  return ledger.recentDays(date, windowDays).map((day) => ({
    date: day.date,
    stance: ledger.generationLogFor(day.date)[0]?.stance ?? null,
    a: personHistoryFor(ledger, day.id, "a", day.prompt_text),
    b: personHistoryFor(ledger, day.id, "b", day.prompt_text),
  }));
}
