import { describe, expect, test } from "bun:test";
import { checkNudges, type NudgeCheckInput } from "../../src/nudge/checker";
import type { DayRow, PersonDayRow } from "../../src/ledger/ledger";

const HOUR = 60 * 60 * 1000;

function day(overrides: Partial<DayRow> = {}): DayRow {
  return {
    id: 1, date: "2026-07-20", prompt_id: "p1", prompt_text: "x",
    state: "dispatched", dispatched_at: "2026-07-20T08:30:00.000Z", resolved_at: null,
    ...overrides,
  };
}

function personDay(overrides: Partial<PersonDayRow> = {}): PersonDayRow {
  return {
    day_id: 1, person: "a", state: "awaiting", response_text: null,
    finalized_at: null, share_sent_at: null, feedback_ask_sent_at: null,
    prompt_id: "p1", prompt_text: "x",
    ...overrides,
  };
}

const dispatchedAt = new Date("2026-07-20T08:30:00.000Z");
const nextDispatchAt = new Date("2026-07-21T08:30:00.000Z"); // 24h later

function baseInput(overrides: Partial<NudgeCheckInput> = {}): NudgeCheckInput {
  return {
    day: day(),
    personA: personDay({ person: "a" }),
    personB: personDay({ person: "b" }),
    now: dispatchedAt,
    nextDispatchAt,
    afterHours: 4,
    beforeDueHours: 4,
    alreadySent: () => false,
    ...overrides,
  };
}

describe("checkNudges: no_response trigger", () => {
  test("fires for both people once neither has answered after afterHours", () => {
    const result = checkNudges(baseInput({ now: new Date(dispatchedAt.getTime() + 4 * HOUR) }));
    expect(result).toContainEqual({ person: "a", trigger: "no_response" });
    expect(result).toContainEqual({ person: "b", trigger: "no_response" });
  });

  test("does not fire before afterHours has elapsed", () => {
    const result = checkNudges(baseInput({ now: new Date(dispatchedAt.getTime() + 3 * HOUR) }));
    expect(result.find((r) => r.trigger === "no_response")).toBeUndefined();
  });

  test("does not fire for a person who already answered", () => {
    const result = checkNudges(
      baseInput({
        personA: personDay({ person: "a", state: "answered" }),
        now: new Date(dispatchedAt.getTime() + 5 * HOUR),
      }),
    );
    expect(result.find((r) => r.person === "a" && r.trigger === "no_response")).toBeUndefined();
  });

  test("does not fire twice (respects alreadySent)", () => {
    const result = checkNudges(
      baseInput({
        now: new Date(dispatchedAt.getTime() + 5 * HOUR),
        alreadySent: (_p, t) => t === "no_response",
      }),
    );
    expect(result.find((r) => r.trigger === "no_response")).toBeUndefined();
  });

  test("does not fire for someone mid-answer (collecting)", () => {
    const result = checkNudges(
      baseInput({
        personA: personDay({ person: "a", state: "collecting" }),
        now: new Date(dispatchedAt.getTime() + 5 * HOUR),
      }),
    );
    expect(result.find((r) => r.person === "a")).toBeUndefined();
  });
});

