import { beforeEach, describe, expect, test } from "bun:test";
import { Ledger } from "../src/ledger/ledger";

let ledger: Ledger;

beforeEach(() => {
  ledger = Ledger.open(":memory:");
});

describe("days", () => {
  test("createDay starts a dispatched day with both persons awaiting", () => {
    const day = ledger.createDay("2026-07-17", "p1", "What's your favorite thing to cook?", "2026-07-17T08:30:00-07:00");
    expect(day.state).toBe("dispatched");
    expect(ledger.personState(day.id, "a")).toBe("awaiting");
    expect(ledger.personState(day.id, "b")).toBe("awaiting");
  });

  test("one day per date", () => {
    ledger.createDay("2026-07-17", "p1", "x", "t");
    expect(() => ledger.createDay("2026-07-17", "p2", "y", "t")).toThrow();
  });

  test("dayForDate returns the day row for that date, or null if never dispatched", () => {
    const day = ledger.createDay("2026-07-17", "p1", "x", "t");
    expect(ledger.dayForDate("2026-07-17")?.id).toBe(day.id);
    expect(ledger.dayForDate("2026-07-18")).toBeNull();
  });

  test("hasDay reports whether a date was ever dispatched, regardless of state", () => {
    const day = ledger.createDay("2026-07-17", "p1", "x", "t");
    expect(ledger.hasDay("2026-07-17")).toBe(true);
    ledger.resolveDay(day.id, "expired", "t2");
    expect(ledger.hasDay("2026-07-17")).toBe(true);
    expect(ledger.hasDay("2026-07-18")).toBe(false);
  });

  test("openDay returns the latest unresolved day and null after resolution", () => {
    const day = ledger.createDay("2026-07-17", "p1", "x", "t");
    expect(ledger.openDay()?.id).toBe(day.id);
    ledger.resolveDay(day.id, "expired", "2026-07-18T08:30:00-07:00");
    expect(ledger.openDay()).toBeNull();
  });
});

describe("person progression", () => {
  test("collecting -> answered stores the finalized bundle", () => {
    const day = ledger.createDay("2026-07-17", "p1", "x", "t");
    ledger.setCollecting(day.id, "a");
    ledger.finalizeResponse(day.id, "a", "pasta\nactually carbonara", "2026-07-17T09:00:00-07:00");
    expect(ledger.personState(day.id, "a")).toBe("answered");
    expect(ledger.personResponse(day.id, "a")).toBe("pasta\nactually carbonara");
  });

  test("skip is terminal per person", () => {
    const day = ledger.createDay("2026-07-17", "p1", "x", "t");
    ledger.markSkipped(day.id, "b", "2026-07-17T09:00:00-07:00");
    expect(ledger.personState(day.id, "b")).toBe("skipped");
  });

  test("share and feedback-ask timestamps are recorded once", () => {
    const day = ledger.createDay("2026-07-17", "p1", "x", "t");
    ledger.markShareSent(day.id, "a", "2026-07-17T10:00:00-07:00");
    ledger.markFeedbackAskSent(day.id, "a", "2026-07-17T09:01:00-07:00");
    const pd = ledger.personDay(day.id, "a");
    expect(pd.share_sent_at).toBe("2026-07-17T10:00:00-07:00");
    expect(pd.feedback_ask_sent_at).toBe("2026-07-17T09:01:00-07:00");
  });
});

describe("messages", () => {
  test("records inbound and outbound verbatim, queryable by day", () => {
    const day = ledger.createDay("2026-07-17", "p1", "prompt text", "t");
    ledger.recordMessage({ dayId: day.id, person: "a", direction: "out", kind: "prompt", text: "[DP] prompt text", at: "t1" });
    ledger.recordMessage({ dayId: day.id, person: "a", direction: "in", kind: "answer_part", text: "pasta", at: "t2" });
    const msgs = ledger.messagesForDay(day.id);
    expect(msgs.length).toBe(2);
    expect(msgs[1]?.text).toBe("pasta");
  });

  test("unknown-sender messages persist with no person or day", () => {
    ledger.recordMessage({ dayId: null, person: null, direction: "in", kind: "unknown_sender", text: "hi", at: "t" });
    expect(ledger.messagesForDay(null).length).toBe(1);
  });
});

