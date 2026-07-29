# Structured Ontology: Domains, Nodes, and a Retired Supermemory

Design doc, 2026-07-29. Status: drafted, under review.

## The failure this fixes

Ten days of live prompts produced three distinct symptom classes with one root cause:

1. **Semantic repetition.** Four self-improvement questions in six days, each sharing almost no vocabulary with the last, so content-word similarity saw nothing.
2. **Altitude retreat.** When specific subjects were used up, the generator did not change subject; it abstracted upward. "Guitar practice" became "an area of growth you're interested in developing", which reads as novelty to a repeat checker while being strictly worse to answer.
3. **Depth blindness in both directions.** "What's another story from Amol?" assumed a well that likely holds one bucket. "What's one cooking sound that makes you feel good?" returned to a puddle expecting depth. The system cannot tell a rich topic from a depleted one.

Root cause: **the generator has no model of the structure of a person's life, only a flat pile of dated observations.** Every guard shipped so far (topic tags, theme checks, stem checks, subject rules) is a point patch fighting symptoms of that missing structure. This spec replaces the pile with a graph.

A secondary driver: Supermemory, the current store, is a flat document service whose flatness is the thing we keep fighting. Its `getContext` is an N+1 list-and-fetch loop with fixed-order truncation (a person with many facts gets EMPTY threads and interests), its coverage tags are too granular to block a semantic repeat, self-hosted `/v4/search` never worked so the client is built on list endpoints, and its one real capability, embedding search, is never invoked at two-person scale. Alternatives were researched properly (Honcho, Mem0, Letta, Cognee, Zep/Graphiti, Kuzu); the full analysis lives in the conversation record and the verdict is one line: every framework decides what to remember by its own model's judgment, and this project has learned three times that judgments that matter must be made in code. The ontology lives in the ledger.

## Decisions already made by the owner

- Fixed domain skeleton in code, LLM-emergent subdomains beneath it.
- Explore = collecting new information (thin domains, unexplored territory). Exploit = digging into known nodes.
- Every node tracks when it was last asked about.
- Storage: the ledger (SQLite). Supermemory retired.

## Data model

Two new tables. `person` is the existing `"a" | "b"`.

