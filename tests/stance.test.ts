import { describe, expect, test } from "bun:test";
import { decideStance, stanceForPerson } from "../src/prompts/stance";

describe("decideStance", () => {
  test("explores when there is nothing to follow up on", () => {
    expect(decideStance({ recentStances: [], hasThreads: false })).toBe("explore");
  });

  test("explores when threads exist but a recent day already exploited", () => {
    expect(decideStance({ recentStances: ["exploit", "explore"], hasThreads: true })).toBe("explore");
  });

  test("exploits once the recent window has no exploit and threads exist", () => {
    // The live failure this exists to prevent: six straight explore days
    // while both people had live open threads.
    expect(decideStance({ recentStances: ["explore", "explore"], hasThreads: true })).toBe("exploit");
  });

  test("never exploits with no threads, however long the explore streak", () => {
    const stances = ["explore", "explore", "explore", "explore"];
    expect(decideStance({ recentStances: stances, hasThreads: false })).toBe("explore");
  });

  test("treats unrecorded stances as not-an-exploit rather than skipping the day", () => {
    // Days predating the stance column, and fallback days, record null.
    expect(decideStance({ recentStances: [null, null], hasThreads: true })).toBe("exploit");
  });

  test("only the most recent window counts, so an old exploit does not suppress forever", () => {
    expect(decideStance({ recentStances: ["explore", "explore", "exploit"], hasThreads: true })).toBe("exploit");
  });

  test("produces a roughly 1-in-3 cadence when fed back its own decisions", () => {
    const stances: string[] = [];
    for (let day = 0; day < 9; day++) {
      stances.unshift(decideStance({ recentStances: stances, hasThreads: true }));
    }
    expect(stances.filter((s) => s === "exploit").length).toBe(3);
  });
});

describe("stanceForPerson", () => {
  test("a person with threads follows the day's exploit stance", () => {
    expect(stanceForPerson("exploit", true)).toBe("exploit");
  });

  test("a person with no threads explores even on an exploit day", () => {
    expect(stanceForPerson("exploit", false)).toBe("explore");
  });

  test("a person with threads still explores on an explore day", () => {
    expect(stanceForPerson("explore", true)).toBe("explore");
  });

  test("a person with no threads explores on an explore day", () => {
    expect(stanceForPerson("explore", false)).toBe("explore");
  });
});