describe("prompt usage", () => {
  test("tracks used prompt ids", () => {
    ledger.markPromptUsed("p1", "2026-07-17");
    ledger.markPromptUsed("p2", "2026-07-18");
    expect(ledger.usedPromptIds()).toEqual(new Set(["p1", "p2"]));
  });
});

describe("extractions", () => {
  test("a day with no extraction rows is unprocessed for both persons", () => {
    const day = ledger.createDay("2026-07-17", "p1", "x", "t");
    ledger.resolveDay(day.id, "resolved_shared", "t2");
    const pending = ledger.unprocessedResolvedDays();
    expect(pending).toEqual([{ dayId: day.id, person: "a" }, { dayId: day.id, person: "b" }]);
  });

  test("markExtraction(done) removes that person from the pending list", () => {
    const day = ledger.createDay("2026-07-17", "p1", "x", "t");
    ledger.resolveDay(day.id, "resolved_shared", "t2");
    ledger.markExtraction(day.id, "a", "done", 3, "t3");
    expect(ledger.unprocessedResolvedDays()).toEqual([{ dayId: day.id, person: "b" }]);
    expect(ledger.extractionFor(day.id, "a")).toMatchObject({ status: "done", attempts: 1, observationCount: 3 });
  });

  test("markExtraction(failed) increments attempts and stays pending until the retry cap", () => {
    const day = ledger.createDay("2026-07-17", "p1", "x", "t");
    ledger.resolveDay(day.id, "resolved_shared", "t2");
    ledger.markExtraction(day.id, "a", "failed", null, "t3");
    expect(ledger.extractionFor(day.id, "a")).toMatchObject({ status: "failed", attempts: 1 });
    expect(ledger.unprocessedResolvedDays().some((p) => p.person === "a" && p.dayId === day.id)).toBe(true);
    ledger.markExtraction(day.id, "a", "failed", null, "t4");
    ledger.markExtraction(day.id, "a", "failed", null, "t5");
    expect(ledger.extractionFor(day.id, "a")?.attempts).toBe(3);
    // 3 attempts is the retry cap: no longer offered as pending.
    expect(ledger.unprocessedResolvedDays().some((p) => p.person === "a" && p.dayId === day.id)).toBe(false);
  });

  test("only resolved/expired days are eligible; a still-open dispatched day is not", () => {
    ledger.createDay("2026-07-17", "p1", "x", "t");
    expect(ledger.unprocessedResolvedDays()).toEqual([]);
  });

  test("clearAllExtractions supports a full rebuild", () => {
    const day = ledger.createDay("2026-07-17", "p1", "x", "t");
    ledger.resolveDay(day.id, "resolved_shared", "t2");
    ledger.markExtraction(day.id, "a", "done", 2, "t3");
    ledger.markExtraction(day.id, "b", "done", 2, "t3");
    ledger.clearAllExtractions();
    expect(ledger.unprocessedResolvedDays()).toEqual([{ dayId: day.id, person: "a" }, { dayId: day.id, person: "b" }]);
  });

  test("unprocessedResolvedDays accepts an optional person filter", () => {
    const day = ledger.createDay("2026-07-17", "p1", "x", "t");
    ledger.resolveDay(day.id, "resolved_shared", "t2");
    expect(ledger.unprocessedResolvedDays("a")).toEqual([{ dayId: day.id, person: "a" }]);
    expect(ledger.unprocessedResolvedDays("b")).toEqual([{ dayId: day.id, person: "b" }]);
  });

  test("clearExtractionsFor only clears the given person's bookkeeping", () => {
    const day = ledger.createDay("2026-07-17", "p1", "x", "t");
    ledger.resolveDay(day.id, "resolved_shared", "t2");
    ledger.markExtraction(day.id, "a", "done", 2, "t3");
    ledger.markExtraction(day.id, "b", "done", 2, "t3");
    ledger.clearExtractionsFor("a");
    expect(ledger.extractionFor(day.id, "a")).toBeNull();
    expect(ledger.extractionFor(day.id, "b")).toMatchObject({ status: "done" });
    expect(ledger.unprocessedResolvedDays()).toEqual([{ dayId: day.id, person: "a" }]);
  });
});

