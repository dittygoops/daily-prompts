# Exploration/Exploitation, Redesigned: Adversarial Minimalism

Design abstract, 2026-08-02. Written from scratch, against the live failure record.

## Position

Every failure in this system's history has the same shape: a *ranking* was supposed to keep something from happening, and it did not, because a ranking has no floor. Recency-LIVE outranked the settling intent. Model judgment outranked the "aim for a mix" instruction six days straight. A content-word repeat guard outranked nothing at all, because self-improvement questions share no content words. Explore had a ranking (thinnest domain first) and no exclusion, so childhood came up four times in two days.

So this design has almost no ranking. It has **exclusion windows and quotas**, all computed from one table by SQL, all provably satisfiable, none of them relaxable except in one bounded and ordered way that is itself an invariant. Ordering exists only to break ties inside the surviving set, and the tie-break is total (ends in `id ASC`), so the selection is a pure function of the ledger and the date. Two runs on the same database produce the same question target, always.

The model's job shrinks to one thing: writing English for a target that code already picked. It is never handed a list to choose from, because a list is a decision, and this project has watched the model make three decisions badly.

## The one table everything is derived from

```sql
CREATE TABLE asks (
  id         INTEGER PRIMARY KEY,
  person     TEXT NOT NULL CHECK (person IN ('a','b')),
  date       TEXT NOT NULL,
  lane       TEXT NOT NULL CHECK (lane IN ('followup','exploit','explore')),
  subject_id INTEGER REFERENCES subjects(id),   -- null on explore
  seed_id    TEXT,                              -- null on followup/exploit
  domain     TEXT NOT NULL,                     -- always recorded, both lanes
  UNIQUE (person, date)
);
```

`UNIQUE (person, date)` is the one-question-per-person-per-day constraint made structural rather than procedural. Every exclusion window in this design is a `SELECT` against this table. Subject cooldown, domain cooldown, seed cooldown, the cross-person same-day lock, and the rotation schedule are five queries over one table, not five subsystems.

## Invariants

Each is numbered, states the live failure it makes impossible, and names the test. Tests marked **audit** run nightly as SQL over the whole live `asks` history and alarm on any row that violates them; a design whose invariants hold only in unit tests has not proven anything about production.

1. **One ask per person per day.** Enforced by `UNIQUE (person, date)`, not by control flow. Prevents double-sends on retry or daemon restart. Test: insert twice, expect constraint error; **audit** `GROUP BY person, date HAVING count(*) > 1`.

2. **No subject is asked twice within `SUBJECT_COOLDOWN` (21) days.** Prevents this week's vada-pav-three-days-running. The follow-up lane is the sole exception and is bounded by invariant 8. Test: property test over generated histories asserting min gap per `subject_id`; **audit** self-join on `asks` for same `subject_id` under 21 days apart where neither row is `lane='followup'`.

3. **No subject is asked while settling.** A subject linked to any fact observed within `SETTLE_DAYS` (2) of today is excluded from the exploit lane. Prevents the recency-LIVE bug that turned yesterday's answer into today's top candidate. Extraction runs a day late, which means "observed yesterday" is exactly the signal available, and this rule reads it as a veto rather than as a boost. Test: fixture where a fact lands on d-1 and the selector must not return its subject on d; **audit** join `asks` to `fact_subjects`/`facts` on observed dates.

4. **No domain is asked of the same person twice within `DOMAIN_COOLDOWN` (5) days, in either lane.** Prevents four food questions in six days for person a, and prevents childhood being explored four times in two days. The domain recorded is the stored domain of the selected subject or seed, so no judgment happens at ask time. Test: property test on min gap per `(person, domain)`; **audit** self-join.

5. **The two people never get the same domain on the same day.** Prevents this week's both-people-same-domain-same-day. Order of selection alternates by date parity so neither person is systematically second. Test: **audit** `SELECT date FROM asks GROUP BY date, domain HAVING count(*) > 1`.

6. **A subject can never be asked more times than its budget allows without new human evidence.** Budget is set once at subject creation from the extractor's `kind` and is decremented in code on each ask; it is incremented only when a fact arrives from an answer on a later day. The model can never grant itself another question about the same subject. Prevents unbounded digging into a subject the model believes is deep. Test: property test that `times_asked <= 1 + budget_granted_by_facts`; **audit** recompute from `asks` and `facts` and compare.