```sql
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY,
  person TEXT NOT NULL CHECK (person IN ('a','b')),
  domain TEXT NOT NULL CHECK (domain IN (
    'career-academics', 'childhood', 'family', 'relationships-friends',
    'hobbies-interests', 'health-body', 'daily-life', 'beliefs-values',
    'plans-future', 'other'
  )),
  -- Emergent, LLM-named, kebab-case: "guitar", "job-search", "cora".
  subdomain TEXT NOT NULL,
  -- One sentence naming what this node is: "Learning guitar, practicing
  -- regularly, aspires to street performance."
  summary TEXT NOT NULL,
  -- open: has material left. depleted: asked and the well came up dry, or
  -- inherently shallow. closed: a dated event that has passed and had its
  -- follow-up. Status changes are made in code from observable signals,
  -- never by model judgment.
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','depleted','closed')),
  -- The event date for time-bound nodes (a concert, a party), null otherwise.
  event_date TEXT,
  last_asked TEXT,          -- date of the most recent question that targeted this node
  times_asked INTEGER NOT NULL DEFAULT 0,
  -- Mean response length across questions that targeted this node. The
  -- depth signal: long answers mean rich, short answers mean puddle.
  avg_yield_chars REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (person, domain, subdomain)
);

CREATE TABLE IF NOT EXISTS node_facts (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id),
  -- fact | thread | interest | mood_signal | prompt_preference (existing vocabulary)
  kind TEXT NOT NULL,
  text TEXT NOT NULL,       -- the observation, temporally grounded as today
  source_day_id INTEGER NOT NULL,
  observed_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Design points:

- **A node is a subject, a fact is evidence.** "guitar" is one node; "practices most evenings" and "wants to street-perform" are facts on it. Today every fact is its own document, which is why coverage reads as 34 unrelated tags.
- **`avg_yield_chars` is the depth signal, and we already collect it.** Response length has been recorded since day one as the energy signal and never used. A node whose questions average 40 characters of answer is a puddle; code marks it depleted rather than asking a model to guess.
- **`status` transitions are deterministic.** Asked and answered short (below a threshold, proposed 60 chars) twice: depleted. `event_date` in the past and `times_asked` >= 1: closed. Never asked: open regardless of age. A model never sets status.
- **`other` is the pressure valve** for the fixed skeleton, so a real part of someone's life that fits no bucket is stored rather than forced or dropped. If `other` accumulates, that is a signal the skeleton needs a domain, which is a code change and a visible decision.

## Extraction (System 2 rework)

The extractor's contract changes from "emit observations" to "emit observations filed into the graph":

1. The extractor receives the person's existing node list (domain, subdomain, summary, one line each) alongside the day's answer.
2. For each observation it emits `{kind, text, domain, subdomain}`. Matching an existing subdomain appends a fact to that node; a new subdomain creates a node. Domain must be one of the fixed ten, enforced by schema validation with a retry, then dropped with a loud log, never guessed by code.
3. All existing zero-trust guards carry over unchanged: person forcing, the feedback gate on prompt_preference and promptIdeas, temporal grounding to absolute dates.
4. Node summaries: when a node gains its third fact or an event passes, a maintenance step rewrites the one-line summary from its facts. This is the only LLM write to `nodes`, it touches only `summary`, and it is validated as one sentence.

`node_facts.kind` keeps the existing five-type vocabulary so mood signals stay time-bound and prompt preferences stay separable, exactly as today.

## Generation (System 3 consumption)

`Memory.getContext` and `getCoverage` are replaced by graph queries, all plain SQL, all testable:

- **Context for generation**: per person, the domain skeleton with node counts, then open nodes ordered by (never-asked first, then staleness), each with its summary, status, last_asked, and yield. The fixed-order truncation bug class disappears because selection is a query with an ORDER BY, not a budget walk over buckets.
- **Explore candidates** = thinnest domains by open-node count, plus domains with zero nodes. Exploration means opening territory the graph shows as empty, which finally makes "explore" checkable: the question's declared target must be a domain or new subdomain, not an existing node.
- **Exploit candidates** = open nodes, never-depleted, not asked within a cooldown (proposed 10 days), ordered by yield descending, with time-live nodes (event_date within a few days, or just passed and not yet closed) jumping the queue.
- The generator receives explicit candidate lists: "explore one of: family (2 nodes), daily-life (1 node), beliefs-values (empty)" or "exploit one of: job-search (rich, last asked 07-24), cora (rich, never asked)". It declares which it targeted; the declaration is validated against the list, and a miss is a rejected generation, same pattern as the topic guard.
- On dispatch, the targeted node gets `last_asked`/`times_asked` updates. On answer finalization, its yield updates. Both in code.

The existing guards (near-duplicate text, opening stem, theme) remain; they police wording while the graph polices subject matter.

## What happens to Supermemory

Retired. The `Memory` interface is deleted rather than reimplemented, because its shape (getContext/getCoverage returning prose buckets) is the flat model this design removes; generation consumes graph queries on `Ledger` directly. `SupermemoryClient`, `FakeMemory`, the launchd plist, and the `SUPERMEMORY_*` env vars go. The README privacy section improves honestly: derived memory no longer lives in a second store, one fewer service holds anything.

**Escape hatch, stated for the record:** if genuine semantic search or multi-hop temporal reasoning is ever needed, Zep/Graphiti is the graduation path, and the swap cost is one consumer (generation context assembly) because everything flows through Ledger queries.

## Migration

Memory is re-derivable from the ledger, which holds every verbatim answer. `scripts/rebuild-memory.ts` is repointed at the new extractor: wipe `nodes`/`node_facts`, replay every resolved day through graph extraction, and the whole structure materializes from real history (16 person-days today, ~30 LLM calls, under a cent). `last_asked` backfills from `person_days.prompt_text` matching during replay where the extractor can attribute a question to a node; unattributable history leaves `last_asked` null, which is honest.

Supermemory keeps running untouched until the new path is verified, then its plist is unloaded. Nothing deletes its data directory; it just stops being consulted.

## Build order

1. **Schema + Ledger queries** (tables, migration, candidate queries, status transitions, yield update). Pure, heavily tested, invisible.
2. **Extractor rework** + rebuild script repoint. Verified by rebuilding a backup ledger and reading the resulting graph by hand.
3. **Generation consumption**: candidate lists into the prompt, target declaration + validation, node bookkeeping on dispatch/finalize.
4. **Cutover**: daemon restart, Supermemory unloaded after a clean week.
5. **Eval alignment**: the planned `answerableByThem` axis becomes cheap and sharp, "does the question's target exist in this person's graph", which is a lookup, not a judgment.

Steps 1-2 are invisible in production. Step 3 is the behavior change and lands alone.

## Risks

- **Extraction quality is now structural.** A misfiled observation used to mean a weird tag; now it means a malformed graph. Mitigations: fixed domain enum with validation-retry-drop, the rebuild path (re-derivable forever), and step 2's by-hand review of the real rebuilt graph before anything consumes it.
- **Depletion thresholds are guesses.** 60 chars and two askings may mark a shy answer as a dead topic. All thresholds in config, and `status` is reversible data, not destiny; a rebuild or a manual UPDATE fixes any misjudgment.
- **The migration touches the live daemon's store.** Same discipline as the per-person migration: additive tables, `sqlite3 .backup` first, verified on a backup before touching production.
- **This obsoletes some week-old work.** The topic column and recent-topics guard shrink to wording police once the graph owns subject selection. Accepted: they were the right patch for their day and their tests carry forward.

## Out of scope

Multi-hop relationships between nodes (the design is deliberately two levels). Vector search. Ria-facing memory access (unchanged parking-lot item, though nodes make it far easier later). Changing the daily message flow, nudges, recap, or personality in any way.
