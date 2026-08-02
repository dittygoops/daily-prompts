# Exploration and Exploitation, Redesigned as a Scheduling Problem

Design abstract, 2026-08-02. Lens: formal decision theory. This replaces the explore/exploit stance machinery (`src/prompts/stance.ts`), the candidate ranking in `src/ontology/ledgerOntology.ts`, and the depletion rules in `src/ontology/status.ts`. It keeps the ontology graph, the closed-vocabulary extractor, and validate-and-retry generation.

The one-line claim: **explore/exploit is the wrong axis.** It is a binary mode flag bolted on top of a ranking, and every one of the four live failures is a failure of that framing rather than a failure of tuning inside it. What we actually have is a scheduling problem: two slots per day, forever, a growing set of subjects with time-varying value, and hard deadlines on a few of them. This document derives a deterministic index over *typed moves* from an explicit objective, and shows the four failures becoming structurally impossible rather than merely less likely.

---

## 1. What is being optimized

**In words.** Maximize, over a rolling horizon of about eight weeks, the couple's felt sense of (a) being known, and (b) being kept curious, subject to a hard floor that no question may read as not having listened.

Three things follow immediately, and each contradicts how the current system behaves.

**The unit of quality is the week, not the day.** A question is read in the context of the six that preceded it. "How is the guitar going?" is excellent on day 1 and grating on day 3. This means the reward is a functional over a *sequence* of actions, not a sum of independent per-action rewards. Any mechanism that scores candidates in isolation and picks the max, as the current ranking does, is optimizing the wrong object. Satiation must be a first-class state variable, not a filter bolted on.

**A merely-good question today can beat a great question today.** If asking about the psychic party on the day of the party burns the "how did it go" follow-up that would have been the best question of the month, the greedy pick loses. The slot is scarce (one per person per day, non-transferable, non-bankable), so subjects compete for slots and the correct policy holds a subject until its value peaks. This is deadline scheduling, not greedy ranking.

**Answer length is not the reward.** Owner requirement, and correct on the merits. "I've liked paneer since childhood" is a complete answer; a 900-character answer about a stressor may be a worse day for the couple than a 40-character delighted one. `avg_yield_chars` is retired entirely, and no metric in this design reads answer length as quality.

**The formal object.**

For day *t* and person *p*, let *q* be the question sent and *h* the history of questions and answers before it. Write

```
J = sum over t, p of  gamma^t * [ Rec(q, h) + Tim(q, h) + Nov(q, h) + beta * VOI(q, h) ]  -  Cost(q, h)
```

subject to: exactly one *q* per person per day, and no *q* may repeat a subject inside the couple's own memory of the last few weeks.

- `Rec` (recognition): the question demonstrably rests on something this person told us. Maximal when it names a specific subject and a specific detail. This is what "being known" means operationally.
- `Tim` (timeliness): the question arrives at the right moment relative to a real-world event. This term is what a friend has and a survey does not.
- `Nov` (novelty): the subject is not one of the last several subjects. Diminishing and sign-flipping: novelty is worth little on its own but its absence is expensive.
- `VOI` (value of information): the question adds state that raises the expected value of *future* questions. This is the **only** justification for exploring, and stating it that way immediately fixes the failure mode where explore is treated as a quota to fill.
- `Cost` (emotional cost): negative value from a question that repeats, intrudes, mistimes a sensitive subject, or asks the person to invent its own subject. Asymmetric and large. A bad question in an intimate ritual is not a missed point, it is a small injury.
- `gamma`: about 0.98 per day. Near 1 because the horizon is weeks. A near-1 discount is exactly why holding a subject for its peak is rational.

`beta` is the price of exploration. Note what it is *not*: it is not a probability, not an epsilon, and not a schedule. It is the exchange rate between a fact learned today and felt value tomorrow.

---

## 2. Why this is not a bandit, stated precisely

Bandit framing is available and I am declining most of it, for four reasons that are specific to this product rather than generic.

**One pull per arm, ever.** At one question per person per day against a subject population growing about four nodes per day, the modal subject is asked about zero or one times in its lifetime. The current spec already discovered this empirically and killed `avg_yield_chars` over it. But the consequence is larger than that fix admitted: **per-arm reward estimation is impossible in principle here.** UCB, Thompson sampling, and epsilon-greedy all exist to resolve uncertainty in a per-arm reward estimate through repeated pulls. We will never have a second sample. Any confidence interval we compute will never narrow. Importing that machinery would be pure ritual.

