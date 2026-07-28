import type { PersonId } from "../config";
// Aliased: inside this file "Effect" already means the state machine's
// effect union (imported below from ./stateMachine), so the channel's
// semantic Effect ("celebrate" | "emphasize" | "gentle") needs its own name.
import type { Channel, Outbound, Effect as ChannelEffect } from "../channel/types";
import type { Ledger } from "../ledger/ledger";
import type { PromptSource } from "../prompts/types";
import { DayMachine, type Effect, type Event, type MachineState, type PromptRef } from "./stateMachine";
import { SettleTimers, type TimerClock } from "./settle";
import { effectFor, effectEventForKind, type EffectIntensity } from "./effects";
import type { AnimalImage, AnimalImageSource } from "../media/animals";

// Two weeks is long enough that a repeat is not noticeable and short enough
// that the avoid-list never grows unbounded; HttpAnimalImageSource only does
// `recentIds.includes(id)` on up to 3 attempts, so list length costs nothing.
const RECENT_ANIMAL_WINDOW = 14;

export interface EngineRuntimeOptions {
  names: Record<PersonId, string>;
  ledger: Ledger;
  channel: Channel;
  promptSource: PromptSource;
  settleWindowSeconds: number;
  timerClock?: TimerClock;
  now?: () => string;
  log?: (msg: string) => void;
  /** Omit to disable all personality enrichment, which is what tests do. */
  personality?: { intensity: EffectIntensity; animalImage: boolean; animalTimeoutMs: number };
  /** Omit and no image is ever attached, regardless of intensity. */
  animals?: AnimalImageSource;
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
  // Set for the duration of one dispatch's event handling only (see
  // dispatch's try/finally); the prompt Send effects it fans out to read it.
  private pendingAnimal: AnimalImage | null = null;

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
    // Concurrent, not sequential: the animal fetch rides alongside the
    // adaptive generator's LLM round trip, which already dominates dispatch
    // latency, so in the normal case it adds no observable delay.
    const [daily, animal] = await Promise.all([
      this.opts.promptSource.nextPrompts(date),
      this.fetchAnimal(),
    ]);
    this.pendingAnimal = animal;
    try {
      await this.enqueue({
        type: "DispatchDue",
        date,
        at: this.now(),
        prompts: daily.prompts,
        theme: daily.theme,
      });
    } finally {
      // Load-bearing: clearing here (rather than after each Send effect
      // finishes) still guarantees no stale image survives past this
      // dispatch. Clearing only on success would leave a stale image alive
      // whenever the enqueued event throws, and tomorrow's dispatch would
      // silently reuse today's cat until the next successful one overwrote
      // it. enqueue returns the event's own promise, which rejects on
      // failure, so this finally always runs before dispatch returns.
      this.pendingAnimal = null;
    }
  }

  /** The single place animal fetch failure is absorbed; must NEVER throw, so
   * the Promise.all in dispatch can never reject because of it. Returns null
   * on ANY failure (network error, non-image body, oversize, or simply
   * exceeding the configured deadline); the prompt then goes out with text
   * only. This adds no validation of its own: HttpAnimalImageSource already
   * enforces per-request timeouts, a size cap, and magic-byte mime
   * detection; it only absorbs.
   *
   * The Promise.race deadline exists because the source's own per-request 8s
   * timeouts can compound to roughly 48s (up to 3 attempts, each doing a
   * provider resolve plus an image download, each separately timed).
   * Dispatch must not stall that long. The losing fetch promise is left to
   * settle and be garbage collected; it holds no lock and writes nothing. */
  private async fetchAnimal(): Promise<AnimalImage | null> {
    const p = this.opts.personality;
    if (!p || p.intensity === "off" || !p.animalImage || !this.opts.animals) return null;
    try {
      const recent = this.opts.ledger.recentAnimalImageIds(RECENT_ANIMAL_WINDOW);
      return await Promise.race([
        this.opts.animals.fetch(recent),
        new Promise<null>((resolve) => {
          const t = setTimeout(() => resolve(null), p.animalTimeoutMs);
          // Bun keeps the process alive for a pending timer; this fetch races
          // against a real network call the process is already waiting on
          // regardless, so unref lets a shutdown proceed without waiting out
          // a stray timeout instead of holding the event loop open for it.
          t.unref?.();
        }),
      ]);
    } catch (err) {
      this.log(`animal image fetch failed, sending prompt without one: ${err}`);
      return null;
    }
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

  /** Decides what actually goes on the wire for a Send effect. Bare-string
   * returns are the property that makes intensity "off" (or any kind with no
   * moment) a byte-identical diff against pre-personality behaviour, at both
   * the channel and the ledger. */
  private outboundFor(effect: Extract<Effect, { type: "Send" }>): string | Outbound {
    const p = this.opts.personality;
    if (!p || p.intensity === "off") return effect.text;

    const event = effectEventForKind(effect.kind);
    const fx: ChannelEffect | null = event ? effectFor(event, p.intensity) : null;
    const image =
      effect.kind === "prompt" && p.animalImage && this.pendingAnimal !== null
        ? this.pendingAnimal
        : null;

    if (!image && !fx) return effect.text;

    return {
      text: effect.text,
      ...(image && { image: { bytes: image.bytes, mimeType: image.mimeType, name: image.name } }),
      ...(fx && { effect: fx }),
    };
  }

  private async execute(effect: Effect): Promise<void> {
    const ledger = this.opts.ledger;
    switch (effect.type) {
      case "CreateDay": {
        // days.prompt_text holds the shared theme, not a question anybody was
        // asked. The questions themselves live per person, since they differ.
        const themeId = effect.prompts.a.id;
        const themeText = effect.theme ?? effect.prompts.a.text;
        const day = ledger.createDay(effect.date, themeId, themeText, effect.at);
        for (const person of ["a", "b"] as const) {
          const p = effect.prompts[person];
          ledger.setPersonPrompt(day.id, person, p.id, p.text);
          ledger.markPromptUsed(p.id, effect.date);
        }
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
        const outbound = this.outboundFor(effect);
        const enriched = typeof outbound !== "string";
        let usedFallback = false;
        try {
          await this.opts.channel.send(effect.person, outbound);
        } catch (err) {
          if (!enriched) {
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
          // outboundContents (src/channel/spectrum.ts) orders image before
          // text and SpectrumChannel.send loops the contents sequentially,
          // so a vendor-rejected attachment would otherwise abort the whole
          // send and the daily question would never arrive. One plain-text
          // retry recovers that: the flourish is expendable, the message
          // is not.
          this.log(`enriched send to ${effect.person} (${effect.kind}) failed, retrying as plain text: ${err}`);
          try {
            await this.opts.channel.send(effect.person, effect.text);
            usedFallback = true;
          } catch (err2) {
            this.log(`send to ${effect.person} (${effect.kind}) failed: ${err2}`);
            if (this.currentDayId !== null) {
              this.opts.ledger.recordMessage({
                dayId: this.currentDayId,
                person: effect.person,
                direction: "out",
                kind: "send_failed",
                text: `${effect.kind}: ${err2}`,
                at: this.now(),
              });
            }
            break;
          }
        }
        if (this.currentDayId !== null) {
          // The ledger message row records the plain text regardless of
          // enrichment: the image and the effect are transport decoration
          // and do not belong in message history.
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
          // Written only after a successful send that actually carried the
          // image (not the plain-text-fallback path): the avoid-list must
          // never contain an image nobody saw. CreateDay sets currentDayId
          // before any Send effect runs, so this is always safe here.
          if (
            enriched &&
            !usedFallback &&
            effect.kind === "prompt" &&
            typeof outbound !== "string" &&
            outbound.image !== undefined &&
            this.pendingAnimal !== null
          ) {
            ledger.setDayAnimalImage(this.currentDayId, this.pendingAnimal.id);
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
          prompts: this.promptsFor(latest),
          theme: latest.prompt_text,
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
            prompts: this.promptsFor(day),
            theme: day.prompt_text,
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
        prompts: this.promptsFor(day),
        theme: day.prompt_text,
        resolved: false,
        persons,
      },
    };
  }

  /** Each person's own question, falling back to the day row for any row
   * written before per-person prompts existed. The migration backfills these,
   * so the fallback is belt-and-braces rather than an expected path. */
  private promptsFor(day: { id: number; prompt_id: string; prompt_text: string }): Record<PersonId, PromptRef> {
    const one = (person: PersonId): PromptRef => {
      const pd = this.opts.ledger.personDay(day.id, person);
      return { id: pd.prompt_id ?? day.prompt_id, text: pd.prompt_text ?? day.prompt_text };
    };
    return { a: one("a"), b: one("b") };
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
