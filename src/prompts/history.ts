import type { PersonId } from "../config";
import type { Ledger } from "../ledger/ledger";

export type ResponseOutcome = "answered" | "skipped" | "no_response";

export interface EnergySignal {
  outcome: ResponseOutcome;
  responseLength: number | null;
}

export interface PromptHistoryEntry {
  date: string;
  text: string;
  a: EnergySignal;
  b: EnergySignal;
}

function energyFor(ledger: Ledger, dayId: number, person: PersonId): EnergySignal {
  const pd = ledger.personDay(dayId, person);
  if (pd.state === "answered") {
    return { outcome: "answered", responseLength: pd.response_text?.length ?? 0 };
  }
  if (pd.state === "skipped") {
    return { outcome: "skipped", responseLength: null };
  }
  return { outcome: "no_response", responseLength: null };
}

/** Recent dispatched prompts before `date`, most-recent first, with a
 * per-person answered/skipped/no_response + response-length energy signal.
 * Feeds the generator's non-repetition and "what landed" context. */
export function recentPromptHistory(
  ledger: Ledger,
  date: string,
  windowDays: number,
): PromptHistoryEntry[] {
  return ledger.recentDays(date, windowDays).map((day) => ({
    date: day.date,
    text: day.prompt_text,
    a: energyFor(ledger, day.id, "a"),
    b: energyFor(ledger, day.id, "b"),
  }));
}
