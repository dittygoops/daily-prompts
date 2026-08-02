// Lanes (spec "Selection" > "Lanes, strict priority"). Each function answers
// "what's eligible, in what order" for one lane, for one person. Pairing
// (pairs.ts) decides which lane actually fires; select.ts wires it all
// together. Pure: no Date, no Ledger, no random.

import type { PersonId } from "../config";
import type { AskRow, SeedRow, SelectableNode, SelectionConstants, TokenRow } from "./types";
import { daysSince, nodeWindowsPass, w3DomainCooldown, w4FamilyCooldown } from "./windows";

/** Lane 0 eligibility: unspent tokens belonging to this person's nodes whose
 * event_date falls in the signed half-open window [today - tokenWindowDays,
 * today) (F12: a future event's token must never look fireable early).
 * Bypasses W1-W5 and budget entirely (spec), so this function doesn't touch
 * either. Ordered oldest event first (most overdue), then id, so callers
 * that want "the" token for a person can take index 0. */
export function lane0Tokens(
  tokens: TokenRow[],
  nodesById: Map<number, SelectableNode>,
  person: PersonId,
  today: string,
  tokenWindowDays: number,
): TokenRow[] {
  return tokens
    .filter((t) => t.spentAt === null)
    .filter((t) => nodesById.get(t.nodeId)?.person === person)
    .filter((t) => {
      const diff = daysSince(today, t.eventDate); // today - eventDate
      // eventDate < today  <=>  diff > 0
      // eventDate >= today - tokenWindowDays  <=>  diff <= tokenWindowDays
      return diff > 0 && diff <= tokenWindowDays;
    })
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate) || a.id - b.id);
}

/** Lane 1 eligibility + ordering: open nodes, budget > 0, passing W1-W5
 * (spec). Budget is checked here rather than in windows.ts because it is
 * not one of the five named windows.
 *
 * Ordering (F4's fix): (1) nodes with an unresolved thread, newest thread
 * date first; (2) never-asked nodes without threads, richest first; (3)
 * previously asked, stalest first; then id within each bucket.
 *
 * "Richest" for bucket 2: SelectableNode carries no direct fact-count field
 * (a contract gap from P0's types.ts noted in the delivery report), so this
 * uses `budget` as the proxy. Budget is granted once, at node creation,
 * from the count of qualifying facts capped at budgetCap (spec "Budget");
 * for a never-asked node it is still exactly that grant (nothing has
 * decremented it yet), so higher budget on an unasked node means more
 * qualifying facts landed on it at creation, up to the cap. */
export function lane1Candidates(
  nodes: SelectableNode[],
  person: PersonId,
  today: string,
  asks: AskRow[],
  constants: SelectionConstants,
): SelectableNode[] {
  const eligible = nodes.filter(
    (n) => n.person === person && n.budget !== null && n.budget > 0 && nodeWindowsPass(n, today, asks, constants),
  );

  const threaded = eligible.filter((n) => n.newestUnresolvedThreadDate !== null);
  const neverAsked = eligible.filter((n) => n.newestUnresolvedThreadDate === null && n.timesAsked === 0);
  const asked = eligible.filter((n) => n.newestUnresolvedThreadDate === null && n.timesAsked > 0);

  threaded.sort(
    (a, b) => b.newestUnresolvedThreadDate!.localeCompare(a.newestUnresolvedThreadDate!) || a.id - b.id,
  );
  neverAsked.sort((a, b) => (b.budget ?? 0) - (a.budget ?? 0) || a.id - b.id);
  asked.sort((a, b) => {
    // stalest first: oldest lastAsked first. lastAsked can't be null here
    // (timesAsked > 0 implies it was set), but fall back to id if it is.
    if (a.lastAsked === null || b.lastAsked === null) return a.id - b.id;
    return a.lastAsked.localeCompare(b.lastAsked) || a.id - b.id;
  });

  return [...threaded, ...neverAsked, ...asked];
}

/** Lane 2 eligibility + ordering: seeds whose domain passes W3 and family
 * passes W4, not already used by this person within seedReuseDays (that
 * window is pre-applied by the caller into `usedSeedIds`, spec's
 * usedSeedIdsWithin), ordered by id (authoring order is the cold-start
 * curve). */
export function lane2Candidates(
  seeds: SeedRow[],
  person: PersonId,
  today: string,
  asks: AskRow[],
  usedSeedIds: Set<number>,
  constants: SelectionConstants,
): SeedRow[] {
  return seeds
    .filter((s) => !usedSeedIds.has(s.id))
    .filter((s) => !w3DomainCooldown(s.domain, person, today, asks, constants.domainCooldownDays))
    .filter((s) => !w4FamilyCooldown(s.family, person, today, asks, constants.familyCooldownDays))
    .sort((a, b) => a.id - b.id);
}
