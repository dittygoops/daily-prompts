import { describe, expect, test } from "bun:test";
import { assembleWeekStats, mechanicalRecapText } from "../../src/recap/assemble";
import { Ledger } from "../../src/ledger/ledger";

describe("assembleWeekStats", () => {
  test("empty week (no days) produces zeroed stats", () => {
    const ledger = Ledger.open(":memory:");
    const stats = assembleWeekStats(ledger, "2026-07-13", "2026-07-19");
    expect(stats).toMatchObject({ totalDays: 0, bothAnswered: 0 });
  });

  test("a full week of resolved_shared days counts correctly", () => {
    const ledger = Ledger.open(":memory:");
    for (let i = 13; i <= 19; i++) {
      const day = ledger.createDay(`2026-07-${i}`, `p${i}`, `prompt ${i}`, "t");
      ledger.finalizeResponse(day.id, "a", "ans a", "t1");
      ledger.finalizeResponse(day.id, "b", "ans b", "t2");
      ledger.resolveDay(day.id, "resolved_shared", "t3");
    }
    const stats = assembleWeekStats(ledger, "2026-07-13", "2026-07-19");
    expect(stats.totalDays).toBe(7);
    expect(stats.bothAnswered).toBe(7);
  });

  test("mixed week: partial, skipped, and expired days are reflected per-day", () => {
    const ledger = Ledger.open(":memory:");
    const d1 = ledger.createDay("2026-07-13", "p1", "x", "t");
    ledger.finalizeResponse(d1.id, "a", "ans", "t1");
    ledger.resolveDay(d1.id, "resolved_partial", "t2");
    const d2 = ledger.createDay("2026-07-14", "p2", "y", "t");
    ledger.markSkipped(d2.id, "a", "t1");
    ledger.markSkipped(d2.id, "b", "t2");
    ledger.resolveDay(d2.id, "resolved_skipped", "t3");
    const d3 = ledger.createDay("2026-07-15", "p3", "z", "t");
    ledger.resolveDay(d3.id, "expired", "t1");

    const stats = assembleWeekStats(ledger, "2026-07-13", "2026-07-19");
    expect(stats.totalDays).toBe(3);
    expect(stats.bothAnswered).toBe(0);
    expect(stats.days.find((d) => d.date === "2026-07-13")).toMatchObject({ aState: "answered", bState: "awaiting" });
    expect(stats.days.find((d) => d.date === "2026-07-14")).toMatchObject({ aState: "skipped", bState: "skipped" });
  });

  test("days outside the range are excluded", () => {
    const ledger = Ledger.open(":memory:");
    ledger.createDay("2026-07-12", "p1", "before", "t");
    ledger.createDay("2026-07-20", "p2", "after", "t");
    const stats = assembleWeekStats(ledger, "2026-07-13", "2026-07-19");
    expect(stats.totalDays).toBe(0);
  });
});

describe("mechanicalRecapText", () => {
  test("produces a sane message for zero check-ins, not a divide-by-zero artifact", () => {
    const ledger = Ledger.open(":memory:");
    const stats = assembleWeekStats(ledger, "2026-07-13", "2026-07-19");
    const text = mechanicalRecapText(stats);
    expect(text.toLowerCase()).toContain("no check-ins");
  });

  test("includes a week-of date label and an X/Y answered-together count", () => {
    const ledger = Ledger.open(":memory:");
    for (let i = 13; i <= 15; i++) {
      const day = ledger.createDay(`2026-07-${i}`, `p${i}`, `prompt about topic-${i}`, "t");
      ledger.finalizeResponse(day.id, "a", "ans a", "t1");
      ledger.finalizeResponse(day.id, "b", "ans b", "t2");
      ledger.resolveDay(day.id, "resolved_shared", "t3");
    }
    const stats = assembleWeekStats(ledger, "2026-07-13", "2026-07-19");
    const text = mechanicalRecapText(stats);
    expect(text).toContain("Week of Jul 13");
    expect(text).toContain("3/3");
  });
});