describe("recentDays", () => {
  test("returns days strictly before the given date, most-recent first, capped at limit", () => {
    ledger.createDay("2026-07-15", "p1", "a", "t");
    ledger.createDay("2026-07-16", "p2", "b", "t");
    ledger.createDay("2026-07-17", "p3", "c", "t");
    const recent = ledger.recentDays("2026-07-17", 2);
    expect(recent.map((d) => d.date)).toEqual(["2026-07-16", "2026-07-15"]);
  });

  test("excludes the day matching the given date itself", () => {
    ledger.createDay("2026-07-17", "p1", "x", "t");
    expect(ledger.recentDays("2026-07-17", 10)).toEqual([]);
  });
});

describe("feedbackSince", () => {
  test("returns feedback messages on/after the cutoff date, tagged with person and date", () => {
    const day1 = ledger.createDay("2026-07-15", "p1", "x", "t");
    ledger.recordMessage({ dayId: day1.id, person: "a", direction: "in", kind: "feedback", text: "old", at: "t" });
    const day2 = ledger.createDay("2026-07-18", "p2", "y", "t");
    ledger.recordMessage({ dayId: day2.id, person: "b", direction: "in", kind: "feedback", text: "new", at: "t" });
    const fb = ledger.feedbackSince("2026-07-17");
    expect(fb).toEqual([{ date: "2026-07-18", person: "b", text: "new" }]);
  });

  test("excludes non-feedback message kinds", () => {
    const day = ledger.createDay("2026-07-18", "p1", "x", "t");
    ledger.recordMessage({ dayId: day.id, person: "a", direction: "in", kind: "answer_part", text: "not feedback", at: "t" });
    expect(ledger.feedbackSince("2026-07-01")).toEqual([]);
  });
});

describe("generation_log", () => {
  test("recordGeneration + generationLogFor round-trips a success-path row", () => {
    ledger.recordGeneration({
      date: "2026-07-18", promptId: "gen-2026-07-18", promptText: "What's on your mind?",
      model: "google/gemini-2.5-flash", systemPrompt: "sys", userPrompt: "usr",
      rawResponse: '{"prompt":"..."}', rationale: "exploit thesis thread",
      fellBack: false, fallbackReason: null, at: "t",
    });
    const rows = ledger.generationLogFor("2026-07-18");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ fellBack: false, model: "google/gemini-2.5-flash", rationale: "exploit thesis thread" });
  });

  test("recordGeneration + generationLogFor round-trips a fallback-path row", () => {
    ledger.recordGeneration({
      date: "2026-07-18", promptId: null, promptText: null,
      model: null, systemPrompt: null, userPrompt: null,
      rawResponse: null, rationale: null,
      fellBack: true, fallbackReason: "LLM outage", at: "t",
    });
    const rows = ledger.generationLogFor("2026-07-18");
    expect(rows[0]).toMatchObject({ fellBack: true, fallbackReason: "LLM outage", model: null });
  });

  test("allGenerationLog returns every row across dates, oldest first", () => {
    const entry = (date: string, promptText: string) => ({
      date, promptId: `gen-${date}`, promptText,
      model: "m", systemPrompt: "sys", userPrompt: "usr", rawResponse: "{}",
      rationale: "r", fellBack: false, fallbackReason: null, at: `${date}T08:00:00Z`,
    });
    ledger.recordGeneration(entry("2026-07-20", "third"));
    ledger.recordGeneration(entry("2026-07-18", "first"));
    ledger.recordGeneration(entry("2026-07-19", "second"));
    expect(ledger.allGenerationLog().map((r) => r.promptText)).toEqual(["first", "second", "third"]);
  });

  test("allGenerationLog includes fallback rows alongside successful ones", () => {
    ledger.recordGeneration({
      date: "2026-07-18", promptId: "gen-2026-07-18", promptText: "ok",
      model: "m", systemPrompt: "sys", userPrompt: "usr", rawResponse: "{}",
      rationale: "r", fellBack: false, fallbackReason: null, at: "t1",
    });
    ledger.recordGeneration({
      date: "2026-07-19", promptId: null, promptText: null,
      model: null, systemPrompt: null, userPrompt: null, rawResponse: null, rationale: null,
      fellBack: true, fallbackReason: "LLM outage", at: "t2",
    });
    expect(ledger.allGenerationLog().map((r) => r.fellBack)).toEqual([false, true]);
  });

  test("allGenerationLog is empty on a fresh ledger", () => {
    expect(ledger.allGenerationLog()).toEqual([]);
  });
});

