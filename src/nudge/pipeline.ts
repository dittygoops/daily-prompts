import * as copy from "../engine/copy";
import type { Channel } from "../channel/types";
import type { PersonId } from "../config";
import type { Ledger } from "../ledger/ledger";
import { effectFor, type EffectIntensity } from "../engine/effects";
import { nextDispatchAt, type DispatchTime } from "../scheduler";
import { checkNudges, type NudgeTrigger } from "./checker";

export interface NudgePipelineDeps {
  ledger: Ledger;
  channel: Channel;
  names: Record<PersonId, string>;
  dispatchTime: DispatchTime;
  timezone: string;
  afterHours: number;
  beforeDueHours: number;
  log: (msg: string) => void;
  now?: () => Date;
  /** Omit for no effect, which is what tests and an unconfigured deployment do. */
  intensity?: EffectIntensity;
}

function messageFor(trigger: NudgeTrigger, person: PersonId, names: Record<PersonId, string>): string {
  switch (trigger) {
    case "no_response":
      return copy.nudgeNoResponse();
    case "partner_waiting": {
      const partner = person === "a" ? "b" : "a";
      return copy.nudgePartnerWaiting(names[partner]);
    }
    case "almost_due":
      return copy.nudgeAlmostDue();
  }
}

/** Polled by index.ts's nudgeLoop. Reads the currently open day, evaluates
 * the three nudge triggers (src/nudge/checker.ts), and sends+records any
 * that are newly eligible. A side-channel module like extraction's
 * pipeline: it touches the ledger and channel directly rather than routing
 * through EngineRuntime, so the state machine (the most critical, most
 * tested part of the system) stays completely untouched by this feature. */
export async function checkAndSendNudges(deps: NudgePipelineDeps): Promise<{ sent: number }> {
  const day = deps.ledger.openDay();
  if (!day) return { sent: 0 };

  const now = (deps.now ?? (() => new Date()))();
  const next = nextDispatchAt(now, deps.dispatchTime, deps.timezone);

  const toSend = checkNudges({
    day,
    personA: deps.ledger.personDay(day.id, "a"),
    personB: deps.ledger.personDay(day.id, "b"),
    now,
    nextDispatchAt: next,
    afterHours: deps.afterHours,
    beforeDueHours: deps.beforeDueHours,
    alreadySent: (person, trigger) => deps.ledger.hasNudgeBeenSent(day.id, person, trigger),
  });

  for (const { person, trigger } of toSend) {
    const text = messageFor(trigger, person, deps.names);
    const fx = effectFor("nudge", deps.intensity ?? "off");
    // No animal image ever rides a nudge: a nudge is already the mildly
    // awkward message in the product, and attaching a cat to "you have not
    // answered yet" is the reading the effect policy exists to avoid.
    await deps.channel.send(person, fx ? { text, effect: fx } : text);
    deps.ledger.recordNudgeSent(day.id, person, trigger, now.toISOString());
    deps.log(`nudge sent: day ${day.id} person ${person} trigger ${trigger}`);
  }

  return { sent: toSend.length };
}