**Exploration here means acquiring state, not reducing variance.** Because estimation is hopeless, "explore" cannot mean "sample an uncertain arm". It means: create arms that do not exist yet. That is a different objective with a different measure, and it is *observable* rather than *inferred*: we know exactly how many subjects we have in `tastes-preferences`, so VOI can be computed from coverage instead of from a posterior. This is the single most important correction in the design, and it is why the mechanism below has an explicit `InfoGain` term computed from node counts rather than an optimism bonus computed from ask counts.

**Arms satiate, which breaks the i.i.d. reward assumption.** The value of asking about vada pav depends on whether we asked about vada pav yesterday. This is not noise, it is a deterministic function of our own recent actions, and it should be *modeled as state*, never treated as stochasticity to be averaged over.

**Answering an arm creates arms.** The psychic-party answer spawned `car-2027`, enriched `cora`, and opened `psychic-readings`. Branching factor is part of an arm's value and there is no slot for it in any standard index. Here it is another component of `InfoGain`.

What survives from the literature: the **index policy** shape (compute a scalar per candidate action, take the max) and the **restless-bandit** intuition that arms evolve whether or not you pull them. Gittins is the honest ancestor of the index below, with the honest caveat that Gittins optimality requires stationarity and independence, and we have neither, so what follows is a hand-derived index whose every term traces to a term in `J`, not a theorem.

---

## 3. State model

### 3.1 Schema changes

Three changes to the ontology, each answering an owner requirement.

**A subject has facets, not a home.** `nodes.domain` (single FK-ish column, `UNIQUE (person, subdomain)`) becomes a many-to-many:

```sql
CREATE TABLE node_facets (
  node_id INTEGER NOT NULL REFERENCES nodes(id),
  domain  TEXT NOT NULL,            -- enum, now 11 values
  PRIMARY KEY (node_id, domain)
);
```

`nodes.domain` is kept as `primary_domain` for display and for `print-graph` only; nothing in selection reads it. The psychic-party answer files under `relationships-friends` (Cora), `beliefs-values` (psychic readings), and `plans-future` (the car) at once, which is what actually happened and what the current single-home column had to lie about.

**A fact can belong to several subjects.** `node_facts.node_id` becomes:

```sql
CREATE TABLE fact_subjects (
  fact_id INTEGER NOT NULL REFERENCES node_facts(id),
  node_id INTEGER NOT NULL REFERENCES nodes(id),
  PRIMARY KEY (fact_id, node_id)
);
```

The extractor emits `nodeIds: number[]` instead of `nodeId: number`, still as ids from a closed vocabulary, still with unknown ids dropped and logged. Capped at 3 ids per observation in code so the model cannot smear one fact across the whole graph.

**New domain: `tastes-preferences`.** Liking paneer is not a hobby, it is not childhood, and forcing it into either corrupts coverage counts for both. Eleven domains total. SQLite cannot alter a CHECK constraint in place, so this is a create-copy-swap (see Migration).

**New table: `moves_log`.** Every selection writes its full decision, including the runner-up, so any question can be explained after the fact and so counterfactual replay has something to read:

```sql
CREATE TABLE moves_log (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  person TEXT NOT NULL,
  move_type TEXT NOT NULL,      -- FOLLOW_UP | DEEPEN | BRANCH | REVISIT | OPEN
  node_id INTEGER,              -- null for OPEN
  facet TEXT NOT NULL,          -- the domain this question counts against
  seed_id TEXT,                 -- non-null for OPEN
  index_value INTEGER NOT NULL,
  runner_up TEXT,               -- serialized move + index
  answered INTEGER              -- filled at finalization
);
```

`moves_log` is also the **satiation source of truth**, and this is load-bearing given the one-day extraction lag. Yesterday's *facts* do not exist yet when today's question is chosen; yesterday's *move* does. Every recency term below reads `moves_log`, never `node_facts`, so the design never depends on information that arrives late.

### 3.2 Continuation class: "should we go further down this path", decided semantically

The schema already types facts as `fact` / `thread` / `interest` and the current system ignores it. That type is the semantic depth signal the owner asked for, and it costs nothing to start using.

Per subject, code computes a **continuation class** from the facts attached to it. This is a pure function of rows, run at selection time, stored nowhere:

| class | condition | means |
|---|---|---|
| `pending` | the node has `event_date` set, or a `thread` fact whose text carries a date | something happened or is about to; there is a specific thing to ask about |
| `open` | at least one unresolved `thread` fact with no date | an ongoing situation with no deadline |
| `standing` | only `interest` facts, or interests plus settled facts | a durable taste or affinity; supports revisiting, not following up |
| `settled` | only `fact` facts | complete statements about the world; there is no next question here |

