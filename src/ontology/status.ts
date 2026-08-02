/** Rich means there is visibly material to dig into. Derived from what
 * exists the moment a node is born, because per-node ask statistics never
 * accumulate at one question per person per day: review showed most nodes
 * are asked zero or one times, ever, so any signal requiring repeat askings
 * is dead code in practice. */
export function isRich(input: { factCount: number; distinctDays: number }): boolean {
  return input.factCount >= 3 || input.distinctDays >= 2;
}

/** Depletion is relative to the person, never absolute: the shortest real
 * answer ever recorded is 84 chars, so an absolute floor below that can
 * never fire, and one above it would misread a normal answer as short. A
 * single shy answer is not evidence either, hence the minimum askings. */
export function shouldDeplete(input: {
  timesAsked: number;
  avgYieldChars: number | null;
  personMedianChars: number;
  depletionRatio: number;
  depletionMinAskings: number;
}): boolean {
  if (input.avgYieldChars === null) return false;
  if (input.timesAsked < input.depletionMinAskings) return false;
  return input.avgYieldChars < input.depletionRatio * input.personMedianChars;
}

// shouldClose and reopensOnFact are gone: the 2026-08-02 synthesis design
// drops nodes.status entirely (budget replaces open/depleted/closed), and
// neither function had any caller left once ledgerOntology.ts (their only
// consumer) was deleted with it. shouldDeplete survives only because
// Ledger.recordYieldForNode (src/ledger/ledger.ts, not owned here) still
// imports it for compile-compatibility with not-yet-migrated callers; it is
// dead at runtime against a migrated database (avg_yield_chars no longer
// exists, so that method throws before shouldDeplete's result would matter).
// isRich survives only because tests/eval/fixtures/memoryStates.ts (not
// owned here) still imports it. The landed selector (src/selection/lanes.ts)
// does NOT use it: lane 1's "richest first" ordering for never-asked nodes
// is computed from `budget` as a proxy instead (see lanes.ts's own comment),
// since SelectableNode carries no fact-count field. So isRich is now dead
// for its originally intended purpose and is kept alive only by that one
// test fixture import.
