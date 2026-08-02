// buildSelectionInput: the ONLY function in this package that touches a
// Ledger. Everything else (windows.ts, lanes.ts, pairs.ts, select.ts,
// anchor.ts) is pure and takes a SelectionInput or plain values; this file
// is the boundary that turns live Ledger state into that snapshot.

import type { PersonId } from "../config";
import type { Ledger } from "../ledger/ledger";
import type { SelectionConstants, SelectionInput } from "./types";
import { subtractDays } from "./windows";

const PEOPLE: PersonId[] = ["a", "b"];

// A generous fixed floor, independent of the configured window sizes.
// W5's run-cap counting skips fallback/null-lane days (impl decision 7),
// so a real run of exploitRunCap lane-bearing asks can span more calendar
// days than exploitRunCap itself if fallback days are interleaved. Rather
// than guess a multiplier on top of the configured windows, this pulls
// asks all the way back to the epoch: the couple's ask history is small
// (one row per person per day since the project started), so there is no
// performance reason to truncate it, and truncating risks silently missing
// history that a window function actually needs.
const ASK_HISTORY_START = "1970-01-01";

export function buildSelectionInput(ledger: Ledger, today: string, constants: SelectionConstants): SelectionInput {
  const nodes: SelectionInput["nodes"] = { a: [], b: [] };
  const usedSeedIds: SelectionInput["usedSeedIds"] = { a: new Set(), b: new Set() };

  for (const person of PEOPLE) {
    nodes[person] = ledger.selectableNodes(person);
    usedSeedIds[person] = ledger.usedSeedIdsWithin(person, subtractDays(today, constants.seedReuseDays));
  }

  return {
    nodes,
    asks: ledger.recentAsks(ASK_HISTORY_START),
    seeds: ledger.allSeeds(),
    usedSeedIds,
    tokens: ledger.fireableTokens(today, constants.tokenWindowDays),
    constants,
    today,
  };
}
