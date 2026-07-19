import { describe, expect, test } from "bun:test";
import { fakeClock } from "./helpers/fakeClock";
import { SettleTimers } from "../src/engine/settle";

describe("SettleTimers", () => {
  test("fires the callback after the quiet gap", () => {
    const { clock, advance } = fakeClock();
    const fired: string[] = [];
    const timers = new SettleTimers(150, (p) => fired.push(p), clock);
    timers.start("a");
    advance(149_000);
    expect(fired).toEqual([]);
    advance(1_000);
    expect(fired).toEqual(["a"]);
  });

  test("restarting resets the quiet gap", () => {
    const { clock, advance } = fakeClock();
    const fired: string[] = [];
    const timers = new SettleTimers(150, (p) => fired.push(p), clock);
    timers.start("a");
    advance(100_000);
    timers.start("a"); // another message arrived
    advance(100_000);
    expect(fired).toEqual([]); // only 100s since last message
    advance(50_000);
    expect(fired).toEqual(["a"]);
  });

  test("timers are independent per person", () => {
    const { clock, advance } = fakeClock();
    const fired: string[] = [];
    const timers = new SettleTimers(150, (p) => fired.push(p), clock);
    timers.start("a");
    advance(75_000);
    timers.start("b");
    advance(75_000);
    expect(fired).toEqual(["a"]);
    advance(75_000);
    expect(fired).toEqual(["a", "b"]);
  });

  test("cancel prevents firing", () => {
    const { clock, advance, pendingCount } = fakeClock();
    const fired: string[] = [];
    const timers = new SettleTimers(150, (p) => fired.push(p), clock);
    timers.start("a");
    timers.cancel("a");
    advance(300_000);
    expect(fired).toEqual([]);
    expect(pendingCount()).toBe(0);
  });

  test("cancelAll clears everything (used at dispatch rollover)", () => {
    const { clock, advance } = fakeClock();
    const fired: string[] = [];
    const timers = new SettleTimers(150, (p) => fired.push(p), clock);
    timers.start("a");
    timers.start("b");
    timers.cancelAll();
    advance(300_000);
    expect(fired).toEqual([]);
  });
});
