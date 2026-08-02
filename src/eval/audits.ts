// Nightly audits over the 2026-08-02 ee-synthesis-design (spec "Audits").
// Every read goes through the Ledger API, never a raw query: recentAsks
// already encodes the mandatory dedup (one row per (date, person), max(id),
// fell_back = 0, person NOT NULL) and the dispatch-time-only columns
// (ask_domain/ask_family), so no audit here re-derives that contract or
// joins back to a mutable node column (spec F11). A7 is deliberately absent
// (the spec deleted it: the selector's budget-0 refusal is a code invariant
// with a test, not an audit); A9 is out of scope for this wave.
import type { PersonId } from "../config";
import type { Ledger } from "../ledger/ledger";
import type { AskRow, AuditViolation, SelectionConstants } from "../selection/types";

const PEOPLE: PersonId[] = ["a", "b"];

/** Whole days between two ISO date strings, later minus earlier. Dates are
 * plain YYYY-MM-DD, so Date.parse is safe and exact (no time-of-day noise). */
function daysBetween(later: string, earlier: string): number {
  return Math.round((Date.parse(later) - Date.parse(earlier)) / 86_400_000);
}

/** W2 (A1): a node asked twice inside subjectCooldownDays is a violation.
 * For a sorted-by-date sequence, the minimum gap between ANY two entries is
 * always realized by some adjacent pair (if a < b < c and c - a is small,
 * both b - a and c - b are smaller still), so scanning adjacent pairs after
 * sorting finds every violation without an O(n^2) all-pairs scan. */
function auditSubjectCooldown(asks: AskRow[], cooldownDays: number): AuditViolation[] {
  const violations: AuditViolation[] = [];
  for (const person of PEOPLE) {
    const byNode = new Map<number, AskRow[]>();
    for (const ask of asks) {
      if (ask.person !== person || ask.targetNodeId === null) continue;
      const list = byNode.get(ask.targetNodeId) ?? [];
      list.push(ask);
      byNode.set(ask.targetNodeId, list);
    }
    for (const [nodeId, nodeAsks] of byNode) {
      const sorted = [...nodeAsks].sort((a, b) => a.date.localeCompare(b.date));
      for (let i = 1; i < sorted.length; i++) {
        const gap = daysBetween(sorted[i]!.date, sorted[i - 1]!.date);
        // Signed, exclusive comparison (spec F12): a gap exactly equal to
        // the cooldown has fully elapsed and is not a violation.
        if (gap < cooldownDays) {
          violations.push({
            audit: "A1",
            person,
            subject: String(nodeId),
            detail: `node ${nodeId} asked on ${sorted[i - 1]!.date} and again on ${sorted[i]!.date} (${gap}d apart, cooldown ${cooldownDays}d)`,
          });
          break; // subject already identifies the node; one row is enough
        }
      }
    }
  }
  return violations;
}

/** Shared shape for W3/W4 (A2/A3): group a person's asks by a dispatch-time
 * column (ask_domain or ask_family), then apply the same adjacent-pair
 * cooldown check A1 uses. Both windows are structurally identical, only the
 * column and the audit id differ. */
function auditColumnCooldown(
  asks: AskRow[],
  cooldownDays: number,
  column: "askDomain" | "askFamily",
  auditId: "A2" | "A3",
): AuditViolation[] {
  const violations: AuditViolation[] = [];
  for (const person of PEOPLE) {
    const byValue = new Map<string, AskRow[]>();
    for (const ask of asks) {
      const value = ask[column];
      if (ask.person !== person || value === null) continue;
      const list = byValue.get(value) ?? [];
      list.push(ask);
      byValue.set(value, list);
    }
    for (const [value, valueAsks] of byValue) {
      const sorted = [...valueAsks].sort((a, b) => a.date.localeCompare(b.date));
      for (let i = 1; i < sorted.length; i++) {
        const gap = daysBetween(sorted[i]!.date, sorted[i - 1]!.date);
        if (gap < cooldownDays) {
          violations.push({
            audit: auditId,
            person,
            subject: value,
            detail: `${column} "${value}" used on ${sorted[i - 1]!.date} and again on ${sorted[i]!.date} (${gap}d apart, cooldown ${cooldownDays}d)`,
          });
          break;
        }
      }
    }
  }
  return violations;
}

/** A4: no same-day domain/family collision across the couple, except token
 * days. A person firing lane 0 bypasses W1-W5 entirely (spec: "appointments
 * outrank hygiene, including pairing hygiene"), so a collision where either
 * side's lane is followup is not a selection bug and must not fire. Relaxed
 * pairs the selector itself records land in audit_log directly under A4 by
 * the selector's own write (a different package this wave); this function
 * only detects collisions from the dispatch-time columns, it does not read
 * or duplicate anything the selector already wrote. */
