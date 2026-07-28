import type { Channel } from "../channel/types";
import type { PersonId } from "../config";
import type { Ledger } from "../ledger/ledger";
import type { LlmClient } from "../llm/types";
import type { EffectIntensity } from "../engine/effects";
import { addDays, mostRecentDayOfWeek } from "../scheduler";
import { sendWeeklyRecap } from "./send";

export interface RecapCheckerDeps {
  ledger: Ledger;
  channel: Channel;
  llm: LlmClient;
  names: Record<PersonId, string>;
  model: string;
  dayOfWeek: number;
  timezone: string;
  log: (msg: string) => void;
  now?: () => Date;
  /** Omit for no effect, which is what tests and an unconfigured deployment do. */
  intensity?: EffectIntensity;
}

/** Polled by index.ts. Triggered by state, not a clock: finds the most
 * recent occurrence of the configured week-ending weekday, and sends the
 * recap only once that day's dispatch has actually resolved (whether both
 * answered, one did, or neither did and it expired at the next day's
 * dispatch) — never while it's still open. This means a couple that
 * answers early gets their recap same-day, and a missed day still gets one
 * once it resolves, with no separate reconciliation logic needed: the poll
 * loop itself catches up naturally on the next tick after any downtime. */
export async function checkAndSendWeeklyRecap(deps: RecapCheckerDeps): Promise<{ sent: boolean }> {
  const now = (deps.now ?? (() => new Date()))();
  const weekEnd = mostRecentDayOfWeek(now, deps.dayOfWeek, deps.timezone);
  const day = deps.ledger.dayForDate(weekEnd);
  if (!day || day.state === "dispatched") return { sent: false };

  const weekStart = addDays(weekEnd, -6);
  if (deps.ledger.hasRecapFor(weekStart)) return { sent: false };

  await sendWeeklyRecap(
    {
      ledger: deps.ledger,
      channel: deps.channel,
      llm: deps.llm,
      names: deps.names,
      model: deps.model,
      log: deps.log,
      intensity: deps.intensity,
    },
    weekStart,
    weekEnd,
  );
  return { sent: true };
}
