export type NodeStatus = "open" | "depleted" | "closed";

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

/** A time-bound node closes only once its post-event follow-up was asked
 * AND answered. Closing at "event passed + asked once" killed the best
 * question the system ever generated (the psychic-party follow-up), which
 * is the regression case this rule exists for. */
export function shouldClose(input: {
  eventDate: string | null;
  today: string;
  followUpAsked: boolean;
  followUpAnswered: boolean;
}): boolean {
  if (input.eventDate === null) return false;
  if (input.eventDate >= input.today) return false;
  return input.followUpAsked && input.followUpAnswered;
}

/** Depletion and closure are claims about the past; a new fact arriving is
 * new evidence and beats both. Without this, every transition moves toward
 * closure and the graph can only decay. */
export function reopensOnFact(status: NodeStatus): boolean {
  return status !== "open";
}
