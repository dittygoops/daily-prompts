import type { TimerClock } from "../../src/engine/settle";

/** Manual fake clock: timers fire only when `advance` crosses their deadline. */
export function fakeClock() {
  let nextId = 1;
  const pending = new Map<number, { fireAt: number; fn: () => void }>();
  let now = 0;
  const clock: TimerClock = {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fireAt: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.fireAt <= now) {
          pending.delete(id);
          t.fn();
        }
      }
    },
    pendingCount: () => pending.size,
  };
}
