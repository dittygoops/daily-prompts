# Question Selection: the Synthesis Design

Design doc, 2026-08-02. Status: **revision 2**, after adversarial and implementation-readiness review. Revision 1's twelve adversarial findings are each resolved inline and marked (F1..F12); the implementation review's rulings are adopted wholesale where not contradicted (its work breakdown, interfaces, migration sequence, and 25 decisions stand except where this revision changes the mechanism).

Provenance: three from-scratch designs judged against the live failure record alongside the incumbent (2026-08-02-ee-verdict.md). The incumbent lost on verified evidence. This is the judge's recommended hybrid, corrected twice.

## The division of labor

**Code picks WHAT to ask (a node or a seed); the model only writes the sentence.** The model no longer chooses subjects, so it cannot repeat them. Selection is a pure function of (ledger state, date): windows veto, lanes order, pairing coordinates the couple.

Replaced: the day-stance scalar, the candidate menu, model target choice, length-based depletion, the topic-repeat guard as selection. Survives: ontology tables and extraction (extended), wording guards plus a restored anchor check (F12), fallback chain, per-person prompts, everything outside generation.

## Schema (delta from live)

```sql
-- nodes: CHECK gains 'tastes-preferences' (11th domain), via the verified
-- FK-safe rebuild in Migration below. status and avg_yield_chars drop in the
-- same rebuild. New columns: budget INTEGER, family TEXT.

ALTER TABLE node_facts ADD COLUMN resolved_at TEXT;

CREATE TABLE IF NOT EXISTS fact_subjects (      -- every home INCLUDING the primary (impl decision 18)
  fact_id INTEGER NOT NULL REFERENCES node_facts(id),
  node_id INTEGER NOT NULL REFERENCES nodes(id),
  PRIMARY KEY (fact_id, node_id)
);

-- F1: the token gets a real table and a real data source. One token per
-- distinct event per node, so recurring events (gym meets, therapy, trips)
-- each earn their follow-up; rev 1's once-ever-per-node is gone.
CREATE TABLE IF NOT EXISTS followup_tokens (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id),
  event_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  spent_at TEXT,                                -- set in the same transaction as the ask
  UNIQUE (node_id, event_date)
);

CREATE TABLE IF NOT EXISTS seeds (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL, domain TEXT NOT NULL, family TEXT NOT NULL,
  UNIQUE (text)
);

ALTER TABLE generation_log ADD COLUMN lane TEXT;      -- followup | exploit | explore
ALTER TABLE generation_log ADD COLUMN seed_id INTEGER;
-- F11: windows and audits must read dispatch-time snapshots, never mutable
-- joins. A later refile of a node's domain or family must not rewrite window
-- history. These two columns are written at dispatch and never updated.
ALTER TABLE generation_log ADD COLUMN ask_domain TEXT;
ALTER TABLE generation_log ADD COLUMN ask_family TEXT;
```

**Every window, audit, and lane query reads asks as: one row per (date, person), max(id), fell_back = 0, person IS NOT NULL** (the live table already holds a hotfix duplicate and seven legacy null-person rows; impl decision 6).

