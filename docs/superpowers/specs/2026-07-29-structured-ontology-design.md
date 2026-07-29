# Structured Ontology: Domains, Nodes, and a Retired Supermemory

Design doc, 2026-07-29. Status: **revision 2**, after adversarial and constructive review. Review verdicts: direction sound, original mechanism structurally wrong in four places. All four are redesigned here, with the reviews' real-data findings folded in. One live bug the review found (the extractor being handed the day's theme as the question) was fixed and deployed separately.

## The failure this fixes

Ten days of live prompts produced three symptom classes with one root cause:

1. **Semantic repetition.** Four self-improvement questions in six days, sharing almost no vocabulary, invisible to content-word similarity.
2. **Altitude retreat.** When specific subjects were used up, the generator abstracted upward instead of changing subject: "guitar practice" became "an area of growth".
3. **Depth blindness.** "Another story from Amol?" assumed a well with one bucket; "one cooking sound that makes you feel good?" returned to a puddle expecting depth.

Root cause: **the generator has no model of the structure of a person's life, only a flat pile of dated observations.** This spec replaces the pile with a graph in the ledger.

Supermemory is retired with it: a flat document store whose `getContext` is an N+1 list-and-fetch with fixed-order truncation, whose coverage tags are too granular to block a semantic repeat, whose self-hosted `/v4/search` never worked, and whose one real capability (embedding search) is never invoked at two-person scale. Framework alternatives (Honcho, Mem0, Letta, Cognee, Zep/Graphiti, Kuzu) were researched and rejected; every one decides what to remember by its own model's judgment, and this project has learned repeatedly that judgments that matter are made in code. Zep/Graphiti is the named graduation path if genuine temporal reasoning is ever needed.

## Owner decisions

- Fixed domain skeleton in code, LLM-emergent subdomains beneath it.
- Explore = collecting new information. Exploit = digging into known nodes.
- Every node tracks when it was last asked about.
- Storage: the ledger. Supermemory retired.

## Data model

```sql
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY,
  person TEXT NOT NULL CHECK (person IN ('a','b')),
  domain TEXT NOT NULL CHECK (domain IN (
    'career-academics','childhood','family','relationships-friends',
    'hobbies-interests','health-body','daily-life','beliefs-values',
    'plans-future','other'
  )),
  subdomain TEXT NOT NULL,            -- emergent, kebab-case, normalized
  summary TEXT NOT NULL,              -- one sentence, <= 140 chars
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','depleted','closed')),
  event_date TEXT,                    -- for time-bound nodes, else null
  last_asked TEXT,
  times_asked INTEGER NOT NULL DEFAULT 0,
  avg_yield_chars REAL,               -- incremental mean, updated at finalization
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (person, subdomain)          -- NOT per domain: review showed the same
);                                    -- subject filed under 3 domains from one answer

CREATE TABLE IF NOT EXISTS node_facts (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id),
  kind TEXT NOT NULL CHECK (kind IN ('fact','thread','interest')),
  text TEXT NOT NULL,                 -- temporally grounded to absolute dates
  source_day_id INTEGER NOT NULL,
  observed_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Moods and prompt preferences are NOT subjects and stay out of the graph
-- (review: a durable summary must never bake in "seems drained this week",
-- and preferences are about the check-in, not the person's life).
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY,
  person TEXT NOT NULL CHECK (person IN ('a','b')),
  kind TEXT NOT NULL CHECK (kind IN ('mood_signal','prompt_preference')),
  text TEXT NOT NULL,
  observed_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Key changes from revision 1, each answering a review finding:

- **`UNIQUE (person, subdomain)`, domain demoted to a mutable attribute.** The real car answer would have produced `daily-life/transportation`, `plans-future/car-2027`, and `family/family-car` as three legal nodes under the old key. A subject has one identity per person; the bucket is a view. On domain disagreement, the stored domain wins and the mismatch is logged.
- **Moods and preferences leave the graph** into `signals`: moods read with a recency window (7 days), preferences read durably, exactly the separation `PersonContext` had. Node counts and summaries never see them.
- **`node_facts.kind` shrinks to the three subject kinds.**

## Depth without asking: fact-count richness

The original design keyed depth off `avg_yield_chars`, and review killed it with live data: no real answer has ever been under 84 chars (the 60-char threshold literally cannot fire), and at one question per person per day against a node population growing ~4/day, most nodes are asked zero or one times ever. Per-node ask statistics never accumulate.

Richness is instead derived from what exists the moment a node is born:

- **rich** = 3+ facts, or facts from 2+ distinct days
- **thin** = 1 fact, one day

Yield still updates (incremental mean at answer finalization, `times_asked` incrementing there too so the count never drifts ahead of the answers feeding the mean; `last_asked` set at dispatch since an unanswered question must still not repeat). But yield is a *refinement* used only when present, via a **relative** threshold: depleted when `times_asked >= depletionMinAskings (2)` and `avg_yield_chars < depletionRatio (0.5) * that person's median answer length`. On live data the medians are 306 and 377 chars, so the real 84-char dancing answer would deplete its node on a second short answer while the 342-char reading answer keeps its node open. Skips update nothing: a skip is not evidence a well is dry.