7. **A settled fact is asked at most once, ever, unless the human volunteers more.** "I've liked paneer since childhood" is `kind='fact'`, budget 0, so it can produce exactly one question in its lifetime. This replaces depletion-by-answer-length entirely, which the owner is right to call wrong: length was never a measure of whether a subject had more in it. Test: fixture asserting a budget-0 subject is excluded after its first ask; **audit** as invariant 6.

8. **Every dated event yields exactly one post-event follow-up, at most, ever.** A `followup_tokens` row exists per subject with `event_date`, `UNIQUE (subject_id)`, deleted when spent inside the same transaction that writes the ask. It becomes spendable the first day after `event_date` and expires after `FOLLOWUP_WINDOW` (4) days. This is the psychic-party success, preserved by construction rather than by hoping a ranking still favours it. Because the token is unique and consumed, the follow-up lane's bypass of invariants 2 and 3 cannot be abused: a subject can be asked at most twice inside 21 days, and only when the second ask is a genuine post-event follow-up. Test: fixture where the same event tries to fire twice; **audit** count `lane='followup'` rows per `subject_id` must be `<= 1`.

9. **Explore fires at least once in every rolling 4-day window per person, and never twice in a row.** Prevents six straight explore days and prevents the ritual becoming an interrogation about one thread. The base cadence is 1 explore in 3; a follow-up may preempt an explore slot at most once consecutively, which caps the drift at 4. Test: property test sliding a 4-day window over generated histories; **audit** the same over live `asks`.

10. **No person goes more than `EXPLOIT_DEFICIT_MAX` (5) days without an exploit ask, unless their eligible set is genuinely empty after the ordered relaxation.** This is the counterweight to invariants 2 through 5: hard windows can starve a lane, and a starved exploit lane silently reproduces failure 1. When the deficit trips, exactly one window relaxes, in a fixed order: domain cooldown first (5 to 3 days), then the cross-person lock. **The subject cooldown and the settling window are never relaxed, in any circumstance.** Test: fixture that starves the lane and asserts the relaxation order and that invariants 2 and 3 still hold; **audit** deficit length per person.

11. **The explore lane is never empty.** With 11 domains, at most 5 blocked by invariant 4 and at most 1 by invariant 5, at least 5 remain. Seeds within a domain are similarly bounded. This is why no fallback path exists for "nothing to ask": explore is always available, so an empty exploit lane is an ordinary day, not an error. Test: exhaustive check that the bound holds for all reachable states of the counters.

12. **Every dispatched question contains at least one anchor token of its target.** Anchor tokens are content words taken verbatim from the subject's fact texts and label (or the seed's own anchor list). Checked in code, case-insensitively, with light stemming. Prevents altitude retreat: "an area of growth" contains no anchor of `guitar`. Test: golden set of the real bad questions from the failure record, each of which must fail the check, and the real good ones, each of which must pass.

13. **The selection target is a pure function of `(ledger snapshot, date)`.** No randomness, no model call, no clock beyond the date. Test: run the selector twice over the same fixture database and diff; run it over the live database at two times of day and diff.

## Subject state, and what "finished" means

`nodes` becomes `subjects`, with the length-derived fields deleted (`avg_yield_chars` goes; it never fired on real data anyway, since the shortest real answer was 84 chars against a 60-char threshold).

```sql
CREATE TABLE subjects (
  id INTEGER PRIMARY KEY,
  person TEXT NOT NULL,
  domain TEXT NOT NULL,          -- 11 values, now including 'tastes-preferences'
  label TEXT NOT NULL,           -- kebab-case, UNIQUE (person, label)
  summary TEXT NOT NULL,
  event_date TEXT,
  budget INTEGER NOT NULL,       -- remaining permitted asks
  times_asked INTEGER NOT NULL DEFAULT 0,
  anchors TEXT NOT NULL          -- JSON array of content words, code-derived
);

CREATE TABLE facts (
  id INTEGER PRIMARY KEY, person TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fact','thread','interest')),
  text TEXT NOT NULL, source_day_id INTEGER NOT NULL, observed_date TEXT NOT NULL
);

CREATE TABLE fact_subjects (         -- the owner's multi-home requirement
  fact_id INTEGER NOT NULL REFERENCES facts(id),
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  PRIMARY KEY (fact_id, subject_id)
);
```