function auditCoupleCollision(asks: AskRow[]): AuditViolation[] {
  const byDate = new Map<string, AskRow[]>();
  for (const ask of asks) {
    const list = byDate.get(ask.date) ?? [];
    list.push(ask);
    byDate.set(ask.date, list);
  }
  const violations: AuditViolation[] = [];
  for (const [date, dayAsks] of byDate) {
    const a = dayAsks.find((r) => r.person === "a");
    const b = dayAsks.find((r) => r.person === "b");
    if (!a || !b) continue;
    if (a.lane === "followup" || b.lane === "followup") continue;
    const domainCollision = a.askDomain !== null && a.askDomain === b.askDomain;
    const familyCollision = a.askFamily !== null && a.askFamily === b.askFamily;
    if (domainCollision || familyCollision) {
      violations.push({
        audit: "A4",
        person: null,
        subject: date,
        detail: `same-day collision on ${date}: domain ${a.askDomain ?? "-"}/${b.askDomain ?? "-"}, family ${a.askFamily ?? "-"}/${b.askFamily ?? "-"}`,
      });
    }
  }
  return violations;
}

/** A5: an unspent token whose event_date fell out of the fireable window is
 * a real invariant now (spec: "not 'or logged why'"), so every row Ledger's
 * expiredUnspentTokens returns is a violation, full stop. */
function auditExpiredTokens(ledger: Ledger, today: string, tokenWindowDays: number): AuditViolation[] {
  return ledger.expiredUnspentTokens(today, tokenWindowDays).map((token) => ({
    audit: "A5" as const,
    person: null,
    subject: String(token.id),
    detail: `token ${token.id} on node ${token.nodeId} (event ${token.eventDate}) expired unspent`,
  }));
}

/** A6: no more than exploitRunCap consecutive followup-or-exploit lane days
 * per person. Null-lane days (fallback, skipped) are invisible to the run
 * count (spec impl decision 7): they are filtered out entirely before
 * scanning, so a fallback day neither extends nor breaks a streak, unlike an
 * explore day which breaks it by being lane 'explore'. */
function auditExploitRunCap(asks: AskRow[], exploitRunCap: number): AuditViolation[] {
  const violations: AuditViolation[] = [];
  for (const person of PEOPLE) {
    const sequence = asks
      .filter((a) => a.person === person && a.lane !== null)
      .sort((a, b) => a.date.localeCompare(b.date));
    let run: AskRow[] = [];
    const flush = () => {
      if (run.length > exploitRunCap) {
        violations.push({
          audit: "A6",
          person,
          subject: run[0]!.date,
          detail: `${run.length} consecutive followup/exploit days from ${run[0]!.date} to ${run[run.length - 1]!.date} (cap ${exploitRunCap})`,
        });
      }
      run = [];
    };
    for (const ask of sequence) {
      if (ask.lane === "followup" || ask.lane === "exploit") {
        run.push(ask);
      } else {
        flush();
      }
    }
    flush();
  }
  return violations;
}

/** A8: informational. Tracks W4's null-family bypass (spec F2): a null
 * family blocks nothing and sets nothing, so silent erosion of the family
 * window needs to be visible somewhere. One row for the whole graph, not per
 * person, since the spec calls it "a single violation row". */
function auditNullFamilyRate(ledger: Ledger): AuditViolation[] {
  const nodes = [...ledger.nodesFor("a"), ...ledger.nodesFor("b")];
  if (nodes.length === 0) return [];
  const nullCount = nodes.filter((n) => n.family === null).length;
  const rate = nullCount / nodes.length;
  if (rate <= 0.25) return [];
  return [
    {
      audit: "A8",
      person: null,
      subject: null,
      detail: `${nullCount}/${nodes.length} nodes (${Math.round(rate * 100)}%) carry a null family`,
    },
  ];
}

/** Runs every audit (A1-A6, A8) as a pure function of ledger state and
 * today's date, returning the violations found. Scans the full ask history
 * rather than a bounded lookback: this is a monitoring pass, not a
 * dispatch-time check, and idempotent persistence (UNIQUE run_date, audit,
 * person, subject) means re-detecting the same stale violation on a later
 * night costs one row, not unbounded growth. Callers persist and log the
 * result; this function has no side effects of its own. */
export function runAudits(ledger: Ledger, today: string, constants: SelectionConstants): AuditViolation[] {
  const asks = ledger.recentAsks("0001-01-01").filter((a) => a.date <= today);

  return [
    ...auditSubjectCooldown(asks, constants.subjectCooldownDays),
    ...auditColumnCooldown(asks, constants.domainCooldownDays, "askDomain", "A2"),
    ...auditColumnCooldown(asks, constants.familyCooldownDays, "askFamily", "A3"),
    ...auditCoupleCollision(asks),
    ...auditExpiredTokens(ledger, today, constants.tokenWindowDays),
    ...auditExploitRunCap(asks, constants.exploitRunCap),
    ...auditNullFamilyRate(ledger),
  ];
}