## Status machine, now with reopening

- `open`: default, and the state most nodes stay in.
- `depleted`: the relative-yield rule above, or set manually. **Any new fact arriving on a depleted node reopens it.** Depletion is a claim about the past, and new evidence beats it.
- `closed`: `event_date` passed AND a post-event follow-up was asked AND answered. **A new fact arriving reopens here too.** Review's regression case: the psychic-party question on 07-27 (the follow-up) produced an 816-char answer whose facts spawn `car-2027` and enrich `cora`, so the *material* lives on in open nodes even as the event node closes; if a later answer adds a party fact, the node reopens.

All transitions in code from observable signals. A model never writes `status`.

## Extraction (System 2 rework)

The closed-vocabulary contract, which is also the drift defense:

1. The extractor receives the person's node list **with ids** (id, domain/subdomain, summary).
2. Per observation it emits `{kind, text, nodeId | newNode}` where `newNode = {domain, subdomain, summary}`. Referencing an existing node is picking an id, never typing a string, which removes the main drift source (an LLM restating a concept it can already see). Creating a node is a structurally distinct action.
3. Guards, all code: an unknown `nodeId` is dropped with a loud log, never coerced. Both `nodeId` and `newNode` set keeps `nodeId` (matching is safer than creating). A `newNode` is normalized (hyphens, plurals) and checked with `nearestPrior` over `"subdomain summary"` against the person's existing nodes at the standard 0.5 threshold; a near-match attaches instead of creating ("fitness" lands on `gym`). Domain must pass the enum, validation-retry, then drop-with-log.
4. Existing zero-trust guards carry over verbatim: person forcing, the feedback gate on preferences and prompt ideas, temporal grounding.
5. **Filing is transactional**: facts, signals, prompt ideas, and `markExtraction` commit together, so a crash cannot double-file on retry (review found the current pipeline has this gap; today it makes harmless duplicate docs, with nodes it would corrupt fact counts).
6. Summary rewrite: on a node's third fact or its event passing, one validated-sentence LLM call rewrites `nodes.summary` only. This is the sole LLM write to `nodes`.

## Generation (System 3 consumption)

Candidate lists with **dated verbatim facts**, answering review's sharpest finding: summaries alone are altitude retreat by construction, and you cannot write "how did the busking plan go?" from "learning guitar, practices regularly". Selection is a query, so the truncation-budget problem stays dead, but the few selected nodes arrive with their actual material (up to 4 most recent facts each).

Layout per person (replacing the Facts/Threads/Interests/Coverage block; moods, feedback, ideas, history, recent topics stay as they are):

```
EXPLOIT CANDIDATES for Aditya (pick exactly one, cite its id in "targetNodeId"):
  [node 14] health-body / back-pain (never asked, rich, LIVE: recorded 2026-07-28)
    - [2026-07-28] Has back pain from bench pressing.
    - [2026-07-28] Plans to try dead hangs and stretching.
  [node 9] hobbies-interests / guitar (never asked, rich)
    - [2026-07-25] Practices guitar toward playing and singing at will.
    - [2026-07-25] Wants to street-perform someday.
EXPLORE CANDIDATES for Aditya (pick one domain, cite it in "targetExplore"):
  other (0 nodes) | plans-future (1 node) | beliefs-values (1 node)
OFF LIMITS today (asked recently or depleted, do not build on these):
  daily-life / cooking-sounds (asked 2026-07-22) | hobbies-interests / live-concerts (asked 2026-07-20)
```