describe("prompt_ideas", () => {
  test("addPromptIdea + unconsumedPromptIdeas round-trips an idea for that person only", () => {
    const day = ledger.createDay("2026-07-18", "p1", "x", "t");
    ledger.addPromptIdea("a", "ask about our trip", day.id, "t1");
    ledger.addPromptIdea("b", "ask about work", day.id, "t2");
    const aIdeas = ledger.unconsumedPromptIdeas("a");
    expect(aIdeas.length).toBe(1);
    expect(aIdeas[0]).toMatchObject({ person: "a", text: "ask about our trip" });
  });

  test("markPromptIdeaUsed removes it from unconsumed", () => {
    const day = ledger.createDay("2026-07-18", "p1", "x", "t");
    const id = ledger.addPromptIdea("a", "ask about our trip", day.id, "t1");
    ledger.markPromptIdeaUsed(id, day.id, "t2");
    expect(ledger.unconsumedPromptIdeas("a")).toEqual([]);
  });
});

describe("daysInRange", () => {
  test("returns only days within the inclusive bounds, ordered by date", () => {
    ledger.createDay("2026-07-15", "p1", "x", "t");
    ledger.createDay("2026-07-17", "p2", "y", "t");
    ledger.createDay("2026-07-19", "p3", "z", "t");
    ledger.createDay("2026-07-21", "p4", "w", "t");
    const rows = ledger.daysInRange("2026-07-16", "2026-07-20");
    expect(rows.map((d) => d.date)).toEqual(["2026-07-17", "2026-07-19"]);
  });

  test("boundary days are included (inclusive on both ends)", () => {
    ledger.createDay("2026-07-15", "p1", "x", "t");
    ledger.createDay("2026-07-21", "p2", "y", "t");
    const rows = ledger.daysInRange("2026-07-15", "2026-07-21");
    expect(rows.map((d) => d.date)).toEqual(["2026-07-15", "2026-07-21"]);
  });
});

describe("recap_log", () => {
  test("hasRecapFor is false before recording, true after, for the exact week_start", () => {
    expect(ledger.hasRecapFor("2026-07-13")).toBe(false);
    ledger.recordRecap({
      weekStart: "2026-07-13", weekEnd: "2026-07-19", recapText: "This week: 5/7 answered.",
      model: null, systemPrompt: null, userPrompt: null, rawResponse: null,
      fellBack: false, fallbackReason: null, at: "t",
    });
    expect(ledger.hasRecapFor("2026-07-13")).toBe(true);
    expect(ledger.hasRecapFor("2026-07-20")).toBe(false);
  });
});

describe("nudges", () => {
  test("hasNudgeBeenSent is false before recording, true after, scoped to the exact trigger", () => {
    const day = ledger.createDay("2026-07-20", "p1", "x", "t");
    expect(ledger.hasNudgeBeenSent(day.id, "a", "no_response")).toBe(false);
    ledger.recordNudgeSent(day.id, "a", "no_response", "t1");
    expect(ledger.hasNudgeBeenSent(day.id, "a", "no_response")).toBe(true);
    expect(ledger.hasNudgeBeenSent(day.id, "a", "partner_waiting")).toBe(false);
    expect(ledger.hasNudgeBeenSent(day.id, "b", "no_response")).toBe(false);
  });

  test("recording the same (day, person, trigger) twice does not throw", () => {
    const day = ledger.createDay("2026-07-20", "p1", "x", "t");
    ledger.recordNudgeSent(day.id, "a", "almost_due", "t1");
    expect(() => ledger.recordNudgeSent(day.id, "a", "almost_due", "t2")).not.toThrow();
  });
});

describe("feedback", () => {
  test("feedback messages are attributable per person and day", () => {
    const day = ledger.createDay("2026-07-17", "p1", "x", "t");
    ledger.recordMessage({ dayId: day.id, person: "a", direction: "in", kind: "feedback", text: "loved it", at: "t" });
    const fb = ledger.messagesForDay(day.id).filter((m) => m.kind === "feedback");
    expect(fb.length).toBe(1);
    expect(fb[0]?.person).toBe("a");
  });
});
