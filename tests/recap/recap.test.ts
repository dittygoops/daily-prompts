import { describe, expect, test } from "bun:test";
import { buildWeeklyRecap } from "../../src/recap/recap";
import { Ledger } from "../../src/ledger/ledger";
import type { LlmClient } from "../../src/llm/types";

const names = { a: "Alex", b: "Sam" } as const;
const okResponse = (highlight: string) => JSON.stringify({ topics: "traditions", highlight });

function seedWeek(ledger: Ledger) {
  const day = ledger.createDay("2026-07-13", "p1", "What's your favorite tradition?", "t");
  ledger.finalizeResponse(day.id, "a", "Tandoori Times", "t1");
  ledger.finalizeResponse(day.id, "b", "Naturals ice cream", "t2");
  ledger.resolveDay(day.id, "resolved_shared", "t3");
}

describe("buildWeeklyRecap", () => {
  test("combines mechanical stats and the LLM highlight on success", async () => {
    const ledger = Ledger.open(":memory:");
    seedWeek(ledger);
    const llm: LlmClient = { async complete() { return okResponse("A lovely week of shared traditions."); } };
    const result = await buildWeeklyRecap({ ledger, llm, names, model: "test-model" }, "2026-07-13", "2026-07-19");
    expect(result.text).toContain("1/1");
    expect(result.text).toContain("A lovely week of shared traditions.");
    expect(result.fellBack).toBe(false);
    expect(result.model).toBe("test-model");
  });

  test("degrades to mechanical-only when the LLM fails, and records why", async () => {
    const ledger = Ledger.open(":memory:");
    seedWeek(ledger);
    const llm: LlmClient = { async complete() { throw new Error("outage"); } };
    const result = await buildWeeklyRecap({ ledger, llm, names, model: "test-model" }, "2026-07-13", "2026-07-19");
    expect(result.text).toContain("1/1");
    expect(result.fellBack).toBe(true);
    expect(result.fallbackReason).toContain("outage");
  });

  test("mechanical tier alone never throws even on an empty week", async () => {
    const ledger = Ledger.open(":memory:");
    const llm: LlmClient = { async complete() { throw new Error("outage"); } };
    const result = await buildWeeklyRecap({ ledger, llm, names, model: "test-model" }, "2026-07-13", "2026-07-19");
    expect(result.text.toLowerCase()).toContain("no check-ins");
    expect(result.fellBack).toBe(true);
  });
});
