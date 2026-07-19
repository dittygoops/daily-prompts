import { describe, expect, test } from "bun:test";
import {
  DayMachine,
  type Effect,
  type MachineState,
} from "../src/engine/stateMachine";

const machine = new DayMachine({
  names: { a: "Alex", b: "Sam" },
});

const prompt = { id: "p1", text: "What's your ideal breakfast?" };

function dispatch(state: MachineState = { day: null }) {
  return machine.step(state, {
    type: "DispatchDue",
    date: "2026-07-17",
    at: "t0",
    prompt,
  });
}

function inbound(state: MachineState, person: "a" | "b", text: string, at = "t") {
  return machine.step(state, { type: "InboundText", person, text, at });
}

function settle(state: MachineState, person: "a" | "b", at = "t") {
  return machine.step(state, { type: "SettleElapsed", person, at });
}

const sends = (effects: Effect[]) =>
  effects.filter((e): e is Extract<Effect, { type: "Send" }> => e.type === "Send");
const sendKinds = (effects: Effect[], person?: "a" | "b") =>
  sends(effects)
    .filter((e) => !person || e.person === person)
    .map((e) => e.kind);
const has = (effects: Effect[], type: Effect["type"]) =>
  effects.some((e) => e.type === type);

describe("dispatch", () => {
  test("first dispatch creates the day and sends the prompt to both", () => {
    const { state, effects } = dispatch();
    expect(state.day?.date).toBe("2026-07-17");
    expect(has(effects, "CreateDay")).toBe(true);
    expect(sendKinds(effects, "a")).toEqual(["prompt"]);
    expect(sendKinds(effects, "b")).toEqual(["prompt"]);
  });

  test("the prompt message mentions SKIP", () => {
    const { effects } = dispatch();
    const promptSend = sends(effects)[0]!;
    expect(promptSend.text).toContain("What's your ideal breakfast?");
    expect(promptSend.text.toUpperCase()).toContain("SKIP");
  });

  test("duplicate DispatchDue for the same date is a no-op", () => {
    const { state } = dispatch();
    const second = machine.step(state, {
      type: "DispatchDue",
      date: "2026-07-17",
      at: "t1",
      prompt,
    });
    expect(second.effects).toEqual([]);
  });

  test("next dispatch expires an unanswered day silently", () => {
    const { state } = dispatch();
    const next = machine.step(state, {
      type: "DispatchDue",
      date: "2026-07-18",
      at: "t9",
      prompt: { id: "p2", text: "Best meal this month?" },
    });
    const resolve = next.effects.find((e) => e.type === "ResolveDay");
    expect(resolve).toEqual({ type: "ResolveDay", state: "expired", at: "t9" });
    expect(next.state.day?.date).toBe("2026-07-18");
  });

  test("next dispatch resolves a one-answer day as partial with no extra messaging", () => {
    let s = dispatch().state;
    s = inbound(s, "a", "pancakes").state;
    s = settle(s, "a").state;
    const next = machine.step(s, {
      type: "DispatchDue",
      date: "2026-07-18",
      at: "t9",
      prompt: { id: "p2", text: "x" },
    });
    const resolve = next.effects.find((e) => e.type === "ResolveDay");
    expect(resolve).toMatchObject({ state: "resolved_partial" });
    // no share/skip notices at expiry, only the new day's prompts
    expect(sendKinds(next.effects)).toEqual(["prompt", "prompt"]);
  });
});

describe("answering", () => {
  test("first text moves person to collecting and starts the settle timer", () => {
    const { state } = dispatch();
    const r = inbound(state, "a", "pancakes");
    expect(r.state.day?.persons.a.state).toBe("collecting");
    expect(has(r.effects, "StartSettle")).toBe(true);
    expect(r.effects).toContainEqual({
      type: "RecordInbound",
      person: "a",
      kind: "answer_part",
      text: "pancakes",
      at: "t",
    });
  });

  test("subsequent texts append parts and reset the settle timer", () => {
    let r = dispatch();
    r = inbound(r.state, "a", "pancakes");
    r = inbound(r.state, "a", "with maple syrup");
    expect(r.state.day?.persons.a.parts).toEqual(["pancakes", "with maple syrup"]);
    expect(has(r.effects, "StartSettle")).toBe(true);
  });

  test("settle finalizes the bundle; first responder gets waiting notice + feedback ask", () => {
    let r = dispatch();
    r = inbound(r.state, "a", "pancakes");
    r = inbound(r.state, "a", "with maple syrup");
    r = settle(r.state, "a");
    expect(r.state.day?.persons.a.state).toBe("answered");
    expect(r.effects).toContainEqual({
      type: "FinalizeResponse",
      person: "a",
      text: "pancakes\nwith maple syrup",
      at: "t",
    });
    const kinds = sendKinds(r.effects, "a");
    expect(kinds).toContain("waiting_notice");
    expect(kinds).toContain("feedback_ask");
    const waiting = sends(r.effects).find((e) => e.kind === "waiting_notice")!;
    expect(waiting.text).toContain("Sam");
  });

  test("second responder completes the day: both get verbatim shares, day resolves shared", () => {
    let r = dispatch();
    r = inbound(r.state, "a", "pancakes");
    r = settle(r.state, "a");
    r = inbound(r.state, "b", "chilaquiles");
    r = settle(r.state, "b");
    const shareToA = sends(r.effects).find((e) => e.person === "a" && e.kind === "share")!;
    const shareToB = sends(r.effects).find((e) => e.person === "b" && e.kind === "share")!;
    expect(shareToA.text).toContain("chilaquiles");
    expect(shareToB.text).toContain("pancakes");
    // second responder gets no waiting notice, but does get the feedback ask
    expect(sendKinds(r.effects, "b")).not.toContain("waiting_notice");
    expect(sendKinds(r.effects, "b")).toContain("feedback_ask");
    expect(r.effects.find((e) => e.type === "ResolveDay")).toMatchObject({
      state: "resolved_shared",
    });
  });

  test("settle for an already-answered person is a no-op (idempotency)", () => {
    let r = dispatch();
    r = inbound(r.state, "a", "pancakes");
    r = settle(r.state, "a");
    const again = settle(r.state, "a");
    expect(again.effects).toEqual([]);
  });
});

