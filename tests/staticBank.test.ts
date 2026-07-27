import { describe, expect, test } from "bun:test";
import { StaticBankPromptSource } from "../src/prompts/staticBank";
import { Ledger } from "../src/ledger/ledger";

const bank = [
  { id: "p1", text: "one" },
  { id: "p2", text: "two" },
  { id: "p3", text: "three" },
];

// Deterministic RNG: returns values from a fixed list, cycling.
const rngFrom = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

describe("StaticBankPromptSource", () => {
  test("returns identical prompts for both people from the bank, with no theme", async () => {
    const ledger = Ledger.open(":memory:");
    const source = new StaticBankPromptSource(bank, ledger, rngFrom([0]));
    const result = await source.nextPrompts("2026-07-17");
    expect(result.theme).toBeNull();
    expect(bank.map((p) => p.id)).toContain(result.prompts.a.id);
    expect(result.prompts.a).toEqual(result.prompts.b);
  });

  test("never repeats until the bank is exhausted", async () => {
    const ledger = Ledger.open(":memory:");
    const source = new StaticBankPromptSource(bank, ledger, rngFrom([0.9, 0.5, 0.1]));
    const seen = new Set<string>();
    for (let i = 0; i < bank.length; i++) {
      const { prompts } = await source.nextPrompts(`2026-07-${17 + i}`);
      ledger.markPromptUsed(prompts.a.id, `2026-07-${17 + i}`);
      expect(seen.has(prompts.a.id)).toBe(false);
      seen.add(prompts.a.id);
    }
    expect(seen.size).toBe(bank.length);
  });

  test("after exhaustion a fresh no-repeat cycle begins (not sampling with replacement)", async () => {
    const ledger = Ledger.open(":memory:");
    for (const p of bank) ledger.markPromptUsed(p.id, "2026-07-01");
    const source = new StaticBankPromptSource(bank, ledger, rngFrom([0.9, 0.5, 0.1]));
    const seen = new Set<string>();
    for (let i = 0; i < bank.length; i++) {
      const { prompts } = await source.nextPrompts(`2026-08-${10 + i}`);
      ledger.markPromptUsed(prompts.a.id, `2026-08-${10 + i}`);
      expect(seen.has(prompts.a.id)).toBe(false);
      seen.add(prompts.a.id);
    }
    expect(seen.size).toBe(bank.length);
  });

  test("selection is deterministic under an injected RNG", async () => {
    const l1 = Ledger.open(":memory:");
    const l2 = Ledger.open(":memory:");
    const s1 = new StaticBankPromptSource(bank, l1, rngFrom([0.5]));
    const s2 = new StaticBankPromptSource(bank, l2, rngFrom([0.5]));
    expect((await s1.nextPrompts("2026-07-17")).prompts.a.id).toBe((await s2.nextPrompts("2026-07-17")).prompts.a.id);
  });

  test("the real seed bank loads: 30 unique ids and texts", async () => {
    const real = (await import("../data/prompts.json")).default;
    expect(real.length).toBe(30);
    expect(new Set(real.map((p: { id: string }) => p.id)).size).toBe(30);
    expect(new Set(real.map((p: { text: string }) => p.text)).size).toBe(30);
  });
});