**Event dates (F1's data source):** the extractor's contract gains `eventDate` in two places: on `newNode` (a dated subject creates its node with the date) and as an optional field on any observation citing an existing `nodeId` (a new date on a known subject updates `event_date` and mints a token row if the date is new for that node). Dates obey the existing absolute-date rule. Tokens are minted at filing; nothing else creates them.

## Families (F2 resolved)

Fifteen registers, in code: `food, nostalgia, people, self-improvement, work-school, play, body, home, plans, values-beliefs, media, romance, daily-mechanics, events-outings, money`. Rev 1's list dropped `self-improvement` and thereby failed its own motivating case: the four live self-improvement questions mapped to four different families. Verified against them now: all four carry `self-improvement` under this list.

Seeds carry a hand-assigned family. Nodes carry an extractor-assigned family from the same closed vocabulary (bounded judgment, enum-validated, retried once, then null with a loud log). A null family blocks nothing and sets nothing, degrading to no-constraint rather than wrong-constraint, and audit A8 tracks the null rate so silent erosion of W4 is visible (F2's null-bypass concern: measured, not wished away).

## Budget: semantic closure (F3, F4, F5 resolved)

Granted once per node, when its creating filing commits, from ALL facts filed onto it in that transaction (primary or secondary home; a node created only as a secondary home grants from the facts homed onto it): only `fact` kinds 1, any `interest` 2, any `thread` 3. Never 0, cap 3.

Dynamics, each rule reading or writing state that another rule reads (nothing write-only, F3):

- **Ask:** budget decrements at dispatch (`recordAsk`: last_asked, times_asked, budget, one statement).
- **Resolution:** after extraction of an answer to a question that targeted node N, if no new thread-kind fact landed on N (via any home), N's open threads get `resolved_at` stamped AND **budget drops to 0**. The subject was asked, answered, and offered nothing new: it is done. This makes `resolved_at` load-bearing (rev 1 stamped it and nothing read it, the incumbent's exact sin) and restores the one-wasted-question bound.
- **Refill (F5's contradiction resolved in favor of life):** a new thread-kind fact filed onto N **by any filing whatsoever**, targeted or not, primary or multi-homed, sets budget = min(cap, max(budget, 0) + 1). Evidence of life counts regardless of which question surfaced it. The weaknesses section's "dies quietly" is now true only if extraction misses the thread entirely, which the golden-set filing eval measures.

## Selection

### Windows (all vetoes; freshness never promotes; date comparisons are signed, F12)

| | Rule | Default |
|---|---|---|
| W1 settling | any fact observed within `settlingDays`, counted across ALL homes via fact_subjects | 2 |
| W2 subject cooldown | node asked within `subjectCooldownDays` | 14 |
| W3 domain cooldown | `ask_domain` used by this person within `domainCooldownDays` | 4 |
| W4 family cooldown | `ask_family` used by this person within `familyCooldownDays` | **7** |
| W5 exploit run cap | this person's last `exploitRunCap` asks were all lane followup or exploit | 2 |

F7 resolved, union reading for W1: the psychic-party answer settles Cora, psychic-readings, AND the car node for 2 days, which is precisely the D+1 car-question spiral prevented; they unfreeze at D+3 into ordinary ordering. This is 2-day settling, not the 7-day co-mention freeze the verdict rejected. A node *created* by a filing is settling by construction (its facts are new).

F12 resolved, W5 counts followup days as exploit days (impl decision 5): six days of token-token-exploit alternation cannot evade the novelty floor. Fallback and skipped days have no lane and are invisible to the run count (impl decision 7). W4 at 7 days (rev 1 had 3, undisclosed drift from the parent's 14): verified against the live failure, the four self-improvement questions span 6 days, so 3 would have caught only one pair; 7 catches three of four, and 15 families minus at most 7 in-window minus the partner's leaves 7+, keeping feasibility.

### Lanes, strict priority

**Lane 0, follow-up token.** Eligible: an unspent token whose `event_date` is in `[today - tokenWindowDays, today)`, signed, so a future event never looks passed (F12). Bypasses W1-W5 and budget (a token ask does not require budget and does not decrement it; F11's A7 trap). Spend = `spent_at` in the ask's transaction. Expired-unspent tokens are audit violations, full stop (A5 is a real invariant now, not "or logged why").

**Lane 1, exploit.** Eligible: open nodes, budget > 0, passing W1-W5. Ordered (F4's fix, which also makes threads drive exploitation as the semantics always intended): **(1) nodes with an unresolved thread, newest thread date first; (2) never-asked nodes without threads, richest first; (3) previously asked, stalest first; then id.** Rev 1's absolute never-asked-first precedence is gone: at ~1.3 new nodes/person/day against at most 0.67 exploit asks/day, the never-asked queue grows monotonically and nothing would ever be asked twice, making budgets and refill decorative. Under this ordering a live thread outranks archaeology, and re-asking is reachable, so the budget mechanism actually runs.

**Lane 2, seeded explore.** Eligible: seeds whose domain passes W3 and family passes W4, not used by this person within `seedReuseDays` (90; F10's exhaustion fix, restoring the parent's reusable-seed model; the bank never drains, it cycles). Ordered by id; authoring order is the cold-start curve.

### Pairing (F6 resolved)

The token has genuine precedence, taken from the verdict verbatim: **a person holding a fireable token IS selected on lane 0; pairing only chooses the partner's candidate, and on a cross-person collision the PARTNER re-selects, never the token.** Both people holding tokens the same day both fire, cross-person rules waived: appointments outrank hygiene, including pairing hygiene. Only when neither person holds a token does pair enumeration run: both top-`candidateDepth` lists, drop pairs violating cross-person rules (same-day domain, same-day family; rev 1's "near-identical seed" rule is deleted, F12, distinct hand-written texts need no similarity metric), order **lexicographically by (best lane in pair, then worse lane in pair, then a's index, then b's index)**, never by sum (F6b: a sum let a tokenless tie beat structure; lexicographic cannot). If every pair is dropped: relax same-day family, then same-day domain, each relaxation recorded in `Selection.relaxations` and written as an audit row; W1-W5 are never relaxed (F6d).

### Feasibility (F10 resolved by construction, not proof-by-marginals)

The seed bank must satisfy, enforced by the loader AND a test against the checked-in file: >= 8 seeds per domain spanning >= 4 families, >= 6 seeds per family spanning >= 3 domains. With 90-day reuse and those minimums, lane 2 is non-empty for any legal window state; the 30-day walk test (impl test 9) proves it against the real bank rather than arithmetic.

## The writer's contract

Per person, exactly one `ASSIGNED TARGET` block (node with dated kind-tagged facts, or a seed's full text), history for wording variety, moods/preferences as tone, background nodes it must not target. It echoes the target id; mismatch retries with the reason; **a final-attempt mismatch throws and the static bank ships** (impl decision 3: an unattributed ask corrupts every window, which is worse than a fallback day). Restored from the parents (F12): the **anchor check**, the written question must share at least one content word with its target node's subdomain, summary, or facts (deterministic, reuses `contentWords`), which is the structural guard against altitude retreat on exploit days; seeds are anchored by construction. `generation_log` records lane, target, seed_id, ask_domain, ask_family at dispatch; `stance` is written `exploit` for lanes followup/exploit and `explore` for explore, with the three-way truth in `lane` (impl decision 4).

## Audits (F11 resolved)

Nightly, inside the scoring poller's own try/catch, pure SQL over dispatch-time rows only (`ask_domain`/`ask_family`, never joins to mutable node columns), deduped as defined above, persisted to `audit_log` with UNIQUE (run_date, audit, person, subject):

- A1 no node asked twice within W2's window
- A2 no `ask_domain` twice within W3 per person
- A3 no `ask_family` twice within W4 per person
- A4 no same-day domain/family collision across the couple, except token days; relaxation rows land here
- A5 no token expired unspent
- A6 no more than `exploitRunCap` consecutive followup-or-exploit days per person
- A7 **deleted** (rev 1's version compared past asks to current mutable budget, unsound; the selector refuses budget-0 nodes at dispatch and that is a code invariant with a test, not an audit)
- A8 null-family node rate, informational

## Constants

Ten, all window-shaped, in a `selection` config block (zod ints, defaults, no switches): settlingDays 2, subjectCooldownDays 14, domainCooldownDays 4, familyCooldownDays 7, tokenWindowDays 3, exploitRunCap 2, budgetCap 3, candidateDepth 8, seedReuseDays 90, anchorMinSharedWords 1. Divergences from the credited parents are deliberate and stated: subject cooldown 14 not 21 (a 20-node graph per person cannot spare 21-day freezes), domain 4 not 5 (11 domains not 12), family 7 (see W4 note).

## Migration (F9 resolved, sequence verified by execution in review)

The nodes rebuild must run with foreign keys OFF, outside any transaction, per SQLite's documented procedure: guard on `sqlite_master` containing 'tastes-preferences'; `PRAGMA foreign_keys = OFF`; BEGIN IMMEDIATE; create `nodes_new` (11-domain CHECK, budget, family, no status, no avg_yield_chars); copy; drop old; rename; `PRAGMA foreign_key_check` must return zero rows or rollback; COMMIT; `PRAGMA foreign_keys = ON`. `fact_subjects`, `followup_tokens`, `seeds` are created AFTER the rebuild so the rebuild has only `node_facts` as a child. `schema.sql`'s own nodes definition updates to the 11-domain form in the same commit so fresh databases skip the rebuild. `wipeGraph` deletes `fact_subjects` and `followup_tokens` before `node_facts` before `nodes` (FK order). Operationally: daemon stopped and verified with lsof, WAL checkpointed, `.backup` taken, full rehearsal on a copy including seed load, rebuild, print-graph read by hand, and a pure multi-day selector dry run walking the acceptance scenarios, before touching the real file.

Rebuild grants budgets from each node's creating filing during replay (all facts of that filing), mints tokens for event dates discovered in replay, and applies resolution/refill in date order so a rebuilt graph matches a lived one.

## Work breakdown, interfaces, tests, seeds

The implementation review's nine-package breakdown (P0 schema/ledger through P9 migration execution), its interface definitions in `src/selection/types.ts`, its twelve named tests, and its seed logistics (TSV format, stable ids, static bank copied not moved, coverage minimums enforced twice, warmth-ordering asserted, owner review stamp gating the loader) are adopted as written, with these deltas from this revision: `SelectionInput` gains `tokens` (fireable token rows) and loses nothing; `AskRow` gains `askDomain`/`askFamily`; the selector exposes the anchor check for the writer's validation loop; P0 additionally owns `followup_tokens`; P2 additionally owns event-date extraction; test 3 (token bypasses everything) adds the budget-0 case; test 8 (refill) adds the untargeted-filing refill case; a new test asserts resolution zeroes budget. The seed bank remains the long pole and the owner review remains a gate.

## Honest weaknesses

- W2 still cannot stop sibling-node spirals by itself (F8: the real food spiral crossed node ids). The defenses are W4 with the corrected vocabulary, W1's union settling, and extraction's near-duplicate node check; if food-register siblings proliferate anyway, the fix is extraction-side merging, not another window. A9 (informational: distinct nodes sharing a family asked within W2's window) would make this visible and can be added cheaply.
- `kind`, `family`, and now `eventDate` are bounded extractor judgments; the golden-set eval measures them, it cannot make them correct. Lane 0's reliability is exactly event-date extraction reliability, which the decision-theory parent named as an unowned dependency and is now owned: it is measured in the filing eval.
- The thread-first exploit ordering means a person who answers everything in closed declarative sentences (no threads extracted) gets mostly explore days. That is arguably correct behavior, and visibly so in A6/A8 trends, but it is a behavior change to watch.
- Budget-0-via-resolution trusts one extraction pass. The refill path is now reachable from any filing, which is the mitigation, but a subject can still die on a misread answer until some later mention revives it.

## Out of scope

Photos (phases 2-3), recap, nudges, personality, participant memory access, extraction's zero-trust guards.
