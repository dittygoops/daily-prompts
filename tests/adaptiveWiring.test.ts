import { describe, expect, test } from "bun:test";
import { EngineRuntime } from "../src/engine/runtime";
import { FakeChannel } from "../src/channel/fake";
import { Ledger } from "../src/ledger/ledger";
import { StaticBankPromptSource } from "../src/prompts/staticBank";
import { FallbackPromptSource } from "../src/prompts/fallback";
import type { Prompt, PromptSource } from "../src/prompts/types";

const bank = [{ id: "p1", text: "What's your ideal breakfast?" }];

describe("adaptive/fallback wiring through EngineRuntime", () => {
  test("dispatch works end-to-end with a throwing adaptive stub falling back to the real static bank", async () => {
    const ledger = Ledger.open(":memory:");
    const channel = new FakeChannel();
    const throwingAdaptive: PromptSource = {
      nextPrompt: async () => { throw new Error("adaptive stub always fails"); },
    };
    const staticSource = new StaticBankPromptSource(bank, ledger);
    const promptSource = new FallbackPromptSource(throwingAdaptive, staticSource, { ledger, log: () => {} });

    const runtime = new EngineRuntime({
      names: { a: "Alex", b: "Sam" },
      ledger,
      channel,
      promptSource,
      settleWindowSeconds: 150,
      now: () => "tnow",
    });

    await runtime.dispatch("2026-07-20");
    expect(channel.sentTo("a")[0]).toContain("ideal breakfast");
    const day = ledger.openDay();
    expect(day?.prompt_text).toBe("What's your ideal breakfast?");
    const logRows = ledger.generationLogFor("2026-07-20");
    expect(logRows[0]).toMatchObject({ fellBack: true });
  });

  test("a successfully generated prompt (via a stub) flows through to dispatch unchanged", async () => {
    const ledger = Ledger.open(":memory:");
    const channel = new FakeChannel();
    const generated: Prompt = { id: "gen-2026-07-20", text: "What made you laugh today?" };
    const workingAdaptive: PromptSource = { nextPrompt: async () => generated };
    const staticSource = new StaticBankPromptSource(bank, ledger);
    const promptSource = new FallbackPromptSource(workingAdaptive, staticSource, { ledger, log: () => {} });

    const runtime = new EngineRuntime({
      names: { a: "Alex", b: "Sam" },
      ledger,
      channel,
      promptSource,
      settleWindowSeconds: 150,
      now: () => "tnow",
    });

    await runtime.dispatch("2026-07-20");
    expect(channel.sentTo("a")[0]).toContain("What made you laugh today?");
  });
});