describe("checkNudges: partner_waiting trigger", () => {
  test("fires for the still-awaiting person once afterHours have passed since the partner answered", () => {
    const partnerAnsweredAt = new Date(dispatchedAt.getTime() + HOUR);
    const result = checkNudges(
      baseInput({
        personB: personDay({ person: "b", state: "answered", finalized_at: partnerAnsweredAt.toISOString() }),
        now: new Date(partnerAnsweredAt.getTime() + 4 * HOUR),
      }),
    );
    expect(result).toContainEqual({ person: "a", trigger: "partner_waiting" });
    expect(result.find((r) => r.person === "b")).toBeUndefined(); // b already answered, never nudged
  });

  test("does not fire before afterHours have passed since the partner's answer", () => {
    const partnerAnsweredAt = new Date(dispatchedAt.getTime() + HOUR);
    const result = checkNudges(
      baseInput({
        personB: personDay({ person: "b", state: "answered", finalized_at: partnerAnsweredAt.toISOString() }),
        now: new Date(partnerAnsweredAt.getTime() + 3 * HOUR),
      }),
    );
    expect(result.find((r) => r.trigger === "partner_waiting")).toBeUndefined();
  });

  test("does not fire if the partner skipped rather than answered (no one is 'waiting')", () => {
    const result = checkNudges(
      baseInput({
        personB: personDay({ person: "b", state: "skipped", finalized_at: dispatchedAt.toISOString() }),
        now: new Date(dispatchedAt.getTime() + 10 * HOUR),
      }),
    );
    expect(result.find((r) => r.trigger === "partner_waiting")).toBeUndefined();
  });

  test("never fires at all if the partner answers so late that the deadline arrives first (edge case)", () => {
    // Partner answers with only 1h left before next dispatch; the 4h-after
    // threshold would land after the day has already rolled over, so this
    // trigger simply never becomes eligible — no special-casing needed,
    // the day moving on supersedes it naturally.
    const partnerAnsweredAt = new Date(nextDispatchAt.getTime() - HOUR);
    const result = checkNudges(
      baseInput({
        personB: personDay({ person: "b", state: "answered", finalized_at: partnerAnsweredAt.toISOString() }),
        now: new Date(nextDispatchAt.getTime() - 1), // still same day, right before rollover
      }),
    );
    expect(result.find((r) => r.trigger === "partner_waiting")).toBeUndefined();
  });

  test("does not fire once alreadySent for that trigger", () => {
    const partnerAnsweredAt = new Date(dispatchedAt.getTime() + HOUR);
    const result = checkNudges(
      baseInput({
        personB: personDay({ person: "b", state: "answered", finalized_at: partnerAnsweredAt.toISOString() }),
        now: new Date(partnerAnsweredAt.getTime() + 5 * HOUR),
        alreadySent: (p, t) => p === "a" && t === "partner_waiting",
      }),
    );
    expect(result.find((r) => r.trigger === "partner_waiting")).toBeUndefined();
  });
});

describe("checkNudges: almost_due trigger", () => {
  test("fires for a still-awaiting person once within beforeDueHours of the next dispatch", () => {
    const result = checkNudges(baseInput({ now: new Date(nextDispatchAt.getTime() - 3 * HOUR) }));
    expect(result).toContainEqual({ person: "a", trigger: "almost_due" });
    expect(result).toContainEqual({ person: "b", trigger: "almost_due" });
  });

  test("does not fire more than beforeDueHours ahead of the deadline", () => {
    const result = checkNudges(baseInput({ now: new Date(nextDispatchAt.getTime() - 5 * HOUR) }));
    expect(result.find((r) => r.trigger === "almost_due")).toBeUndefined();
  });

  test("fires regardless of the partner's state (last call, independent trigger)", () => {
    const result = checkNudges(
      baseInput({
        personB: personDay({ person: "b", state: "skipped" }),
        now: new Date(nextDispatchAt.getTime() - 2 * HOUR),
      }),
    );
    expect(result).toContainEqual({ person: "a", trigger: "almost_due" });
  });

  test("does not fire for someone who already answered or skipped", () => {
    const result = checkNudges(
      baseInput({
        personA: personDay({ person: "a", state: "answered" }),
        now: new Date(nextDispatchAt.getTime() - 2 * HOUR),
      }),
    );
    expect(result.find((r) => r.person === "a")).toBeUndefined();
  });
});

describe("checkNudges: multiple triggers can both fire for the same person on the same day", () => {
  test("no_response earlier, almost_due later — both are eligible independently over time", () => {
    const early = checkNudges(baseInput({ now: new Date(dispatchedAt.getTime() + 4 * HOUR) }));
    expect(early).toContainEqual({ person: "a", trigger: "no_response" });

    // Later, no_response already sent (tracked externally), almost_due now eligible too.
    const late = checkNudges(
      baseInput({
        now: new Date(nextDispatchAt.getTime() - 2 * HOUR),
        alreadySent: (p, t) => p === "a" && t === "no_response",
      }),
    );
    expect(late).toContainEqual({ person: "a", trigger: "almost_due" });
    expect(late.find((r) => r.person === "a" && r.trigger === "no_response")).toBeUndefined();
  });
});

describe("checkNudges: day already resolved", () => {
  test("nothing fires once the day has resolved", () => {
    const result = checkNudges(
      baseInput({
        day: day({ state: "resolved_shared", resolved_at: "t" }),
        now: new Date(nextDispatchAt.getTime() - HOUR),
      }),
    );
    expect(result).toEqual([]);
  });
});
