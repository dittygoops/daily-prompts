import type { PersonId } from "../config";
import type { Channel } from "../channel/types";
import type { Ledger } from "../ledger/ledger";
import type { PromptSource } from "../prompts/types";
import { DayMachine, type Effect, type Event, type MachineState } from "./stateMachine";
import { SettleTimers, type TimerClock } from "./settle";

export interface EngineRuntimeOptions {
  names: Record<PersonId, string>;
  ledger: Ledger;
  channel: Channel;
  promptSource: PromptSource;
  settleWindowSeconds: number;
  timerClock?: TimerClock;
  now?: () => string;
  log?: (msg: string) => void;
}

/** Owns the machine state and executes its effects against the ledger,
 * channel, and settle timers. The daemon feeds it dispatch ticks and the
 * channel feeds it inbound messages; everything else happens in here. */
export class EngineRuntime {
  private state: MachineState;
  private currentDayId: number | null = null;
  private readonly machine: DayMachine;
  private readonly settle: SettleTimers;
  private readonly now: () => string;
  private readonly log: (msg: string) => void;
  private queue: Promise<void> = Promise.resolve();
  // Bumped on every timer (re)start; a firing whose generation is stale was
  // superseded by a later answer part and must not finalize early.
  private readonly settleGen: Record<PersonId, number> = { a: 0, b: 0 };

  constructor(private readonly opts: EngineRuntimeOptions) {
    this.machine = new DayMachine({ names: opts.names });
    this.now = opts.now ?? (() => new Date().toISOString());
    this.log = opts.log ?? (() => {});
    this.settle = new SettleTimers(
      opts.settleWindowSeconds,
      (person, generation) =>
        void this.enqueue({ type: "SettleElapsed", person, at: this.now(), generation }),
      opts.timerClock,
    );
    this.state = this.rebuild();
    opts.channel.onMessage((msg) =>
      this.enqueue({ type: "InboundText", person: msg.person, text: msg.text, at: msg.at }),
    );
  }

  /** Dispatch the day's prompt (called by the scheduler, or late at startup).
   * Routed through the same queue as inbound/settle events so effects never
   * interleave. Unlike fire-and-forget inbound handling, failures propagate
   * to the caller so a broken dispatch is loud. */
  async dispatch(date: string): Promise<void> {
    const prompt = await this.opts.promptSource.nextPrompt(date);
    await this.enqueue({ type: "DispatchDue", date, at: this.now(), prompt });
  }

  /** Serialize event handling so effects never interleave. Returns the
   * event's own completion (which rejects on failure); the internal chain
   * swallows the rejection so one bad event never wedges the queue. */
  private enqueue(event: Event): Promise<void> {
    const run = this.queue.then(() => this.handleEvent(event));
    this.queue = run.catch((err) => this.log(`event failed: ${err}`));
    return run;
  }

  async settled(): Promise<void> {
    await this.queue;
  }

  private async handleEvent(event: Event): Promise<void> {
    // A settle firing queued before a newer answer part restarted the timer
    // is stale by the time it's processed: finalizing now would cut the
    // window short and demote the late part to feedback.
    if (
      event.type === "SettleElapsed" &&
      event.generation !== undefined &&
      event.generation !== this.settleGen[event.person]
    ) {
      return;
    }
    const { state, effects } = this.machine.step(this.state, event);
    // Effects first, state after: if a ledger write throws, memory stays on
    // the old state instead of diverging from what the ledger recorded.
    for (const effect of effects) {
      await this.execute(effect);
    }
    this.state = state;
  }

