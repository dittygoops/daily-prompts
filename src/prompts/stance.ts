export type Stance = "explore" | "exploit";

/** How many days back to look when deciding whether an exploit is overdue.
 * Two prior days plus today yields the roughly-1-in-3 cadence the product
 * wants: follow-ups often enough to feel known, not so often that the daily
 * question becomes an interrogation about the same open thread. */
const WINDOW_DAYS = 2;

export interface StanceInput {
  /** Declared stances of the most recent generated days, most recent first.
   * Null entries (pre-stance days, fallback days) count as not-an-exploit. */
  recentStances: (string | null)[];
  /** Whether either person has any open thread available to follow up on. */
  hasThreads: boolean;
}

/** Decides today's explore/exploit stance in code rather than leaving it to
 * the model's judgment. Asking the generator to "aim for a mix" produced
 * zero exploits across six live days, and adding an explicit 1-in-3 target
 * plus its own visible stance history did not move it either: it kept
 * reading the threads and then asking a generic question anyway. So the
 * choice is made here and handed to the generator as an instruction. */
export function decideStance(input: StanceInput): Stance {
  if (!input.hasThreads) return "explore";
  const window = input.recentStances.slice(0, WINDOW_DAYS);
  return window.some((s) => s === "exploit") ? "explore" : "exploit";
}
