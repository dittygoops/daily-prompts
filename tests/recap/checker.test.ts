import { describe, expect, test } from "bun:test";
import { checkAndSendWeeklyRecap } from "../../src/recap/checker";
import { Ledger } from "../../src/ledger/ledger";
import { FakeChannel } from "../../src/channel/fake";
import type { LlmClient } from "../../src/llm/types";

const names = { a: "Alex", b: "Sam" } as const;

function deps(ledger: Ledger, channel: FakeChannel, now: Date, dayOfWeek = 0) {
  const llm: LlmClient = { async complete() { return JSON.stringify({ topics: "topics", highlight: "A nice week." }); } };
  return { ledger, channel, llm, names, model: "test-model", dayOfWeek, timezone: "America/Phoenix", log: () => {}, now: () => now };
}

describe("checkAndSendWeeklyRecap", () => {
  test("does nothing if the target weekday hasn't been dispatched yet", async () => {
    const ledger = Ledger.open(":memory:");
    const channel = new FakeChannel();
    // 2026-07-19 is a Sunday, but no day was ever created for it.
    const result = await checkAndSendWeeklyRecap(deps(ledger, channel, new Date("2026-07-19T15:00:00-07:00")));
    expect(result).toEqual({ sent: false });
    expect(channel.sentTo("a")).toEqual([]);
  });

  test("does nothing while Sunday's day is still open (dispatched, unresolved)", async () => {
    const ledger = Ledger.open(":memory:");
    ledger.createDay("2026-07-19", "p1", "x", "t0"); // stays 'dispatched'
    const channel = new FakeChannel();
    const result = await checkAndSendWeeklyRecap(deps(ledger, channel, new Date("2026-07-19T20:00:00-07:00")));
    expect(result).toEqual({ sent: false });
  });

  test("sends the recap once both have answered and Sunday's day resolves (same-day)", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-19", "p1", "x", "t0");
    ledger.finalizeResponse(day.id, "a", "answer a", "t1");
    ledger.finalizeResponse(day.id, "b", "answer b", "t2");
    ledger.resolveDay(day.id, "resolved_shared", "t3");
    const channel = new FakeChannel();
    const result = await checkAndSendWeeklyRecap(deps(ledger, channel, new Date("2026-07-19T21:00:00-07:00")));
    expect(result).toEqual({ sent: true });
    expect(channel.sentTo("a")[0]).toContain("A nice week.");
    expect(channel.sentTo("b")[0]).toBe(channel.sentTo("a")[0]);
  });

  test("still sends the recap if Sunday expired unanswered (they missed it) — fires once Monday's dispatch resolves it", async () => {
    const ledger = Ledger.open(":memory:");
    const sunday = ledger.createDay("2026-07-19", "p1", "x", "t0");
    // Nobody answered; Monday's dispatch would have resolved it to 'expired'.
    ledger.resolveDay(sunday.id, "expired", "t1");
    const channel = new FakeChannel();
    const result = await checkAndSendWeeklyRecap(deps(ledger, channel, new Date("2026-07-20T09:00:00-07:00")));
    expect(result).toEqual({ sent: true });
  });

  test("is idempotent: does not resend once already sent for that week", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-19", "p1", "x", "t0");
    ledger.finalizeResponse(day.id, "a", "a", "t1");
    ledger.finalizeResponse(day.id, "b", "b", "t2");
    ledger.resolveDay(day.id, "resolved_shared", "t3");
    const channel = new FakeChannel();
    const d = deps(ledger, channel, new Date("2026-07-19T21:00:00-07:00"));
    await checkAndSendWeeklyRecap(d);
    const countAfterFirst = channel.sentTo("a").length;
    const second = await checkAndSendWeeklyRecap(d);
    expect(second).toEqual({ sent: false });
    expect(channel.sentTo("a").length).toBe(countAfterFirst);
  });
});