"I've liked paneer since childhood" is an `interest` plus a `fact`. Class `standing`. It is a complete answer at 38 characters, and the class says so without ever looking at the character count. "I'm meeting Amol Thursday" is a dated `thread`. Class `pending`. It is a complete answer too, and it has an obvious next question. **Length distinguishes neither; the fact type distinguishes both.**

**The resolution rule, which is how mislabels self-correct.** When a question targets node *N* and the answer arrives, if extraction attaches no new `thread` fact to *N*, then every existing `thread` fact on *N* is marked `resolved_on = <date>` in code. A resolved thread stops counting toward `pending` or `open`. So a subject that the extractor wrongly typed as an open thread demotes to `settled` after exactly one question, and a subject that genuinely still has a thread keeps it. This bounds the cost of an extraction mislabel to one question, and it is arithmetic over rows, not a second judgment call.

**Where model judgment lives, stated honestly.** The model does exactly two things: it types each observation into a three-value enum at extraction time (validated against the enum, one observation at a time, on text it can see), and it writes question prose from a target chosen entirely in code (validated by retry). It never chooses a subject, never chooses a stance, never decides whether a subject is exhausted, and never writes to `nodes`. That is the boundary the project has learned to hold.

`status` collapses. `depleted` is retired (it was a length rule). `closed` is retired (continuation class `settled` plus the subject cooldown already produces the behavior, without a state that can get stuck). `nodes.status` remains only as a manual override with values `active` and `muted`, where `muted` means the owner said never ask about this.

### 3.3 Per-subject state used by selection

- continuation class (derived, above)
- `event_date`, and `follow_up_asked` (derived from `moves_log`)
- last date this subject was a target (`moves_log`)
- number of the person's last 5 questions that shared a facet with this subject (`moves_log`)
- fact count and distinct-day count (branching evidence)
- untouched facets: facets of this node that have never appeared in `moves_log.facet` for this person

---

## 4. The action space: typed moves

There is no stance. The day does not have a mode. There are five move types, and they compete on one scale.

1. **`FOLLOW_UP(node)`**: a `pending` subject whose moment has arrived. "How did the psychic reading party go?"
2. **`DEEPEN(node)`**: an `open` subject with an unresolved undated thread. "Any progress on the job search?"
3. **`BRANCH(node, facet)`**: a known subject approached through a facet never used. Their `cora` node has been asked through `relationships-friends`; branch through `plans-future`.
4. **`REVISIT(node)`**: a `standing` or `settled` subject brought back after a long gap, from a new angle. This is the move that answers "when does a good friend bring a subject back up".
5. **`OPEN(domain, seed)`**: acquire state in a thin domain, through a concrete seed subject.

Replacing a two-valued flag with a five-valued typed action is most of the fix. "Six straight explore days" was possible because explore was a *mode* the model could keep choosing; there is no mode to choose here, and `FOLLOW_UP` outscores `OPEN` by construction whenever a live follow-up exists.

### 4.1 The seed bank, and why `OPEN` carries a noun

`OPEN` never hands the model a bare domain. Handing a model "write a question about beliefs-values" is exactly the instruction that regenerates the banned nominate-a-category shape, and it is how four self-improvement questions went out in six days. Instead, `OPEN` selects a **seed**: a concrete everyday subject, drawn deterministically in code.

```sql
CREATE TABLE seeds (
  id      TEXT PRIMARY KEY,
  domain  TEXT NOT NULL,
  family  TEXT NOT NULL,         -- ~15 static families: food, commute, music, sleep,
                                 -- self-improvement, money, school, pets, weather, ...
  text    TEXT NOT NULL          -- "what's your favorite thing to cook"
);
```

`data/prompts.json` already holds 30 of these; they are re-tagged with domain and family and the bank is grown to about 150 (sizing in Weaknesses). Selection rule, entirely in code:

- eligible seeds are those in the target domain, not used by this person in 90 days, not used by *either* person in 14 days, whose `family` has not been used by this person in 14 days
- among eligible, pick least-recently-used globally, tie broken by id

Then the generator's job is "write a warm, short question for <name> about <seed text>, in their voice, given what we know". Validation checks in code that the emitted question contains a content word from the seed or declares a `topic` whose nearest match is the seed. **Abstraction retreat is structurally unavailable** because the target is a noun, not a category, and the check is mechanical.

The `family` column is the guard that content-word similarity could never be. "Growth", "a skill you'd like to build", and "an area of development" share no vocabulary and all three are `family = self-improvement`. A static hand-written mapping catches what an embedding threshold did not.

