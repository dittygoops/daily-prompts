import { describe, expect, test } from "bun:test";
import { lane2Candidates } from "../../src/selection/lanes";
import { selectPair } from "../../src/selection/select";
import type { AskRow, SeedRow, SelectionConstants, SelectionInput } from "../../src/selection/types";
import { ALL_FAMILIES } from "../../src/selection/types";
import { subtractDays } from "../../src/selection/windows";

const CONSTANTS: SelectionConstants = {
  settlingDays: 2,
  subjectCooldownDays: 14,
  domainCooldownDays: 4,
  familyCooldownDays: 7,
  tokenWindowDays: 3,
  exploitRunCap: 2,
  budgetCap: 3,
  candidateDepth: 8,
  seedReuseDays: 90,
  anchorMinSharedWords: 1,
};

// A synthetic seed bank built to comfortably clear the spec's coverage
// minimums (>= 8 seeds/domain spanning >= 4 families, >= 6 seeds/family
// spanning >= 3 domains): the full cross product of 11 domains x 15
// families gives every domain 15 seeds across 15 families, and every
// family 11 seeds across 11 domains.
const DOMAINS = [
  "career-academics", "childhood", "family", "relationships-friends",
  "hobbies-interests", "health-body", "daily-life", "beliefs-values",
  "plans-future", "other", "tastes-preferences",
];

// Deterministic PRNG (mulberry32) so the interleave below is reproducible
// without pulling in a dependency.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Real seed-bank authoring order is not domain-grouped (the spec calls it
// "the cold-start curve", i.e. organic authoring order), so a domain-major
// list here would be an artifact of the test, not a property of the real
// bank: with candidateDepth truncating each person's list to the top 8, a
// domain-major bank would make every one of the first 8 seeds share a
// domain, manufacturing a same-day-domain collision on every pair that
// selectNoToken's relaxation exists to handle but that a realistic bank
// would rarely hit this hard. Shuffling deterministically interleaves
// domains and families the way a hand-authored bank naturally would.
function buildSyntheticSeedBank(): SeedRow[] {
  const pairs: { domain: string; family: string }[] = [];
  for (const domain of DOMAINS) {
    for (const family of ALL_FAMILIES) {
      pairs.push({ domain, family });
    }
  }
  const rand = mulberry32(42);
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j]!, pairs[i]!];
  }
  return pairs.map((p, i) => ({ id: i + 1, text: `seed ${p.domain}/${p.family}`, domain: p.domain, family: p.family }));
}

describe("30-day walk: lane 2 never empties, windows never relax", () => {
  test("with only seed candidates (no nodes) for 30 consecutive days", () => {
    const seeds = buildSyntheticSeedBank();
    const asks: AskRow[] = [];
    const usedSeedIds: SelectionInput["usedSeedIds"] = { a: new Set(), b: new Set() };
    let nextAskId = 1;

    const start = "2026-08-01";
    for (let day = 0; day < 30; day++) {
      const today = addDays(start, day);

      // The invariant under test, checked independently of selectPair:
      // lane 2 must be non-empty for both people every single day.
      const lane2A = lane2Candidates(seeds, "a", today, asks, usedSeedIds.a, CONSTANTS);
      const lane2B = lane2Candidates(seeds, "b", today, asks, usedSeedIds.b, CONSTANTS);
      expect(lane2A.length).toBeGreaterThan(0);
      expect(lane2B.length).toBeGreaterThan(0);

      const input: SelectionInput = {
        nodes: { a: [], b: [] },
        asks,
        seeds,
        usedSeedIds,
        tokens: [],
        constants: CONSTANTS,
        today,
      };

      const result = selectPair(input);

      // With no nodes at all, both people MUST land on lane 2 (explore);
      // nothing to relax down to, and no reason to, given lane 2 depth.
      expect(result.a.lane).toBe("explore");
      expect(result.b.lane).toBe("explore");
      expect(result.relaxations).toEqual([]);

      // Feed today's picks back in exactly as a live ledger would: an
      // AskRow per person, and the seed id added to that person's used set.
      for (const [person, candidate] of [["a", result.a], ["b", result.b]] as const) {
        asks.push({
          id: nextAskId++,
          date: today,
          person,
          targetNodeId: null,
          askDomain: candidate.domain,
          askFamily: candidate.family,
          lane: candidate.lane,
          seedId: candidate.seed!.id,
        });
        usedSeedIds[person].add(candidate.seed!.id);
      }

      // Seeds age out of usedSeedIds once seedReuseDays has passed, exactly
      // as Ledger.usedSeedIdsWithin's caller (read.ts) would recompute it
      // against a shifting sinceDate each day.
      const since = subtractDays(today, CONSTANTS.seedReuseDays);
      for (const person of ["a", "b"] as const) {
        for (const seedId of [...usedSeedIds[person]]) {
          const usedOn = asks.find((a) => a.person === person && a.seedId === seedId)?.date;
          if (usedOn !== undefined && usedOn < since) usedSeedIds[person].delete(seedId);
        }
      }
    }
  });
});

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(y!, m! - 1, d! + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}