  private async execute(effect: Effect): Promise<void> {
    const ledger = this.opts.ledger;
    switch (effect.type) {
      case "CreateDay": {
        const day = ledger.createDay(effect.date, effect.prompt.id, effect.prompt.text, effect.at);
        ledger.markPromptUsed(effect.prompt.id, effect.date);
        this.currentDayId = day.id;
        break;
      }
      case "ResolveDay": {
        if (this.currentDayId !== null) {
          ledger.resolveDay(this.currentDayId, effect.state, effect.at);
        }
        this.settle.cancelAll();
        break;
      }
      case "Send": {
        // A delivery failure must never abort the rest of the day's effects
        // (e.g. the other person's prompt); it is logged and recorded instead.
        try {
          await this.opts.channel.send(effect.person, effect.text);
        } catch (err) {
          this.log(`send to ${effect.person} (${effect.kind}) failed: ${err}`);
          if (this.currentDayId !== null) {
            this.opts.ledger.recordMessage({
              dayId: this.currentDayId,
              person: effect.person,
              direction: "out",
              kind: "send_failed",
              text: `${effect.kind}: ${err}`,
              at: this.now(),
            });
          }
          break;
        }
        if (this.currentDayId !== null) {
          ledger.recordMessage({
            dayId: this.currentDayId,
            person: effect.person,
            direction: "out",
            kind: effect.kind,
            text: effect.text,
            at: this.now(),
          });
          if (effect.kind === "share") {
            ledger.markShareSent(this.currentDayId, effect.person, this.now());
          } else if (effect.kind === "feedback_ask") {
            ledger.markFeedbackAskSent(this.currentDayId, effect.person, this.now());
          }
        }
        break;
      }
      case "RecordInbound":
        ledger.recordMessage({
          dayId: this.currentDayId,
          person: effect.person,
          direction: "in",
          kind: effect.kind,
          text: effect.text,
          at: effect.at,
        });
        break;
      case "StartSettle":
        this.settle.start(effect.person, ++this.settleGen[effect.person]);
        break;
      case "SetCollecting":
        if (this.currentDayId !== null) ledger.setCollecting(this.currentDayId, effect.person);
        break;
      case "FinalizeResponse":
        if (this.currentDayId !== null) {
          ledger.finalizeResponse(this.currentDayId, effect.person, effect.text, effect.at);
        }
        break;
      case "MarkSkipped":
        if (this.currentDayId !== null) {
          ledger.markSkipped(this.currentDayId, effect.person, effect.at);
        }
        break;
    }
  }

  /** Reconstruct in-memory state from the ledger after a restart. Mid-collection
   * answer parts are replayed from recorded messages and their settle timers
   * restarted (the quiet gap begins anew; acceptable). */
  private rebuild(): MachineState {
    const day = this.opts.ledger.openDay();
    if (!day) {
      // No open day: restore the latest resolved day so the feedback window
      // (open until the next dispatch) survives the restart.
      const latest = this.opts.ledger.latestDay();
      if (!latest) return { day: null };
      this.currentDayId = latest.id;
      const messages = this.opts.ledger.messagesForDay(latest.id);
      return {
        day: {
          date: latest.date,
          prompt: { id: latest.prompt_id, text: latest.prompt_text },
          resolved: true,
          persons: {
            a: this.rebuildPerson(latest.id, "a", messages),
            b: this.rebuildPerson(latest.id, "b", messages),
          },
        },
      };
    }
    this.currentDayId = day.id;
    const messages = this.opts.ledger.messagesForDay(day.id);
    const persons = { a: this.rebuildPerson(day.id, "a", messages), b: this.rebuildPerson(day.id, "b", messages) };

    // Crash-recovery: a day where both persons are terminal but the day is
    // still open crashed between finalization and the shares/resolution. No
    // future event can advance it, so replay the exchange: demote an answered
    // person whose share never went out back to "collecting"; the settle
    // timer then re-finalizes them and onTerminal re-emits shares/notices.
    const terminal = (s: string) => s === "answered" || s === "skipped";
    if (terminal(persons.a.state) && terminal(persons.b.state)) {
      if (persons.a.state === "skipped" && persons.b.state === "skipped") {
        this.opts.ledger.resolveDay(day.id, "resolved_skipped", this.now());
        return {
          day: {
            date: day.date,
            prompt: { id: day.prompt_id, text: day.prompt_text },
            resolved: true,
            persons,
          },
        };
      }
      const replay = (["a", "b"] as const).find(
        (p) =>
          persons[p].state === "answered" &&
          this.opts.ledger.personDay(day.id, p).share_sent_at === null,
      ) ?? (["a", "b"] as const).find((p) => persons[p].state === "answered")!;
      const parts = messages
        .filter((m) => m.person === replay && m.kind === "answer_part")
        .map((m) => m.text);
      persons[replay] = {
        state: "collecting",
        parts: parts.length > 0 ? parts : [persons[replay].response ?? ""],
        response: null,
      };
      this.log(`rebuild: replaying stranded day ${day.date} via person ${replay}`);
    }

    for (const person of ["a", "b"] as const) {
      if (persons[person].state === "collecting") {
        this.settle.start(person, ++this.settleGen[person]);
      }
    }
    return {
      day: {
        date: day.date,
        prompt: { id: day.prompt_id, text: day.prompt_text },
        resolved: false,
        persons,
      },
    };
  }

  private rebuildPerson(
    dayId: number,
    person: PersonId,
    messages: ReturnType<Ledger["messagesForDay"]>,
  ) {
    const row = this.opts.ledger.personDay(dayId, person);
    const parts =
      row.state === "collecting"
        ? messages.filter((m) => m.person === person && m.kind === "answer_part").map((m) => m.text)
        : [];
    return {
      state: row.state,
      parts,
      response: row.response_text,
    };
  }
}
