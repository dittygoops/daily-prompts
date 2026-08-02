// Pairing (spec "Selection" > "Pairing"). Takes each person's already-
// ordered lane-0/1/2 candidates and decides who fires. Token precedence is
// VERBATIM from the spec: a person holding a fireable token IS lane 0;
// pairing only picks the partner, and the partner re-selects on a
// cross-person collision, never the token. Only when neither person holds a
// token does pair enumeration run. Pure: no Date, no Ledger, no random.

import type { PersonId } from "../config";
import type { Candidate, Lane, SeedRow, SelectableNode, TokenRow } from "./types";

/** Builds one person's ordered candidate list: lane 1 (exploit) nodes first,
 * then lane 2 (explore) seeds, truncated to candidateDepth (spec: "enumerate
 * top candidateDepth lists"). Each list is already in its own lane's
 * priority order (lanes.ts), so this is a straight concatenation. */
export function buildCandidateList(
  person: PersonId,
  lane1Nodes: SelectableNode[],
  lane2Seeds: SeedRow[],
  candidateDepth: number,
): Candidate[] {
  const fromNodes: Candidate[] = lane1Nodes.map((node) => ({
    person,
    lane: "exploit",
    node,
    seed: null,
    token: null,
    domain: node.domain,
    family: node.family,
  }));
  const fromSeeds: Candidate[] = lane2Seeds.map((seed) => ({
    person,
    lane: "explore",
    node: null,
    seed,
    token: null,
    domain: seed.domain,
    family: seed.family,
  }));
  return [...fromNodes, ...fromSeeds].slice(0, candidateDepth);
}

/** The Candidate for a person's fired lane-0 token: the node the token
 * belongs to, carrying that node's own domain/family (Candidate's contract:
 * "the node's own domain/family for lanes followup/exploit"). */
export function tokenCandidate(
  person: PersonId,
  token: TokenRow,
  nodesById: Map<number, SelectableNode>,
): Candidate {
  const node = nodesById.get(token.nodeId);
  if (!node) {
    throw new Error(`fireable token ${token.id} references unknown node ${token.nodeId}`);
  }
  return { person, lane: "followup", node, seed: null, token, domain: node.domain, family: node.family };
}

function collidesDomain(a: Candidate, b: Candidate): boolean {
  return a.domain !== null && b.domain !== null && a.domain === b.domain;
}

/** Family collision, honoring W4's "null family passes and never sets": two
 * null-family candidates are not a collision, they're just both unset. */
function collidesFamily(a: Candidate, b: Candidate): boolean {
  return a.family !== null && b.family !== null && a.family === b.family;
}

/** Only one person holds a token this day: the fixed candidate is forced
 * (the token), and the partner walks their own ordered list looking for the
 * first candidate that doesn't collide (same-day domain, same-day family)
 * with the fixed one. If every candidate in the partner's list collides,
 * relax family first, then domain (spec order), recording each relaxation.
 * W1-W5 are never touched here; they were already applied when the
 * partner's list was built. */
export function selectPartner(
  fixed: Candidate,
  partnerList: Candidate[],
): { candidate: Candidate; relaxations: string[] } {
  if (partnerList.length === 0) {
    throw new Error(
      "no eligible partner candidate: the seed-bank feasibility invariant (spec 'Feasibility') was violated",
    );
  }

  const clean = partnerList.find((c) => !collidesDomain(fixed, c) && !collidesFamily(fixed, c));
  if (clean) return { candidate: clean, relaxations: [] };

  const familyRelaxed = partnerList.find((c) => !collidesDomain(fixed, c));
  if (familyRelaxed) return { candidate: familyRelaxed, relaxations: ["family"] };

  // Both relaxed: the partner's own best candidate fires regardless.
  return { candidate: partnerList[0]!, relaxations: ["family", "domain"] };
}

/** followup > exploit > explore is the general lane order, but this
 * comparator is only ever used inside no-token pair enumeration, where
 * neither candidate can be "followup" (a token holder never reaches this
 * path). exploit ranks better (lower) than explore. */
function laneRank(lane: Lane): number {
  if (lane === "followup") return 0;
  if (lane === "exploit") return 1;
  return 2;
}

interface IndexedPair {
  a: Candidate;
  b: Candidate;
  ai: number;
  bi: number;
}

function buildPairs(listA: Candidate[], listB: Candidate[], allowFamily: boolean, allowDomain: boolean): IndexedPair[] {
  const pairs: IndexedPair[] = [];
  for (let ai = 0; ai < listA.length; ai++) {
    for (let bi = 0; bi < listB.length; bi++) {
      const a = listA[ai]!;
      const b = listB[bi]!;
      if (!allowDomain && collidesDomain(a, b)) continue;
      if (!allowFamily && collidesFamily(a, b)) continue;
      pairs.push({ a, b, ai, bi });
    }
  }
  return pairs;
}

/** Lexicographic by (best lane in pair, worse lane in pair, a's index, b's
 * index), NEVER by sum (spec F6b: a sum lets a tokenless tie beat
 * structure). Returns negative if x should sort before y (x is better). */
function comparePairs(x: IndexedPair, y: IndexedPair): number {
  const xBest = Math.min(laneRank(x.a.lane), laneRank(x.b.lane));
  const yBest = Math.min(laneRank(y.a.lane), laneRank(y.b.lane));
  if (xBest !== yBest) return xBest - yBest;

  const xWorse = Math.max(laneRank(x.a.lane), laneRank(x.b.lane));
  const yWorse = Math.max(laneRank(y.a.lane), laneRank(y.b.lane));
  if (xWorse !== yWorse) return xWorse - yWorse;

  if (x.ai !== y.ai) return x.ai - y.ai;
  return x.bi - y.bi;
}

function bestOf(pairs: IndexedPair[]): IndexedPair {
  let best = pairs[0]!;
  for (let i = 1; i < pairs.length; i++) {
    if (comparePairs(pairs[i]!, best) < 0) best = pairs[i]!;
  }
  return best;
}

/** Neither person holds a token: enumerate both top-candidateDepth lists,
 * drop same-day-domain and same-day-family collisions, pick the
 * lexicographically best surviving pair. If every pair collides, relax
 * family then domain (spec order), recording each relaxation. Once both are
 * relaxed the full cross product is unfiltered, so as long as both lists
 * are non-empty a pair always exists (the "unsolvable" case is a list being
 * empty at all, which is a seed-bank feasibility violation, not something
 * pairing can fix). */
export function selectNoToken(
  listA: Candidate[],
  listB: Candidate[],
): { a: Candidate; b: Candidate; relaxations: string[] } {
  if (listA.length === 0 || listB.length === 0) {
    throw new Error(
      "no eligible candidates for one person: the seed-bank feasibility invariant (spec 'Feasibility') was violated",
    );
  }

  let pairs = buildPairs(listA, listB, false, false);
  if (pairs.length > 0) {
    const best = bestOf(pairs);
    return { a: best.a, b: best.b, relaxations: [] };
  }

  pairs = buildPairs(listA, listB, true, false); // relax same-day family
  if (pairs.length > 0) {
    const best = bestOf(pairs);
    return { a: best.a, b: best.b, relaxations: ["family"] };
  }

  pairs = buildPairs(listA, listB, true, true); // relax same-day domain too
  const best = bestOf(pairs); // non-empty: full cross product of two non-empty lists
  return { a: best.a, b: best.b, relaxations: ["family", "domain"] };
}