---

## 5. Selection algorithm, step by step

Run once per day, after extraction of the previous day has completed. Pure function of `(ledger snapshot, today)`; same inputs give the same move, always.

### Step 1: enumerate candidate moves per person

For each of the person's nodes, and for each move type, emit a candidate if the type's structural precondition holds:

- `FOLLOW_UP` requires class `pending` and `follow_up_asked = false`
- `DEEPEN` requires class `open`
- `BRANCH` requires at least one untouched facet and at least 2 facts
- `REVISIT` requires class `standing` or `settled`
- `OPEN` emits one candidate per domain with an eligible seed

Expect roughly 30 to 120 candidates per person at current graph size.

### Step 2: apply hard gates (eligibility, not scoring)

A candidate is dropped outright if any of these fire. Gates are hard because they encode the emotional-cost floor, and a floor that can be outbid is not a floor.

- **G1, subject cooldown.** This node was a target within `subjectCooldownDays = 21`. *Exception:* `FOLLOW_UP` whose `event_date` is in `[today - 5, today]` and whose follow-up has not been asked. This is the only exception in the design and it is gated on a *column*, not on freshness.
- **G2, settling.** This node acquired a fact within `settleDays = 2`, or was a target within 2 days. Same single exception. **This gate is the direct fix for the recency-LIVE bug: a fresh fact is a reason to wait, not a reason to ask.** Freshness never promotes anything. `LIVE` now means one thing only, an `event_date` inside its window.
- **G3, facet run.** The candidate's facet was the facet of 2 or more of this person's last 4 questions. Hard cap on runs, independent of the soft penalty in Step 3.
- **G4, seed eligibility.** For `OPEN`, the seed rules in 4.1.
- **G5, sensitivity.** The node has a `mood_signal` within 7 days containing distress markers (a static keyword list plus the `signals` rows tied to that day), or `status = 'muted'`. Dropped for all move types. A person processing something alone does not get probed about it.
- **G6, near-duplicate subject.** `nearestPrior` similarity >= 0.5 against subjects targeted in the last 21 days. This is the existing check, retained, now applied to the *target* rather than to the *wording*.

### Step 3: score the survivors

All terms are integers in "utils" and live in config. They are **ordinal**: what matters is the ordering they induce, and the tests assert orderings (see Section 8).

```
V(m) = Base(m) + Timeliness(m) + InfoGain(m) - Satiation(m)
```

**Base** (prior expected felt value of the move type):

| move | base | reasoning |
|---|---|---|
| `FOLLOW_UP` | 100 | the single highest-`Rec`, highest-`Tim` action available |
| `DEEPEN` | 55 | high `Rec`, no deadline |
| `OPEN` | 50 | low `Rec`, all its value in `VOI` |
| `BRANCH` | 45 | moderate `Rec`, moderate `VOI` |
| `REVISIT` | 40 | pure `Nov` recovery, no new information |

**Timeliness**, the `Tim` term, nonzero only for `FOLLOW_UP` and `REVISIT`:

- `FOLLOW_UP`, with `d = today - event_date` in days:
  - `d >= 0`: `max(0, 60 - 12 * |d - 1|)`. Peak at `d = 1` (60), then 48, 36, 24, 12, 0 at `d = 6`. Peaking one day *after* rather than on the day is deliberate: on the day, the honest question is "excited?", which is thin; one day after, "how did it go" is the best question this system has produced.
  - `-3 <= d <= -1` and no pre-event ask yet: `20`. Anticipation is worth something and much less than aftermath.
- `REVISIT`, with `g = days since this subject was last a target`: `0` if `g < 21`, else `min(40, 2 * (g - 21))`. Zero for three weeks, then ramping to a 41-day cap.

  **This curve is the answer to "when does a good friend bring a subject back up".** Not on a fixed schedule, and not never. The shape encodes a specific claim: returning to a subject inside three weeks reads as being stuck on it, and returning after a month or two reads as having remembered. The ramp is linear because there is no data to justify anything fancier, and Section 9 says so plainly.

**InfoGain**, the `VOI` term:

- `OPEN(domain)`: `30 * (1 - min(1, open_nodes_in_domain / 3))`. A zero-node domain scores 30, a one-node domain 20, three or more scores 0. **This is what makes exploration self-limiting.** The current design has explore competing on a separate track with no notion of enough; here, exploring a domain reduces the reason to explore it again, automatically, with no cooldown counter to tune. The `exploreCooldownCount` hack disappears.
- `BRANCH`: `15`. A new facet reliably produces facts on a subject already rich.
- `FOLLOW_UP`: `5`. Follow-ups do produce facts (the 816-character psychic answer spawned three subjects), just not as their point.
- `DEEPEN`, `REVISIT`: `0`.

