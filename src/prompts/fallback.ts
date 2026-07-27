import type { Ledger } from "../ledger/ledger";
import type { DailyPrompts, PromptSource } from "./types";

export interface FallbackPromptSourceDeps {
  ledger: Ledger;
  log: (msg: string) => void;
  now?: () => string;
}

/** Wraps an adaptive prompt source with a known-safe fallback (the static
 * bank). The daily ritual must never miss a day because generation broke —
 * this is the structural enforcement of that safety property (PRD F4),
 * matching the same catch-log-degrade philosophy already used for message
 * delivery (EngineRuntime's Send effect) and memory extraction
 * (index.ts's runExtraction). Catches any failure from the primary
 * (network, malformed output, memory backend down — all surface as a
 * thrown Error) and falls back; if the fallback itself throws, that
 * propagates, since no further safety net exists. */
export class FallbackPromptSource implements PromptSource {
  constructor(
    private readonly primary: PromptSource,
    private readonly fallback: PromptSource,
    private readonly deps: FallbackPromptSourceDeps,
  ) {}

  async nextPrompts(date: string): Promise<DailyPrompts> {
    try {
      return await this.primary.nextPrompts(date);
    } catch (err) {
      const reason = String(err);
      this.deps.log(`ADAPTIVE PROMPT GENERATION FAILED for ${date}, falling back to static bank: ${reason}`);
      this.deps.ledger.recordGeneration({
        date,
        promptId: null,
        promptText: null,
        model: null,
        systemPrompt: null,
        userPrompt: null,
        rawResponse: null,
        rationale: null,
        stance: null,
        person: null,
        fellBack: true,
        fallbackReason: reason,
        at: (this.deps.now ?? (() => new Date().toISOString()))(),
      });
      return this.fallback.nextPrompts(date); // if this throws too, it propagates
    }
  }
}
