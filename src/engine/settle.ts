import type { PersonId } from "../config";

export interface TimerClock {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

const realClock: TimerClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
};

/** Per-person settle-window timers: each inbound answer part restarts the
 * person's timer; when the quiet gap elapses, the response is considered
 * complete and `onSettle` fires. */
export class SettleTimers {
  private readonly active = new Map<PersonId, number>();

  constructor(
    private readonly windowSeconds: number,
    private readonly onSettle: (person: PersonId, generation?: number) => void,
    private readonly clock: TimerClock = realClock,
  ) {}

  /** `generation` is passed through to the callback so the consumer can
   * discard a stale firing that was queued before the timer restarted. */
  start(person: PersonId, generation?: number): void {
    this.cancel(person);
    const id = this.clock.setTimeout(() => {
      this.active.delete(person);
      this.onSettle(person, generation);
    }, this.windowSeconds * 1000);
    this.active.set(person, id);
  }

  cancel(person: PersonId): void {
    const id = this.active.get(person);
    if (id !== undefined) {
      this.clock.clearTimeout(id);
      this.active.delete(person);
    }
  }

  cancelAll(): void {
    for (const person of [...this.active.keys()]) this.cancel(person);
  }
}
