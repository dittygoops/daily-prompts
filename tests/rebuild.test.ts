import { describe, expect, test } from "bun:test";
import { rebuildMemory } from "../src/rebuild/rebuild";
import { processPending } from "../src/extraction/pipeline";
import { Ledger } from "../src/ledger/ledger";
import { FakeMemory } from "../src/memory/fake";
import type { LlmClient } from "../src/llm/types";

function scriptedLlm(behavior: (userPrompt: string) => string | Promise<string>) {
  const calls: string[] = [];
  const client: LlmClient = {
    async complete(_system, user) {
      calls.push(user);
      return behavior(user);
    },
  };
  return { client, calls };
}

const okResponse = (text: string) =>
  JSON.stringify({ observations: [{ type: "fact", text, topic: "t" }] });

function seedResolvedDay(ledger: Ledger, date: string, promptId: string) {
  const day = ledger.createDay(date, promptId, "x", "t0");
  ledger.finalizeResponse(day.id, "a", `a-${promptId}`, "t1");
  ledger.finalizeResponse(day.id, "b", `b-${promptId}`, "t2");
  ledger.resolveDay(day.id, "resolved_shared", "t3");
  return day;
}

describe("rebuildMemory", () => {
  test("restores the same data as before a wipe, given the same ledger and a deterministic LLM", async () => {
    const ledger = Ledger.open(":memory:");
    seedResolvedDay(ledger, "2026-07-18", "p1");
    const memory = new FakeMemory();
    const { client } = scriptedLlm((u) => okResponse(u.includes("a-p1") ? "about a" : "about b"));

    await processPending({ ledger, llm: client, memory, log: () => {} });
    const before = [...memory.stored].sort((x, y) => x.text.localeCompare(y.text));

    const result = await rebuildMemory({ ledger, llm: client, memory, log: () => {} });
    const after = [...memory.stored].sort((x, y) => x.text.localeCompare(y.text));

    expect(result.processed).toBe(2);
    expect(result.failed).toBe(0);
    expect(after).toEqual(before);
  });

  test("after a prompt/code change, rebuild produces updated observations without duplicating old ones", async () => {
    const ledger = Ledger.open(":memory:");
    seedResolvedDay(ledger, "2026-07-18", "p1");
    const memory = new FakeMemory();
    const { client: v1 } = scriptedLlm(() => okResponse("old fact"));
    await processPending({ ledger, llm: v1, memory, log: () => {} });

    const { client: v2 } = scriptedLlm(() => okResponse("new fact"));
    await rebuildMemory({ ledger, llm: v2, memory, log: () => {} });

    expect(memory.stored.filter((o) => o.text === "new fact").length).toBe(2); // one per person
    expect(memory.stored.filter((o) => o.text === "old fact").length).toBe(0);
  });

  test("rebuilding a single person doesn't touch the other person's data or extraction bookkeeping", async () => {
    const ledger = Ledger.open(":memory:");
    const day = seedResolvedDay(ledger, "2026-07-18", "p1");
    const memory = new FakeMemory();
    const { client: v1 } = scriptedLlm(() => okResponse("v1"));
    await processPending({ ledger, llm: v1, memory, log: () => {} });

    const bBefore = [...memory.stored.filter((o) => o.person === "b")];
    const bExtractionBefore = ledger.extractionFor(day.id, "b");

    const { client: v2 } = scriptedLlm(() => okResponse("rebuilt-a"));
    await rebuildMemory({ ledger, llm: v2, memory, log: () => {} }, { person: "a" });

    expect(memory.stored.filter((o) => o.person === "b")).toEqual(bBefore);
    expect(ledger.extractionFor(day.id, "b")).toEqual(bExtractionBefore);
    expect(memory.stored.filter((o) => o.person === "a").every((o) => o.text === "rebuilt-a")).toBe(true);
  });

  test("rebuilding an empty ledger is a no-op that still wipes both people, without erroring", async () => {
    const ledger = Ledger.open(":memory:");
    const memory = new FakeMemory();
    const wipedCalls: string[] = [];
    const spiedMemory = {
      add: memory.add.bind(memory),
      getContext: memory.getContext.bind(memory),
      getCoverage: memory.getCoverage.bind(memory),
      wipe: async (p: "a" | "b") => {
        wipedCalls.push(p);
        await memory.wipe(p);
      },
    };
    const { client } = scriptedLlm(() => okResponse("x"));

    const result = await rebuildMemory({ ledger, llm: client, memory: spiedMemory, log: () => {} });
    expect(result).toEqual({ peopleWiped: ["a", "b"], processed: 0, failed: 0 });
    expect(wipedCalls.sort()).toEqual(["a", "b"]);
  });

  test("dry-run makes no changes at all", async () => {
    const ledger = Ledger.open(":memory:");
    const day = seedResolvedDay(ledger, "2026-07-18", "p1");
    const memory = new FakeMemory();
    const { client } = scriptedLlm(() => okResponse("v1"));
    await processPending({ ledger, llm: client, memory, log: () => {} });
    const storedBefore = [...memory.stored];
    const extractionBefore = ledger.extractionFor(day.id, "a");

    let wipeCalls = 0;
    const spiedMemory = {
      add: memory.add.bind(memory),
      getContext: memory.getContext.bind(memory),
      getCoverage: memory.getCoverage.bind(memory),
      wipe: async (_p: "a" | "b") => { wipeCalls++; },
    };

    const result = await rebuildMemory({ ledger, llm: client, memory: spiedMemory, log: () => {} }, { dryRun: true });
    expect(result).toEqual({ peopleWiped: [], processed: 0, failed: 0 });
    expect(wipeCalls).toBe(0);
    expect(memory.stored).toEqual(storedBefore);
    expect(ledger.extractionFor(day.id, "a")).toEqual(extractionBefore);
  });

  test("a partial failure during reprocess is isolated and reported, wipe/clear still happened", async () => {
    const ledger = Ledger.open(":memory:");
    const day = seedResolvedDay(ledger, "2026-07-18", "p1");
    const memory = new FakeMemory();
    const { client } = scriptedLlm((u) => {
      if (u.includes("a-p1")) throw new Error("boom");
      return okResponse("ok");
    });

    const result = await rebuildMemory({ ledger, llm: client, memory, log: () => {} });
    expect(result.failed).toBe(1);
    expect(result.processed).toBe(1);
    expect(ledger.extractionFor(day.id, "a")).toMatchObject({ status: "failed" });
    expect(ledger.extractionFor(day.id, "b")).toMatchObject({ status: "done" });
  });
});
