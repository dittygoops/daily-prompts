import { describe, expect, test } from "bun:test";
import {
  effectFor,
  type Effect,
  type EffectEvent,
  type EffectIntensity,
} from "../src/engine/effects";

const ALL_EVENTS: EffectEvent[] = [
  "daily_prompt",
  "day_resolved_both_answered",
  "day_resolved_skipped",
  "nudge",
  "weekly_recap",
];

const ALL_INTENSITIES: EffectIntensity[] = ["off", "subtle", "playful"];

describe("effectFor", () => {
  test("off silences everything", () => {
    for (const event of ALL_EVENTS) {
      expect(effectFor(event, "off")).toBe(null);
    }
  });

  test("a skipped day is never celebrated or emphasized", () => {
    for (const intensity of ALL_INTENSITIES) {
      const result = effectFor("day_resolved_skipped", intensity);
      expect(result).not.toBe("celebrate");
      expect(result).not.toBe("emphasize");
    }
  });

  test("nudges are never loud, and never escalate with intensity", () => {
    for (const intensity of ALL_INTENSITIES) {
      const result = effectFor("nudge", intensity);
      expect(result === null || result === "gentle").toBe(true);
    }
    expect(effectFor("nudge", "subtle")).toBe("gentle");
    expect(effectFor("nudge", "playful")).toBe("gentle");
  });

  test("celebration is reserved for genuine good news", () => {
    for (const intensity of ["subtle", "playful"] as const) {
      const celebrating = ALL_EVENTS.filter((e) => effectFor(e, intensity) === "celebrate");
      expect(new Set(celebrating)).toEqual(
        new Set(["day_resolved_both_answered", "weekly_recap"]),
      );
    }
  });

  test("distribution across a realistic week of events", () => {
    const week: EffectEvent[] = [
      ...Array(7).fill("daily_prompt"),
      ...Array(5).fill("day_resolved_both_answered"),
      ...Array(2).fill("day_resolved_skipped"),
      ...Array(2).fill("nudge"),
      ...Array(1).fill("weekly_recap"),
    ];

    const off = week.map((e) => effectFor(e, "off"));
    expect(off.every((r) => r === null)).toBe(true);

    const subtle = week.map((e) => effectFor(e, "subtle"));
    const playful = week.map((e) => effectFor(e, "playful"));

    const subtleCount = subtle.filter((r) => r !== null).length;
    const playfulCount = playful.filter((r) => r !== null).length;
    // Subtle is restrained but not mute: the week's real moments still land.
    expect(subtleCount).toBeGreaterThan(0);
    expect(subtleCount).toBeLessThan(playfulCount);

    const subtleDailyPrompts = week
      .map((e, i) => (e === "daily_prompt" ? subtle[i] : undefined))
      .filter((r) => r !== undefined);
    expect(subtleDailyPrompts.every((r) => r === null)).toBe(true);

    expect(playful.every((r) => r !== null)).toBe(true);
    const distinctPlayful = new Set(playful as Effect[]);
    expect(distinctPlayful.size).toBe(3);
  });

  test("pins every cell of the policy table", () => {
    const table: Record<EffectIntensity, Record<EffectEvent, Effect | null>> = {
      off: {
        daily_prompt: null,
        day_resolved_both_answered: null,
        day_resolved_skipped: null,
        nudge: null,
        weekly_recap: null,
      },
      subtle: {
        daily_prompt: null,
        day_resolved_both_answered: "celebrate",
        day_resolved_skipped: null,
        nudge: "gentle",
        weekly_recap: "celebrate",
      },
      playful: {
        daily_prompt: "emphasize",
        day_resolved_both_answered: "celebrate",
        day_resolved_skipped: "gentle",
        nudge: "gentle",
        weekly_recap: "celebrate",
      },
    };

    for (const intensity of ALL_INTENSITIES) {
      for (const event of ALL_EVENTS) {
        expect(effectFor(event, intensity)).toBe(table[intensity][event]);
      }
    }
  });
});
