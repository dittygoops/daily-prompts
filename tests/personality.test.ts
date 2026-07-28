import { describe, expect, test } from "bun:test";
import { fakeClock } from "./helpers/fakeClock";
import { EngineRuntime, type EngineRuntimeOptions } from "../src/engine/runtime";
import { FakeChannel } from "../src/channel/fake";
import type { Channel, ChannelInbound, Outbound } from "../src/channel/types";
import type { PersonId } from "../src/config";
import { Ledger } from "../src/ledger/ledger";
import { StaticBankPromptSource } from "../src/prompts/staticBank";
import { FakeAnimalImageSource, type AnimalImage, type AnimalImageSource } from "../src/media/animals";
import * as copy from "../src/engine/copy";

const bank = [
  { id: "p1", text: "What's your ideal breakfast?" },
  { id: "p2", text: "What made you laugh today?" },
];

function makeRuntime(
  ledger: Ledger,
  channel: Channel,
  clock: ReturnType<typeof fakeClock>["clock"],
  extra: Partial<EngineRuntimeOptions> = {},
) {
  return new EngineRuntime({
    names: { a: "Alex", b: "Sam" },
    ledger,
    channel,
    promptSource: new StaticBankPromptSource(bank, ledger, () => 0),
    settleWindowSeconds: 150,
    timerClock: clock,
    now: () => "tnow",
    ...extra,
  });
}

