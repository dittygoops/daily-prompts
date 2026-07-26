import type { Ledger } from "../ledger/ledger";
import type { Prompt, PromptSource } from "./types";

export class StaticBankPromptSource implements PromptSource {
  constructor(
    private readonly bank: readonly Prompt[],
    private readonly ledger: Ledger,
    private readonly rng: () => number = Math.random,
  ) {
    if (bank.length === 0) throw new Error("Prompt bank is empty");
  }

  async nextPrompt(_date: string): Promise<Prompt> {
    const used = this.ledger.usedPromptIds();
    let candidates = this.bank.filter((p) => !used.has(p.id));
    if (candidates.length === 0) {
      // Bank exhausted: start a fresh no-repeat cycle rather than sampling
      // with replacement forever.
      this.ledger.clearPromptUsage();
      candidates = [...this.bank];
    }
    return candidates[Math.floor(this.rng() * candidates.length)]!;
  }
}
