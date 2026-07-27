import { describe, expect, test } from "bun:test";
import { recentPromptHistory } from "../src/prompts/history";
import { Ledger } from "../src/ledger/ledger";

describe("recentPromptHistory", () => {
  test("returns days before the given date, most recent first, with per-person energy signals", () => {
    const ledger = Ledger.open(":memory:");
    const day1 = ledger.createDay("2026-07-16", "p1", "first prompt", "t");
    ledger.finalizeResponse(day1.id, "a", "a short answer", "t1");
    ledger.markSkipped(day1.id, "b", "t2");
    const day2 = ledger.createDay("2026-07-17", "p2", "second prompt", "t");
    ledger.finalizeResponse(day2.id, "a", "another answer here", "t1");
    ledger.finalizeResponse(day2.id, "b", "b answered too", "t2");

    const history = recentPromptHistory(ledger, "2026-07-18", 10);
    expect(history.map((h) => h.date)).toEqual(["2026-07-17", "2026-07-16"]);
    expect(history[0]).toMatchObject({
      a: { text: "second prompt", outcome: "answered", responseLength: "another answer here".length },
      b: { text: "second prompt", outcome: "answered", responseLength: "b answered too".length },
    });
    expect(history[1]).toMatchObject({
      a: { text: "first prompt", outcome: "answered", responseLength: "a short answer".length },
      b: { text: "first prompt", outcome: "skipped", responseLength: null },
    });
  });

  test("a person who never answered (still awaiting/collecting) is reported as no_response", () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-16", "p1", "x", "t");
    ledger.finalizeResponse(day.id, "a", "answered", "t1");
    // b never answered; day resolved partial by the caller elsewhere
    const history = recentPromptHistory(ledger, "2026-07-17", 10);
    expect(history[0]!.b).toEqual({ text: "x", stance: null, outcome: "no_response", responseLength: null });
  });

  test("respects the window limit", () => {
    const ledger = Ledger.open(":memory:");
    for (let i = 1; i <= 5; i++) {
      ledger.createDay(`2026-07-${10 + i}`, `p${i}`, `prompt ${i}`, "t");
    }
    const history = recentPromptHistory(ledger, "2026-07-20", 2);
    expect(history.length).toBe(2);
  });

  test("empty ledger returns an empty array, not an error", () => {
    const ledger = Ledger.open(":memory:");
    expect(recentPromptHistory(ledger, "2026-07-17", 10)).toEqual([]);
  });

  test("each person's history entry carries their own question text when they were asked different things", () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-16", "p1", "the day's theme", "t");
    ledger.setPersonPrompt(day.id, "a", "id-a", "A's own question");
    ledger.setPersonPrompt(day.id, "b", "id-b", "B's own question");
    ledger.finalizeResponse(day.id, "a", "a's answer", "t1");
    ledger.finalizeResponse(day.id, "b", "b's answer", "t2");

    const history = recentPromptHistory(ledger, "2026-07-17", 10);
    expect(history[0]!.a.text).toBe("A's own question");
    expect(history[0]!.b.text).toBe("B's own question");
  });
});

describe("per-person stance", () => {
  const gen = (date: string, person: "a" | "b" | null, stance: string) => ({
    date, promptId: `gen-${date}-${person ?? "x"}`, promptText: "q",
    model: "m", systemPrompt: "s", userPrompt: "u", rawResponse: "{}",
    rationale: "r", stance, person, fellBack: false, fallbackReason: null, at: "t",
  });

  test("each person's stance comes from their own generation row", () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-19", "p1", "theme", "t");
    ledger.resolveDay(day.id, "resolved_shared", "t2");
    ledger.recordGeneration(gen("2026-07-19", "a", "exploit"));
    ledger.recordGeneration(gen("2026-07-19", "b", "explore"));
    const [entry] = recentPromptHistory(ledger, "2026-07-20", 14);
    expect(entry!.a.stance).toBe("exploit");
    expect(entry!.b.stance).toBe("explore");
  });

  test("the day counts as an exploit day if either person exploited", () => {
    // decideStance reads these back to drive the 1-in-3 cadence, and
    // stanceForPerson only ever downgrades an exploit to explore, so the
    // day's intent is exploit even when one person could not follow it.
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-19", "p1", "theme", "t");
    ledger.resolveDay(day.id, "resolved_shared", "t2");
    ledger.recordGeneration(gen("2026-07-19", "a", "explore"));
    ledger.recordGeneration(gen("2026-07-19", "b", "exploit"));
    expect(recentPromptHistory(ledger, "2026-07-20", 14)[0]!.stance).toBe("exploit");
  });

  test("a legacy row with no person applies to both people", () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-19", "p1", "shared question", "t");
    ledger.resolveDay(day.id, "resolved_shared", "t2");
    ledger.recordGeneration(gen("2026-07-19", null, "exploit"));
    const [entry] = recentPromptHistory(ledger, "2026-07-20", 14);
    expect(entry!.stance).toBe("exploit");
    expect(entry!.a.stance).toBe("exploit");
    expect(entry!.b.stance).toBe("exploit");
  });
});