Finishedness is semantic and it is the extractor's `kind`, which the schema already carries and today ignores. But the judgment is made **non-load-bearing** by binding it to a budget rather than to a status:

| kind | meaning | budget granted | worst case if the model is wrong |
| --- | --- | --- | --- |
| `fact` | settled, complete as stated | 0 | the subject is never asked about again; a good question is lost, no repeat occurs |
| `interest` | a standing liking, some room | 1 | at most one extra question, at least 21 days later |
| `thread` | open, ongoing, unresolved | 2 | at most two extra questions, each at least 21 days apart |

Budget is granted once, at the fact's arrival, to each subject the fact links to, and it is capped: `budget = min(budget + grant, 3)`. So drift in the `kind` judgment cannot compound. A subject with budget 0 is finished. It un-finishes only when a human answer on a later day produces a new fact linked to it, which is evidence from the couple rather than from the model. That is the whole state machine: no `open`/`depleted`/`closed` enum, no reopen rules, no yield statistics. One integer, decremented by code, incremented only by human evidence.

"I've liked paneer since childhood" arrives as `kind='fact'` in `tastes-preferences`, gets budget 0, is asked at most once, and never becomes tomorrow's question. That is exactly the owner's requirement, and it costs one column.

## The selection algorithm

Deterministic, one pass, per person, in date-parity order.

```
select(person, today):
  E := asks-derived exclusion sets (5 SQL queries against `asks`)

  # Lane 0: follow-up. Bypasses SUBJECT_COOLDOWN and SETTLE only.
  t := spendable followup token for `person`
       (event_date < today <= event_date + 4, domain not in E.domain,
        domain not taken today by partner)
  if t exists: return (followup, t.subject) and consume the token

  # Lane assignment: rotation
  lane := 'explore' if explore_due(person, today) else 'exploit'
  # explore_due: no explore in last 2 days, or no explore in last 3 days
  # (the deferral case, invariant 9)

  if lane == 'exploit':
    C := subjects where person matches
         and budget > 0
         and id not in E.subject_cooldown
         and id not in E.settling
         and domain not in E.domain_cooldown
         and domain != partner_domain_today
    if C empty and deficit(person) >= 5: C := relax(C)   # invariant 10
    if C nonempty:
      return (exploit, argmin over C of (event_date is null, oldest_linked_fact_date, id))
    # else fall through to explore; this is a normal day

  S := seeds where domain not in E.domain_cooldown
       and domain != partner_domain_today
       and seed_id not used by this person in 90 days
       and seed_id not used by the partner in 30 days
  return (explore, argmin over S of (domain_subject_count, days_since_domain_used desc, seed_id))
```

The only ordering choices in the entire algorithm are the two `argmin` tie-breaks, and both are total orders ending in an id. There is no score, no weight, and nothing tunable inside them.

**Moving parts: 10.** (1) the `asks` table as sole exclusion source; (2) subject cooldown; (3) domain cooldown; (4) settling window; (5) cross-person same-day domain lock; (6) budget from `kind`; (7) the follow-up token; (8) the 1-in-3 rotation with bounded deferral; (9) the explore seed bank; (10) anchor validation with retry.

Defence of each: 1 exists because five subsystems reading five tables is how the recency rule and the settling rule ended up contradicting each other. 2, 3, 4 and 5 each map one-to-one onto a distinct live failure and none subsumes another (2 is per subject, 3 is per person and domain, 4 is per fact arrival, 5 is cross-person). 6 replaces the yield machinery and is one integer. 7 is the single mechanism preserving the best question the system ever wrote. 8 is failure 1 made impossible. 9 is the only part carrying handwritten content and is defended below. 10 is the only enforcement available against the model, since target compliance cannot be checked semantically in code.

Six tunable numbers total: 21, 5, 2, 3, 4, 5.

## The explore seed bank

Explore days do not hand the model a bare domain. Failure 2, four self-improvement questions in six days, happened because "write a question about beliefs-values" regenerates the nominate-a-category shape, and that shape is invisible to every repeat guard because it has no subject. The fix that makes it structurally impossible is to give explore a concrete subject too.