**Satiation**, the `Nov` term with its sign flipped, read entirely from `moves_log`:

- **facet satiation:** `25 * (count of this person's last 5 questions whose facet equals this candidate's facet)`. One prior hit costs 25, two cost 50, three cost 75.
- **family satiation** (for `OPEN`): `20` if this seed's family appeared in the person's last 10 questions. Covers the cross-domain abstraction case that facet satiation misses.
- **type satiation:** `10` if this move type was used by this person on each of the last 2 days. Prevents a monotonous rhythm of follow-ups even when material supports it.

### Step 4: joint selection over the pair

The budget is two questions per day and the couple reads them together, so the decision is a **joint** one over `(m_a, m_b)`. Take the top 8 scored candidates per person and enumerate all 64 pairs:

```
V_pair(m_a, m_b) = V(m_a) + V(m_b) + Coupling(m_a, m_b)
```

`Coupling`:
- `-1000` if the two share a facet **and** at least one alternative pair with disjoint facets exists. Effectively a hard constraint with a defined relaxation: if literally every pair collides (possible only in the first days), the penalty drops out and the collision is logged.
- `-15` if both moves are `OPEN`.
- `+10` if exactly one of the two is a `FOLLOW_UP`. Variety inside the day, and it keeps the shared theme writable.

Pick argmax, ties broken by `(higher V(m_a), lower node id)`. Sixty-four evaluations of an integer function is free, and exhaustive enumeration is the *honest* formulation of a two-slot assignment problem. This step is the direct fix for "both people, same domain, same day", which no amount of per-person ranking can prevent because per-person ranking cannot see the other person.

### Step 5: hand off, validate, record

The generator receives, per person: the move type, the target node with its dated verbatim facts (up to 4, as today) or the seed text, the person's recent question history, moods, preferences, and the off-limits list. It writes prose. Validation in code, retried up to 4 times:

- the declared `targetNodeId` equals the node we chose (not "is on a list", equals; there is no list to choose from anymore, which removes an entire class of miscompliance)
- for `OPEN`, the question contains a seed content word or the declared topic nearest-matches the seed
- existing guards retained: no near-duplicate wording, no repeated topic, no reused opening frame, no cross-person leakage
- on final-attempt failure of the *target* check, ship with `moves_log.node_id` recorded and a loud log, as today

Then write `moves_log`, set `last_asked`, and at finalization set `answered` and run the resolution rule from 3.2.

---

## 6. Cold start

Day 0 has no nodes, so only `OPEN` moves exist and `InfoGain` is maximal everywhere. Rather than let ties decide, a fixed opening schedule runs for 10 days:

- an ordered list of 11 domains (a hand-chosen sequence, lightest first: `daily-life`, `tastes-preferences`, `hobbies-interests`, `childhood`, `family`, `career-academics`, `relationships-friends`, `health-body`, `plans-future`, `beliefs-values`, `other`)
- person A walks it from index 0, person B from index 5. Disjoint by construction for 10 days.
- seed selection within the domain is the ordinary rule from 4.1.

From roughly day 3, extraction has produced nodes and `DEEPEN` and `FOLLOW_UP` start winning on their own scores; the schedule is a floor, not a lock, and any move scoring above the day's scheduled `OPEN` takes the slot. No warm-up flag, no special-casing: `InfoGain` already makes early days explore-heavy, and the schedule only removes arbitrariness from the ordering.

A **new domain added later** (which is exactly what `tastes-preferences` is on migration day) cold-starts itself: coverage 0 gives `InfoGain = 30`, so it wins an `OPEN` slot within a few days without a backfill or a special rule.

---

## 7. The failure record, walked

### 7.1 Six straight explore days, when stance was model judgment

Under the current design the model was asked to aim for a mix, then told the target ratio, then shown its own stance history, and produced zero exploits across six days. The current fix moved the decision into `decideStance`, which is right in spirit but produces a *day mode* both people then inherit.

Under this design **there is no stance and nothing to ask the model about.** A person with a `pending` node scoring `100 + Tim + 5` cannot lose a slot to an `OPEN` capped at `50 + 30 = 80`. Concretely, on a day with one two-day-old event and one thin domain:

- `FOLLOW_UP(psychic-party)`: `100 + 48 + 5 - 0 = 153`
- `OPEN(tastes-preferences)`: `50 + 0 + 30 - 0 = 80`

