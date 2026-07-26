import type { PersonId } from "../config";
import type { DayRow, PersonDayRow } from "../ledger/ledger";

export type NudgeTrigger = "no_response" | "partner_waiting" | "almost_due";

export interface NudgeToSend {
  person: PersonId;
  trigger: NudgeTrigger;
}

export interface NudgeCheckInput {
  day: DayRow;
  personA: PersonDayRow;
  personB: PersonDayRow;
  now: Date;
  nextDispatchAt: Date;
  afterHours: number;
  beforeDueHours: number;
  alreadySent: (person: PersonId, trigger: NudgeTrigger) => boolean;
}

const HOUR_MS = 60 * 60 * 1000;

/** Pure eligibility check for the three nudge triggers, run by a poller
 * (src/nudge/pipeline.ts) against the currently open day. No I/O; every
 * input is a plain value so this is exhaustively unit-testable.
 *
 * - no_response: neither person has answered `afterHours` after dispatch —
 *   nudges whoever is still awaiting (that's both, by definition).
 * - partner_waiting: your partner answered and it's been `afterHours` since
 *   then and you still haven't — nudges just you. Never fires if the
 *   partner skipped (nobody is "waiting" in that case) or if the day rolls
 *   over before the threshold is reached (naturally superseded, no
 *   special-casing needed).
 * - almost_due: within `beforeDueHours` of the next dispatch and you still
 *   haven't answered — a last-call nudge, independent of the partner's
 *   state.
 *
 * Never fires for someone `collecting` (mid-answer) or already terminal
 * (`answered`/`skipped`), and never once a resolved day.
 */
export function checkNudges(input: NudgeCheckInput): NudgeToSend[] {
  if (input.day.state !== "dispatched") return [];

  const persons: { id: PersonId; me: PersonDayRow; them: PersonDayRow }[] = [
    { id: "a", me: input.personA, them: input.personB },
    { id: "b", me: input.personB, them: input.personA },
  ];

  const dispatchedAt = new Date(input.day.dispatched_at!);
  const result: NudgeToSend[] = [];

  for (const { id, me, them } of persons) {
    if (me.state !== "awaiting") continue;

    if (
      them.state === "awaiting" &&
      input.now.getTime() >= dispatchedAt.getTime() + input.afterHours * HOUR_MS &&
      !input.alreadySent(id, "no_response")
    ) {
      result.push({ person: id, trigger: "no_response" });
    }

    if (
      them.state === "answered" &&
      them.finalized_at &&
      input.now.getTime() >= new Date(them.finalized_at).getTime() + input.afterHours * HOUR_MS &&
      !input.alreadySent(id, "partner_waiting")
    ) {
      result.push({ person: id, trigger: "partner_waiting" });
    }

    if (
      input.now.getTime() >= input.nextDispatchAt.getTime() - input.beforeDueHours * HOUR_MS &&
      !input.alreadySent(id, "almost_due")
    ) {
      result.push({ person: id, trigger: "almost_due" });
    }
  }

  return result;
}
