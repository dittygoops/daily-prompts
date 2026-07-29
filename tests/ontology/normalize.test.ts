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
});
