# Question Selection: the Synthesis Design

Design doc, 2026-08-02. Status: drafted from the judged competition, under review.

Provenance: three from-scratch designs (decision-theory, conversation, minimalist) were written blind to each other, judged against the live failure record alongside the incumbent (docs/superpowers/specs/2026-08-02-ee-verdict.md). The incumbent lost: it stores fact kinds and never reads them, its only closure rule is answer length, its fuzzy topic guard scores 0.33 on the exact example its own comment cites against a 0.5 threshold, and its day-stance scalar structurally cannot both guarantee variety and let a dated follow-up fire. This spec is the judge's recommended hybrid: the minimalist's exclusion-window spine with named grafts, plus the corrections for every self-contradiction the judge found in the contenders.

## What is being replaced, what survives

Replaced: `decideStance`/`stanceForPerson` (the day-stance scalar, deleted), the exploit/explore candidate menu handed to the model, the model's stance and target choice, the topic-repeat guard as a selection mechanism, `shouldDeplete` and `avg_yield_chars` as closure signals.

Survives unchanged: the ontology tables and extraction pipeline (extended, below), event-date-only LIVE and the settling veto (this week's two patches the judge kept), all wording guards (near-duplicate text, opening-stem variety, same-day frame, theme), the FallbackPromptSource chain, per-person prompts, and everything outside generation.

The division of labor becomes absolute: **code picks WHAT to ask (a subject or a seed), the model only writes the sentence.** The model no longer chooses subjects, so it can no longer repeat them.

## Owner requirements this design answers

1. **Closure is semantic, never length.** "I've liked paneer since childhood" is a complete answer at 38 chars. Budget-from-kind (below) encodes this: a settled preference earns one question ever; an open thread earns more; nothing reads answer length.
2. **`tastes-preferences` domain.** Liking paneer is not a hobby. Eleventh domain, extractor refiles on rebuild.
3. **Multi-homed facts.** The psychic-party answer is about Cora AND psychic readings AND a car. A junction table lets one fact live on several subjects, and a golden-set eval makes filing quality measurable for the first time.

## Schema changes

```sql
-- nodes: the domain CHECK gains 'tastes-preferences'. SQLite cannot ALTER a
-- CHECK, so migrateSchema does a guarded table rebuild (create new, copy,
-- drop, rename) exactly once, keyed on the constraint's text.

ALTER TABLE nodes ADD COLUMN budget INTEGER;         -- null until granted
ALTER TABLE nodes ADD COLUMN family TEXT;            -- closed vocabulary, below
ALTER TABLE node_facts ADD COLUMN resolved_at TEXT;  -- threads resolve, facts do not

CREATE TABLE IF NOT EXISTS fact_subjects (           -- multi-homing; node_facts.node_id stays the primary home
  fact_id INTEGER NOT NULL REFERENCES node_facts(id),
  node_id INTEGER NOT NULL REFERENCES nodes(id),
  PRIMARY KEY (fact_id, node_id)
);

CREATE TABLE IF NOT EXISTS seeds (                   -- the explore bank, hand-written content
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,                                -- a full, concrete question
  domain TEXT NOT NULL,
  family TEXT NOT NULL,
  UNIQUE (text)
);

ALTER TABLE generation_log ADD COLUMN lane TEXT;     -- followup | exploit | explore
ALTER TABLE generation_log ADD COLUMN seed_id INTEGER;
```

**Families** are a fixed 12-item register vocabulary in code: `food, nostalgia, people, work-school, play, body, home, plans, values, media, romance, daily-mechanics`. Seeds carry a hand-assigned family. Nodes carry an extractor-assigned family from the same closed list (a bounded judgment like `kind`: enum-validated, retried once, dropped to null with a log). Family is what catches a register spread across domains: four self-improvement questions in four different domains share one family, and this week's food spiral spanned `childhood` explores and a `hobbies` exploit that all carry `food`.

## Budget: the semantic closure mechanism

Granted at node creation from the kinds of its initial facts, **1/2/3, never 0** (the judge's correction: the minimalist's 0/1/2 grant made every settled subject unaskable from birth, contradicting its own invariant that everything is askable once):

- only `fact` kinds: **1** (one question ever: "you mentioned X, tell me the story" is legitimate exactly once)
- any `interest`: **2**
- any `thread`: **3** (cap)

Decremented at dispatch when a question targets the node. Budget 0 means finished: excluded from selection, shown to the writer model as background context only.

**Refill, the resolution rule graft:** after extraction of an answer to a question that targeted node N, if a NEW `thread`-kind fact was filed onto N (or onto it via `fact_subjects`), budget += 1 (cap 3): the subject demonstrably still has live material. If NO new thread fact arrived, every open thread on N gets `resolved_at` stamped: the person was asked, answered, and did not continue the thread, so the thread is done. This bounds an extractor mislabel to one wasted question in either direction and lets closure self-correct: a finished subject can come back to life only when a real answer breathes a new thread into it.

## Selection: windows, then lanes

All windows are **vetoes computed by SQL from generation_log and nodes**. Freshness never promotes anything (unanimous across all three designs; the direct kill of the recency-LIVE spiral).

| Window | Rule | Prevents |
|---|---|---|
| W1 settling | node has a fact observed within 2 days | yesterday's answer becoming today's question |
| W2 subject cooldown | node asked within 14 days | vada pav three days running |
| W3 domain cooldown | domain used by this person within 4 days | childhood four times in two days |
| W4 family cooldown | family used by this person within 3 days | the food register spiral across domains |
| W5 exploit run cap | this person's last 2 questions were both exploit lane | novelty starvation, all-exploit drift |

**Lanes, in strict priority order:**

**Lane 0, follow-up token.** When a node's `event_date` passes, a token exists for `liveEventWindowDays` (3). Spending it is recorded in the same transaction as the ask, and `UNIQUE` per node means it fires once, ever. **The token bypasses every window including W3 and W4** (the judge's fatal finding on the minimalist: its token sat inside the domain cooldown and could expire unspendable; and on the conversation design: its heat rule blocked the exact follow-up it celebrated). An appointment outranks all hygiene. This is the psychic-party case as a first-class mechanism, and it fires regardless of any rhythm state, which is the structural fix for the incumbent's irreconcilable scalar.