- **Exploit ordering** (fixing the inverted original): never-asked rich nodes first, then never-asked thin, then eligible asked nodes by staleness. LIVE nodes (event within `liveEventWindowDays`, or newest fact within 2 days) jump the queue. Depleted, closed, and in-cooldown (14 days) nodes are excluded and the nearest appear as OFF LIMITS.
- **Explore stays subject-carrying.** Review showed "write a question about beliefs-values, where you have no material" regenerates the banned nominate-a-category shape. Rule added to the prompt: an explore question opens the target domain through a *concrete everyday subject* (the static bank's register: "what's your favorite thing to cook" carries its subject while exploring food), and the carry-its-own-subject rule applies to explore questions with no exemption.
- **Declared-target validation in code**: exploit must cite an offered `targetNodeId`, explore an offered domain, cross-wiring rejected, retry. `MAX_ATTEMPTS` rises to 4. On the final attempt the wording guards (stem, theme) still bypass as today, but a failed *target* validation ships the question with target recorded null and a loud log rather than blocking dispatch: the question is probably fine, the bookkeeping notes it was unattributed.
- **Empty lists are normal states**: empty exploit list forces the day to explore (this also becomes `stanceForPerson`'s signal: `hasThreads` is redefined as "has at least one exploit candidate", which is exact where the old signal was approximate). The explore list is never empty by construction (thinnest domains always exist).
- Targets recorded in `generation_log.target_node_id` / `target_domain` (additive nullable columns, no FK so rebuilds cannot break the audit trail). On dispatch: `last_asked`. On finalization: yield + `times_asked` + depletion check, one transaction.

## Interface

`Memory` is deleted. In its place, the codebase's two-file pattern at the read seam only:

```ts
// src/ontology/types.ts
export interface OntologyView {
  candidates(person: PersonId, today: string): PersonCandidates;
  nodeExists(person: PersonId, nodeId: number): boolean;  // the eval axis
}
```

`LedgerOntology` implements it over ledger queries; the eval fixtures implement it as literal data, preserving `tests/eval/fixtures` as readable objects rather than populated databases. Writes (`fileObservation`, `recordAsked`, `recordYield`) are ordinary `Ledger` methods: one caller each, no second implementation, no interface. This keeps the Graphiti escape hatch honest at one consumer.

## Migration

1. Rebuild derives the graph from the ledger's verbatim answers (24 person-days, ~30 extraction calls plus ~15 summary rewrites, still under a cent).
2. **Attribution by argmax, not string matching** (the original backfill was unimplementable: `generation_log.topic` is NULL in all 11 rows, and matching free prompt text to LLM-named subdomains is not matching). During date-ordered replay, if exactly one node received the day's maximum fact count and that max >= 2, it gets `last_asked`, `times_asked`, and the answer's length folded into yield. Ties and singletons attribute nothing. On real data this attributes the concert, cooking-sounds, job-search, Amol, Cora, back-pain, car, and reading days correctly and declines the ambiguous ones, which prevents the day-one disaster of the whole graph presenting as never-asked (re-asking the concert question) OR entirely in cooldown (no exploit candidates at all).
3. Rebuild is for extraction-rule changes, not casual repair; it renames node identity (nondeterministic extraction), so manual `UPDATE` is the repair path for a wrong status, and the spec stops claiming rebuild as the mitigation for everything. Replay offers already-created nodes as closed vocabulary, which bounds the drift within a single rebuild.
4. Wipe order: facts before nodes (FK). `sqlite3 .backup` before anything. Supermemory keeps running untouched until the new path is verified, then its plist unloads; nothing deletes its data.
5. `scripts/print-graph.ts`: renders the graph as a tree. This is the acceptance gate for the rebuild ("read the resulting graph by hand" is otherwise impossible).

## Blast radius (from review, so the estimate is honest)

`index.ts` (4 sites), `config.ts` (`supermemory` key out, `SUPERMEMORY_API_KEY` out of REQUIRED_ENV, new `ontology` block: cooldown 14, liveEventWindowDays 3, depletionRatio 0.5, depletionMinAskings 2, candidate limits 5/3/8, summaryRewriteAtFacts 3), `.env.example`, `ops/com.dailyprompts.supermemory.plist`, README install steps and privacy paragraph (which improves: derived memory joins `ledger.db` under chmod 600, one fewer service holds anything). Tests: `memory/supermemory/pipeline/rebuild/rebuildCli/adaptiveWiring` rewritten or retired, `adaptivePromptSource` reworked, and `tests/eval/fixtures/memoryStates.ts` (301 lines of PersonContext data) rewritten against `PersonCandidates` keeping the nine scenario names so eval reports stay comparable. The 2026-07-28 eval spec's `answerableByThem` axis redefines onto `nodeExists`, which makes it a lookup instead of a judge call for the exploit case.

## Build order

1. Schema + ledger queries + status machine + `LedgerOntology` (pure, tested, invisible).
2. Extractor rework + transactional filing + rebuild with argmax attribution + `print-graph`. Verified by rebuilding a backup and reading the tree.
3. Generation consumption: candidate blocks, target validation, node bookkeeping.
4. Cutover: daemon restart, Supermemory unloaded after a clean week.
5. Eval alignment: fixtures re-shaped, `answerableByThem` as a lookup.

## Risks

- **Misfiling is now structural.** Mitigations: closed vocabulary, the near-duplicate creation check, the enum guard, `print-graph` review before cutover, and re-derivability as the last resort (with its identity-renaming cost stated).
- **Thresholds are guesses.** All in config; status is reversible by rule (reopen-on-new-fact) and by hand.
- **Two-level flatness.** `music` and `guitar` are siblings and `music` may keep collecting guitar facts. Accepted: closed vocabulary means the more specific node wins once it exists, and no hierarchy is added.
- **This obsoletes week-old work.** The topic guard shrinks to wording police (its column has never held a live value anyway). Accepted.

## Out of scope

Multi-hop node relationships, vector search, Ria-facing memory access, any change to the daily message flow, nudges, recap, or personality.
