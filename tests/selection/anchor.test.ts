import { describe, expect, test } from "bun:test";
import { anchorCheck } from "../../src/selection/anchor";

describe("anchorCheck", () => {
  test("passes when the question shares a content word with the subdomain", () => {
    const target = { subdomain: "guitar", summary: "learning to play" };
    expect(anchorCheck("How's the guitar practice going?", target, [], 1)).toBe(true);
  });

  test("passes when the shared word is only in the summary", () => {
    const target = { subdomain: "car", summary: "shopping for a used sedan" };
    expect(anchorCheck("Any luck finding a sedan you like?", target, [], 1)).toBe(true);
  });

  test("passes when the shared word is only in a supplied fact", () => {
    const target = { subdomain: "car", summary: "car shopping" };
    expect(
      anchorCheck("How was the test drive?", target, ["Test drove a Civic on Saturday"], 1),
    ).toBe(true);
  });

  test("fails when nothing overlaps: altitude retreat into generic small talk", () => {
    const target = { subdomain: "guitar", summary: "learning to play" };
    expect(anchorCheck("How's your day going?", target, [], 1)).toBe(false);
  });

  test("respects a higher minSharedWords threshold", () => {
    const target = { subdomain: "guitar", summary: "learning to play chords" };
    // shares only "guitar"
    expect(anchorCheck("Guitar going well?", target, [], 2)).toBe(false);
    // shares "guitar" and "chords"
    expect(anchorCheck("Guitar chords still tricky?", target, [], 2)).toBe(true);
  });

  test("stopwords are excluded from the overlap", () => {
    const target = { subdomain: "guitar", summary: "the guitar" };
    // "the" and "you" are stopwords; only "guitar" is a real content word
    expect(anchorCheck("What is the guitar you have?", target, [], 1)).toBe(true);
    expect(anchorCheck("What is the thing you have?", target, [], 1)).toBe(false);
  });
});
