import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger/ledger";

let ledger: Ledger;

beforeEach(() => {
  ledger = Ledger.open(":memory:");
});

describe("schema migration", () => {
  // CREATE TABLE IF NOT EXISTS silently skips an existing table, so a column
  // added to schema.sql never reaches a ledger that already exists. The live
  // production ledger is exactly that case.
  test("adds the stance column to a generation_log created before it existed", () => {
    const path = join(tmpdir(), `daily-prompts-migration-${Date.now()}.db`);
    try {
      const old = new Database(path, { create: true, strict: true });
      old.exec(`CREATE TABLE generation_log (
        id INTEGER PRIMARY KEY, date TEXT NOT NULL, prompt_id TEXT, prompt_text TEXT,
        model TEXT, system_prompt TEXT, user_prompt TEXT, raw_response TEXT,
        rationale TEXT, fell_back INTEGER NOT NULL DEFAULT 0, fallback_reason TEXT, at TEXT NOT NULL)`);
      old.exec(`INSERT INTO generation_log (date, prompt_text, fell_back, at) VALUES ('2026-07-18', 'pre-existing', 0, 't')`);
      old.close();

      const migrated = Ledger.open(path);
      const rows = migrated.generationLogFor("2026-07-18");
      expect(rows[0]!.promptText).toBe("pre-existing"); // existing data survives
      expect(rows[0]!.stance).toBeNull();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });
});

describe("per-person prompts", () => {
  test("createDay backfills each person's prompt from the day's prompt", () => {
    // Until the generator produces two prompts, both people share one, so
    // the per-person columns must never be empty for a freshly created day.
    const day = ledger.createDay("2026-07-17", "p1", "shared question", "t");
    expect(ledger.personDay(day.id, "a").prompt_text).toBe("shared question");
    expect(ledger.personDay(day.id, "b").prompt_text).toBe("shared question");
  });

  test("setPersonPrompt stores a different question per person", () => {
    const day = ledger.createDay("2026-07-17", "theme", "a shared theme", "t");
    ledger.setPersonPrompt(day.id, "a", "gen-a", "How is the guitar going?");
    ledger.setPersonPrompt(day.id, "b", "gen-b", "How did the party go?");
    expect(ledger.personDay(day.id, "a").prompt_text).toBe("How is the guitar going?");
    expect(ledger.personDay(day.id, "b").prompt_text).toBe("How did the party go?");
    expect(ledger.personDay(day.id, "a").prompt_id).toBe("gen-a");
  });

  test("a migrated ledger backfills prompts onto rows that predate the columns", () => {
    // person_days rows created before these columns existed would otherwise
    // read null, and every consumer would need a null branch forever.
    const path = join(tmpdir(), `daily-prompts-pp-${Date.now()}.db`);
    try {
      const old = new Database(path, { create: true, strict: true });
      old.exec(`CREATE TABLE days (id INTEGER PRIMARY KEY, date TEXT NOT NULL UNIQUE, prompt_id TEXT NOT NULL,
        prompt_text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'dispatched', dispatched_at TEXT NOT NULL, resolved_at TEXT)`);
      old.exec(`CREATE TABLE person_days (day_id INTEGER NOT NULL, person TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'awaiting',
        response_text TEXT, finalized_at TEXT, share_sent_at TEXT, feedback_ask_sent_at TEXT, PRIMARY KEY (day_id, person))`);
      old.exec(`INSERT INTO days (id,date,prompt_id,prompt_text,state,dispatched_at) VALUES (1,'2026-07-18','p9','legacy question','resolved_shared','t')`);
      old.exec(`INSERT INTO person_days (day_id,person,state) VALUES (1,'a','answered'),(1,'b','answered')`);
      old.close();

      const migrated = Ledger.open(path);
      expect(migrated.personDay(1, "a").prompt_text).toBe("legacy question");
      expect(migrated.personDay(1, "b").prompt_text).toBe("legacy question");
      expect(migrated.personDay(1, "a").state).toBe("answered"); // existing data survives
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });

  test("generation_log rows are attributable to a person", () => {
    ledger.recordGeneration({
      date: "2026-07-18", promptId: "gen-a", promptText: "How is the guitar going?",
      model: "m", systemPrompt: "s", userPrompt: "u", rawResponse: "{}",
      rationale: "r", stance: "exploit", person: "a", topic: null,
      fellBack: false, fallbackReason: null, at: "t",
    });
    expect(ledger.generationLogFor("2026-07-18")[0]!.person).toBe("a");
  });

  test("a fallback generation row has no person, since neither got a tailored prompt", () => {
    ledger.recordGeneration({
      date: "2026-07-18", promptId: null, promptText: null,
      model: null, systemPrompt: null, userPrompt: null, rawResponse: null,
      rationale: null, stance: null, person: null, topic: null,
      fellBack: true, fallbackReason: "LLM outage", at: "t",
    });
    expect(ledger.generationLogFor("2026-07-18")[0]!.person).toBeNull();
  });
});

describe("prompt scores", () => {
  const gen = (date: string, text: string | null, fellBack = false) => ({
    date, promptId: text ? `gen-${date}` : null, promptText: text,
    model: "m", systemPrompt: "s", userPrompt: "u", rawResponse: "{}",
    rationale: "r", stance: "explore", person: null, topic: null, fellBack, fallbackReason: null, at: "t",
  });

  test("a generated prompt with no score row is pending", () => {
    ledger.recordGeneration(gen("2026-07-18", "What's a small win?"));
    expect(ledger.unscoredGenerations().map((r) => r.date)).toEqual(["2026-07-18"]);
  });

  test("fallback rows are never scored, since the static bank has its own baseline", () => {
    ledger.recordGeneration(gen("2026-07-18", null, true));
    expect(ledger.unscoredGenerations()).toEqual([]);
  });

  test("recording a score removes it from the pending list and round-trips", () => {
    ledger.recordGeneration(gen("2026-07-18", "What's a small win?"));
    const pending = ledger.unscoredGenerations()[0]!;
    ledger.recordPromptScore({
      generationId: pending.id, date: pending.date,
      answerable: true, singleQuestion: true, appropriateLength: true, emotionallySafe: false,
      passedAll: false, failureReasons: "emotionallySafe: too pointed", model: "judge-model", at: "t2",
    });
    expect(ledger.unscoredGenerations()).toEqual([]);
    const scores = ledger.promptScores();
    expect(scores.length).toBe(1);
    expect(scores[0]).toMatchObject({ date: "2026-07-18", emotionallySafe: false, passedAll: false });
  });

  test("scoring is idempotent per generation, so a re-run cannot double-count", () => {
    ledger.recordGeneration(gen("2026-07-18", "What's a small win?"));
    const pending = ledger.unscoredGenerations()[0]!;
    const score = {
      generationId: pending.id, date: pending.date,
      answerable: true, singleQuestion: true, appropriateLength: true, emotionallySafe: true,
      passedAll: true, failureReasons: null, model: "judge-model", at: "t2",
    };
    ledger.recordPromptScore(score);
    ledger.recordPromptScore(score);
    expect(ledger.promptScores().length).toBe(1);
  });
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
  test("round-trips the generator's declared stance", () => {
    ledger.recordGeneration({
      date: "2026-07-18", promptId: "gen-2026-07-18", promptText: "How did the defense go?",
      model: "m", systemPrompt: "sys", userPrompt: "usr", rawResponse: "{}",
      rationale: "following up on the thesis thread", stance: "exploit", person: null, topic: null,
      fellBack: false, fallbackReason: null, at: "t",
    });
    expect(ledger.generationLogFor("2026-07-18")[0]!.stance).toBe("exploit");
  });

  test("a fallback row has no stance, since no generator ran", () => {
    ledger.recordGeneration({
      date: "2026-07-18", promptId: null, promptText: null,
      model: null, systemPrompt: null, userPrompt: null, rawResponse: null,
      rationale: null, stance: null, person: null, topic: null,
      fellBack: true, fallbackReason: "LLM outage", at: "t",
    });
    expect(ledger.generationLogFor("2026-07-18")[0]!.stance).toBeNull();
  });

  test("recordGeneration + generationLogFor round-trips a success-path row", () => {
    ledger.recordGeneration({
      date: "2026-07-18", promptId: "gen-2026-07-18", promptText: "What's on your mind?",
      model: "google/gemini-2.5-flash", systemPrompt: "sys", userPrompt: "usr",
      rawResponse: '{"prompt":"..."}', rationale: "exploit thesis thread",
      stance: null, person: null, topic: null,
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
      stance: null, person: null, topic: null,
      fellBack: true, fallbackReason: "LLM outage", at: "t",
    });
    const rows = ledger.generationLogFor("2026-07-18");
    expect(rows[0]).toMatchObject({ fellBack: true, fallbackReason: "LLM outage", model: null });
  });

  test("allGenerationLog returns every row across dates, oldest first", () => {
    const entry = (date: string, promptText: string) => ({
      date, promptId: `gen-${date}`, promptText,
      model: "m", systemPrompt: "sys", userPrompt: "usr", rawResponse: "{}",
      rationale: "r", stance: null, person: null, topic: null, fellBack: false, fallbackReason: null, at: `${date}T08:00:00Z`,
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
      rationale: "r", stance: null, person: null, topic: null, fellBack: false, fallbackReason: null, at: "t1",
    });
    ledger.recordGeneration({
      date: "2026-07-19", promptId: null, promptText: null,
      model: null, systemPrompt: null, userPrompt: null, rawResponse: null, rationale: null,
      stance: null, person: null, topic: null,
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

describe("per-person prompt history for novelty", () => {
  test("returns only that person's own prior questions, oldest first", () => {
    for (const [date, aq, bq] of [
      ["2026-07-18", "a-one", "b-one"],
      ["2026-07-19", "a-two", "b-two"],
      ["2026-07-20", "a-three", "b-three"],
    ] as const) {
      const day = ledger.createDay(date, "theme", "theme text", "t");
      ledger.setPersonPrompt(day.id, "a", `g-${date}-a`, aq);
      ledger.setPersonPrompt(day.id, "b", `g-${date}-b`, bq);
    }
    // Comparing a question against the day-level theme, or against the
    // partner's question, measures the wrong thing entirely.
    expect(ledger.personPromptsBefore("2026-07-20", "a")).toEqual(["a-one", "a-two"]);
    expect(ledger.personPromptsBefore("2026-07-20", "b")).toEqual(["b-one", "b-two"]);
  });

  test("excludes the date itself, so a prompt never compares against itself", () => {
    const day = ledger.createDay("2026-07-18", "t", "t", "t");
    ledger.setPersonPrompt(day.id, "a", "g", "only question");
    expect(ledger.personPromptsBefore("2026-07-18", "a")).toEqual([]);
  });
});

describe("animal image recency", () => {
  test("returns [] on a fresh ledger", () => {
    expect(ledger.recentAnimalImageIds(5)).toEqual([]);
  });

  test("newest first, skips days with no image, respects the limit", () => {
    const d1 = ledger.createDay("2026-07-17", "p1", "x", "t");
    const d2 = ledger.createDay("2026-07-18", "p2", "x", "t");
    const d3 = ledger.createDay("2026-07-19", "p3", "x", "t");
    const d4 = ledger.createDay("2026-07-20", "p4", "x", "t");
    ledger.setDayAnimalImage(d1.id, "cataas:sha256-aaa");
    // d2 gets no image: fetch disabled or failed that day.
    ledger.setDayAnimalImage(d3.id, "cataas:sha256-ccc");
    ledger.setDayAnimalImage(d4.id, "cataas:sha256-ddd");
    void d2;

    expect(ledger.recentAnimalImageIds(10)).toEqual([
      "cataas:sha256-ddd",
      "cataas:sha256-ccc",
      "cataas:sha256-aaa",
    ]);
    expect(ledger.recentAnimalImageIds(2)).toEqual(["cataas:sha256-ddd", "cataas:sha256-ccc"]);
  });

  test("setDayAnimalImage is idempotent: last write wins, still one entry", () => {
    const day = ledger.createDay("2026-07-17", "p1", "x", "t");
    ledger.setDayAnimalImage(day.id, "cataas:sha256-first");
    ledger.setDayAnimalImage(day.id, "cataas:sha256-second");
    expect(ledger.recentAnimalImageIds(10)).toEqual(["cataas:sha256-second"]);
  });

  test("migration adds animal_image_id to a days table created before it existed", () => {
    const path = join(tmpdir(), `daily-prompts-animal-${Date.now()}.db`);
    try {
      const old = new Database(path, { create: true, strict: true });
      old.exec(`CREATE TABLE days (id INTEGER PRIMARY KEY, date TEXT NOT NULL UNIQUE, prompt_id TEXT NOT NULL,
        prompt_text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'dispatched', dispatched_at TEXT, resolved_at TEXT)`);
      old.exec(`INSERT INTO days (date, prompt_id, prompt_text, dispatched_at) VALUES ('2026-07-17','p1','x','t')`);
      old.close();

      const migrated = Ledger.open(path);
      const check = new Database(path, { readonly: true });
      const columns = check.query(`PRAGMA table_info(days)`).all() as { name: string }[];
      check.close();
      expect(columns.some((c) => c.name === "animal_image_id")).toBe(true);
      // Pre-existing rows migrate to null: no backfill value exists for them.
      expect(migrated.recentAnimalImageIds(10)).toEqual([]);
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });
});

describe("day theme", () => {
  test("stores the shared theme separately from the day's label", () => {
    // prompt_text held the theme when there was one and a full question
    // otherwise, so no reader could tell which it was looking at.
    const day = ledger.createDay("2026-07-28", "gen-a", "How is the guitar going?", "t", "looking back");
    expect(ledger.dayForDate("2026-07-28")!.theme).toBe("looking back");
  });

  test("theme is null when the source had none, rather than echoing a question", () => {
    ledger.createDay("2026-07-28", "p1", "What's your favorite meal?", "t");
    expect(ledger.dayForDate("2026-07-28")!.theme).toBeNull();
  });

  test("days predating the column read as having no theme", () => {
    const path = join(tmpdir(), `daily-prompts-theme-${Date.now()}.db`);
    try {
      const old = new Database(path, { create: true, strict: true });
      old.exec(`CREATE TABLE days (id INTEGER PRIMARY KEY, date TEXT NOT NULL UNIQUE, prompt_id TEXT NOT NULL,
        prompt_text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'dispatched', dispatched_at TEXT NOT NULL, resolved_at TEXT)`);
      old.exec(`INSERT INTO days (id,date,prompt_id,prompt_text,dispatched_at) VALUES (1,'2026-07-18','p9','legacy question','t')`);
      old.close();
      const migrated = Ledger.open(path);
      expect(migrated.dayForDate("2026-07-18")!.theme).toBeNull();
      expect(migrated.dayForDate("2026-07-18")!.prompt_text).toBe("legacy question");
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });
});

describe("recent prompt topics", () => {
  const g = (date: string, person: "a" | "b", topic: string) => ({
    date, promptId: `gen-${date}-${person}`, promptText: "q", model: "m",
    systemPrompt: "s", userPrompt: "u", rawResponse: "{}", rationale: "r",
    stance: "explore", person, topic, fellBack: false, fallbackReason: null, at: "t",
  });

  test("returns that person's recent topics, most recent first", () => {
    ledger.recordGeneration(g("2026-07-27", "a", "self-improvement"));
    ledger.recordGeneration(g("2026-07-28", "a", "childhood-food"));
    ledger.recordGeneration(g("2026-07-28", "b", "reading"));
    expect(ledger.recentTopics("a", 5)).toEqual(["childhood-food", "self-improvement"]);
  });

  test("ignores rows with no topic, so pre-feature days do not block anything", () => {
    ledger.recordGeneration({ ...g("2026-07-27", "a", "x"), topic: null });
    expect(ledger.recentTopics("a", 5)).toEqual([]);
  });
});
