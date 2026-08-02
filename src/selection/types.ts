// Types for the 2026-08-02 ee-synthesis-design selector
// (docs/superpowers/specs/2026-08-02-ee-synthesis-design.md). This file is
// P0's contract: types and the two closed vocabularies only, no logic. The
// selectPair implementation that consumes SelectionInput and produces a
// Selection belongs to a later package.

import type { PersonId } from "../config";

/** The 15 registers a node or seed can carry (spec "Families"), distinct
 * from the 11-item nodes.domain vocabulary. Order matches the spec exactly;
 * seed-loader coverage checks and W4 both depend on this exact list. */
export const ALL_FAMILIES = [
  "food", "nostalgia", "people", "self-improvement", "work-school", "play",
  "body", "home", "plans", "values-beliefs", "media", "romance",
  "daily-mechanics", "events-outings", "money",
] as const;

export type Family = (typeof ALL_FAMILIES)[number];

/** The three-way truth written to generation_log.lane at dispatch. `stance`
 * stays the two-value exploit/explore label the writer already understands
 * (impl decision 4); `lane` is the finer-grained value selection reasons
 * about (W5's exploit-run cap counts followup and exploit days together). */
export type Lane = "followup" | "exploit" | "explore";

/** The ten window-shaped constants from the spec's Constants section. Kept
 * in lockstep with config.ts's `selection` zod block (that file duplicates
 * this shape rather than importing it, to avoid a config -> selection
 * dependency; a compile-time assertion belongs wherever that wiring lands). */
export interface SelectionConstants {
  settlingDays: number;
  subjectCooldownDays: number;
  domainCooldownDays: number;
  familyCooldownDays: number;
  tokenWindowDays: number;
  exploitRunCap: number;
  budgetCap: number;
  candidateDepth: number;
  seedReuseDays: number;
  anchorMinSharedWords: number;
}

/** One person's node as the selector sees it: enough to run every window
 * (W1-W5) and every lane-1 ordering rule without a further ledger read.
 * `newestFactDate` and `newestUnresolvedThreadDate` are both computed across
 * ALL homes via fact_subjects (spec F7's union reading for W1; F4's
 * thread-first ordering for lane 1), never just the primary node_id. */
export interface SelectableNode {
  id: number;
  person: PersonId;
  domain: string;
  family: string | null;
  subdomain: string;
  summary: string;
  /** Never 0 the moment budget is granted (spec: "never 0, cap 3"); 0 only
   * once budget is spent down by recordAsk or zeroed by resolveOpenThreads.
   * Null on a node that predates budget grant (a rebuild's replay backfills
   * it; an un-rebuilt live node reads null until then). */
  budget: number | null;
  lastAsked: string | null;
  timesAsked: number;
  createdAt: string;
  /** Newest observed_date among facts homed on this node via fact_subjects,
   * any kind, across ALL homes. Drives W1 settling. */
  newestFactDate: string | null;
  /** Newest observed_date among this node's thread-kind facts (any home)
   * still lacking resolved_at. Drives lane 1's thread-first ordering. */
  newestUnresolvedThreadDate: string | null;
}

/** A row from the static seed bank (docs' TSV, loaded via replaceSeeds). */
export interface SeedRow {
  id: number;
  text: string;
  domain: string;
  family: string;
}

/** One dispatch-time snapshot read for window/audit purposes. Deduped to one
 * row per (date, person) by max(id), fell_back = 0, person NOT NULL (spec's
 * mandatory read pattern, live table already holds a hotfix duplicate and
 * seven legacy null-person rows). `askDomain`/`askFamily` are the frozen
 * dispatch-time columns (F11): never a join back to the mutable node. */
export interface AskRow {
  id: number;
  date: string;
  person: PersonId;
  targetNodeId: number | null;
  askDomain: string | null;
  askFamily: string | null;
  lane: Lane | null;
  seedId: number | null;
}

/** A follow-up token (F1): one per distinct (node, event_date). Unspent and
 * inside [today - tokenWindowDays, today) is lane 0's whole eligibility
 * rule; unspent and older than that is an A5 audit violation, full stop. */
export interface TokenRow {
  id: number;
  nodeId: number;
  eventDate: string;
  createdAt: string;
  spentAt: string | null;
}

/** The full read snapshot selectPair needs to run as a pure function of
 * (ledger state, date), per person on the fields that are inherently
 * per-person (nodes, used seed ids) and shared where the underlying data is
 * (seeds are one bank; tokens and asks already carry `person`/`nodeId` and
 * are filtered by the consumer). */
export interface SelectionInput {
  nodes: Record<PersonId, SelectableNode[]>;
  asks: AskRow[];
  seeds: SeedRow[];
  usedSeedIds: Record<PersonId, Set<number>>;
  tokens: TokenRow[];
  constants: SelectionConstants;
  today: string;
}

/** One person's half of a Selection: which lane fired and what it targeted.
 * Exactly one of node/seed/token is non-null, matching `lane`. */
export interface Candidate {
  person: PersonId;
  lane: Lane;
  node: SelectableNode | null;
  seed: SeedRow | null;
  token: TokenRow | null;
  /** The domain/family this candidate would write as ask_domain/ask_family
   * at dispatch: the node's own domain/family for lanes followup/exploit,
   * the seed's for lane explore. */
  domain: string | null;
  family: string | null;
}

/** The result of one day's pairing (spec "Pairing"). `relaxations` records
 * which cross-person rule was dropped, in order, when every pair was
 * rejected (same-day family relaxed before same-day domain); empty when no
 * relaxation was needed. `background` lists, per person, the other nodes the
 * writer must not target that day (the prior OntologyView.offLimits role). */
export interface Selection {
  a: Candidate;
  b: Candidate;
  relaxations: string[];
  background: Record<PersonId, { domain: string; subdomain: string }[]>;
}

/** The audit codes from the spec's Audits section. A7 is deliberately absent
 * (deleted: the selector's budget-0 refusal is a code invariant with a test,
 * not an audit). */
export type AuditId = "A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "A8" | "A9";

export interface AuditViolation {
  audit: AuditId;
  person: PersonId | null;
  subject: string | null;
  detail: string | null;
}
