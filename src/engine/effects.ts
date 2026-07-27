// The semantic effect vocabulary belongs to the channel boundary, which owns
// the mapping to vendor constants. Re-exported here only so callers of this
// policy do not need a second import.
import type { Effect } from "../channel/types";

export type { Effect };

export type EffectEvent =
  | "daily_prompt"
  | "day_resolved_both_answered"
  | "day_resolved_skipped"
  | "nudge"
  | "weekly_recap";

export type EffectIntensity = "off" | "subtle" | "playful";

/** Decides which visual flourish (if any) belongs to a moment in the ritual,
 * in code rather than by an LLM's judgment. A prior "use your judgment"
 * instruction produced 100% drift to a single option; src/prompts/stance.ts
 * exists for the same reason.
 *
 * "playful" is deliberate: the product owner wants most days to carry
 * something rather than saving flourishes for rare milestones, so every
 * event gets an effect at "playful" and a normal day carries at least two.
 *
 * Celebration is reserved for genuine good news (both people answered, the
 * weekly recap) and is never spent on routine.
 *
 * A skipped day never gets "celebrate" or "emphasize": that would read as
 * mocking someone for missing. "playful" gives it "gentle" acknowledgement;
 * "subtle" stays silent, since silence is the most respectful minimum there.
 *
 * Nudges are "gentle" at every non-off intensity and never escalate,
 * because a louder nudge reads as nagging. */
const POLICY: Record<Exclude<EffectIntensity, "off">, Record<EffectEvent, Effect | null>> = {
  subtle: {
    daily_prompt: null,
    day_resolved_both_answered: "celebrate",
    day_resolved_skipped: null,
    nudge: "gentle",
    weekly_recap: "celebrate",
  },
  playful: {
    daily_prompt: "emphasize",
    day_resolved_both_answered: "celebrate",
    day_resolved_skipped: "gentle",
    nudge: "gentle",
    weekly_recap: "celebrate",
  },
};

export function effectFor(event: EffectEvent, intensity: EffectIntensity): Effect | null {
  // Hard, unconditional escape hatch: cannot be defeated by a future edit
  // to the policy table above.
  if (intensity === "off") return null;
  return POLICY[intensity][event];
}
