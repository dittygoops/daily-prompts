import type { Ledger } from "../ledger/ledger";

/** Raw feedback text since `sinceDate`, split by person. Passed to
 * generation alongside System 2's already-extracted, durable
 * `promptPreferences` — this gives the freshest unprocessed text. */
export function recentFeedbackByPerson(
  ledger: Ledger,
  sinceDate: string,
): { a: string[]; b: string[] } {
  const rows = ledger.feedbackSince(sinceDate);
  return {
    a: rows.filter((r) => r.person === "a").map((r) => r.text),
    b: rows.filter((r) => r.person === "b").map((r) => r.text),
  };
}
