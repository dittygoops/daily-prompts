import { describe, expect, test } from "bun:test";
import { findExactDuplicates } from "../../src/eval/novelty";

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
