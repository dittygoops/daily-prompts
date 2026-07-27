import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PHOTO_CADENCE_DAYS,
  isPhotoDay,
  resolveBackground,
  turnHolder,
  type Participant,
} from "../../src/photos/schedule";

describe("isPhotoDay", () => {
  test("default cadence: day 0 and every other day after are photo days", () => {
    expect(isPhotoDay({ dayIndex: 0 })).toBe(true);
    expect(isPhotoDay({ dayIndex: 1 })).toBe(false);
    expect(isPhotoDay({ dayIndex: 2 })).toBe(true);
    expect(isPhotoDay({ dayIndex: 3 })).toBe(false);
    expect(DEFAULT_PHOTO_CADENCE_DAYS).toBe(2);
  });

  test("cadenceDays 1 makes every day a photo day", () => {
    for (let day = 0; day < 5; day++) {
      expect(isPhotoDay({ dayIndex: day, cadenceDays: 1 })).toBe(true);
    }
  });

  test("cadenceDays 3 fires every third day", () => {
    expect(isPhotoDay({ dayIndex: 0, cadenceDays: 3 })).toBe(true);
    expect(isPhotoDay({ dayIndex: 1, cadenceDays: 3 })).toBe(false);
    expect(isPhotoDay({ dayIndex: 2, cadenceDays: 3 })).toBe(false);
    expect(isPhotoDay({ dayIndex: 3, cadenceDays: 3 })).toBe(true);
  });

  test("negative dayIndex is never a photo day", () => {
    expect(isPhotoDay({ dayIndex: -1 })).toBe(false);
    expect(isPhotoDay({ dayIndex: -2, cadenceDays: 1 })).toBe(false);
  });

  test("throws for a non-integer dayIndex", () => {
    expect(() => isPhotoDay({ dayIndex: 1.5 })).toThrow();
  });

  test("throws for a cadenceDays that is not a positive integer", () => {
    expect(() => isPhotoDay({ dayIndex: 0, cadenceDays: 0 })).toThrow();
    expect(() => isPhotoDay({ dayIndex: 0, cadenceDays: -1 })).toThrow();
    expect(() => isPhotoDay({ dayIndex: 0, cadenceDays: 1.5 })).toThrow();
  });
});

describe("turnHolder", () => {
  test("alternates starting with b on photo day 1", () => {
    expect(turnHolder(1)).toBe("b");
    expect(turnHolder(2)).toBe("a");
    expect(turnHolder(3)).toBe("b");
    expect(turnHolder(4)).toBe("a");
  });

  test("throws for photoDayNumber below 1 or non-integer", () => {
    expect(() => turnHolder(0)).toThrow();
    expect(() => turnHolder(-1)).toThrow();
    expect(() => turnHolder(1.5)).toThrow();
  });
});

describe("resolveBackground", () => {
  test("both sent: turn holder's photo wins, counter advances", () => {
    // Photo day 2 is a's turn.
    const decision = resolveBackground({
      photoDayNumber: 2,
      aPhoto: "a-photo",
      bPhoto: "b-photo",
    });
    expect(decision).toEqual({
      changeBackground: true,
      from: "a",
      photo: "a-photo",
      nextPhotoDayNumber: 3,
    });
  });

  test("a's turn but only b sent: falls back to b, counter still advances", () => {
    // Photo day 2 is a's turn; a is silent, b filled in.
    const decision = resolveBackground({
      photoDayNumber: 2,
      aPhoto: null,
      bPhoto: "b-photo",
    });
    expect(decision).toEqual({
      changeBackground: true,
      from: "b",
      photo: "b-photo",
      nextPhotoDayNumber: 3,
    });
  });

  test("b's turn but only a sent: falls back to a, counter still advances", () => {
    // Photo day 1 is b's turn; b is silent, a filled in.
    const decision = resolveBackground({
      photoDayNumber: 1,
      aPhoto: "a-photo",
      bPhoto: null,
    });
    expect(decision).toEqual({
      changeBackground: true,
      from: "a",
      photo: "a-photo",
      nextPhotoDayNumber: 2,
    });
  });

  test("neither sent: no change, counter frozen, same person keeps the turn", () => {
    const decision = resolveBackground({
      photoDayNumber: 5,
      aPhoto: null,
      bPhoto: null,
    });
    expect(decision).toEqual({
      changeBackground: false,
      from: null,
      photo: null,
      nextPhotoDayNumber: 5,
    });
    // Turn holder is unchanged because the ordinal did not move.
    expect(turnHolder(decision.nextPhotoDayNumber)).toBe(turnHolder(5));
  });

  test("a long run of simulated photo days stays balanced between a and b", () => {
    // Drive photoDayNumber purely from the returned nextPhotoDayNumber, mixing
    // in missed days, and confirm the distribution does not drift toward one
    // participant even though missed days delay but never skip a turn.
    let photoDayNumber = 1;
    const wins: Record<"a" | "b", number> = { a: 0, b: 0 };
    let counter = 0;
    for (let i = 0; i < 40; i++) {
      counter++;
      // Every 7th simulated day, nobody sends anything.
      const bothMissed = counter % 7 === 0;
      const holder = turnHolder(photoDayNumber);
      const aPhoto = bothMissed ? null : "a-photo";
      const bPhoto = bothMissed ? null : "b-photo";
      const decision = resolveBackground({ photoDayNumber, aPhoto, bPhoto });
      if (decision.changeBackground) {
        wins[decision.from]++;
        expect(decision.from).toBe(holder); // both present, so turn holder wins
      }
      photoDayNumber = decision.nextPhotoDayNumber;
    }
    expect(wins.a + wins.b).toBeGreaterThan(0);
    // Balanced alternation: neither side should dominate the long run.
    expect(Math.abs(wins.a - wins.b)).toBeLessThanOrEqual(1);
  });

  test("a long run with turn-holder skips still keeps counter advancing and turns rotating", () => {
    // holder always skips, other person always sends: fallback should still
    // alternate the turn holder every ordinal since the counter advances.
    let photoDayNumber = 1;
    const from: Participant[] = [];
    for (let i = 0; i < 30; i++) {
      const holder = turnHolder(photoDayNumber);
      const other: Participant = holder === "a" ? "b" : "a";
      const aPhoto = holder === "a" ? null : "fallback";
      const bPhoto = holder === "b" ? null : "fallback";
      const decision = resolveBackground({ photoDayNumber, aPhoto, bPhoto });
      expect(decision.changeBackground).toBe(true);
      if (decision.changeBackground) {
        expect(decision.from).toBe(other);
        from.push(decision.from);
      }
      photoDayNumber = decision.nextPhotoDayNumber;
    }
    // The holder alternates every ordinal (turnHolder is strictly even/odd),
    // so the fallback winner alternates too: it should not settle on one side.
    expect(from[0]).not.toBe(from[1]);
    expect(from[1]).not.toBe(from[2]);
  });
});