`seeds` is a static table, roughly 12 hand-written entries per domain, each with an id, a domain, a phrasing hint, and its own anchor tokens: `first-thing-you-cook-when-tired`, `the-oldest-thing-you-own`, `who-you-call-when-something-good-happens`. It is data, not logic. It is the one place in the design where a human wrote content, which is deliberate: it means the abstract-question register can only appear if someone typed it into the bank, and nobody will. With 90-day per-person and 30-day cross-person seed cooldowns and ~130 seeds, the bank does not exhaust and never repeats within a season.

This also makes cold start trivial: on day 1 both people have zero subjects, the exploit lane is empty, the rotation is irrelevant, and both get seeds from different domains (invariant 5 separates them; the tie-break gives person-first-today the lowest-index domain and the partner the next). No special-case code path for cold start exists.

## Enforcement against the model

The model receives exactly one target and writes one sentence. Validation in code, in order, retry up to 3 attempts:

1. Strict JSON shape and echoed target id matches the assigned one.
2. Single question: exactly one `?`, no `and also`, under 160 chars.
3. Anchor check (invariant 12): at least one anchor token present.
4. Opening-frame check: the first four tokens do not match the first four tokens of any question sent to either person in 14 days. Exact, code-checkable, and it kills "What's one thing you're..." repetition without pretending to measure semantics.

On exhausting retries, the question is composed by a deterministic template from the target's newest fact ("Last week you mentioned {fact}. How is that going?") and the fallback is logged. This is worse writing than the model produces, and it is always on-subject, which is the trade this design makes everywhere.

Note what is deliberately gone: the shared daily theme becomes cosmetic. Two independently selected targets in guaranteed-different domains often have no honest common angle, and forcing one is how questions get distorted. The theme label is still generated for the ritual's texture, and nothing depends on it.

## The failure record, walked

**Failure 1, six straight explore days from model judgment.** The model no longer holds the stance. Invariant 9 forces an explore at least every 4 days and never twice consecutively, so six in a row is not reachable. Invariant 10 catches the other direction, a chronically starved exploit lane producing the same symptom for a different reason, which the current `stanceForPerson` does not: today, "no threads" silently means explore forever.

**Failure 2, four self-improvement questions in six days.** Those were abstract questions on explore-like days. Under the seed bank there is no such thing as an abstract question: every explore day names a concrete subject drawn from a bank containing no growth-shaped seeds, and the anchor check rejects a question that drifted off it. Honest limit, stated again in weaknesses: on *exploit* days, guitar-practice and job-search are different subjects in different domains and both may read as self-improvement to a human. The anchor requirement forces them to be concrete, which is what made the original four bad.

**Failure 3a, four food questions in four days for person a.** Food subjects live in `tastes-preferences` or `daily-life`. Invariant 4 blocks that person's domain for 5 days after any ask in it, exploit or explore. Two food questions in four days is impossible; four is impossible twice over.

**Failure 3b, the same vada-pav subject three days running.** Day 1 asks it. Invariant 2 blocks it for 21 days. Invariant 3 independently blocks it for 2 days after the answer's facts land. Either alone is sufficient; both fire.

**Failure 3c, the recency-LIVE rule promoting yesterday's answer.** There is no recency promotion anywhere in this design. Freshness is a veto (invariant 3) and never a boost. The only thing that jumps the queue is a spent-once token tied to a dated event.

**Failure 3d, childhood explored four times in two days, both people same day.** Explore asks record their domain in `asks` exactly like exploit asks, so invariant 4 gives childhood a 5-day cooldown for that person, and invariant 5 stops the partner getting it the same day. The seed cooldowns add a third barrier.

**The success, the psychic-party follow-up.** The party subject has `event_date`. On the first day after it, its token becomes spendable, lane 0 preempts whatever the rotation said, and the token's bypass of the subject cooldown and settling window is precisely what lets "how did it go?" fire the day after the answer that created the subject. The token then disappears, so the party cannot produce a third question. The 816-char answer's facts link to `cora`, `psychic-readings`, and `car-2027` through `fact_subjects`, so all three subjects gain budget and all three enter settling for 2 days, which is the multi-home behaviour the owner asked for, working in both directions at once.