The follow-up wins by 73. Six explore days in a row is only possible if the person genuinely has no `pending` and no `open` subject for six days, which is the case where exploring is correct.

### 7.2 Four self-improvement questions in six days, invisible to content-word guards

Those were `OPEN`-shaped questions whose targets were abstractions. Four mechanisms now stand between the system and a repeat, and they are independent, so I will name what each one catches and what it misses.

1. `OPEN` targets a seed noun, never a category. "What's an area of growth you're interested in?" has no seed to derive from; validation rejects a question that names no seed content word.
2. Facet satiation: if two of those four shared a domain (the real ones spanned `career-academics` and `beliefs-values`), the second costs 25 and the third 50, dropping `OPEN` below `DEEPEN` at 55.
3. **Family satiation is the one that actually catches this case.** All four map to `family = self-improvement`. The second within 10 days pays 20 and the seed itself is ineligible for 14 days. Honest note: mechanisms 1 and 2 alone would *not* have caught four questions spread across four different domains. The static family table is the load-bearing part, and it is load-bearing precisely because it is hand-written rather than derived.
4. G6 near-duplicate subject at 0.5 similarity, retained, which catches the easy half.

### 7.3 This week: food 4 days for A, vada pav 3 days for B, childhood 4x in 2 days, both people same domain same day

Four distinct bugs in one week. Each has a distinct structural fix.

**Vada pav 3 days running.** Cause: the recency-LIVE rule promoted whatever was answered yesterday to today's top candidate, because `isSettling` was overridden by an `isLive` that counted fresh facts. Under this design G2 drops any node with a fact inside 2 days *and* G1 drops any node targeted inside 21 days, and the only exception is gated on `event_date`, a column that vada pav does not have. Day 2 is impossible; day 3 is impossible twice over.

**Food 4 days running for A.** Cause: no facet-level memory at all. Now: day 2 costs 25 (facet) and probably 20 more (family `food`), so a food candidate needs to beat its rival by 45. Day 3 trips G3 (2 of the last 4 questions on that facet) and is dropped, not penalized. A run of 3 is unreachable; a run of 2 is possible only when the day-2 food candidate outscores everything else by 45 or more, which in practice means it is a live follow-up about a specific meal, and that is a question a friend would ask.

**Childhood picked 4 times in 2 days.** Cause: explore had no cooldown at all and thin domains stay thin until an answer arrives, which is a day late, so `childhood` stayed the argmin of `domainCounts` four selections running. Two fixes: (a) `InfoGain` decays with coverage rather than ranking by argmin, so a domain moving from 0 to 1 node loses 10 points instead of staying top; (b) satiation reads `moves_log`, which is written at *dispatch*, so the second selection already sees the first. The one-day extraction lag is designed around rather than suffered.

**Both people, same domain, same day.** Cause: two independent per-person rankings over the same domain-count vector, which will collide whenever the two people's graphs are similarly shaped. Now: Step 4's joint enumeration with a `-1000` coupling penalty. Not a tuned discouragement, a constraint with an explicit and logged relaxation condition.

### 7.4 The psychic-party follow-up, the one success, preserved and made routine

Timeline under this design. Party on 2026-07-26. On 07-26 the answer arrives; overnight extraction creates node `psychic-party` with `event_date = 2026-07-26` and a dated `thread` fact, filed under facets `relationships-friends` and `beliefs-values`, with `cora` also receiving the fact via `fact_subjects`.

On 07-27, `d = 1`:

- `FOLLOW_UP(psychic-party)`: base 100 + timeliness 60 + infogain 5 = **165**
- G2 would normally drop it (a fact landed yesterday), but the exception fires: `event_date` inside `[today - 5, today]`, follow-up not yet asked
- next best that day, a `DEEPEN` on the job search: `55 + 0 + 0 - 0 = 55`

Chosen by a margin of 110. Not a coincidence, not a model noticing: the highest-scoring configuration in the entire design is exactly a real event one day past. **The best question the system ever produced is the design's global maximum.**

Then, and this is the part the current design gets wrong, the *day after*. The answer is 816 characters, extraction attaches no new `thread` fact to `psychic-party`, so the resolution rule marks its thread resolved and the class flips to `settled`. `FOLLOW_UP` no longer emits. G1 blocks the node for 21 days. `REVISIT` scores 0 until day 21 and then ramps. Meanwhile `car-2027` is a *new* node with 2 facts and untouched facets, and `cora` gained a fact, so the material genuinely lives on in subjects that are not the party. On 08-17 (`g = 21`) `REVISIT(psychic-party)` becomes eligible at 40 and grows; a callback around late August, phrased as a callback, is exactly when a friend would bring it up again.

