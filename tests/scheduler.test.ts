import { describe, expect, test } from "bun:test";
import { mostRecentDayOfWeek, nextDispatchAt, todayInTz } from "../src/scheduler";

const t = { hour: 8, minute: 30 };

describe("todayInTz", () => {
  test("returns the calendar date in the configured timezone", () => {
    // 2026-07-17T02:00:00Z is still 2026-07-16 in Phoenix (UTC-7)
    expect(todayInTz(new Date("2026-07-17T02:00:00Z"), "America/Phoenix")).toBe("2026-07-16");
    expect(todayInTz(new Date("2026-07-17T16:00:00Z"), "America/Phoenix")).toBe("2026-07-17");
  });
});

describe("nextDispatchAt", () => {
  test("before dispatch time: today at 08:30 local", () => {
    const now = new Date("2026-07-17T06:00:00-07:00");
    const next = nextDispatchAt(now, t, "America/Phoenix");
    expect(next.toISOString()).toBe(new Date("2026-07-17T08:30:00-07:00").toISOString());
  });

  test("after dispatch time: tomorrow at 08:30 local", () => {
    const now = new Date("2026-07-17T09:00:00-07:00");
    const next = nextDispatchAt(now, t, "America/Phoenix");
    expect(next.toISOString()).toBe(new Date("2026-07-18T08:30:00-07:00").toISOString());
  });

  test("exactly at dispatch time: tomorrow (the daemon fires 'now' separately)", () => {
    const now = new Date("2026-07-17T08:30:00-07:00");
    const next = nextDispatchAt(now, t, "America/Phoenix");
    expect(next.toISOString()).toBe(new Date("2026-07-18T08:30:00-07:00").toISOString());
  });

  test("DST spring-forward: 08:30 America/New_York stays 08:30 wall clock", () => {
    // US DST begins 2026-03-08: 08:30 EST on Mar 7 is UTC-5, 08:30 EDT on Mar 8 is UTC-4.
    const now = new Date("2026-03-07T10:00:00-05:00");
    const next = nextDispatchAt(now, t, "America/New_York");
    expect(next.toISOString()).toBe(new Date("2026-03-08T08:30:00-04:00").toISOString());
  });

  test("DST fall-back: 08:30 America/New_York stays 08:30 wall clock", () => {
    // US DST ends 2026-11-01.
    const now = new Date("2026-10-31T10:00:00-04:00");
    const next = nextDispatchAt(now, t, "America/New_York");
    expect(next.toISOString()).toBe(new Date("2026-11-01T08:30:00-05:00").toISOString());
  });
});

describe("mostRecentDayOfWeek", () => {
  test("today matches the target weekday: returns today", () => {
    // 2026-07-19 is a Sunday
    const now = new Date("2026-07-19T10:00:00-07:00");
    expect(mostRecentDayOfWeek(now, 0, "America/Phoenix")).toBe("2026-07-19");
  });

  test("today is after the target weekday: returns this week's occurrence", () => {
    // 2026-07-21 is a Tuesday; most recent Sunday is 2026-07-19
    const now = new Date("2026-07-21T10:00:00-07:00");
    expect(mostRecentDayOfWeek(now, 0, "America/Phoenix")).toBe("2026-07-19");
  });

  test("today is before the target weekday in the week: returns last week's occurrence", () => {
    // 2026-07-16 is a Thursday; most recent Sunday is 2026-07-12
    const now = new Date("2026-07-16T10:00:00-07:00");
    expect(mostRecentDayOfWeek(now, 0, "America/Phoenix")).toBe("2026-07-12");
  });

  test("respects the timezone boundary near midnight", () => {
    // 2026-07-20T05:00:00Z is still 2026-07-19 in Phoenix (UTC-7)
    expect(mostRecentDayOfWeek(new Date("2026-07-20T05:00:00Z"), 0, "America/Phoenix")).toBe("2026-07-19");
  });
});
