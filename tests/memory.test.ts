import { describe, expect, test } from "bun:test";
import { FakeMemory } from "../src/memory/fake";
import type { Observation } from "../src/memory/types";

function obs(overrides: Partial<Observation>): Observation {
  return {
    type: "fact",
    text: "text",
    topic: "topic",
    person: "a",
    provenance: { dayId: 1, date: "2026-07-17", snippet: "snippet" },
    ...overrides,
  };
}

describe("FakeMemory (the Memory contract)", () => {
  test("getContext buckets by observation type", async () => {
    const memory = new FakeMemory();
    await memory.add([
      obs({ type: "fact", text: "fact one" }),
      obs({ type: "thread", text: "thread one" }),
      obs({ type: "interest", text: "interest one" }),
      obs({ type: "mood_signal", text: "mood one" }),
      obs({ type: "prompt_preference", text: "pref one" }),
    ]);
    const ctx = await memory.getContext("a");
    expect(ctx.facts).toEqual(["[2026-07-17] fact one"]);
    expect(ctx.threads).toEqual(["[2026-07-17] thread one"]);
    expect(ctx.interests).toEqual(["[2026-07-17] interest one"]);
    expect(ctx.recentMoods).toEqual(["[2026-07-17] mood one"]);
    expect(ctx.promptPreferences).toEqual(["[2026-07-17] pref one"]);
  });

  test("getContext is person-isolated", async () => {
    const memory = new FakeMemory();
    await memory.add([obs({ person: "a", text: "about a" }), obs({ person: "b", text: "about b" })]);
    const ctxA = await memory.getContext("a");
    expect(ctxA.facts).toEqual(["[2026-07-17] about a"]);
  });

  test("getContext returns newest-first", async () => {
    const memory = new FakeMemory();
    await memory.add([
      obs({ text: "older", provenance: { dayId: 1, date: "2026-07-15", snippet: "s" } }),
      obs({ text: "newer", provenance: { dayId: 2, date: "2026-07-18", snippet: "s" } }),
    ]);
    const ctx = await memory.getContext("a");
    expect(ctx.facts).toEqual(["[2026-07-18] newer", "[2026-07-15] older"]);
  });

  test("getContext respects a char budget, dropping the oldest first", async () => {
    const memory = new FakeMemory();
    await memory.add([
      obs({ text: "a".repeat(30), provenance: { dayId: 1, date: "2026-07-15", snippet: "s" } }),
      obs({ text: "b".repeat(30), provenance: { dayId: 2, date: "2026-07-18", snippet: "s" } }),
    ]);
    const ctx = await memory.getContext("a", 50);
    expect(ctx.facts.length).toBe(1);
    expect(ctx.facts[0]).toContain("b".repeat(30)); // the newer one survives
  });

  test("getCoverage returns distinct topics for that person only", async () => {
    const memory = new FakeMemory();
    await memory.add([
      obs({ person: "a", topic: "food" }),
      obs({ person: "a", topic: "food" }),
      obs({ person: "a", topic: "music" }),
      obs({ person: "b", topic: "sports" }),
    ]);
    const coverage = await memory.getCoverage("a");
    expect(new Set(coverage)).toEqual(new Set(["food", "music"]));
  });

  test("wipe removes only that person's observations", async () => {
    const memory = new FakeMemory();
    await memory.add([obs({ person: "a" }), obs({ person: "b" })]);
    await memory.wipe("a");
    expect((await memory.getContext("a")).facts).toEqual([]);
    expect((await memory.getContext("b")).facts.length).toBe(1);
  });
});
