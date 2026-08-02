// Windows (spec "Selection" > "Windows"). Every window is a pure veto: it
// answers "is this blocked", never promotes anything, and never touches
// Date.now or a Ledger. All date comparisons are SIGNED (today minus the
// candidate date), never Math.abs: F12's whole point is that a future
// date (an event that hasn't happened yet) must not look "recent" the way
// abs() would make it look, which is exactly what let lane 0 fire early in
// the incumbent's failure record.

import type { PersonId } from "../config";
import type { AskRow, SelectableNode, SelectionConstants } from "./types";

/** Parses a YYYY-MM-DD date-only string as UTC midnight so day-difference
 * arithmetic is never perturbed by the host's local timezone or DST. */
function parseDateOnly(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

/** today - date, in whole days. Positive when `date` is in the past,
 * negative when `date` is in the future, zero when they're the same day.
 * Every window and lane function goes through this so "signed, never
 * Math.abs" is enforced in one place. */
export function daysSince(today: string, date: string): number {
  return Math.round((parseDateOnly(today) - parseDateOnly(date)) / 86_400_000);
}

/** today shifted back by `days`, as a YYYY-MM-DD string. Used by read.ts to
 * bound the seed-reuse lookback; exported here so both modules share one
 * date arithmetic implementation. */
export function subtractDays(today: string, days: number): string {
  const shifted = parseDateOnly(today) - days * 86_400_000;
  const d = new Date(shifted);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** W1 settling: any fact within settlingDays of today, across ALL homes
 * (spec F7's union reading), blocks the node. `newestFactDate` already
 * folds every home together (Ledger.selectableNodes), so this is a single
 * comparison. Inclusive: a fact from exactly `settlingDays` ago still
 * blocks; the day after that, it doesn't ("unfreeze at D+3" for the
 * settlingDays=2 default means D+2 blocks, D+3 doesn't). */
export function w1Settling(node: SelectableNode, today: string, settlingDays: number): boolean {
  if (node.newestFactDate === null) return false;
  return daysSince(today, node.newestFactDate) <= settlingDays;
}

/** W2 subject cooldown: the node itself was asked within subjectCooldownDays. */
export function w2SubjectCooldown(node: SelectableNode, today: string, subjectCooldownDays: number): boolean {
  if (node.lastAsked === null) return false;
  return daysSince(today, node.lastAsked) <= subjectCooldownDays;
}

/** W3 domain cooldown: this person used `domain` (as ask_domain, the frozen
 * dispatch-time column, F11) within domainCooldownDays. Generic over
 * `domain` so lane 1 (a node's domain) and lane 2 (a seed's domain) share
 * one implementation. */
export function w3DomainCooldown(
  domain: string,
  person: PersonId,
  today: string,
  asks: AskRow[],
  domainCooldownDays: number,
): boolean {
  return asks.some(
    (a) => a.person === person && a.askDomain === domain && daysSince(today, a.date) <= domainCooldownDays,
  );
}

/** W4 family cooldown: this person used `family` (ask_family) within
 * familyCooldownDays. A null family "passes and never sets" (spec): it
 * never blocks (returns false immediately) and, because the comparison
 * below is strict equality against a non-null `family`, an ask row with a
 * null askFamily can never match it either, so a null-family ask never sets
 * the cooldown for anyone else. */
export function w4FamilyCooldown(
  family: string | null,
  person: PersonId,
  today: string,
  asks: AskRow[],
  familyCooldownDays: number,
): boolean {
  if (family === null) return false;
  return asks.some(
    (a) => a.person === person && a.askFamily === family && daysSince(today, a.date) <= familyCooldownDays,
  );
}

/** W5 exploit run cap: this person's last `exploitRunCap` LANE-BEARING asks
 * were all lane followup or exploit. Fallback and skipped days have no lane
 * and are invisible to the run count (impl decision 7), so we filter those
 * out before taking the tail. Fewer than `exploitRunCap` lane-bearing asks
 * in history means there can't be a full run yet, so it never blocks. */
export function w5ExploitRunCap(
  person: PersonId,
  today: string,
  asks: AskRow[],
  exploitRunCap: number,
): boolean {
  const history = asks
    .filter((a) => a.person === person && a.lane !== null && daysSince(today, a.date) > 0)
    .sort((x, y) => {
      const byDate = y.date.localeCompare(x.date); // most recent first
      return byDate !== 0 ? byDate : y.id - x.id;
    });
  if (history.length < exploitRunCap) return false;
  const recent = history.slice(0, exploitRunCap);
  return recent.every((a) => a.lane === "followup" || a.lane === "exploit");
}

/** Combined W1-W5 gate for a lane-1 (exploit) node candidate: every window
 * must pass for the node to be eligible. W5 is person-scoped rather than
 * node-scoped, but it's folded in here because lane 1 eligibility needs all
 * five at once (spec: "open nodes, budget > 0, passing W1-W5"). Budget
 * itself is NOT checked here (lanes.ts checks it separately, since it is
 * not one of the five named windows). */
export function nodeWindowsPass(
  node: SelectableNode,
  today: string,
  asks: AskRow[],
  constants: SelectionConstants,
): boolean {
  if (w1Settling(node, today, constants.settlingDays)) return false;
  if (w2SubjectCooldown(node, today, constants.subjectCooldownDays)) return false;
  if (w3DomainCooldown(node.domain, node.person, today, asks, constants.domainCooldownDays)) return false;
  if (w4FamilyCooldown(node.family, node.person, today, asks, constants.familyCooldownDays)) return false;
  if (w5ExploitRunCap(node.person, today, asks, constants.exploitRunCap)) return false;
  return true;
}
