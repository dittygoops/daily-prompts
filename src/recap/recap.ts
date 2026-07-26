import type { PersonId } from "../config";
import type { Ledger } from "../ledger/ledger";
import type { LlmClient } from "../llm/types";
import { assembleWeekStats, mechanicalRecapText } from "./assemble";
import { generateHighlight } from "./highlight";

export interface RecapDeps {
  ledger: Ledger;
  llm: LlmClient;
  names: Record<PersonId, string>;
  model: string;
}

export interface WeeklyRecapResult {
  text: string;
  model: string | null;
  fellBack: boolean;
  fallbackReason: string | null;
}

/** Always computes the mechanical stats tier (pure ledger reads, cannot
 * fail) and attempts to append an LLM-synthesized highlight on top. If the
 * highlight fails for any reason, degrades to mechanical-only rather than
 * blocking the recap entirely — same catch-log-degrade philosophy as
 * System 3's FallbackPromptSource. */
export async function buildWeeklyRecap(
  deps: RecapDeps,
  weekStart: string,
  weekEnd: string,
): Promise<WeeklyRecapResult> {
  const stats = assembleWeekStats(deps.ledger, weekStart, weekEnd);
  const mechanicalText = mechanicalRecapText(stats);

  try {
    const { topics, highlight } = await generateHighlight(deps.ledger, weekStart, weekEnd, deps.names, deps.llm, deps.model);
    const topicsLine = topics.trim().length > 0 ? `Topics discussed: ${topics.trim()}.` : null;
    const text = [mechanicalText, topicsLine, highlight].filter((part): part is string => part !== null).join("\n\n");
    return { text, model: deps.model, fellBack: false, fallbackReason: null };
  } catch (err) {
    return { text: mechanicalText, model: null, fellBack: true, fallbackReason: String(err) };
  }
}
