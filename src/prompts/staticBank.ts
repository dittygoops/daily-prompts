import type { Ledger } from "../ledger/ledger";
import type { DailyPrompts, Prompt, PromptSource } from "./types";

export class StaticBankPromptSource implements PromptSource {
  constructor(
    private readonly bank: readonly Prompt[],
    private readonly ledger: Ledger,
    private readonly rng: () => number = Math.random,
  ) {
    if (bank.length === 0) throw new Error("Prompt bank is empty");
  }

  async nextPrompts(_date: string): Promise<DailyPrompts> {
    const used = this.ledger.usedPromptIds();
    let candidates = this.bank.filter((p) => !used.has(p.id));
    if (candidates.length === 0) {
      // Bank exhausted: start a fresh no-repeat cycle rather than sampling
      // with replacement forever.
      this.ledger.clearPromptUsage();
      candidates = [...this.bank];
    }
    const chosen = candidates[Math.floor(this.rng() * candidates.length)]!;
    // Degraded mode is deliberately simple: both people get the identical
    // bank question, and there is no theme to name because nothing was
    // generated.
    return { theme: null, prompts: { a: chosen, b: chosen } };
  }
}