describe("SKIP", () => {
  test("literal SKIP (any case, surrounding whitespace) while awaiting skips", () => {
    for (const text of ["SKIP", "skip", "  Skip  "]) {
      const r0 = dispatch();
      const r = inbound(r0.state, "b", text);
      expect(r.state.day?.persons.b.state).toBe("skipped");
      expect(has(r.effects, "MarkSkipped")).toBe(true);
    }
  });

  test("'skip this one please' is an answer, not a skip", () => {
    const r0 = dispatch();
    const r = inbound(r0.state, "b", "skip this one please");
    expect(r.state.day?.persons.b.state).toBe("collecting");
  });

  test("SKIP mid-collection discards parts and skips", () => {
    let r = dispatch();
    r = inbound(r.state, "a", "hmm");
    r = inbound(r.state, "a", "SKIP");
    expect(r.state.day?.persons.a.state).toBe("skipped");
  });

  test("skipper gets an ack; nothing else until partner finishes", () => {
    const r = inbound(dispatch().state, "b", "SKIP");
    expect(sendKinds(r.effects, "b")).toEqual(["skip_ack"]);
    expect(sendKinds(r.effects, "a")).toEqual([]);
  });

  test("answer after partner skipped: answerer gets skip notice, never a share; skipper gets nothing; day resolves skipped", () => {
    let r = dispatch();
    r = inbound(r.state, "b", "SKIP");
    r = inbound(r.state, "a", "pancakes");
    r = settle(r.state, "a");
    const aKinds = sendKinds(r.effects, "a");
    expect(aKinds).toContain("skip_notice");
    expect(aKinds).toContain("feedback_ask");
    expect(aKinds).not.toContain("share");
    expect(sendKinds(r.effects, "b")).toEqual([]);
    expect(r.effects.find((e) => e.type === "ResolveDay")).toMatchObject({
      state: "resolved_skipped",
    });
    const notice = sends(r.effects).find((e) => e.kind === "skip_notice")!;
    expect(notice.text).toContain("Sam");
  });

  test("skip after partner answered: answerer notified immediately", () => {
    let r = dispatch();
    r = inbound(r.state, "a", "pancakes");
    r = settle(r.state, "a");
    r = inbound(r.state, "b", "SKIP");
    expect(sendKinds(r.effects, "a")).toContain("skip_notice");
    expect(sendKinds(r.effects, "b")).toContain("skip_ack");
    expect(r.effects.find((e) => e.type === "ResolveDay")).toMatchObject({
      state: "resolved_skipped",
    });
  });

  test("both skip: both informed, day resolves skipped", () => {
    let r = dispatch();
    r = inbound(r.state, "a", "SKIP");
    r = inbound(r.state, "b", "SKIP");
    expect(sendKinds(r.effects, "a")).toContain("skip_notice");
    expect(sendKinds(r.effects, "b")).toContain("skip_ack");
    expect(r.effects.find((e) => e.type === "ResolveDay")).toMatchObject({
      state: "resolved_skipped",
    });
  });
});

describe("feedback window", () => {
  test("texts after answering are recorded as feedback, no reply sent", () => {
    let r = dispatch();
    r = inbound(r.state, "a", "pancakes");
    r = settle(r.state, "a");
    r = inbound(r.state, "a", "fun one today!");
    expect(r.effects).toEqual([
      { type: "RecordInbound", person: "a", kind: "feedback", text: "fun one today!", at: "t" },
    ]);
  });

  test("texts after the share still count as feedback", () => {
    let r = dispatch();
    r = inbound(r.state, "a", "pancakes");
    r = settle(r.state, "a");
    r = inbound(r.state, "b", "chilaquiles");
    r = settle(r.state, "b");
    r = inbound(r.state, "b", "more like this please");
    expect(r.effects).toEqual([
      { type: "RecordInbound", person: "b", kind: "feedback", text: "more like this please", at: "t" },
    ]);
  });

  test("a skipper's texts get one out-of-band reply, not feedback", () => {
    let r = dispatch();
    r = inbound(r.state, "b", "SKIP");
    r = inbound(r.state, "b", "actually how does this work");
    expect(r.effects).toContainEqual({
      type: "RecordInbound",
      person: "b",
      kind: "oob_in",
      text: "actually how does this work",
      at: "t",
    });
    expect(sendKinds(r.effects, "b")).toEqual(["oob_reply"]);
  });
});

describe("no open day", () => {
  test("inbound with no day ever gets oob reply", () => {
    const r = machine.step({ day: null }, { type: "InboundText", person: "a", text: "hi", at: "t" });
    expect(sendKinds(r.effects, "a")).toEqual(["oob_reply"]);
    expect(r.effects).toContainEqual({
      type: "RecordInbound",
      person: "a",
      kind: "oob_in",
      text: "hi",
      at: "t",
    });
  });
});
