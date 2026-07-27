import type { PersonId } from "../config";
import type { DayState, MessageKind } from "../ledger/ledger";
import * as copy from "./copy";

export interface PromptRef {
  id: string;
  text: string;
}

export type Event =
  | { type: "DispatchDue"; date: string; at: string; prompts: Record<PersonId, PromptRef>; theme: string | null }
  | { type: "InboundText"; person: PersonId; text: string; at: string }
  | { type: "SettleElapsed"; person: PersonId; at: string; generation?: number };

export type Effect =
  | { type: "CreateDay"; date: string; prompts: Record<PersonId, PromptRef>; theme: string | null; at: string }
  | { type: "ResolveDay"; state: Exclude<DayState, "dispatched">; at: string }
  | { type: "Send"; person: PersonId; kind: MessageKind; text: string }
  | { type: "RecordInbound"; person: PersonId; kind: MessageKind; text: string; at: string }
  | { type: "StartSettle"; person: PersonId }
  | { type: "SetCollecting"; person: PersonId }
  | { type: "FinalizeResponse"; person: PersonId; text: string; at: string }
  | { type: "MarkSkipped"; person: PersonId; at: string };

export interface PersonCtx {
  state: "awaiting" | "collecting" | "answered" | "skipped";
  parts: string[];
  response: string | null;
}

export interface DayCtx {
  date: string;
  /** One question per person: a question built from one person's memory is
   * unanswerable by the other, which reached production once. */
  prompts: Record<PersonId, PromptRef>;
  theme: string | null;
  resolved: boolean;
  persons: Record<PersonId, PersonCtx>;
}

export interface MachineState {
  day: DayCtx | null;
}

export interface StepResult {
  state: MachineState;
  effects: Effect[];
}

const partnerOf = (p: PersonId): PersonId => (p === "a" ? "b" : "a");

const isSkip = (text: string) => text.trim().toUpperCase() === "SKIP";

const freshPerson = (): PersonCtx => ({ state: "awaiting", parts: [], response: null });

export class DayMachine {
  constructor(private readonly opts: { names: Record<PersonId, string> }) {}

  step(state: MachineState, event: Event): StepResult {
    switch (event.type) {
      case "DispatchDue":
        return this.onDispatch(state, event);
      case "InboundText":
        return this.onInbound(state, event);
      case "SettleElapsed":
        return this.onSettle(state, event);
    }
  }

  private onDispatch(
    state: MachineState,
    event: Extract<Event, { type: "DispatchDue" }>,
  ): StepResult {
    if (state.day?.date === event.date) return { state, effects: [] };

    const effects: Effect[] = [];

    // Close out the previous day silently (F4: no late messaging).
    if (state.day && !state.day.resolved) {
      const answered = (["a", "b"] as const).some(
        (p) => state.day!.persons[p].state === "answered",
      );
      effects.push({
        type: "ResolveDay",
        state: answered ? "resolved_partial" : "expired",
        at: event.at,
      });
    }

    effects.push({ type: "CreateDay", date: event.date, prompts: event.prompts, theme: event.theme, at: event.at });
    for (const person of ["a", "b"] as const) {
      effects.push({
        type: "Send",
        person,
        kind: "prompt",
        text: copy.promptMessage(event.prompts[person].text),
      });
    }

    return {
      state: {
        day: {
          date: event.date,
          prompts: event.prompts,
          theme: event.theme,
          resolved: false,
          persons: { a: freshPerson(), b: freshPerson() },
        },
      },
      effects,
    };
  }

