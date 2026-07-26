import { describe, expect, test } from "bun:test";
import { recentFeedbackByPerson } from "../src/prompts/feedback";
import { Ledger } from "../src/ledger/ledger";

describe("recentFeedbackByPerson", () => {
  test("splits feedback since the cutoff into per-person buckets", () => {
    const ledger = Ledger.open(":memory:");
    const day = ledger.createDay("2026-07-18", "p1", "x", "t");
    ledger.recordMessage({ dayId: day.id, person: "a", direction: "in", kind: "feedback", text: "a's note", at: "t" });
    ledger.recordMessage({ dayId: day.id, person: "b", direction: "in", kind: "feedback", text: "b's note", at: "t" });
    const { a, b } = recentFeedbackByPerson(ledger, "2026-07-01");
    expect(a).toEqual(["a's note"]);
    expect(b).toEqual(["b's note"]);
  });

  test("no feedback yields empty arrays for both", () => {
    const ledger = Ledger.open(":memory:");
    expect(recentFeedbackByPerson(ledger, "2026-07-01")).toEqual({ a: [], b: [] });
  });
});
