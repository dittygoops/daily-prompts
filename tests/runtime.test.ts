import { describe, expect, test } from "bun:test";
import { fakeClock } from "./helpers/fakeClock";
import { EngineRuntime } from "../src/engine/runtime";
import { FakeChannel } from "../src/channel/fake";
import { Ledger } from "../src/ledger/ledger";
import { StaticBankPromptSource } from "../src/prompts/staticBank";
import type { TimerClock } from "../src/engine/settle";

const bank = [{ id: "p1", text: "What's your ideal breakfast?" }];

function makeRuntime(ledger: Ledger, channel: FakeChannel, clock: TimerClock) {
  return new EngineRuntime({
    names: { a: "Alex", b: "Sam" },
    ledger,
    channel,
    promptSource: new StaticBankPromptSource(bank, ledger, () => 0),
    settleWindowSeconds: 150,
    timerClock: clock,
    now: () => "tnow",
  });
}

describe("EngineRuntime: full simulated day", () => {
  test("dispatch -> multi-part answer -> settle -> partner answers -> shares; ledger agrees", async () => {
    const ledger = Ledger.open(":memory:");
    const channel = new FakeChannel();
    const { clock, advance } = fakeClock();
    const runtime = makeRuntime(ledger, channel, clock);

    await runtime.dispatch("2026-07-17");
    expect(channel.sentTo("a").length).toBe(1);
    expect(channel.sentTo("b")[0]).toContain("ideal breakfast");
    const day = ledger.openDay()!;
    expect(day.prompt_id).toBe("p1");

    channel.inject("a", "pancakes", "t1");
    channel.inject("a", "with maple syrup", "t2");
    await runtime.settled();
    expect(ledger.personState(day.id, "a")).toBe("collecting");
    advance(150_000);
    await runtime.settled();
    expect(ledger.personState(day.id, "a")).toBe("answered");
    expect(ledger.personResponse(day.id, "a")).toBe("pancakes\nwith maple syrup");
    expect(channel.sentTo("a").some((t) => t.includes("Waiting on Sam"))).toBe(true);

    channel.inject("b", "chilaquiles", "t3");
    await runtime.settled();
    advance(150_000);
    await runtime.settled();
    const dayAfter = ledger.day(day.id);
    expect(dayAfter.state).toBe("resolved_shared");
    expect(channel.sentTo("a").some((t) => t.includes("chilaquiles"))).toBe(true);
    expect(channel.sentTo("b").some((t) => t.includes("pancakes\nwith maple syrup"))).toBe(true);

    // post-share feedback is recorded, not replied to
    const bSendsBefore = channel.sentTo("b").length;
    channel.inject("b", "loved this one", "t4");
    await runtime.settled();
    expect(channel.sentTo("b").length).toBe(bSendsBefore);
    const feedback = ledger.messagesForDay(day.id).filter((m) => m.kind === "feedback");
    expect(feedback.map((m) => m.text)).toEqual(["loved this one"]);
  });

  test("skip day: skipper acked, answerer notified, ledger resolved_skipped", async () => {
    const ledger = Ledger.open(":memory:");
    const channel = new FakeChannel();
    const { clock, advance } = fakeClock();
    const runtime = makeRuntime(ledger, channel, clock);

    await runtime.dispatch("2026-07-17");
    const day = ledger.openDay()!;
    channel.inject("b", "SKIP", "t1");
    await runtime.settled();
    expect(ledger.personState(day.id, "b")).toBe("skipped");
    channel.inject("a", "pancakes", "t2");
    await runtime.settled();
    advance(150_000);
    await runtime.settled();
    expect(ledger.day(day.id).state).toBe("resolved_skipped");
    expect(channel.sentTo("a").some((t) => t.includes("Sam skipped"))).toBe(true);
    expect(channel.sentTo("b").some((t) => t.includes("pancakes"))).toBe(false);
  });

  test("share/feedback-ask timestamps land in person_days", async () => {
    const ledger = Ledger.open(":memory:");
    const channel = new FakeChannel();
    const { clock, advance } = fakeClock();
    const runtime = makeRuntime(ledger, channel, clock);
    await runtime.dispatch("2026-07-17");
    const day = ledger.openDay()!;
    channel.inject("a", "x", "t1");
    await runtime.settled();
    advance(150_000);
    await runtime.settled();
    expect(ledger.personDay(day.id, "a").feedback_ask_sent_at).not.toBeNull();
    channel.inject("b", "y", "t2");
    await runtime.settled();
    advance(150_000);
    await runtime.settled();
    expect(ledger.personDay(day.id, "a").share_sent_at).not.toBeNull();
    expect(ledger.personDay(day.id, "b").share_sent_at).not.toBeNull();
  });
});