describe("personality: animal image + effects", () => {
  test("happy path: playful intensity attaches image + emphasize effect to the prompt", async () => {
    const ledger = Ledger.open(":memory:");
    const channel = new FakeChannel();
    const { clock } = fakeClock();
    const animals = new FakeAnimalImageSource();
    const runtime = makeRuntime(ledger, channel, clock, {
      personality: { intensity: "playful", animalImage: true, animalTimeoutMs: 1000 },
      animals,
    });

    await runtime.dispatch("2026-07-17");

    const out = channel.outboundTo("a")[0]!;
    expect(out.image?.mimeType).toBe("image/png");
    expect(out.effect).toBe("emphasize");
    expect(out.text).toBe(copy.promptMessage("What's your ideal breakfast?"));
  });

  // The guarantee that matters most: a broken image source must never keep
  // the daily question from arriving.
  test("source failure: prompt still goes out unchanged, with no image", async () => {
    const ledger = Ledger.open(":memory:");
    const channel = new FakeChannel();
    const { clock } = fakeClock();
    const animals = new FakeAnimalImageSource(undefined, new Error("boom"));
    const runtime = makeRuntime(ledger, channel, clock, {
      personality: { intensity: "playful", animalImage: true, animalTimeoutMs: 1000 },
      animals,
    });

    await runtime.dispatch("2026-07-17");

    expect(channel.sentTo("a")).toContain(copy.promptMessage("What's your ideal breakfast?"));
    expect(channel.outboundTo("a")[0]?.image).toBeUndefined();
  });

  test("timeout: a fetch that never settles yields no image, real timers, milliseconds", async () => {
    const ledger = Ledger.open(":memory:");
    const channel = new FakeChannel();
    const { clock } = fakeClock();
    const neverSettles: AnimalImageSource = {
      fetch: () => new Promise<AnimalImage>(() => {}),
    };
    const runtime = makeRuntime(ledger, channel, clock, {
      personality: { intensity: "playful", animalImage: true, animalTimeoutMs: 5 },
      animals: neverSettles,
    });

    await runtime.dispatch("2026-07-17");

    expect(channel.outboundTo("a")[0]?.image).toBeUndefined();
    expect(channel.sentTo("a")).toContain(copy.promptMessage("What's your ideal breakfast?"));
  });

  test("intensity 'off': no image and no effect on anything sent", async () => {
    const ledger = Ledger.open(":memory:");
    const channel = new FakeChannel();
    const { clock } = fakeClock();
    const animals = new FakeAnimalImageSource();
    const runtime = makeRuntime(ledger, channel, clock, {
      personality: { intensity: "off", animalImage: true, animalTimeoutMs: 1000 },
      animals,
    });

    await runtime.dispatch("2026-07-17");

    // IMPORTANT: we cannot assert "the outbound is a bare string" through
    // FakeChannel: FakeChannel.send normalizes `typeof message === "string"
    // ? { text: message } : message`, so a bare string is unobservable here.
    // That stronger, wire-level assertion lives in
    // tests/channel/outbound.test.ts (outboundContents("plain text")).
    for (const entry of channel.sent) {
      expect(entry.message.image).toBeUndefined();
      expect(entry.message.effect).toBeUndefined();
    }
  });

  test("animalImage: false with intensity 'playful': effect but no image", async () => {
    const ledger = Ledger.open(":memory:");
    const channel = new FakeChannel();
    const { clock } = fakeClock();
    const animals = new FakeAnimalImageSource();
    const runtime = makeRuntime(ledger, channel, clock, {
      personality: { intensity: "playful", animalImage: false, animalTimeoutMs: 1000 },
      animals,
    });

    await runtime.dispatch("2026-07-17");

    const out = channel.outboundTo("a")[0]!;
    expect(out.effect).toBe("emphasize");
    expect(out.image).toBeUndefined();
  });

  test("resolution effects: share carries celebrate, skip_notice carries gentle", async () => {
    const ledger = Ledger.open(":memory:");
    const channel = new FakeChannel();
    const { clock, advance } = fakeClock();
    const animals = new FakeAnimalImageSource();
    const runtime = makeRuntime(ledger, channel, clock, {
      personality: { intensity: "playful", animalImage: true, animalTimeoutMs: 1000 },
      animals,
    });

    await runtime.dispatch("2026-07-17");
    channel.inject("a", "pancakes", "t1");
    await runtime.settled();
    advance(150_000);
    await runtime.settled();
    channel.inject("b", "waffles", "t2");
    await runtime.settled();
    advance(150_000);
    await runtime.settled();

    const shares = channel.sent.filter((s) => s.message.effect === "celebrate");
    expect(shares.length).toBeGreaterThan(0);

    // Second day: one skips, the other answers, to reach skip_notice.
    const ledger2 = Ledger.open(":memory:");
    const channel2 = new FakeChannel();
    const { clock: clock2, advance: advance2 } = fakeClock();
    const runtime2 = makeRuntime(ledger2, channel2, clock2, {
      personality: { intensity: "playful", animalImage: true, animalTimeoutMs: 1000 },
      animals: new FakeAnimalImageSource(),
    });
    await runtime2.dispatch("2026-07-17");
    channel2.inject("b", "SKIP", "t1");
    await runtime2.settled();
    channel2.inject("a", "pancakes", "t2");
    await runtime2.settled();
    advance2(150_000);
    await runtime2.settled();

    const skipNotices = channel2.outboundTo("a").filter((o) => o.text?.includes("Sam skipped"));
    expect(skipNotices.length).toBe(1);
    expect(skipNotices[0]?.effect).toBe("gentle");
  });

  // MANDATORY: the correction the whole design hinges on. A vendor that
  // rejects the attachment must never take the daily question down with it.
  test("channel that throws on an image, but succeeds on plain text: prompt still lands", async () => {
    class ThrowOnImageChannel implements Channel {
      readonly inner = new FakeChannel();
      async send(person: PersonId, message: string | Outbound): Promise<void> {
        if (typeof message !== "string" && message.image !== undefined) {
          throw new Error("vendor rejected attachment");
        }
        await this.inner.send(person, message);
      }
      onMessage(handler: (msg: ChannelInbound) => void): void {
        this.inner.onMessage(handler);
      }
    }

    const ledger = Ledger.open(":memory:");
    const channel = new ThrowOnImageChannel();
    const { clock } = fakeClock();
    const animals = new FakeAnimalImageSource();
    const runtime = makeRuntime(ledger, channel, clock, {
      personality: { intensity: "playful", animalImage: true, animalTimeoutMs: 1000 },
      animals,
    });

    await runtime.dispatch("2026-07-17");

    expect(channel.inner.sentTo("a")).toContain(copy.promptMessage("What's your ideal breakfast?"));
    const day = ledger.openDay()!;
    const messages = ledger.messagesForDay(day.id).filter((m) => m.person === "a" && m.direction === "out");
    expect(messages.some((m) => m.kind === "prompt")).toBe(true);
    expect(messages.some((m) => m.kind === "send_failed")).toBe(false);
    expect(ledger.recentAnimalImageIds(14)).not.toContain("fake:1");
  });

  test("recency: sent image id appears exactly once per day, and rides into the next dispatch's avoid-list", async () => {
    const ledger = Ledger.open(":memory:");
    const channel = new FakeChannel();
    const { clock } = fakeClock();
    const animals = new FakeAnimalImageSource();
    const runtime = makeRuntime(ledger, channel, clock, {
      personality: { intensity: "playful", animalImage: true, animalTimeoutMs: 1000 },
      animals,
    });

    await runtime.dispatch("2026-07-17");
    const ids = ledger.recentAnimalImageIds(14);
    expect(ids.filter((id) => id === "fake:1").length).toBe(1);

    await runtime.dispatch("2026-07-18");
    const lastCall = animals.calls[animals.calls.length - 1];
    expect(lastCall).toContain("fake:1");
  });
});
