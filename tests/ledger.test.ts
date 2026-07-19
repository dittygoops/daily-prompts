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

describe("feedback", () => {
  test("feedback messages are attributable per person and day", () => {
    const day = ledger.createDay("2026-07-17", "p1", "x", "t");
    ledger.recordMessage({ dayId: day.id, person: "a", direction: "in", kind: "feedback", text: "loved it", at: "t" });
    const fb = ledger.messagesForDay(day.id).filter((m) => m.kind === "feedback");
    expect(fb.length).toBe(1);
    expect(fb[0]?.person).toBe("a");
  });
});
