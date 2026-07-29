import { beforeEach, describe, expect, test } from "bun:test";
import { Ledger } from "../../src/ledger/ledger";

let ledger: Ledger;

beforeEach(() => {
  ledger = Ledger.open(":memory:");
});

const gen = (date: string, person: "a" | "b", targetNodeId: number | null) => ({
  date, promptId: `gen-${date}-${person}`, promptText: "q", model: "m",
  systemPrompt: "s", userPrompt: "u", rawResponse: "{}", rationale: "r",
  stance: "exploit", person, topic: null, targetNodeId, targetDomain: null,
  fellBack: false, fallbackReason: null, at: "t",
});

describe("nodes", () => {
  test("createNode + nodesFor round-trips", () => {
    const id = ledger.createNode({
      person: "a", domain: "hobbies-interests", subdomain: "guitar",
      summary: "Learning guitar, wants to street-perform.", eventDate: null, at: "t",
    });
    const nodes = ledger.nodesFor("a");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ id, subdomain: "guitar", status: "open", timesAsked: 0 });
  });

  test("the same subdomain cannot exist twice for one person, even under different domains", () => {
    // The real car answer produced daily-life/transportation,
    // plans-future/car-2027 and family/family-car as three legal nodes under
    // a per-domain key. A subject has one identity per person.
    ledger.createNode({ person: "b", domain: "daily-life", subdomain: "car-2027", summary: "s", eventDate: null, at: "t" });
    expect(() =>
      ledger.createNode({ person: "b", domain: "plans-future", subdomain: "car-2027", summary: "s2", eventDate: null, at: "t" }),
    ).toThrow();
  });

  test("subdomains are normalized before the uniqueness check", () => {
    ledger.createNode({ person: "b", domain: "health-body", subdomain: "fitness-goals", summary: "s", eventDate: null, at: "t" });
    expect(() =>
      ledger.createNode({ person: "b", domain: "health-body", subdomain: "Fitness Goal", summary: "s", eventDate: null, at: "t" }),
    ).toThrow();
  });

  test("a new fact reopens a depleted node", () => {
    const id = ledger.createNode({ person: "a", domain: "daily-life", subdomain: "cooking-sound", summary: "s", eventDate: null, at: "t" });
    ledger.setNodeStatus(id, "depleted", "t2");
    ledger.addNodeFact({ nodeId: id, kind: "fact", text: "Also likes kettle sounds.", sourceDayId: 1, observedDate: "2026-08-01", at: "t3" });
    expect(ledger.nodesFor("a")[0]!.status).toBe("open");
  });

  test("a new fact reopens a closed node", () => {
    const id = ledger.createNode({ person: "b", domain: "relationships-friends", subdomain: "psychic-party", summary: "s", eventDate: "2026-07-26", at: "t" });
    ledger.setNodeStatus(id, "closed", "t2");
    ledger.addNodeFact({ nodeId: id, kind: "fact", text: "Cora's mom mentioned her again.", sourceDayId: 2, observedDate: "2026-08-02", at: "t3" });
    expect(ledger.nodesFor("b")[0]!.status).toBe("open");
  });
});

describe("recordYield", () => {
  function seedDayWithTarget(date: string, nodeId: number) {
    const day = ledger.createDay(date, "p", "theme", "t");
    ledger.recordGeneration(gen(date, "a", nodeId));
    return day;
  }

  test("computes an incremental mean over successive answers and increments times_asked", () => {
    const id = ledger.createNode({ person: "a", domain: "career-academics", subdomain: "job-search", summary: "s", eventDate: null, at: "t" });
    seedDayWithTarget("2026-08-01", id);
    ledger.recordYield("2026-08-01", "a", 400);
    seedDayWithTarget("2026-08-02", id);
    ledger.recordYield("2026-08-02", "a", 200);
    const node = ledger.nodesFor("a")[0]!;
    expect(node.timesAsked).toBe(2);
    expect(node.avgYieldChars).toBe(300);
  });

  test("no-ops when the day had no target node (explore or fallback day)", () => {
    ledger.createNode({ person: "a", domain: "career-academics", subdomain: "job-search", summary: "s", eventDate: null, at: "t" });
    ledger.createDay("2026-08-01", "p", "theme", "t");
    ledger.recordGeneration(gen("2026-08-01", "a", null));
    ledger.recordYield("2026-08-01", "a", 400);
    expect(ledger.nodesFor("a")[0]!.timesAsked).toBe(0);
  });

  test("depletes after two short answers relative to the person's median, not an absolute floor", () => {
    // Person median here is 306 (live person-a value at design time). Two
    // answers of 84 chars average under half of it and deplete; a 342-char
    // answer pattern would not.
    const id = ledger.createNode({ person: "a", domain: "hobbies-interests", subdomain: "dancing", summary: "s", eventDate: null, at: "t" });
    for (const [i, date] of (["2026-08-01", "2026-08-02", "2026-08-03"] as const).entries()) {
      const day = ledger.createDay(date, "p", "theme", "t");
      ledger.finalizeResponse(day.id, "a", "x".repeat(306), "t1"); // builds the median
      if (i < 2) ledger.recordGeneration(gen(date, "a", id));
    }
    ledger.recordYield("2026-08-01", "a", 84);
    expect(ledger.nodesFor("a")[0]!.status).toBe("open"); // one short answer is not evidence
    ledger.recordYield("2026-08-02", "a", 84);
    expect(ledger.nodesFor("a")[0]!.status).toBe("depleted");
  });
});

describe("signals", () => {
  test("moods are windowed, preferences are durable", () => {
    ledger.addSignal({ person: "a", kind: "mood_signal", text: "tired", observedDate: "2026-07-01", at: "t" });
    ledger.addSignal({ person: "a", kind: "mood_signal", text: "upbeat", observedDate: "2026-07-28", at: "t" });
    ledger.addSignal({ person: "a", kind: "prompt_preference", text: "likes short questions", observedDate: "2026-07-01", at: "t" });
    const moods = ledger.recentSignals("a", "mood_signal", 7, "2026-07-29");
    expect(moods.map((s) => s.text)).toEqual(["upbeat"]);
    const prefs = ledger.recentSignals("a", "prompt_preference", null, "2026-07-29");
    expect(prefs.map((s) => s.text)).toEqual(["likes short questions"]);
  });
});

describe("personMedianAnswerChars", () => {
  test("returns the median answer length for that person only", () => {
    for (const [date, len] of [["2026-08-01", 100], ["2026-08-02", 300], ["2026-08-03", 500]] as const) {
      const day = ledger.createDay(date, "p", "t", "t");
      ledger.finalizeResponse(day.id, "a", "x".repeat(len), "t1");
      ledger.finalizeResponse(day.id, "b", "y".repeat(50), "t1");
    }
    expect(ledger.personMedianAnswerChars("a")).toBe(300);
    expect(ledger.personMedianAnswerChars("b")).toBe(50);
  });

  test("returns null with no answers yet", () => {
    expect(ledger.personMedianAnswerChars("a")).toBeNull();
  });
});
