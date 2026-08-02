# Exploration and Exploitation, Redesigned as Conversation

Design abstract, 2026-08-02. Scope: replaces the stance decision, the candidate algorithm, and the depletion model. Keeps: one question per person per day, LLM wording with validate-and-retry, all state in SQLite, extraction after answers.

## Thesis

The current system is a bandit wearing a graph. It has arms (nodes), a reward proxy (answer length), an explore rate (a 1-in-3 stance rule), and cooldowns bolted on after each failure. Every live failure came from bandit thinking: length as reward gave depletion by verbosity, freshness as value gave recency-LIVE which made yesterday's answer today's question, and "aim for a mix" gave six explore days.

A close friend does not run a bandit. They run a small number of very specific habits. This design derives the mechanism from those habits, names each one, and makes each one a column, a table, or a comparison. Nothing in the selection path is a judgment call by a model. The model receives exactly one subject and writes one sentence.

The central structural change: **the code does not offer the model a menu. The code picks the subject.** Today's algorithm hands over five exploit candidates plus three explore domains and asks the model to choose. That is still delegated judgment, just narrowed. Here the selector returns one subject, one required question form, and one weight budget. The model's only remaining freedom is wording, which is the only thing it is reliably good at and the only thing a validator can police.

## The nine principles

Each principle is stated as a fact about human conversation, then as a mechanism.

### P1. Closure, not exhaustion

A friend stops asking about a subject when the subject is finished, not when the answers get short. "I've liked paneer since childhood" is complete. "I'm waiting to hear back from the interview" is not. The difference is semantic, not lengthwise.

Mechanism: `facts.kind` already types observations as `fact` / `thread` / `interest`, unused today. It becomes load-bearing. Add `event`. A subject's openness is computed, never judged:

```
openness(subject) = count(open threads on subject) + count(pending hooks on subject)
```

`avg_yield_chars` stops being read. Depletion by length is deleted, not tuned.

### P2. The beat

After you answer a question about X, a friend does not raise X again tomorrow. The beat length depends on what X is: an event has a beat of one day (you follow up right after), an open thread a couple of weeks, a settled fact a season.

Mechanism: one date column, `subjects.return_not_before`, written by code at two moments (ask, and fact arrival) as a pure function of kind and outcome. Cooldown, settling, and staleness collapse into this one field, which makes the whole thing inspectable with one `SELECT`.

| trigger | new `return_not_before` |
| --- | --- |
| any fact observed on the subject, date `d` | `max(current, d + 3)` |
| subject asked, answered, still has open threads | `asked + 10` |
| subject asked, answered, no open threads left | `asked + 45` |
| subject asked, skipped | `asked + 7` |
| co-mentioned subject (shares a fact with the asked subject) | `max(current, asked + 7)` |

The first row is the structural fix for failure 3: a fact observed yesterday freezes its subjects for three days, so yesterday's answer physically cannot be today's question. There is exactly one bypass, P3, and it requires a dated event.

### P3. The pending appointment

The one time a friend returns to a topic fast is when something has changed since last time: the party happened, the deadline arrived, a new development landed. "How did the psychic reading party go" was the best question this system ever produced, and it was produced by accident, as a side effect of a ranking heuristic. Accidents do not repeat reliably. Make it a row.

Mechanism: a `hooks` table. Every hook is a dated appointment with a subject. A hook due today outranks everything else in the system and bypasses P2. Four kinds, covering the four real reasons a friend circles back:

- `event_passed`: an event fact with a date. Due `event_date + 1`. Expires unfired after 7 days (after a week, "how did it go" is stale) and downgrades to a `development` hook at +30.
- `horizon`: a stated intention with a time reference ("I'll decide by August"). Due at the stated date, or `observed + 14` if the reference does not resolve to a date.
- `development`: a new fact lands on a subject that was finished. Due `observed + 3` (P2's settling still applies). This replaces the current reopen-on-fact status flip with a scheduled callback, which is what reopening was actually trying to express.
- `season`: an `interest` subject with no facts for 90 days. Created by a nightly deterministic sweep, not by the model. Due immediately, capped at one per person per 14 days.

Hooks are created two ways only: the extractor emits them as typed pointers (subject id plus a date it read out of the answer), or the nightly sweep computes them from dates already in the database. No model ever writes a hook priority.

### P4. Rooms, not just subjects

Four food questions in four days is a failure even when the four foods are different, because a friend notices they are standing in the same room. Subject-level cooldown cannot see this; the current design has no domain-level memory at all outside the explore list.

Mechanism: a domain cooldown of 4 days applied to the domain of the selected subject, enforced for every tier except due hooks. Plus the co-mention dampener in P2, which catches most of the cross-domain version (childhood-food and paneer-liking share facts, so asking one freezes the other for 7 days).

Also: a new domain, `tastes-preferences`. Liking paneer is not a hobby and is not daily life. Filing it in `hobbies-interests` is why food questions looked like three different rooms.

### P5. Not the same room as your partner, same day

Both people got childhood questions on the same day. Two people in a shared ritual notice this instantly and it makes the whole thing feel generated.

Mechanism: the two people are selected sequentially, in a fixed order (whoever has an earlier due hook; ties broken by `date` parity so it alternates), and the second person's selector excludes the first person's chosen domain, provided the second person has candidates in at least two domains. The shared theme is an angle ("a small daily ritual", "something that surprised you"), not a domain, so this costs nothing structurally.

### P6. After something heavy, go light

A friend who just heard about your back injury or your grandmother does not open the next day with another heavy question. And a friend who has asked you six breezy questions in a row is not really talking to you either. The alternation runs both directions.

Mechanism: every subject has a `weight` in `{light, medium, heavy}`, assigned by code from a static domain map at creation:

- heavy: `health-body`, `beliefs-values`
- medium: `career-academics`, `family`, `relationships-friends`, `plans-future`, `childhood`
- light: `daily-life`, `hobbies-interests`, `tastes-preferences`, `other`

Two counters per person, both derived, both integers:

- `heat`: set to 2 when a heavy subject is asked, or when a `mood_signal` was recorded in the last 3 days. Decrements 1 per day. While `heat > 0`, only `light` subjects are eligible.
- `levity_streak`: consecutive light picks. At 5, `light` subjects are excluded for that person if any medium or heavy candidate exists.

Both counters read from `generation_log` and `signals`, no new state.

### P7. Novelty is a residual, not a rate

A friend does not budget 33% new-territory questions. They ask a new-territory question when they have no live business with you, which after a while is rare and early on is constant. Setting an explore rate is what produced six explore days: the rate was a target the model could satisfy while ignoring everything else.

Mechanism: there is no stance decision. `decideStance` and `stanceForPerson` are deleted. The stance is whatever tier the winner came from, recorded after the fact for analytics. Explore is the last tier, reached only when tiers A through D are empty for that person today.

### P8. Explore still carries its subject, and code supplies the subject

The current spec already knows that "write a question about beliefs-values" regenerates the nominate-a-category shape, and it patched this with a prompt rule. A prompt rule is model judgment. Since it is code's job, code does it.

Mechanism: a checked-in seed bank, `src/prompts/exploreSeeds.ts`, roughly 12 concrete everyday nouns per domain ("the last thing you cooked from scratch", "your walk to class", "a mug you always reach for"). The selector picks a domain from the explore rotation, then the least-recently-used unused seed in that domain, and hands the model the seed text. Seed usage is recorded in `generation_log.seed_id`. The model wraps the seed in a question; it does not invent the territory.

Explore rotation: domains ordered by open-subject count ascending, filtered by a 21-day per-domain explore cooldown read from `generation_log.target_domain`. This is the direct fix for childhood being explored four times in two days.

### P9. Don't reuse the shape

"What's one thing you're..." twice in a week reads as a template even when the subjects differ. A friend's questions have varied grammar because their reasons for asking vary.

Mechanism: the selector assigns a required `form` from a rotation, excluding the person's last 3 forms:

`retrospective` ("how did X go"), `status_check` ("where are you with X"), `detail_zoom` ("what does X actually look like"), `preference` ("which X do you reach for"), `origin` ("when did X start"), `hypothetical` ("would you rather X or Y").

Form is validated two ways in code: the model echoes the form label (cheap, cross-checkable against the sentence's interrogative word via a small lexical map) and the question's first three tokens must not match the first three tokens of any of the person's last 5 questions. Form assignment is also constrained by hooks: an `event_passed` hook forces `retrospective`, which is exactly the shape that produced the psychic-party question.

## State model

```sql
-- Renamed from nodes. Same identity rule (one subject per person per name).
CREATE TABLE subjects (
  id INTEGER PRIMARY KEY,
  person TEXT NOT NULL CHECK (person IN ('a','b')),
  domain TEXT NOT NULL CHECK (domain IN (
    'career-academics','childhood','family','relationships-friends',
    'hobbies-interests','tastes-preferences','health-body','daily-life',
    'beliefs-values','plans-future','other')),
  name TEXT NOT NULL,                 -- was subdomain
  summary TEXT NOT NULL,
  weight TEXT NOT NULL CHECK (weight IN ('light','medium','heavy')),
  return_not_before TEXT,             -- P2, the single beat column
  last_asked TEXT,
  times_asked INTEGER NOT NULL DEFAULT 0,
  last_fact_date TEXT,                -- for dormancy and season hooks
  finished_at TEXT,                   -- set by code when openness hits 0 + 30d
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (person, name)
);

CREATE TABLE facts (
  id INTEGER PRIMARY KEY,
  person TEXT NOT NULL CHECK (person IN ('a','b')),
  kind TEXT NOT NULL CHECK (kind IN ('fact','thread','interest','event')),
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','resolved','settled')),
  event_date TEXT,                    -- non-null only for kind='event'
  resolves_fact_id INTEGER REFERENCES facts(id),
  source_day_id INTEGER NOT NULL,
  observed_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- P: a fact belongs to several subjects. The psychic-party answer is about
-- Cora AND psychic readings AND a car, and those are three different future
-- conversations. Single-home was the known simplification; this removes it.
CREATE TABLE fact_subjects (
  fact_id INTEGER NOT NULL REFERENCES facts(id),
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  role TEXT NOT NULL CHECK (role IN ('primary','secondary')),
  PRIMARY KEY (fact_id, subject_id)
);

CREATE TABLE hooks (
  id INTEGER PRIMARY KEY,
  person TEXT NOT NULL CHECK (person IN ('a','b')),
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  fact_id INTEGER REFERENCES facts(id),
  kind TEXT NOT NULL CHECK (kind IN ('event_passed','horizon','development','season')),
  due_date TEXT NOT NULL,
  expires_date TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','fired','expired','superseded')),
  created_at TEXT NOT NULL
);
CREATE INDEX hooks_due ON hooks(person, state, due_date);
```

`signals` is unchanged. `generation_log` gains `target_subject_id`, `target_form`, `seed_id`, `tier` (additive nullable columns, no FK, matching the existing convention).

### Is this subject finished

Computed, in this order, entirely in code:

1. `openThreads = SELECT count(*) FROM facts f JOIN fact_subjects fs ... WHERE f.kind='thread' AND f.status='open'`
2. `pendingHooks = SELECT count(*) FROM hooks WHERE subject_id=? AND state='pending'`
3. If `openThreads + pendingHooks > 0`: **open**. Not finished, at any age, regardless of how short the answers were.
4. Else if `last_fact_date` is within 30 days: **settling**. Eligible again after `return_not_before`, but not asked eagerly.
5. Else: **finished**. `finished_at` is stamped. It leaves the candidate pool entirely.

A finished subject re-enters only two ways: a new fact arrives (`development` hook), or 90 days pass on an `interest` subject (`season` hook). Both are hooks, so both go through the same door.

Thread resolution, the semantic part, is a typed pointer and not free judgment. The extractor already picks subject ids from a closed vocabulary; it now also gets the person's open threads with ids and may emit `{resolves: factId}` on an observation. Code applies it. Three code guards:

- A `resolves` pointer to a fact that is not an open thread on a subject touched by the same observation is dropped with a log.
- If the same extraction emits a resolution and a new open thread on the same subject, the subject stays open. Code arbitrates, not the model.
- A `thread` whose text contains no future or unresolved marker from a small closed list (`will`, `going to`, `wants to`, `plans`, `hoping`, `waiting`, `hasn't`, `still`, `deciding`, `next`) is demoted to `fact`. This keeps the model from labeling everything a thread to look useful.

## The daily algorithm

Pure function of `(database state, today)`. No model call before a subject is chosen. Testable as a table.

```
selectDay(today):
  order = personsOrderedBy(earliestDueHook, then dateParity)
  chosen = {}
  for person in order:
    chosen[person] = selectFor(person, today, exclude=domainsOf(chosen))
  return chosen

selectFor(person, today, excludeDomains):
  heat         = heatFor(person, today)             # P6
  levity       = levityStreakFor(person, today)     # P6
  recentDomains= domainsAskedWithin(person, today, 4)   # P4
  blockedDom   = recentDomains ∪ excludeDomains          # P5

  # --- Tier A: due appointments. Bypasses P2 and P4, never P6-heat. ---
  A = hooks WHERE person=? AND state='pending' AND due_date <= today
            AND (expires_date IS NULL OR expires_date >= today)
            AND NOT (heat > 0 AND subject.weight != 'light')
      ORDER BY rank(kind: event_passed=0, horizon=1, development=2, season=3),
               due_date ASC, subject_id ASC
  if A nonempty: return exploit(A[0].subject, form=formFor(A[0].kind), tier='A')

  # --- Common eligibility for tiers B-D ---
  eligible(s) = s.finished_at IS NULL
              AND (s.return_not_before IS NULL OR s.return_not_before <= today)
              AND s.domain NOT IN blockedDom
              AND weightAllowed(s.weight, heat, levity)

  # --- Tier B: live open threads (the normal exploit) ---
  B = eligible subjects with >=1 open thread whose newest open thread is
      between 3 and 21 days old
      ORDER BY newestOpenThreadDate DESC, subject_id ASC
  if B nonempty: return exploit(B[0], form=rotate(person), tier='B')

  # --- Tier C: aged threads, asked in the past tense. Max one per 14 days. ---
  if daysSinceLastTierC(person) >= 14:
    C = eligible subjects with >=1 open thread older than 21 days
        ORDER BY newestOpenThreadDate ASC, subject_id ASC
    if C nonempty: return exploit(C[0], form='retrospective', tier='C')

  # --- Tier D: standing interests gone quiet (a small season return) ---
  D = eligible subjects with kind='interest' facts and
      last_fact_date <= today - 45
      ORDER BY last_fact_date ASC, subject_id ASC
  if D nonempty: return exploit(D[0], form=rotate(person), tier='D')

  # --- Tier E: explore. Code picks domain and seed. ---
  dom  = domains ORDER BY openSubjectCount ASC, fixedIndex ASC
         FILTER domain NOT IN blockedDom
         FILTER NOT exploredWithin(person, domain, 21)
         FILTER weightAllowed(domainWeight(domain), heat, levity)
         (relax filters in the order: 21-day explore cooldown, then P4, then P5)
  seed = leastRecentlyUsedUnusedSeed(dom)
  return explore(dom, seed, form=rotate(person), tier='E')
```

`weightAllowed(w, heat, levity)`: `heat > 0` requires `w == 'light'`; `levity >= 5` forbids `w == 'light'`; otherwise all pass. If both fire (a person 5 light days deep who also just had a mood signal), heat wins, because going light after heavy is the safer error in an intimate ritual.

Filter relaxation is ordered and logged, so an empty pool degrades predictably instead of throwing.

### What the model receives

```
PERSON A: Aditya
  TODAY'S SUBJECT (assigned, not chosen by you): subject 14, health-body / back-pain
  REQUIRED FORM: retrospective
  WHY NOW: event_passed hook, event dated 2026-07-30
  ITS MATERIAL (verbatim, dated):
    - [2026-07-28] Has back pain from bench pressing.
    - [2026-07-28] Plans to try dead hangs and stretching.
  DO NOT open with any of these frames: "What's one" / "How is your" / "When did you"
  Write one question about subject 14 in the retrospective form. Echo
  "targetSubjectId": 14 and "form": "retrospective".
```

For explore, `TODAY'S SUBJECT` is replaced by `TODAY'S SEED` with the seed text and its domain.

### Validation and retry, all code

1. `targetSubjectId` must equal the assigned id (or `targetExplore` the assigned domain plus `seedId`). Any other value is rejected, not coerced.
2. Lexical grounding: the question must share at least one non-stopword token with the subject `name` or with one of the supplied facts (for explore, with the seed text). This turns the existing `answerableByThem` judge axis into a string operation.
3. Opening frame: first three tokens must not match the first three tokens of the person's last 5 questions.
4. Form echo must match the assigned form, and the question's interrogative word must be in that form's allowed set.
5. Existing checks stay: single question, length, no cross-person leakage of the other's material (mechanical, since each person's prompt block contains only their own subject).
6. `MAX_ATTEMPTS = 4`. On exhaustion, **do not ship an unattributed question**. Ship a code-authored template for the assigned subject: `retrospective` becomes `How did things go with {name}?`, `status_check` becomes `Where are you with {name} these days?`. A plain but correct question costs less emotionally than a wrong one, and unlike today's fallback the bookkeeping stays intact.

### Bookkeeping

At dispatch: `subjects.last_asked = today`, `times_asked += 1`, hook (if any) `state='fired'`, `generation_log` row with tier, subject, form, seed. At finalization (answered or skipped): `return_not_before` per the P2 table, applied to the asked subject and to every co-mentioned subject. At extraction (one day later, one transaction): facts, `fact_subjects`, resolutions, new hooks, `last_fact_date`, `return_not_before` bumps, `finished_at` recomputation for touched subjects. Nightly sweep: expire stale hooks, create `season` hooks, recompute `finished_at`.

## Cold start

Days with no graph are the normal state for a week, not an error.

- Person A follows a fixed opening rotation; person B follows the same rotation offset by one, so P5 holds on day one without any special case. Order, chosen by conversational warmth rather than by information gain: `tastes-preferences`, `daily-life`, `childhood`, `hobbies-interests`, `relationships-friends`, `career-academics`, `plans-future`, `family`, `health-body`, `beliefs-values`. Heavy domains are deliberately last. A friend does not open with your health.
- Tiers B through D are disabled until a person has at least one subject with an open thread that is at least 3 days old, which lands around day 4. Tier A is live from day 2: if the first answer contains a dated event, the follow-up fires on schedule, and that is the single best thing this system does.
- The 21-day explore cooldown is suspended while a person has fewer than 5 subjects, otherwise the rotation strands itself. The 4-day domain cooldown is not suspended.

## The failure record, walked

**Failure 1: six straight explore days, stance was model judgment.** There is no stance to judge. The tier that produced the winner is recorded after the fact. Six explore days can now only mean six days on which every person had zero due hooks, zero open threads aged 3 to 21 days, zero aged threads, and zero quiet interests. After the first week that state is visible in the database and is itself the bug report, not a silent preference. Analytics: `SELECT tier, count(*) FROM generation_log GROUP BY tier`.

**Failure 2: four self-improvement questions in six days.** Those four questions pointed at subjects in `career-academics` and `hobbies-interests`. The 4-day domain cooldown caps either domain at 2 appearances in 6 days, and `return_not_before` prevents the same subject twice. To reach four, the selector would need four distinct domains, which by definition is not four self-improvement questions. The abstract-shape problem is also structurally gone: the model is handed a named subject with verbatim facts and cannot retreat to "an area of growth" without failing validation rule 2.

**Failure 3a: food four days running for person A.** With `tastes-preferences` split out, food subjects live in two domains at most, each on a 4-day cooldown, and the co-mention dampener freezes food subjects sharing facts with the asked one for 7 days. The reachable worst case is two food questions in six days, in different rooms of food. This is a real improvement rather than a guarantee; see weaknesses.

**Failure 3b: the same vada-pav subject three days running for person B.** Cause was recency-LIVE turning yesterday's fresh facts into today's top candidate. Recency-LIVE does not exist here. LIVE is replaced by hooks, and a hook requires a dated event, not a fresh fact. Meanwhile P2's first row sets `return_not_before = observed + 3` on every subject a new fact touches, so the vada-pav subject is frozen for exactly the days it repeated on. The only bypass, Tier A, requires an `event_date`, which a food preference does not have.

**Failure 3c: explore had no cooldown, childhood picked 4 times in 2 days, both people same domain same day.** Three independent fixes, any one of which would have prevented it: the 21-day per-domain explore cooldown (P8), the 4-day domain cooldown applied to explore as well as exploit (P4), and the cross-person same-day domain exclusion (P5). The relaxation order matters: P5 is relaxed last, so the both-people-same-day version is the hardest to reproduce.

**Success 4: the psychic-party follow-up, preserved and made deliberate.** Walked in full:

1. Day D, an answer mentions a psychic reading party on 2026-07-27.
2. Day D+1, extraction files an `event` fact with `event_date = 2026-07-27`, multi-homed via `fact_subjects` to `psychic-readings` (primary), `cora`, and any subject the sentence also touched. It creates an `event_passed` hook, due `2026-07-28`, expiring `2026-08-03`.
3. On 2026-07-28 the hook is due. Tier A fires. It bypasses the 3-day settling and the 4-day domain cooldown. `heat` is 0 (nothing heavy recently), so weight does not block it. Form is forced to `retrospective`.
4. The model receives subject `psychic-readings`, the event fact, and the required form. It writes "How did the psychic reading party end up going?" Validation checks the id, the token overlap ("psychic"), and the opening frame.
5. The 816-char answer arrives. Extraction files its facts, multi-homed: `car-2027` gets a new thread, `cora` gets enriched. The event fact is marked `resolved`. `psychic-readings` now has openness 0 and begins its 30-day settle toward finished. The car thread becomes Tier B material about ten days later, and a `horizon` hook is created if the answer named a date.
6. Nothing about this depended on ranking luck. It is a row with a due date.

The regression risk this replaces: under the current design, the same follow-up depends on `isLive` ordering surviving the next round of cooldown patches. Here it is the highest-precedence tier in the algorithm and has a dedicated fixture.

## What is measurable

The selector is a pure function of `(SQLite state, date)`, so all of this is testable without an LLM and without spending anything.

- **Determinism and golden replay.** Replay the 24 live person-days into a fixture database and assert the selected subject for each subsequent day. Any change to thresholds shows up as a diff on a readable table.
- **Four failure fixtures as gates.** One fixture per failure above, each asserting the selector cannot produce the failing sequence. These block merge.
- **SQL counters, no judge needed.** Domain repeat interval histogram (target: zero pairs under 4 days). Subject repeat interval (target: zero under 7). Explore share by tier (informational, not a target, per P7). Hook latency, `fired_date - due_date` (target: 0 or 1 for `event_passed`). Hook fire rate (pending hooks that expire unfired; a rising number means the tiers above them are starving). Heavy-day spacing (target: no two heavy days within 3). Consecutive light days (target: max 5). Finished-subject re-ask count (target: 0 outside hooks).
- **Validator pass rate by rule.** Which of the five rules fails most, and how often attempt 4 falls back to the template. A rising template rate means the selector is picking subjects the model cannot write about, which is the main failure mode of this design.
- **Judge axes shrink to two.** Emotional safety and single-question stay LLM-judged. Subject grounding becomes rule 2, a string operation. `answerableByThem` becomes an id lookup, as the current spec already anticipated.
- **Shadow mode.** Before cutover, run the selector daily and log what it would have picked next to what shipped. Three days of shadow output read by hand is the acceptance gate, the same role `print-graph.ts` plays for the rebuild.

## Migration sketch

The current schema is 3 commits old and has roughly 24 person-days of derived data, so this is cheap.

1. `sqlite3 .backup` first. Non-negotiable, WAL mode makes a file copy lossy.
2. `subjects`: create the new table (the domain CHECK constraint changes, so SQLite requires a new table rather than an `ALTER`), `INSERT ... SELECT` from `nodes` mapping `subdomain -> name`, `weight` from the static domain map, `return_not_before = last_asked + 10` where `last_asked` is set, `last_fact_date` from the max `observed_date` of its facts. `status='depleted'` rows migrate to `finished_at = updated_at` only if they also have zero threads after step 3; otherwise they migrate to open, because depletion by length was wrong and its verdicts should not be inherited.
3. `facts` and `fact_subjects`: `INSERT ... SELECT` from `node_facts`, one `primary` row each. `kind` already matches for three of four values. `status` defaults to `settled` for `fact` and `interest`, `open` for `thread`.
4. New `tastes-preferences` domain: existing food and preference subjects are re-domained by hand. There are fewer than ten and this is a `UPDATE subjects SET domain=...` list, reviewed by eye, not an LLM pass.
5. `hooks`: cannot be backfilled by SQL, because event dates live in answer prose. One replay of the existing answers through the reworked extractor (24 person-days, well under a cent) produces facts, resolutions, and hooks together. The existing argmax attribution for `last_asked` carries over unchanged.
6. Additive columns on `generation_log`: `target_subject_id`, `target_form`, `seed_id`, `tier`, all nullable, following the existing `runMigrations` pattern.
7. `nodes` and `node_facts` are dropped only after the shadow-mode week passes. `avg_yield_chars` migrates as a dead column and is deleted in a later cleanup, so a rollback stays possible.
8. Deleted code: `src/prompts/stance.ts` entirely, `isRich` and `shouldDeplete` in `status.ts`, and the multi-candidate list building in `ledgerOntology.ts`. `shouldClose` is replaced by the openness computation. The generation prompt loses the candidate-menu block and the stance instructions, which is the largest single reduction in what the model is asked to decide.

## Weaknesses of this design

Stated plainly, because a judge will find them anyway.

- **One subject, no escape hatch.** If code picks a subject the model cannot write a good question about (a thin fact, an awkward name), there is no second choice. The template fallback guarantees a valid question but a bland one, and blandness has emotional cost in a daily ritual too. The current design's five-candidate menu buys real robustness here, and this design trades it away on purpose. If the template rate exceeds roughly 1 in 10, the right response is to offer a second-ranked subject as a fallback, not to give the menu back.
- **Kind labels are still model output.** I claim code decides everything, and strictly, code decides *given* the extractor's `kind`, `resolves`, and event dates. A thread mislabeled `fact` finishes a subject early and the system goes quiet on something live. A fact mislabeled `thread` makes it nag. The future-marker lexical guard is crude and will misfire on "I still make it the same way", which is a settled fact containing "still".
- **Hook due-dates inherit date-parsing ambiguity.** "Next week" is not a date. Vague references fall back to `observed + 14` as a `horizon` hook, which is a guess, and a `horizon` hook that fires early asks about something that has not happened. This is the most likely source of a genuinely wrong-feeling question under this design, and it is the same class of error as the recency-LIVE bug, just rarer and better bounded.
- **The co-mention dampener is blunt.** A fact multi-homed to three subjects freezes all three for 7 days. At two subjects per day of graph growth, month one can starve tiers B through D and push everything to explore, which is failure 1 arriving through a different door. Mitigation is that the seed bank makes explore days decent rather than vague, but the shape of the failure is real and the counter to watch is explore share in weeks 2 and 3.
- **Domain weights are static and impersonal.** Someone who loves talking about the gym gets `health-body` treated as heavy. Per-person weight learning is exactly the kind of adaptive judgment that has failed three times here, so this is a deliberate refusal rather than an oversight, but it is still wrong for a real person some of the time.
- **Season returns are unevaluable for months.** The 90-day season hook cannot fire before late October. Its thresholds are guesses with no data behind them and no way to test them before then except by lowering them artificially.
- **Lexical grounding is gameable.** A question that names the subject noun and otherwise says nothing passes rule 2. It is strictly better than the current content-word repeat guard, which caught nothing semantic, but it is a floor rather than a standard.
- **Theme quality may drop.** Forcing distinct domains per person per day makes a genuine shared angle harder to find, and the model will reach for broader themes. The judgment here is that two correct questions with a loose theme beat two related questions where one is wrong, but the couple experiences the theme, so this is a real cost and should be watched in feedback.
- **The seed bank is finite and hand-authored.** Eleven domains times twelve seeds is 132 seeds. At roughly one explore per person every two days, that is about nine months before the bank is exhausted and someone has to write more. Acceptable, but it is a maintenance obligation the current design does not have.
