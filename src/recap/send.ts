import * as copy from "../engine/copy";
import type { Channel } from "../channel/types";
import type { PersonId } from "../config";
import type { Ledger } from "../ledger/ledger";
import type { LlmClient } from "../llm/types";
import { effectFor, type EffectIntensity } from "../engine/effects";
import { buildWeeklyRecap } from "./recap";

export interface SendRecapDeps {
  ledger: Ledger;
  channel: Channel;
  llm: LlmClient;
  names: Record<PersonId, string>;
  model: string;
  log: (msg: string) => void;
  now?: () => string;
  /** Omit for no effect, which is what tests and an unconfigured deployment do. */
  intensity?: EffectIntensity;
}

/** Idempotent (via hasRecapFor) send of one week's recap to both people,
 * identical text, mirroring how the daily prompt is always identical. */
export async function sendWeeklyRecap(
  deps: SendRecapDeps,
  weekStart: string,
  weekEnd: string,
): Promise<void> {
  if (deps.ledger.hasRecapFor(weekStart)) {
    deps.log(`weekly recap for ${weekStart} already sent; skipping`);
    return;
  }

  const result = await buildWeeklyRecap(
    { ledger: deps.ledger, llm: deps.llm, names: deps.names, model: deps.model },
    weekStart,
    weekEnd,
  );
  const text = copy.weeklyRecapMessage(result.text);
  // One shared value: both people must see identical decoration, mirroring
  // the identical text below.
  const fx = effectFor("weekly_recap", deps.intensity ?? "off");
  const out = fx ? { text, effect: fx } : text;

  await deps.channel.send("a", out);
  await deps.channel.send("b", out);

  deps.ledger.recordRecap({
    weekStart,
    weekEnd,
    recapText: result.text,
    model: result.model,
    systemPrompt: null,
    userPrompt: null,
    rawResponse: null,
    fellBack: result.fellBack,
    fallbackReason: result.fallbackReason,
    at: (deps.now ?? (() => new Date().toISOString()))(),
  });

  if (result.fellBack) {
    deps.log(`weekly recap for ${weekStart} sent with mechanical-only fallback: ${result.fallbackReason}`);
  } else {
    deps.log(`weekly recap for ${weekStart} sent`);
  }
}
