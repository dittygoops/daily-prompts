import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { ALL_FAMILIES } from "../src/selection/types";
import {
  ALL_DOMAINS,
  parseSeedsFile,
  validateAll,
  validateCoverage,
  validateReviewStamp,
  validateSchema,
  validateWarmthOrdering,
} from "../scripts/load-seeds";

const seedsPath = join(import.meta.dir, "..", "data", "seeds.tsv");
const realContent = readFileSync(seedsPath, "utf8");
const real = parseSeedsFile(realContent);

// Shapes the product's live failure record calls out by name: a question
// that hands the respondent an open category to nominate from instead of a
// concrete subject. "and similar" extends the three named examples to the
// same aspirational/unbounded construction (want/wish/like + to
// learn/improve/change/develop a named-but-empty slot).
const NOMINATE_A_CATEGORY_PATTERNS = [
  /what'?s an area (you|of)/i,
  /\bsomething you value\b/i,
  /\ba skill you'?d like\b/i,
  /\ba (skill|value|quality|belief|habit|goal) you('d| would)? (want|wish) to (learn|improve|change|develop)\b/i,
];

describe("data/seeds.tsv parsing", () => {
  test("parses the reviewed header and every row", () => {
    expect(real.reviewedStamp).toBe("PENDING");
    expect(real.rows.length).toBeGreaterThanOrEqual(130);
  });

  test("every row is schema-valid: unique positive ids, closed vocabularies, non-empty text", () => {
    expect(validateSchema(real.rows)).toEqual([]);
  });

  test("ids are stable-format: non-negative integers, unique, one per row", () => {
    const ids = real.rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(0);
    }
  });

  test("the static bank's 30 questions are present verbatim among ids 1-30", () => {
    const staticBank: { id: string; text: string }[] = JSON.parse(readFileSync(join(import.meta.dir, "..", "data", "prompts.json"), "utf8"));
    const seedIds1to30 = real.rows.filter((r) => r.id >= 1 && r.id <= 30);
    expect(seedIds1to30.length).toBe(30);
    const seedTexts = new Set(seedIds1to30.map((r) => r.text));
    for (const p of staticBank) {
      expect(seedTexts.has(p.text)).toBe(true);
    }
  });
});

describe("coverage minimums (spec Feasibility)", () => {
  test("every domain has >= 8 seeds spanning >= 4 families, across all 11 domains", () => {
    expect(ALL_DOMAINS.length).toBe(11);
    expect(validateCoverage(real.rows).filter((e) => e.startsWith("domain "))).toEqual([]);
  });

  test("every family has >= 6 seeds spanning >= 3 domains, across all 15 families", () => {
    expect(ALL_FAMILIES.length).toBe(15);
    expect(validateCoverage(real.rows).filter((e) => e.startsWith("family "))).toEqual([]);
  });
});

describe("warmth ordering", () => {
  test("the checked-in bank satisfies the warmth curve", () => {
    expect(validateWarmthOrdering(real.rows)).toEqual([]);
  });

  test("rejects a family outside food/play/daily-mechanics/home in ids 1-20", () => {
    const rows = [{ id: 5, domain: "career-academics", family: "work-school", text: "x" }];
    expect(validateWarmthOrdering(rows)).toEqual([
      "seed 5 (family work-school) is in ids 1-20, which is restricted to food/play/daily-mechanics/home",
    ]);
  });

  test("rejects nostalgia or people before id 21", () => {
    expect(validateWarmthOrdering([{ id: 20, domain: "childhood", family: "nostalgia", text: "x" }]).length).toBeGreaterThan(0);
    expect(validateWarmthOrdering([{ id: 20, domain: "family", family: "people", text: "x" }]).length).toBeGreaterThan(0);
    expect(validateWarmthOrdering([{ id: 21, domain: "childhood", family: "nostalgia", text: "x" }])).toEqual([]);
  });

  test("rejects values-beliefs, plans, or romance before id 60", () => {
    expect(validateWarmthOrdering([{ id: 59, domain: "beliefs-values", family: "values-beliefs", text: "x" }]).length).toBeGreaterThan(0);
    expect(validateWarmthOrdering([{ id: 59, domain: "plans-future", family: "plans", text: "x" }]).length).toBeGreaterThan(0);
    expect(validateWarmthOrdering([{ id: 59, domain: "other", family: "romance", text: "x" }]).length).toBeGreaterThan(0);
    expect(validateWarmthOrdering([{ id: 60, domain: "beliefs-values", family: "values-beliefs", text: "x" }])).toEqual([]);
  });
});

describe("wording quality bar", () => {
  test("no em dashes anywhere in seed text", () => {
    for (const r of real.rows) {
      expect(r.text.includes("—")).toBe(false);
    }
  });

  test("no nominate-a-category shapes", () => {
    for (const r of real.rows) {
      for (const pattern of NOMINATE_A_CATEGORY_PATTERNS) {
        expect(pattern.test(r.text)).toBe(false);
      }
    }
  });

  test("every seed is a single question (exactly one question mark)", () => {
    for (const r of real.rows) {
      expect(r.text.split("?").length - 1).toBe(1);
    }
  });
});

describe("loader --check semantics", () => {
  test("the checked-in file passes every content validation (schema, coverage, warmth)", () => {
    expect(validateAll(real.rows)).toEqual([]);
  });

  test("stamp rule: PENDING always refuses, tested against fixtures rather than the real (still-PENDING) file", () => {
    expect(validateReviewStamp("PENDING", null)).toEqual({
      ok: false,
      reason: "reviewed stamp is PENDING; the owner must review the bank before it can load",
    });
  });

  test("stamp rule: a malformed stamp refuses", () => {
    expect(validateReviewStamp("soon", null).ok).toBe(false);
  });

  test("stamp rule: a stamp older than the file's last git modification refuses", () => {
    const result = validateReviewStamp("2026-07-01", "2026-07-15");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/older than/);
  });

  test("stamp rule: a stamp on or after the last git modification passes", () => {
    expect(validateReviewStamp("2026-07-15", "2026-07-15")).toEqual({ ok: true });
    expect(validateReviewStamp("2026-07-20", "2026-07-15")).toEqual({ ok: true });
  });

  test("stamp rule: no git history at all only enforces the PENDING/format checks", () => {
    expect(validateReviewStamp("2026-07-15", null)).toEqual({ ok: true });
  });
});
