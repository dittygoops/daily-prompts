import { describe, expect, test } from "bun:test";
import { FallbackPromptSource } from "../src/prompts/fallback";
import { Ledger } from "../src/ledger/ledger";
import type { Prompt, PromptSource } from "../src/prompts/types";

function stubSource(behavior: () => Promise<Prompt>): PromptSource {
  return { nextPrompt: behavior };
}

describe("FallbackPromptSource", () => {
  test("returns the primary's prompt when generation succeeds, and never calls the fallback source", async () => {
    const ledger = Ledger.open(":memory:");
    let fallbackCalled = false;
    const primary = stubSource(async () => ({ id: "gen-1", text: "primary prompt" }));
    const fallback = stubSource(async () => {
      fallbackCalled = true;
      return { id: "p1", text: "fallback prompt" };
    });
    const source = new FallbackPromptSource(primary, fallback, { ledger, log: () => {} });
    const prompt = await source.nextPrompt("2026-07-20");
    expect(prompt).toEqual({ id: "gen-1", text: "primary prompt" });
    expect(fallbackCalled).toBe(false);
  });

  test("falls back to the fallback source when the primary throws", async () => {
    const ledger = Ledger.open(":memory:");
    const primary = stubSource(async () => { throw new Error("LLM outage"); });
    const fallback = stubSource(async () => ({ id: "p1", text: "fallback prompt" }));
    const source = new FallbackPromptSource(primary, fallback, { ledger, log: () => {} });
    const prompt = await source.nextPrompt("2026-07-20");
    expect(prompt).toEqual({ id: "p1", text: "fallback prompt" });
  });

  test("falls back on a simulated memory outage error from the primary", async () => {
    const ledger = Ledger.open(":memory:");
    const primary = stubSource(async () => { throw new Error("supermemory down"); });
    const fallback = stubSource(async () => ({ id: "p1", text: "fallback prompt" }));
    const source = new FallbackPromptSource(primary, fallback, { ledger, log: () => {} });
    await expect(source.nextPrompt("2026-07-20")).resolves.toEqual({ id: "p1", text: "fallback prompt" });
  });

  test("falls back on malformed LLM output from the primary", async () => {
    const ledger = Ledger.open(":memory:");
    const primary = stubSource(async () => { throw new Error("LLM response was not valid JSON"); });
    const fallback = stubSource(async () => ({ id: "p1", text: "fallback prompt" }));
    const source = new FallbackPromptSource(primary, fallback, { ledger, log: () => {} });
    await expect(source.nextPrompt("2026-07-20")).resolves.toEqual({ id: "p1", text: "fallback prompt" });
  });

  test("logs a loud, specific message including the underlying error on fallback", async () => {
    const ledger = Ledger.open(":memory:");
    const primary = stubSource(async () => { throw new Error("boom"); });
    const fallback = stubSource(async () => ({ id: "p1", text: "fallback prompt" }));
    const logs: string[] = [];
    const source = new FallbackPromptSource(primary, fallback, { ledger, log: (m) => logs.push(m) });
    await source.nextPrompt("2026-07-20");
    const line = logs.find((l) => l.includes("boom"));
    expect(line).toBeDefined();
    expect(line!.toUpperCase()).toContain("FALL");
  });

  test("records a generation_log row noting fellBack=true and the fallback reason", async () => {
    const ledger = Ledger.open(":memory:");
    const primary = stubSource(async () => { throw new Error("boom"); });
    const fallback = stubSource(async () => ({ id: "p1", text: "fallback prompt" }));
    const source = new FallbackPromptSource(primary, fallback, { ledger, log: () => {} });
    await source.nextPrompt("2026-07-20");
    const rows = ledger.generationLogFor("2026-07-20");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ fellBack: true });
    expect(rows[0]!.fallbackReason).toContain("boom");
  });

  test("if the fallback source itself throws, the error propagates (no further fallback)", async () => {
    const ledger = Ledger.open(":memory:");
    const primary = stubSource(async () => { throw new Error("primary broke"); });
    const fallback = stubSource(async () => { throw new Error("fallback also broke"); });
    const source = new FallbackPromptSource(primary, fallback, { ledger, log: () => {} });
    await expect(source.nextPrompt("2026-07-20")).rejects.toThrow(/fallback also broke/);
  });

  test("never mutates or wraps the primary's successful Prompt", async () => {
    const ledger = Ledger.open(":memory:");
    const exact: Prompt = { id: "gen-exact", text: "exact text" };
    const primary = stubSource(async () => exact);
    const fallback = stubSource(async () => ({ id: "p1", text: "fallback" }));
    const source = new FallbackPromptSource(primary, fallback, { ledger, log: () => {} });
    const prompt = await source.nextPrompt("2026-07-20");
    expect(prompt).toBe(exact);
  });
});