## What is measurable

The invariants are the evaluation. Because they are structural, they are checked by replay rather than judged: `scripts/audit-invariants.ts` runs every invariant as SQL over the entire live `asks` history each night and exits non-zero on any violation. A regression cannot be subtle; it is a row.

Alongside, a property test generates 365-day synthetic histories (random answers, random extraction outputs, random skips) and asserts all 13 invariants hold over every generated run. This is the test the current design cannot have, because its guarantees are ranking-shaped.

Kept as observation only, never fed back into selection: answer length distribution, skip rate, follow-up answer rate versus non-follow-up, distinct subjects asked per 30 days, distinct domains per 30 days, and share of days that fell back to the template. Any of these becoming a control input reintroduces the class of failure this design exists to eliminate.

## Migration

1. `sqlite3 .backup` first, per the standing rule about WAL.
2. `subjects` is `nodes` minus `status` and `avg_yield_chars`, plus `budget` and `anchors`, with the domain CHECK extended by `tastes-preferences`. SQLite cannot alter a CHECK, so this is create-new, `INSERT ... SELECT`, drop, rename, inside one transaction.
3. `fact_subjects` backfills one row per existing `node_facts` row from its `node_id`, so nothing is lost and multi-home links accrue only going forward.
4. `budget` backfills from each subject's newest fact kind, minus `times_asked`, floored at 0.
5. `asks` backfills from `generation_log` joined to `person_days` by date. Subject attribution uses the existing argmax rule (the day's max fact-count subject, when the max is at least 2 and unique) and attributes nothing otherwise. Rows with no subject still carry a date and a null domain, so they constrain nothing; the exposure is a single possible early repeat of one subject, which is survivable, whereas guessing a domain would silently block a correct question. `anchors` is computed in code from label plus fact text, no model call.
6. `seeds` ships as a checked-in TSV loaded at startup.
7. Acceptance gate: run `audit-invariants.ts` against the migrated database before the first live day. A migration that produces a violating history is rejected, not patched.

## Weaknesses of this design

**It sacrifices peak questions for a floor.** The single best question available on a given day is regularly excluded by a window. If the couple has a genuinely hot thread, this design will refuse it for 21 days after asking once. That is the trade, stated plainly: the failure record shows the emotional cost of a wrong repeat is higher than the cost of a merely-fine question, and only one of the two is bounded here.

**The rhythm may become legible.** Explore every third day, never the same domain twice in a week: a couple reading this daily for months may feel the machine's schedule. A ranking system feels more organic, right up until it asks about vada pav three days running.

**One model judgment remains load-bearing, just bounded.** `kind` decides the budget. A model that calls everything a `thread` triples the questions per subject; the cap at 3 and the 21-day spacing bound the damage to "somewhat repetitive over months" rather than "the same subject tomorrow", but the judgment is not eliminated, and claiming otherwise would be dishonest. The measurable defence is the distribution of `kind` over time, which the audit reports.

**Cross-domain registers are only partly constrained.** Self-improvement is not a domain, so two concrete exploit questions in different domains can still both read as self-improvement. Killing this properly needs a register tag, which needs a judgment, which is what this design refuses. Partly mitigated because the register's harmful form was the abstract question, which the seed bank and anchor check make impossible.

**Settling can freeze a wide slice of the graph.** A rich answer linking one fact to five subjects settles all five. With a small graph in the first two weeks, this can empty the exploit lane repeatedly; the design's answer is to explore, which is correct but means early weeks skew explore-heavy. Invariant 10's relaxation does not help, because settling is never relaxed.

**The anchor check is a lexical proxy for a semantic property.** A question can contain "guitar" and still not be about the guitar thread. It catches altitude retreat, which is the observed failure, and it does not catch a subtle miss. It will also occasionally reject a good question that paraphrased every anchor, costing a retry.

**The seed bank is manual content and will age.** It needs a human to add seeds once a season, and a stale bank degrades explore days into predictability. It is the only part of the design that does not maintain itself.

**Invariants 2 and 4 assume the subject and domain assignments are right.** If extraction files a food subject under `hobbies-interests`, the domain cooldown protects the wrong thing. Nothing here detects that; the mitigation is only the closed-vocabulary extraction contract already in place, and `print-graph` read by hand.