And the paneer contrast, which is the whole point of the semantic rule: "I've liked paneer since childhood" creates a `standing` node. `FOLLOW_UP` never emits for it (no `pending`), `DEEPEN` never emits (no thread), so it is not askable tomorrow at any score. It waits 21 days for `REVISIT`. A 38-character answer and an 816-character answer get opposite treatment, and length appears nowhere in the reasoning.

---

## 8. What is measurable

Deliberately biased toward checks that need no LLM, because this project has been burned by model judgment three times and an LLM judge is a fourth opportunity.

**Determinism and golden tests.** Selection is a pure function of `(snapshot, today)`. Snapshot the ledger, assert the chosen move. These are ordinary unit tests.

**Ordering tests, not value tests.** The constants are ordinal, so tests assert propositions, not numbers: a `FOLLOW_UP` at `d = 1` beats every `OPEN` at maximum `InfoGain`; a second `OPEN` in the same family within 10 days loses to any `DEEPEN`; a `REVISIT` at `g = 20` scores below a `BRANCH`. These survive retuning; assertions on 153 versus 80 would not.

**Counterfactual replay is the acceptance gate.** Rebuild the graph from the 24 live person-days, then replay selection day by day and assert, mechanically:

- no subject targeted twice inside 21 days (catches vada pav)
- no facet appearing 3 times in any 4-day window per person (catches food)
- no facet shared by both people on any day where a disjoint pair existed (catches childhood)
- no `family` appearing 3 times in any 10-day window (catches self-improvement)
- the 07-27 psychic follow-up is selected (protects the success)

If replay does not reproduce all five, the design is wrong, not the thresholds. This is a falsifiable gate and it runs offline for free.

**Ongoing metrics, all computable from `moves_log` alone:**

| metric | target |
|---|---|
| facet entropy over trailing 14 days per person | >= 2.2 bits (of a 3.46-bit maximum over 11 domains) |
| longest same-facet run | <= 2 |
| follow-up latency: median days from `event_date` to `FOLLOW_UP` | 1 to 2 |
| follow-up coverage: nodes with `event_date` that got a follow-up within 5 days | > 80% |
| minimum subject reuse interval | >= 21 days |
| share of days with a `FOLLOW_UP` or `DEEPEN` | 30% to 50% |
| share of scored days where the winner's margin over the runner-up is < 10 | reported, not targeted; a high value means the index is not discriminating and the constants need work |

**Felt-experience proxies, from the ledger, explicitly excluding answer length:** skip rate, response latency, and explicit feedback sentiment. Plus a monthly two-question human rating from the couple ("did any question this month feel repetitive", "did any question feel like we had listened"), which is the only ground truth that actually measures the objective.

**The one retained LLM-judged axis:** does the question name a concrete subject the person can answer without inventing one. Cheap, already half-enforced in code by the seed word check, and the half that needs judgment is small enough to be safe.

---

## 9. Migration sketch

1. `sqlite3 ledger.db ".backup"` first, as always (a plain copy drops WAL rows).
2. Domain enum: create `nodes_new` with the 11-value CHECK, copy, swap, recreate indexes. Same treatment for any CHECK referencing domains.
3. Create `node_facets`; backfill one row per node from `nodes.domain`. Rename `nodes.domain` to `primary_domain`. Selection stops reading it in the same commit.
4. Create `fact_subjects`; backfill from `node_facts.node_id`. Leave `node_facts.node_id` in place, unread, for one release, then drop.
5. Add `node_facts.resolved_on TEXT` (nullable). Backfill: for each node that was a target of a question that was answered, mark its threads resolved unless a later fact re-opened them. This makes the resolution rule's history consistent from day one rather than treating every historical thread as still open.
6. Create `moves_log`. Backfill from `generation_log.target_node_id` / `target_domain` where present, plus the existing argmax attribution already implemented for `last_asked`. Rows we cannot attribute are left out; the satiation windows are 5 to 21 days, so a partly sparse backfill degrades to "slightly more permissive for the first three weeks", which is acceptable and should be logged.
7. Create `seeds`; import the 30 rows from `data/prompts.json`, hand-tag each with domain and family, and write the remaining ~120. This is the largest piece of manual work in the migration and it is deliberately manual: the family taxonomy is the guard that a learned similarity metric already failed to be.
8. Stop writing `avg_yield_chars` (leave the column). Migrate `status`: `depleted` and `closed` both become `active`; `muted` is new and unset.
9. Delete `src/prompts/stance.ts` and its wiring. `decideStance` and `stanceForPerson` have no analogue; the generator prompt's stance paragraphs are replaced by a single "your target is given, write it" instruction.
10. `scripts/print-graph.ts` gains a `--why <date>` mode that prints the day's full scored candidate list from `moves_log`. Reading a day's decision by hand is the operational acceptance test.