**Lane 1, exploit.** Eligible: open nodes with budget > 0 passing W1-W5. Ordered never-asked first, then stalest `last_asked`, then `id`. (The minimalist's oldest-fact-first tie-break is dropped per the verdict: it re-surfaces the most archaeological material for no articulated reason.)

**Lane 2, seeded explore.** Eligible: unused-by-this-person seeds whose domain passes W3 and family passes W4. Ordered by `id`. **The seed bank is the only hand-written content in the design and the reason abstract questions become impossible: an "area of growth you're interested in" question cannot appear because no human would write one into the bank.** Authoring order IS the cold-start curve (the conversation design's graft): the first ~20 seeds are light and concrete (food, play, daily mechanics), nostalgia and people mid-bank, values and plans deferred, so day one of an empty graph asks something warm without any special-case code. ~130 seeds at launch: the existing 30-question static bank is absorbed as seeds 1-30, ~100 written new. The bank is a checked-in file; adding seeds is a PR, not a prompt tweak.

**Joint pair selection** (decision-theory's graft, zero new constants): compute each person's top 8 eligible candidates across lanes, enumerate pairs, drop pairs violating cross-person rules (same domain today, same family today, near-identical seed), take the first pair by (lane priority sum, then person-a tie-break order). Sequential selection is gone, so neither person systematically gets second pick.

**Feasibility, proven not fallback:** 11 domains minus at most W3's exclusions (4 days x 1 domain/day) minus the partner's domain leaves >= 5 domains; the seed bank spans all 11; therefore lane 2 is never empty and no window ever needs relaxing. If lanes 0 and 1 are empty, the day is an explore day; that is a normal state, not a degradation.

## The model's contract, after selection

The writer receives, per person: the selected target (a node with its facts and family, or a seed's full text), the recent question history for wording variety, moods and preferences as tone context, and remaining open nodes as background it must not target. For a seed, the model may adapt phrasing but must preserve the seed's subject. It echoes the target id; a mismatch is validate-and-retry with the reason fed back, wording guards unchanged. `generation_log` records lane, target, seed_id. The stance column is written from the lane for continuity of old reports.

## Audits: regression as a row, not a vibe

Nightly (piggybacking the scoring poller), pure SQL over live history, each a named invariant:

- A1: no node asked twice within 14 days (W2 held)
- A2: no domain used twice within 4 days per person (W3 held)
- A3: no family used twice within 3 days per person (W4 held)
- A4: no same-day domain or family collision across the couple
- A5: every passed `event_date` either spent its token within 3 days or logged why not
- A6: no more than 2 consecutive exploit-lane days per person
- A7: no node with budget 0 was asked

Violations log loudly and land in the eval report. This week's food spiral would have been rows in A3 and A2 on day two instead of a complaint on day four.

## Testing the extractor's filing (the "how do we test that" answer)

`tests/golden/filing/`: ~20 real answers (from the ledger, names kept, they are ours) hand-labeled with expected subjects, kinds, families, and multi-homes. `scripts/eval-filing.ts` runs the real extractor against them and scores subject-match, kind-match, family-match, and multi-home recall. Run on demand like the other eval scripts; the score gates future extractor prompt changes the way the dry runs gated generation changes.

## Migration and rollout

1. Schema commit: tables/columns above, the nodes CHECK rebuild, migrateSchema guards. Invisible.
2. Extractor commit: family assignment, multi-home emission (1-3 subjects per fact, primary first), resolution/refill wiring in the filing transaction. Rebuild refiles paneer into `tastes-preferences`; budgets grant retroactively from existing kinds during rebuild.
3. Selector commit: `src/selection/` pure module (windows, lanes, pairing, ~250 lines), the writer prompt rework, stance.ts deleted, adaptive.ts rewired. Verified by a multi-day dry run against the rebuilt live graph before cutover, walking S1-S7 explicitly.
4. Seeds content: the long pole, ~130 questions. Owner reviews the bank before cutover since every explore question for months comes from it.
5. Cutover: backup, rebuild, restart. Audits live from day one.

Constants, all window-shaped, 8 total: settling 2, subject cooldown 14, domain cooldown 4, family cooldown 3, token window 3, exploit run cap 2, budget cap 3, candidate depth 8. Config block `selection`, defaults in zod, no schema default may enable anything silently.

## Honest weaknesses

- The 14-day subject cooldown refuses a genuinely hot thread with no token. If the job search develops daily, the system asks about it at most every two weeks unless an event date gives it a token. Mitigation deferred until it is observed hurting: a `development` token type (new thread fact on an in-cooldown node grants a one-shot early return) is sketched in the conversation design and can graft later without schema change.
- The rhythm may become legible: cooldown arithmetic could make Tuesdays feel like "new topic day". Watch, do not pre-engineer.
- `kind` and `family` remain bounded extractor judgments. The golden-set eval measures them; it does not make them correct.
- The seed bank ages. Seeds referencing seasons or life stages need occasional pruning; the bank is content with a maintenance cost, accepted deliberately over generated novelty, because generated novelty is where "area of growth" came from.
- Budget-from-kind trusts initial classification more than lived behavior. A subject born as three flat facts that the couple would happily discuss for an hour gets one question unless an answer resurrects it via the refill path, which requires that one question to land well. The refill path is the only self-correction; if extraction misses a thread, the subject dies quietly.

## Out of scope

Photos (phases 2-3, unchanged plan), recap, nudges, personality, participant memory access. Any change to extraction's zero-trust guards.