  private onInbound(
    state: MachineState,
    event: Extract<Event, { type: "InboundText" }>,
  ): StepResult {
    const { person, text, at } = event;
    const day = state.day;

    // No active day at all: out of band.
    if (!day) {
      return {
        state,
        effects: [
          { type: "RecordInbound", person, kind: "oob_in", text, at },
          { type: "Send", person, kind: "oob_reply", text: copy.oobReply() },
        ],
      };
    }

    const me = day.persons[person];

    if (day.resolved || me.state === "answered" || me.state === "skipped") {
      // Post-answer texts are feedback until the next prompt; a skipper (or a
      // resolved-day skipper) without a feedback window gets one canned reply.
      if (me.state === "answered") {
        return {
          state,
          effects: [{ type: "RecordInbound", person, kind: "feedback", text, at }],
        };
      }
      return {
        state,
        effects: [
          { type: "RecordInbound", person, kind: "oob_in", text, at },
          { type: "Send", person, kind: "oob_reply", text: copy.oobReply() },
        ],
      };
    }

    if (isSkip(text)) {
      const next = this.withPerson(day, person, { state: "skipped", parts: [], response: null });
      const term = this.onTerminal(next, person, at);
      const effects: Effect[] = [
        { type: "RecordInbound", person, kind: "skip", text, at },
        { type: "MarkSkipped", person, at },
        { type: "Send", person, kind: "skip_ack", text: copy.skipAck() },
        ...term.effects,
      ];
      return { state: { day: term.resolved ? { ...next, resolved: true } : next }, effects };
    }

    // Answer part (first or subsequent): collect and (re)start the settle timer.
    const next = this.withPerson(day, person, {
      state: "collecting",
      parts: [...me.parts, text],
      response: null,
    });
    const effects: Effect[] = [
      { type: "RecordInbound", person, kind: "answer_part", text, at },
    ];
    if (me.state === "awaiting") effects.push({ type: "SetCollecting", person });
    effects.push({ type: "StartSettle", person });
    return { state: { day: next }, effects };
  }

  private onSettle(
    state: MachineState,
    event: Extract<Event, { type: "SettleElapsed" }>,
  ): StepResult {
    const { person, at } = event;
    const day = state.day;
    if (!day || day.resolved) return { state, effects: [] };
    const me = day.persons[person];
    if (me.state !== "collecting") return { state, effects: [] };

    const response = me.parts.join("\n");
    const next = this.withPerson(day, person, {
      state: "answered",
      parts: me.parts,
      response,
    });
    const term = this.onTerminal(next, person, at);
    const effects: Effect[] = [
      { type: "FinalizeResponse", person, text: response, at },
      ...term.effects,
    ];
    return { state: { day: term.resolved ? { ...next, resolved: true } : next }, effects };
  }

  /** Effects due when `person` just reached a terminal state (answered/skipped).
   * Pure: reports whether the day resolved instead of mutating it. */
  private onTerminal(
    day: DayCtx,
    person: PersonId,
    at: string,
  ): { effects: Effect[]; resolved: boolean } {
    const partner = partnerOf(person);
    const me = day.persons[person];
    const them = day.persons[partner];
    const myName = this.opts.names[person];
    const theirName = this.opts.names[partner];
    const effects: Effect[] = [];
    let resolved = false;

    if (me.state === "answered") {
      if (them.state === "answered") {
        // Day complete: verbatim shares both ways, then feedback ask for the
        // second responder (the first got theirs at their own answer time).
        effects.push({
          type: "Send",
          person: partner,
          kind: "share",
          text: copy.shareMessage(myName, day.prompts[person].text, me.response!),
        });
        effects.push({
          type: "Send",
          person,
          kind: "share",
          text: copy.shareMessage(theirName, day.prompts[partner].text, them.response!),
        });
        effects.push({ type: "Send", person, kind: "feedback_ask", text: copy.feedbackAsk() });
        effects.push({ type: "ResolveDay", state: "resolved_shared", at });
        resolved = true;
      } else if (them.state === "skipped") {
        effects.push({
          type: "Send",
          person,
          kind: "skip_notice",
          text: copy.skipNotice(theirName),
        });
        effects.push({ type: "Send", person, kind: "feedback_ask", text: copy.feedbackAsk() });
        effects.push({ type: "ResolveDay", state: "resolved_skipped", at });
        resolved = true;
      } else {
        effects.push({
          type: "Send",
          person,
          kind: "waiting_notice",
          text: copy.waitingNotice(theirName),
        });
        effects.push({ type: "Send", person, kind: "feedback_ask", text: copy.feedbackAsk() });
      }
    } else if (me.state === "skipped") {
      if (them.state === "answered" || them.state === "skipped") {
        effects.push({
          type: "Send",
          person: partner,
          kind: "skip_notice",
          text: copy.skipNotice(myName),
        });
        effects.push({ type: "ResolveDay", state: "resolved_skipped", at });
        resolved = true;
      }
      // Partner still awaiting/collecting: they keep going; resolution happens
      // when they reach a terminal state.
    }

    return { effects, resolved };
  }

  private withPerson(day: DayCtx, person: PersonId, ctx: PersonCtx): DayCtx {
    return {
      ...day,
      persons: { ...day.persons, [person]: ctx },
    };
  }
}
