import { describe, expect, test } from "bun:test";
import { normalizeSubdomain } from "../../src/ontology/normalize";

describe("normalizeSubdomain", () => {
  test("kebab-cases arbitrary input", () => {
    expect(normalizeSubdomain("Fitness Goals!")).toBe("fitness-goal");
  });

  test("collapses plural/singular to one key", () => {
    expect(normalizeSubdomain("fitness-goals")).toBe(normalizeSubdomain("fitness-goal"));
  });

  test("squeezes repeated hyphens and trims edges", () => {
    expect(normalizeSubdomain("--gym---sessions--")).toBe("gym-session");
  });

  test("keeps short words and -ss words intact", () => {
    expect(normalizeSubdomain("chess")).toBe("chess");
    expect(normalizeSubdomain("gas")).toBe("gas");
  });

  test("does not mangle singulars ending in s, or -es plurals", () => {
    // All four observed in the first live rebuild, stored corrupted:
    // "basi-school", "career-focu-psychic", "childhood-storie".
    expect(normalizeSubdomain("Basis school")).toBe("basis-school");
    expect(normalizeSubdomain("career-focus")).toBe("career-focus");
    expect(normalizeSubdomain("childhood-stories")).toBe("childhood-stories");
    expect(normalizeSubdomain("crisis")).toBe("crisis");
    // The collapse it exists for still works.
    expect(normalizeSubdomain("league-of-legends")).toBe("league-of-legend");
    expect(normalizeSubdomain("cooking-sounds")).toBe("cooking-sound");
  });
});
