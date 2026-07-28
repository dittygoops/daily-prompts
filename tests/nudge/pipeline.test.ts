import { describe, expect, test } from "bun:test";
import { checkAndSendNudges } from "../../src/nudge/pipeline";
import { Ledger } from "../../src/ledger/ledger";
import { FakeChannel } from "../../src/channel/fake";

const HOUR = 60 * 60 * 1000;

function baseDeps(ledger: Ledger, channel: FakeChannel, now: Date) {
  return {
    ledger,
    channel,
    names: { a: "Alex", b: "Sam" } as const,
    dispatchTime: { hour: 8, minute: 30 },
    timezone: "America/Phoenix",
    afterHours: 4,
    beforeDueHours: 4,
    log: () => {},
    now: () => now,
  };
}

describe("checkAndSendNudges", () => {
  test("no-op when there is no open day", async () => {
    const ledger = Ledger.open(":memory:");
    const channel = new FakeChannel();
    const result = await checkAndSendNudges(baseDeps(ledger, channel, new Date()));
    expect(result).toEqual({ sent: 0 });
  });

  test("sends and records a no_response nudge to both when neither has answered after afterHours", async () => {
    const ledger = Ledger.open(":memory:");
    const dispatchedAt = new Date("2026-07-20T15:30:00.000Z"); // 08:30 America/Phoenix
    ledger.createDay("2026-07-20", "p1", "x", dispatchedAt.toISOString());
    const channel = new FakeChannel();
    const now = new Date(dispatchedAt.getTime() + 5 * HOUR);

    const result = await checkAndSendNudges(baseDeps(ledger, channel, now));
    expect(result.sent).toBe(2);
    expect(channel.sentTo("a")[0]).toContain("still open");
    expect(channel.sentTo("b")[0]).toContain("still open");
    const day = ledger.openDay()!;
    expect(ledger.hasNudgeBeenSent(day.id, "a", "no_response")).toBe(true);
    expect(ledger.hasNudgeBeenSent(day.id, "b", "no_response")).toBe(true);
  });

  test("sends a partner_waiting nudge naming the partner", async () => {
    const ledger = Ledger.open(":memory:");
    const dispatchedAt = new Date("2026-07-20T15:30:00.000Z");
    const day = ledger.createDay("2026-07-20", "p1", "x", dispatchedAt.toISOString());
    const partnerAnsweredAt = new Date(dispatchedAt.getTime() + HOUR);
    ledger.finalizeResponse(day.id, "b", "answer", partnerAnsweredAt.toISOString());
    const channel = new FakeChannel();
    const now = new Date(partnerAnsweredAt.getTime() + 5 * HOUR);

    await checkAndSendNudges(baseDeps(ledger, channel, now));
    expect(channel.sentTo("a")[0]).toContain("Sam");
    expect(channel.sentTo("b")).toEqual([]); // b already answered, never nudged
  });

  test("calling twice does not double-send", async () => {
    const ledger = Ledger.open(":memory:");
    const dispatchedAt = new Date("2026-07-20T15:30:00.000Z");
    ledger.createDay("2026-07-20", "p1", "x", dispatchedAt.toISOString());
    const channel = new FakeChannel();
    const now = new Date(dispatchedAt.getTime() + 5 * HOUR);

    await checkAndSendNudges(baseDeps(ledger, channel, now));
    const firstCount = channel.sentTo("a").length;
    await checkAndSendNudges(baseDeps(ledger, channel, now));
    expect(channel.sentTo("a").length).toBe(firstCount);
  });

  test("sends an almost_due nudge near the deadline", async () => {
    const ledger = Ledger.open(":memory:");
    const dispatchedAt = new Date("2026-07-20T15:30:00.000Z");
    ledger.createDay("2026-07-20", "p1", "x", dispatchedAt.toISOString());
    const channel = new FakeChannel();
    // next dispatch is 08:30 the following day (America/Phoenix, UTC-7) = 2026-07-21T15:30:00Z
    const now = new Date("2026-07-21T13:00:00.000Z"); // 2.5h before next dispatch
    await checkAndSendNudges(baseDeps(ledger, channel, now));
    expect(channel.sentTo("a").some((t) => t.includes("closes soon"))).toBe(true);
  });

  test("intensity 'playful' attaches the 'gentle' effect to a nudge", async () => {
    const ledger = Ledger.open(":memory:");
    const dispatchedAt = new Date("2026-07-20T15:30:00.000Z");
    ledger.createDay("2026-07-20", "p1", "x", dispatchedAt.toISOString());
    const channel = new FakeChannel();
    const now = new Date(dispatchedAt.getTime() + 5 * HOUR);

    await checkAndSendNudges({ ...baseDeps(ledger, channel, now), intensity: "playful" });
    expect(channel.outboundTo("a")[0]?.effect).toBe("gentle");
  });

  // FakeChannel normalizes a bare string send to { text }, so "the outbound
  // was a bare string" is unobservable here; effect === undefined is the
  // strongest assertion available at this layer (see outbound.test.ts for
  // the wire-level proof).
  test("omitting intensity attaches no effect to a nudge", async () => {
    const ledger = Ledger.open(":memory:");
    const dispatchedAt = new Date("2026-07-20T15:30:00.000Z");
    ledger.createDay("2026-07-20", "p1", "x", dispatchedAt.toISOString());
    const channel = new FakeChannel();
    const now = new Date(dispatchedAt.getTime() + 5 * HOUR);

    await checkAndSendNudges(baseDeps(ledger, channel, now));
    expect(channel.outboundTo("a")[0]?.effect).toBeUndefined();
  });
});
