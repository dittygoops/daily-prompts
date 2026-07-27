import { describe, expect, test } from "bun:test";
import { NEAR_DUPLICATE_THRESHOLD, contentWords, findExactDuplicates, nearestPrior, openingStem, repeatedStems } from "../../src/eval/novelty";

describe("findExactDuplicates", () => {
  test("returns an empty array when every prompt text is unique", () => {
    const dupes = findExactDuplicates([
      { id: "p1", text: "one" },
      { id: "p2", text: "two" },
    ]);
    expect(dupes).toEqual([]);
  });

  test("flags an exact text duplicate by id pair", () => {
    const dupes = findExactDuplicates([
      { id: "p1", text: "same text" },
      { id: "p2", text: "different" },
      { id: "p3", text: "same text" },
    ]);
    expect(dupes).toEqual([{ a: "p1", b: "p3", text: "same text" }]);
  });

  test("is case-insensitive and trims whitespace", () => {
    const dupes = findExactDuplicates([
      { id: "p1", text: "Same Text" },
      { id: "p2", text: "  same text  " },
    ]);
    expect(dupes.length).toBe(1);
  });
});

describe("contentWords", () => {
  test("strips punctuation, casing and question scaffolding", () => {
    expect(contentWords("What's your favorite thing to cook?")).toEqual(new Set(["favorite", "thing", "cook"]));
  });

  test("collapses a word to a single set member however often it repeats", () => {
    expect(contentWords("cook cook cook")).toEqual(new Set(["cook"]));
  });

  test("returns an empty set for a string with nothing but stopwords", () => {
    expect(contentWords("what is your")).toEqual(new Set());
  });
});

describe("nearestPrior", () => {
  test("returns null when there is no prior history", () => {
    expect(nearestPrior("What's your ideal breakfast?", [])).toBeNull();
  });

  test("scores an identical prompt as a perfect match", () => {
    const match = nearestPrior("What's your ideal breakfast?", ["What's your ideal breakfast?"]);
    expect(match).not.toBeNull();
    expect(match!.similarity).toBe(1);
    expect(match!.isNearDuplicate).toBe(true);
  });

  test("flags a reworded restatement of a prior prompt as a near-duplicate", () => {
    const match = nearestPrior("What is the favorite thing that you like to cook?", [
      "What's your favorite thing to cook?",
    ]);
    expect(match!.isNearDuplicate).toBe(true);
    expect(match!.similarity).toBeGreaterThanOrEqual(NEAR_DUPLICATE_THRESHOLD);
  });

  test("does not flag a genuinely different prompt on the same broad topic", () => {
    const match = nearestPrior("Which app do you open first in the morning?", [
      "What's your favorite thing to cook?",
      "Best movie you've seen in the last 6 months?",
    ]);
    expect(match!.isNearDuplicate).toBe(false);
    expect(match!.similarity).toBeLessThan(NEAR_DUPLICATE_THRESHOLD);
  });

  test("reports the single closest prior, not the first one it overlaps with", () => {
    const match = nearestPrior("What song have you had on repeat lately?", [
      "What's your ideal breakfast?",
      "What song do you play on repeat?",
      "Best meal you've had this month?",
    ]);
    expect(match!.text).toBe("What song do you play on repeat?");
  });

  test("scores zero rather than dividing by zero when both sides are all stopwords", () => {
    const match = nearestPrior("what is your", ["what are you"]);
    expect(match!.similarity).toBe(0);
    expect(match!.isNearDuplicate).toBe(false);
  });

  test("honours a caller-supplied threshold over the default", () => {
    const strict = nearestPrior("What song do you have on repeat?", ["What song have you had on repeat lately?"], 0.99);
    expect(strict!.isNearDuplicate).toBe(false);
  });

  test("does not flag prompts that share only their opening template", () => {
    // Content-word Jaccard is deliberately blind to shared scaffolding;
    // repeatedStems is what catches this failure mode instead.
    const match = nearestPrior("What's one thing you're currently trying to improve?", [
      "What's one thing you're looking forward to this week?",
    ]);
    expect(match!.isNearDuplicate).toBe(false);
  });
});

describe("openingStem", () => {
  test("normalizes casing, punctuation and contractions to a comparable stem", () => {
    expect(openingStem("What's one thing you're hoping to learn?", 4)).toBe("whats one thing youre");
  });

  test("returns the whole prompt when it is shorter than the requested stem", () => {
    expect(openingStem("Best gift ever?", 4)).toBe("best gift ever");
  });
});

describe("repeatedStems", () => {
  test("finds no repetition among structurally varied prompts", () => {
    expect(
      repeatedStems([
        "What's your ideal breakfast?",
        "Best movie you've seen lately?",
        "Who was your first celebrity crush?",
      ]),
    ).toEqual([]);
  });

  test("flags a formulaic run that content-word overlap misses entirely", () => {
    const stems = repeatedStems([
      "What's one thing you're looking forward to this week?",
      "What's one thing you're hoping to learn about yourself?",
      "What's one thing you're currently trying to improve?",
      "What's your ideal breakfast?",
    ]);
    expect(stems.length).toBe(1);
    expect(stems[0]!.stem).toBe("whats one thing youre");
    expect(stems[0]!.count).toBe(3);
  });

  test("a stem used only once is not a repetition", () => {
    expect(repeatedStems(["What's one thing you love?", "Best meal this month?"])).toEqual([]);
  });
});