Build order: schema and backfill (invisible) → scorer as a pure module with ordering tests → counterfactual replay gate → generator handoff and validation → cutover, with `print-graph --why` reviewed daily for the first week.

---

## 10. Weaknesses of this design

**The constants are invented, and no amount of live data will fit them.** There are about a dozen: five bases, two curves, three satiation weights, three coupling terms. Two people at one question per day produce 14 observations a week, with no counterfactual and no repeated measurement. These will never be fit statistically, and any claim that they will be is dishonest. The defense is that only the *ordering* matters and the ordering is coarse, which is why the tests assert orderings. But it remains true that someone hand-tuned twelve numbers, and if the ordering is wrong somewhere, the system will be confidently and silently wrong in exactly that region.

**The continuation class still rests on the extractor's three-way label.** I have argued this is the narrowest place model judgment can sit and that the resolution rule bounds a mislabel to one question. Both are true. It is still model judgment inside the loop, and a systematic bias (an extractor that labels everything `fact` because most sentences look declarative) would quietly collapse the graph to `settled` and turn the system into a pure `OPEN` machine. Detection: monitor the ratio of `thread` to `fact` labels per week; a sharp drop is the alarm. There is no automatic recovery.

**`REVISIT` is the weakest move and I know it.** "When does a good friend bring a subject back up" is genuinely answered by external triggers: a season, an anniversary, the subject reappearing in a different context, seeing something that reminds you. What I built is a 21-day timer with a linear ramp, which is a guess wearing the costume of a curve. The right version fires `REVISIT` when a *new* fact arrives that shares a facet with an old settled subject, and I did not build it because the one-day extraction lag makes the trigger awkward and I did not want to hand-wave the timing. This is the most likely place a judge finds the design thin, and correctly.

**`event_date` reliability is an unowned dependency.** The entire `FOLLOW_UP` path, which is the design's best move and its answer to the psychic-party case, assumes extraction reliably sets `event_date` on time-bound subjects. It does not reliably do so today. Without it, the party degrades to a `DEEPEN` at 55, competing on even terms with a job-search question, and the best question of the month becomes a coin flip. This is a dependency, not a mitigation, and it is the single highest-leverage extraction improvement in the system.

**Deadline dominance.** A busy fortnight with four events could hand `FOLLOW_UP` every slot and starve exploration entirely, which is exactly the mirror image of the six-explore-day failure. Type satiation (10 after two consecutive days) is far too weak to prevent this. A governor is needed and I have not designed it well: a cap of at most 4 of any person's last 7 questions being `FOLLOW_UP` or `DEEPEN` is the obvious blunt version, and blunt caps interact badly with a genuinely eventful week in someone's life, which is the week you most want to be paying attention.

**Seed bank exhaustion, with arithmetic.** If roughly half of days are `OPEN`, that is about one seed per day across the couple, 365 per year, against a 90-day per-seed cooldown and a 14-day family cooldown. 150 seeds sustains this, but unevenly: the family cooldown binds first, and if the 150 seeds cluster into 6 popular families rather than spreading across 15, eligible-seed sets go empty and the rule has to relax. The relaxation order is defined (drop family cooldown, then the 14-day cross-person rule, then the 90-day rule) but each relaxation is a small quality loss, and the design does not currently alarm when it relaxes. It should.

**The objective sums over people and ignores the pair.** `J` is written per person and added. But part of the ritual's value is in reading each other's answers, and nothing in the mechanism models that beyond a `-15` for two `OPEN`s and a `+10` for exactly one follow-up. A design that took the shared reading seriously would score pairs on complementarity, not just on collision avoidance. I do not know how to do that without model judgment, which is why it is not here.

**Joint enumeration does not scale.** 64 pairs is free; 5 people would be 32,768 and would need a proper assignment solver. This is fine because the product is two people by construction, but it should be said out loud rather than discovered.

**Nothing here models the *question*, only the subject.** Two questions about the same node can differ enormously in quality, and all of that variance sits with the generating model behind a validate-and-retry harness that checks compliance, not craft. This design makes the target right and leaves the prose exactly as reliable as it is today.

---

## Out of scope

Multi-hop node relationships, embedding search, weekly recap, nudges, personality, the message flow, and any change to how answers are collected.