describe("EngineRuntime: send failures", () => {
  test("one person's send failure doesn't block the other's messages or ledger writes", async () => {
    const ledger = Ledger.open(":memory:");
    const channel = new FakeChannel();
    const { clock } = fakeClock();
    const failing = {
      send: async (person: "a" | "b", text: string) => {
        if (person === "b") throw new Error("Target not allowed for this project");
        await channel.send(person, text);
      },
      onMessage: channel.onMessage.bind(channel),
    };
    const runtime = new EngineRuntime({
      names: { a: "Alex", b: "Sam" },
      ledger,
      channel: failing,
      promptSource: new StaticBankPromptSource(bank, ledger, () => 0),
      settleWindowSeconds: 150,
      timerClock: clock,
      now: () => "tnow",
    });
    await runtime.dispatch("2026-07-17");
    // a still got the prompt even though b's send blew up
    expect(channel.sentTo("a").length).toBe(1);
    // the day exists and the failed send is visible in the ledger as a failure
    const day = ledger.openDay()!;
    expect(day.state).toBe("dispatched");
    const failures = ledger
      .messagesForDay(day.id)
      .filter((m) => m.kind === "send_failed");
    expect(failures.length).toBe(1);
    expect(failures[0]?.person).toBe("b");
  });
});

describe("EngineRuntime: restart recovery", () => {
  test("a collecting person's parts survive a restart and settle after it", async () => {
    const dbPath = `/tmp/dp-runtime-test-${Date.now()}.db`;
    const ledger1 = Ledger.open(dbPath);
    const channel1 = new FakeChannel();
    const c1 = fakeClock();
    const r1 = makeRuntime(ledger1, channel1, c1.clock);
    await r1.dispatch("2026-07-17");
    channel1.inject("a", "part one", "t1");
    channel1.inject("a", "part two", "t2");
    await r1.settled();
    ledger1.close(); // simulated crash before settle

    const ledger2 = Ledger.open(dbPath);
    const channel2 = new FakeChannel();
    const c2 = fakeClock();
    const r2 = new EngineRuntime({
      names: { a: "Alex", b: "Sam" },
      ledger: ledger2,
      channel: channel2,
      promptSource: new StaticBankPromptSource(bank, ledger2, () => 0),
      settleWindowSeconds: 150,
      timerClock: c2.clock,
      now: () => "tnow2",
    });
    // restart restarts the settle timer for the mid-collection person
    c2.advance(150_000);
    await r2.settled();
    const day = ledger2.openDay()!;
    expect(ledger2.personState(day.id, "a")).toBe("answered");
    expect(ledger2.personResponse(day.id, "a")).toBe("part one\npart two");
    expect(channel2.sentTo("a").some((t) => t.includes("Waiting on Sam"))).toBe(true);
  });

  test("a day stranded with both answered but unshared is replayed: shares go out after restart", async () => {
    const ledger = Ledger.open(":memory:");
    // Simulate the pre-crash ledger: both finalized, no shares, day open.
    const day = ledger.createDay("2026-07-17", "p1", "What's your ideal breakfast?", "t0");
    ledger.setCollecting(day.id, "a");
    ledger.recordMessage({ dayId: day.id, person: "a", direction: "in", kind: "answer_part", text: "pancakes", at: "t1" });
    ledger.finalizeResponse(day.id, "a", "pancakes", "t2");
    ledger.setCollecting(day.id, "b");
    ledger.recordMessage({ dayId: day.id, person: "b", direction: "in", kind: "answer_part", text: "chilaquiles", at: "t3" });
    ledger.finalizeResponse(day.id, "b", "chilaquiles", "t4");

    const channel = new FakeChannel();
    const c = fakeClock();
    const runtime = makeRuntime(ledger, channel, c.clock);
    c.advance(150_000);
    await runtime.settled();
    expect(ledger.day(day.id).state).toBe("resolved_shared");
    expect(channel.sentTo("a").some((t) => t.includes("chilaquiles"))).toBe(true);
    expect(channel.sentTo("b").some((t) => t.includes("pancakes"))).toBe(true);
  });

  test("feedback window survives a restart: post-share texts stay feedback, not oob", async () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-17", "p1", "x", "t0");
    ledger.finalizeResponse(day.id, "a", "pancakes", "t1");
    ledger.finalizeResponse(day.id, "b", "waffles", "t2");
    ledger.resolveDay(day.id, "resolved_shared", "t3");

    const channel = new FakeChannel();
    const c = fakeClock();
    const runtime = makeRuntime(ledger, channel, c.clock);
    channel.inject("a", "loved this one", "t4");
    await runtime.settled();
    expect(channel.sentTo("a")).toEqual([]); // no canned oob reply
    const feedback = ledger.messagesForDay(day.id).filter((m) => m.kind === "feedback");
    expect(feedback.map((m) => m.text)).toEqual(["loved this one"]);
  });

  test("dispatch after an unanswered day expires it and opens the new one", async () => {
    const ledger = Ledger.open(":memory:");
    const channel = new FakeChannel();
    const { clock } = fakeClock();
    const runtime = makeRuntime(ledger, channel, clock);
    await runtime.dispatch("2026-07-17");
    const first = ledger.openDay()!;
    await runtime.dispatch("2026-07-18");
    expect(ledger.day(first.id).state).toBe("expired");
    expect(ledger.openDay()!.date).toBe("2026-07-18");
  });
});
