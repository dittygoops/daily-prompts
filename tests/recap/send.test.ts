import { describe, expect, test } from "bun:test";
import { sendWeeklyRecap } from "../../src/recap/send";
import { Ledger } from "../../src/ledger/ledger";
import { FakeChannel } from "../../src/channel/fake";
import type { LlmClient } from "../../src/llm/types";

const names = { a: "Alex", b: "Sam" } as const;

function seedWeek(ledger: Ledger) {
  const day = ledger.createDay("2026-07-13", "p1", "What's your favorite tradition?", "t");
  ledger.finalizeResponse(day.id, "a", "Tandoori Times", "t1");
  ledger.finalizeResponse(day.id, "b", "Naturals ice cream", "t2");
  ledger.resolveDay(day.id, "resolved_shared", "t3");
}

describe("sendWeeklyRecap", () => {
  test("sends the identical recap text to both people and records it", async () => {
    const ledger = Ledger.open(":memory:");
    seedWeek(ledger);
    const channel = new FakeChannel();
    const llm: LlmClient = { async complete() { return JSON.stringify({ topics: "topics", highlight: "A great week." }); } };
    await sendWeeklyRecap({ ledger, channel, llm, names, model: "m", log: () => {} }, "2026-07-13", "2026-07-19");
    expect(channel.sentTo("a")[0]).toBe(channel.sentTo("b")[0]);
    expect(channel.sentTo("a")[0]).toContain("A great week.");
    expect(ledger.hasRecapFor("2026-07-13")).toBe(true);
  });

  test("is a no-op the second time for the same week (idempotent)", async () => {
    const ledger = Ledger.open(":memory:");
    seedWeek(ledger);
    const channel = new FakeChannel();
    const llm: LlmClient = { async complete() { return JSON.stringify({ topics: "topics", highlight: "x" }); } };
    const deps = { ledger, channel, llm, names, model: "m", log: () => {} };
    await sendWeeklyRecap(deps, "2026-07-13", "2026-07-19");
    const countAfterFirst = channel.sentTo("a").length;
    await sendWeeklyRecap(deps, "2026-07-13", "2026-07-19");
    expect(channel.sentTo("a").length).toBe(countAfterFirst);
  });

  test("intensity 'playful' attaches the 'celebrate' effect to both sends", async () => {
    const ledger = Ledger.open(":memory:");
    seedWeek(ledger);
    const channel = new FakeChannel();
    const llm: LlmClient = { async complete() { return JSON.stringify({ topics: "topics", highlight: "x" }); } };
    await sendWeeklyRecap(
      { ledger, channel, llm, names, model: "m", log: () => {}, intensity: "playful" },
      "2026-07-13",
      "2026-07-19",
    );
    expect(channel.outboundTo("a")[0]?.effect).toBe("celebrate");
    expect(channel.outboundTo("b")[0]?.effect).toBe("celebrate");
  });

  // FakeChannel normalizes a bare string to { text }, so "bare string" isn't
  // observable here; effect === undefined is the strongest assertion at this
  // layer (the wire-level proof lives in tests/channel/outbound.test.ts).
  test("omitting intensity attaches no effect", async () => {
    const ledger = Ledger.open(":memory:");
    seedWeek(ledger);
    const channel = new FakeChannel();
    const llm: LlmClient = { async complete() { return JSON.stringify({ topics: "topics", highlight: "x" }); } };
    await sendWeeklyRecap({ ledger, channel, llm, names, model: "m", log: () => {} }, "2026-07-13", "2026-07-19");
    expect(channel.outboundTo("a")[0]?.effect).toBeUndefined();
  });
});
