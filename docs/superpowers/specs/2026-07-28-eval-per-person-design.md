# Eval Harness for Per-Person Prompts

Design doc, 2026-07-28. Status: proposed, not implemented.

Follows `docs/superpowers/specs/2026-07-27-per-person-prompts-design.md`, step 4 ("Readers": recap, history, novelty, eval). Per-person generation itself has landed (`bcfcba5`); this doc covers only the eval half.

## The bug the harness could not see

On 2026-07-27 the live prompt was "How did the psychic reading party with Cora and her mom end up going?", sent to both people. The party is Ria's memory. Aditya's reply: "This is Ria's memory, I have no way of responding."

The eval harness scored that prompt as a clean pass on every axis, and it was right to, given what it was asked. `src/eval/rubric.ts:9` defines `answerable` as "can a person read this and start typing a reply within 15-30 seconds? False if it requires research, a long story, or forces choosing among many things." A person could. Some person. The rubric never asks *which* person, because `judgePrompt` (`src/eval/judge.ts:23`) takes nothing but a string.

So the worst product bug to date sits in a row of the `prompt_scores` table marked `passed_all = 1`. That is the gap this doc closes.

Two things make the gap fixable now that were not true a week ago:

1. `generation_log` has a `person` column (`src/ledger/schema.sql:68`), one row per person per generation, ids `gen-<date>-a` / `gen-<date>-b` (`src/prompts/adaptive.ts:131,146`). A score row already keys off `generation_id` (`schema.sql:79`), so scores are already per person. Only the axis is missing.
2. `generation_log.user_prompt` already stores the exact memory context the generator was shown (`adaptive.ts:135,150`). The evidence needed to judge "could *they* answer this" is already in the ledger, at the moment it mattered.

---

## 1. The new axis: `answerableByThem`

### What it asks

> Does this question presuppose anything that is not this person's to answer?

Not "is this a good question". Not "is this easy". Only: does every specific person, place, event, plan or object the question names or implies belong to the life of the person who received it.

### How it differs from `answerable`, and why they cannot collapse

| | `answerable` | `answerableByThem` |
|---|---|---|
| Unit of judgement | the question text alone | the question text against one person's memory |
| Failure mode it catches | effort, scope, research burden, too many options | referential ownership: the question is about somebody else's life |
| Input | prompt text | prompt text, one person's name, the date, that person's memory snapshot |
| Sparse memory | irrelevant | must **pass**. Empty memory is a normal day-one state, not a failure |
| Psychic-party prompt | passes (correctly) | fails |

The two collapse into one only if the judge is allowed to reason about difficulty on either axis. The system prompt below therefore forbids it explicitly, in both directions, with a worked contrast: a vague boring question passes `answerableByThem` and may fail `answerable`; a beautifully written question about somebody else's weekend passes `answerable` and fails `answerableByThem`.

This is a **separate judge call with its own system prompt**, not a fifth field bolted onto `JUDGE_SYSTEM_PROMPT`. Three reasons:

- `scripts/eval-static-bank.ts:20` judges 30 static prompts that belong to no person. A required fifth field in `judgmentSchema` (`judge.ts:5-14`) would break that script outright, and an optional one would silently return `undefined` for the whole baseline.
- Contamination. A judge shown a rich memory context and asked to also rate `answerable` starts rating answerability *for that person*, and the generic axis quietly changes meaning across the corpus without anyone noticing. Keeping the calls separate keeps the static-bank baseline in `docs/eval-baseline-static-bank.md` comparable to generated prompts on the four original axes.
- Failure isolation. `judgePrompt` retries once on malformed JSON (`judge.ts:21`). A four-axis call that fails because of the fifth axis loses all four.

Cost of separation: two judge calls per generated prompt instead of one, so four per day. At `google/gemini-2.5-flash` this is noise.

### What the judge is shown

Shown:

- the person's display name and the date the question was sent (context lines are dated; staleness matters here exactly as it does in generation, see `generationPrompt.ts:26`)
- the question text
- that person's `PersonContext` (`src/memory/types.ts:18-24`): facts, threads, interests, recentMoods. `promptPreferences` is omitted, it is about question style, not about what they can answer
- that person's coverage list (`Memory.getCoverage`, `types.ts:32`), as a topic index

Deliberately **not** shown:

- **the partner's memory.** This is the load-bearing exclusion. The criterion is absence from *their own* context; presence in the partner's context is what the deterministic check in section 5 uses. Handing the judge both sections invites exactly the reasoning that produced the bug: "they are a couple, he was probably at the party too."
- **the generator's `rationale`, `stance`, and the day's `theme`.** These are the generator's own self-justification. Feeding them to the judge is a direct channel for the self-agreement problem in section 5.
- the four original axes' verdicts, for the same reason.

Budget: the same `config.generation.contextBudgetChars` (default 4000, `src/config.ts:38-45`) the generator was given. The judge should see exactly the evidence the generator had, no more and no less. More evidence makes the judge fail prompts for referents the generator could not have known were legitimate; less makes it fail prompts the generator grounded correctly.

### Pass / fail line

Fail (`answerableByThem: false`) when the question presupposes something that is not theirs:

- it names a person, place, event, object, plan or activity that appears nowhere in their memory and is not something nearly any adult has (a job, a meal, a weekend, a childhood, a commute)
- it asks "how did X go", "did you finish X", "how is X going" about an X absent from their memory
- it assumes they were present at, involved in, or responsible for something not recorded for them

Pass (`answerableByThem: true`) when:

- the question is broad or general and any person could answer it from their own life, **even if nothing in the memory relates to it**. Sparse memory is not a failure. A day-one person with an empty context can answer "what did you eat today?"
- or every specific thing it names appears in their memory

The asymmetry is deliberate and is the single most important calibration decision here. Memory is incomplete by construction: `SupermemoryClient.getContext` (`src/memory/supermemory.ts:102`) returns a budgeted slice of extracted observations, not a person's life. If absence from memory were sufficient to fail, every explore-stance prompt would fail, the axis would report a 60% failure rate, and it would be switched off within a week. **Specificity is what makes absence damning.** Broad question plus empty memory equals pass; named referent plus absent from memory equals fail.

### Judge system prompt (proposed wording, verbatim)

```
You are checking ONE thing about a daily check-in question: whether the
specific person it was sent to can actually answer it, given what we know
about their life.

You are given that person's name, the date the question was sent, and
everything our memory holds about them: facts, open threads, interests,
recent moods, and the topics they have already talked about. You are NOT
given their partner's memory. Judge only from what is in front of you.

FAIL (answerableByThem: false) if the question presupposes something that
is not this person's to answer:
- it names a person, place, event, object, plan or activity that appears
  nowhere in their memory below, and that is not something nearly any adult
  has (a job, a meal, a weekend, a childhood, a commute)
- it asks "how did X go", "did you finish X" or "how is X going" about an X
  that does not appear in their memory below
- it assumes they were present at, involved in, or responsible for
  something not recorded for them

PASS (answerableByThem: true) if either:
- the question is broad or general and any person could answer it from
  their own life, even when nothing in the memory below relates to it.
  Sparse or empty memory is NORMAL and is NOT a failure. Someone with an
  empty memory can still answer "what did you eat today?"
- or every specific thing the question names appears in the memory below

Do NOT judge length, tone, warmth, how many questions it contains, how hard
it is to answer, or how interesting it is. Those are graded separately. A
vague, boring, generic question PASSES this check. A beautifully written
question about somebody else's weekend FAILS it.

Respond with strict JSON only, no prose, in exactly this shape:
{"answerableByThem":true,"answerableByThemReason":"one sentence: name the
specific thing you checked and where in the memory you found it, or state
what the question presupposes that the memory does not contain"}
```

### Judge user prompt (proposed wording)

```
Question sent to Aditya on 2026-07-27:
"How did the psychic reading party with Cora and her mom end up going?"

What we know about Aditya (every line is prefixed with the date it was recorded):
  Facts: [2026-07-20] ...; ...
  Open threads: [2026-07-24] ...; ...
  Interests: ...
  Recent moods: ...
  Topics already talked about: work, guitar, food, ...
```

Rendered by a new `buildPersonAnswerabilityUserPrompt(input)` in `src/eval/rubric.ts`, alongside a `PERSON_ANSWERABILITY_SYSTEM_PROMPT` export. New `judgeAnswerableByThem(...)` in `src/eval/judge.ts`, same one-retry shape as `judgePrompt` (`judge.ts:21-41`), own two-field zod schema.

### While in `rubric.ts`: kill the triplicated axis list

The axis list is currently written out three times: `src/eval/scoring.ts:18-23`, `scripts/eval-generated-prompts.ts:59-64`, and inline at `scripts/eval-static-bank.ts:51-56`. Adding an axis means editing all three and there is nothing to catch a miss. Export a single `AXES` from `rubric.ts` and have all three import it. This is a prerequisite, not a nicety: without it the new axis will be added to two of the three and the report will silently under-count.

---

## 2. Plumbing: getting the context to the scorer

`scorePending` (`src/eval/scoring.ts:39`) runs on the extraction poller's tick (`index.ts:124-133`, called from `extractionLoop` at `index.ts:135`). Its deps are `{ ledger, llm, model, log }` (`scoring.ts:5-11`). There is no `Memory`.

### Option A: give the scorer a Memory. Rejected.

`ScoringDeps` gains `memory: Memory`, `scorePending` calls `memory.getContext(row.person, budget)`. The composition root already has one (`index.ts:37`), so wiring is one line.

It is still wrong, for a reason that has nothing to do with wiring cost:

- **It reads the wrong memory.** `unscoredGenerations()` (`ledger.ts:550`) returns every unscored row, oldest first. After downtime, or on the first run after this ships, it scores prompts generated days ago against memory as it stands today. Extraction has since added observations from the answers to those very prompts. A prompt correctly grounded on the day it was sent can fail against today's memory, and, worse, a prompt that was *not* grounded can pass because the answer that revealed the gap has since been extracted into the person's context. The axis would be least trustworthy exactly where it matters most.
- It puts a network dependency (`supermemory.ts:102` does a list call plus a per-document fetch per observation, `supermemory.ts:96,115`) inside a poller whose contract is "pure observability, never blocks anything" (`scoring.ts:64-66`).
- It couples the eval module to `Memory`, which today it does not touch at all. `src/eval/` currently imports only `Ledger` and `LlmClient`.

### Option B: read the snapshot the generator already stored. Recommended.

`generation_log.user_prompt` holds the full `buildGenerationUserPrompt` output (`adaptive.ts:75-89,135,150`), which contains both people's sections verbatim. That is a point-in-time snapshot, taken at the moment the prompt was written, which is precisely the right evidence.

Parsing it back out is the catch. `buildGenerationUserPrompt` has already changed format once: the current version emits `PERSON A: <name>` headers (`generationPrompt.ts:73`), while rows written before `bcfcba5` emit `<name>'s context:`. A regex-based splitter is a silent-failure machine, and a splitter that silently returns an empty context produces false failures on the new axis.

So: **store the snapshot explicitly, and parse only as a fallback for history.**

Add `generation_log.context_snapshot TEXT` (nullable), written by `AdaptivePromptSource` on each of its two `recordGeneration` calls (`adaptive.ts:129,144`), holding JSON:

```json
{ "context": { "facts": [], "threads": [], "interests": [], "recentMoods": [], "promptPreferences": [] },
  "coverage": [] }
```

Structured rather than rendered, because the deterministic check in section 5 wants token sets per field and the judge wants prose; rendering from JSON is trivial in either direction, parsing prose back into JSON is not.

Consequences, stated honestly:

- **Generation writes a column that only the scorer reads.** That is a real coupling, and it is the price of scoring against a snapshot rather than against live memory. It is small: `recordGeneration` already carries `systemPrompt`, `userPrompt` and `rawResponse` for exactly this kind of after-the-fact analysis.
- **Ledger growth**: up to `contextBudgetChars` (4000) per person per day, roughly 8 KB/day. `user_prompt` and `raw_response` already store the same content twice per day, so this is a third copy of data already on disk, not a new exposure. No new privacy surface: the file is already `chmod 600` (`ledger.ts:219`) precisely because it holds everything.
- **Historical rows have `context_snapshot = NULL`.** Six generated rows exist as of 2026-07-27 (`docs/eval-generated-prompts.md`), all predating the `person` column. They score `answerableByThem = NULL`, meaning not applicable. See section 3.
- `ScoringDeps` gains **nothing**. The composition root at `index.ts:126` is untouched except for the model choice in section 5. That is the point of option B.

### The offline script

`scripts/eval-generated-prompts.ts` opens its own `Ledger` (line 21) and no `Memory`, so it gets the snapshot the same way, from the same column, with no new dependency either.

---

## 3. Schema and migration

Column on `prompt_scores` (`schema.sql:77-89`):

```sql
answerable_by_them INTEGER,   -- nullable: NULL means "not applicable / no context snapshot"
```

**Nullable, and that is not laziness.** Rows fall into three states and two-valued logic cannot represent them: judged and grounded (1), judged and not grounded (0), and not judgeable because no per-person context exists (NULL). Fallback rows never reach `prompt_scores` at all (`unscoredGenerations` filters `fell_back = 0`, `ledger.ts:555`), but pre-`bcfcba5` generated rows have `person IS NULL` and `context_snapshot IS NULL`, and forcing them to 0 would report six historical failures that never happened, while forcing them to 1 would inflate the pass rate.

Migration, following `Ledger.migrateSchema` (`ledger.ts:183-207`), which exists because `schema.sql`'s `CREATE TABLE IF NOT EXISTS` is a no-op against the live ledger (`ledger.ts:179-182`):

```ts
if (!has("prompt_scores", "answerable_by_them")) {
  db.exec("ALTER TABLE prompt_scores ADD COLUMN answerable_by_them INTEGER");
}
if (!has("generation_log", "context_snapshot")) {
  db.exec("ALTER TABLE generation_log ADD COLUMN context_snapshot TEXT");
}
```

Both additive, both guarded by their own existence check, both idempotent, no backfill. Unlike the `person_days` backfill at `ledger.ts:203-206`, there is nothing to backfill from: no historical row carries a per-person context snapshot, and inventing one would be fabrication.

### `passed_all` semantics

`passesAll` (`judge.ts:44`) currently ANDs four booleans. It must become: all four original axes pass **and** `answerableByThem !== false`. NULL tolerated, `false` fatal. Concretely:

```ts
passedAll: passesAll(judgment) && personal !== false
```

This changes the meaning of a column already populated with 6 rows. Those rows keep their old meaning (four axes only), which is fine because they also keep `answerable_by_them = NULL`, so the two are distinguishable by query. Any report that quotes a historical pass rate must say which definition it used.

### Rows already scored are never rescored

`recordPromptScore` is `INSERT OR IGNORE` on a `UNIQUE generation_id` (`ledger.ts:564-570`, `schema.sql:79`), deliberately, so a restart mid-pass cannot double-count. The consequence: **existing `prompt_scores` rows will never acquire the new axis.** Every row scored before this ships stays NULL forever unless deleted.

Recommendation: leave them. Six rows, all pre-per-person, none of which have the context to judge. Do not add a rescore path; a "delete and let the poller redo it" script is a foot-gun aimed at a table whose entire value is being an append-only record of what was judged when.

### Reader changes in `ledger.ts`

- `PromptScoreEntry` / `PromptScoreRow` (`ledger.ts:82-99`) gain `answerableByThem: boolean | null`; `promptScores()` (`ledger.ts:585`) maps `r.answerable_by_them === null ? null : r.answerable_by_them === 1`.
- `promptScores()` should also expose `person`, by joining `generation_log` on `generation_id`. Do **not** denormalize a `person` column onto `prompt_scores`: it is derivable, and a second copy is a second thing to get wrong.
- `GenerationLogEntry` / `GenerationLogRow` (`ledger.ts:63-81`) gain `contextSnapshot: string | null`, threaded through `recordGeneration` (`ledger.ts:506`) and `toGenerationLogRow` (`ledger.ts:113`).
- New: `personPromptsBefore(person, beforeDate)`, for section 4.

---

## 4. Per-person readers in the offline report

### The novelty bug, which is live right now

`scripts/eval-generated-prompts.ts:43`:

```ts
const priors = ledger.recentDays(row.date, 10_000).map((d) => d.prompt_text);
```

`days.prompt_text` is now the day's **theme** (`schema.sql:23`, and the per-person design doc's data-model section), a 2 to 6 word label like "small daily rituals". It is not a question anybody was asked.

So the novelty check currently compares a full question against a bag of short theme labels. `nearestPrior` (`novelty.ts:121`) computes Jaccard over content words; a question and a theme label share almost no content words, so similarity trends to ~0, `isNearDuplicate` is never true, and the report cheerfully prints "0 generated prompt(s) near-duplicate a prompt that preceded them". **The check has not started failing, it has stopped being able to fail.** That is worse than a broken check, because it looks like a pass.

Note that the *live* repeat guard is fine: `AdaptivePromptSource` compares each person's candidate against `history.map(h => h.a.text)` / `h.b.text` from `recentPromptHistory` (`adaptive.ts:113-116`, `history.ts:50-55`), which reads `person_days.prompt_text`. Only the offline report reads the wrong column.

Fix: a per-person prior reader on `Ledger`.

```ts
/** Every question this person was actually asked before `beforeDate`, most
 * recent first. person_days.prompt_text, never days.prompt_text, which
 * holds the day's theme. */
personPromptsBefore(person: PersonId, beforeDate: string): { date: string; text: string }[]
```

```sql
SELECT d.date AS date, pd.prompt_text AS text
FROM person_days pd JOIN days d ON d.id = pd.day_id
WHERE pd.person = ? AND d.date < ? AND pd.prompt_text IS NOT NULL
ORDER BY d.date DESC
```

Historical rows are safe: `migrateSchema` backfilled `person_days.prompt_text` from the owning day (`ledger.ts:203-206`), so pre-per-person days contribute the one question both people were asked, which is exactly right.

The script then becomes, per row, `personPromptsBefore(row.person, row.date)`. Rows with `person === null` (pre-`bcfcba5`) fall back to the union of both people's histories, which for those dates is the same list.

### Template repetition

`repeatedStems(scored.map((s) => s.text))` at line 153 now mixes both people's questions into one pool. Split it:

- per person: is the generator reusing a frame on the same person across days
- **same-day cross-person**: do A's and B's questions share an opening stem today. This is a new and genuinely useful check, because `ADAPTIVE_SYSTEM_PROMPT` explicitly forbids it (`generationPrompt.ts:22`, "do not give both people the same sentence frame today") and nothing currently verifies it. `openingStem` (`novelty.ts:73`) already does the work; it just needs to be called on the pair.

### Report structure

Every table currently keyed by `date` (lines 136-143, 181-191, 196-198) now has two rows per date. Add a `person` column and key on `(date, person)`. Sort by date then person so the two halves of a day sit adjacent and asymmetries are visible by eye.

Sections that become per person: novelty table, full-results table, failing-prompts detail (heading `### 2026-07-27 / a: "..."`), recorded rationales (the rationale is one sentence covering both people, `adaptive.ts:137,152`, so print it once per date, not twice).

### Summary numbers, and what they now mean

| Line | Currently | Must become |
|---|---|---|
| `${rows.length} generation attempt(s)` (line 100) | counts rows | say both: N prompts across D distinct dates. A generated day contributes 2 rows, a fallback day 1 |
| Fallback rate, `pct(fellBack.length, rows.length)` (line 110) | **wrong today**: denominator mixes 1-row fallback days with 2-row generated days, understating the rate by up to half | count over `DISTINCT date`. Fallback is a property of a day, not of a person |
| `passCount/scored.length` (line 101) | per prompt | keep per prompt, and label it "prompts" not "days". Add a per-person breakdown; a generator that systematically fails one person is invisible in the pooled number |
| Static-bank comparison (line 102) | 6/6 vs 26/30 | still valid, both sides count prompts. But the generated side is now scored on five axes and the static side on four, so the comparison line must state that it compares the **four shared axes only** |
| Near-duplicate count (line 103) | measured against themes, always 0 | measured per person against their own prior questions |
| Stance mix (lines 87-88, 116-122) | one count per row | per person **and** per day. `stanceForPerson` (`stance.ts`) only ever downgrades exploit to explore for a person with no threads (`adaptive.ts:72-73`), so the day's intended stance is exploit if either person's is. The 1-in-3 cadence `decideStance` targets is a day-level property and must be read from the day-level number, not the per-prompt one |

### One more thing already wrong, not in scope to fix here

`history.ts:52` labels a whole day with `ledger.generationLogFor(day.date)[0]?.stance`, the first generation row for that date, which is now person A's row. When the two stances differ, B's question is shown to the next generation tagged with A's stance. That is a per-person-prompts bug in already-committed code, not an eval bug. Flagged, not fixed here.

---

## 5. The self-agreement problem, and the deterministic pre-check

### The problem is worse than "same model family"

`config.ts:32` and `config.ts:38` both default to `google/gemini-2.5-flash`, and `index.ts:126` passes `extractionLlm` (the extraction model) to `scorePending`. So the judge is not merely the same family as the generator, it is **the same model**. Asking gemini-2.5-flash whether gemini-2.5-flash's question was grounded in a context that gemini-2.5-flash just read is close to asking it to re-run its own last decision and disagree with itself.

For most rubric axes this is tolerable, because they are surface properties (length, compound question) that a model judges more reliably than it generates. For `answerableByThem` it is not, because the failure is a *reasoning* failure about the same evidence, and it is exactly the reasoning the generator already did and got wrong.

Two mitigations, both cheap:

1. **A distinct judge model.** Add `config.eval.model`, defaulting to a different family than `config.generation.model`. `anthropic/claude-sonnet-4.5` is already in `config.json:16` for the weekly recap, so no new provider. `prompt_scores.model` already records what judged each row (`schema.sql:87`), so a family switch is measurable after the fact.
2. **A grader-validation set before trusting the axis.** `tests/eval/fixtures/memoryStates.ts` already contains the two states that matter: `one-sided` (line 64: Sam has nothing) and `private-asymmetry` (line 155: Alex holds a thread Sam does not know about). Hand-label a set of question-plus-person pairs against those fixtures, including the real psychic-party prompt and a deliberately borderline set (broad question plus empty memory, which must PASS), and measure the judge's agreement with the labels before any of its verdicts are quoted as a quality number. A judge nobody has checked is a random number generator with good prose.

### The deterministic pre-check: verdict, it is more reliable for this failure mode

The 2026-07-27 bug has a specific shape: the question borrowed a **named specific from the other person's memory**. That shape is detectable without a model.

New `src/eval/ownership.ts`, no LLM, no network:

```ts
export interface OwnershipCheck {
  /** Specifics the question uses that appear in the partner's snapshot and
   * nowhere in this person's. */
  borrowed: string[];
  verdict: "clean" | "borrowed";
}

export function checkOwnership(
  question: string,
  own: ContextSnapshot,
  partner: ContextSnapshot,
): OwnershipCheck
```

Algorithm:

1. Candidate tokens = `contentWords(question)` (`novelty.ts:43`, already stopword-stripped and lowercased, reused as-is), plus any non-sentence-initial capitalized token from the raw text, since proper nouns are the highest-signal case and lowercasing loses the signal.
2. `ownTokens` = `contentWords` over every field of the person's snapshot plus their coverage list. `partnerTokens` = the same over the partner's.
3. `borrowed` = candidates present in `partnerTokens` and absent from `ownTokens`.
4. `verdict = "borrowed"` when `borrowed` contains a proper noun, or two or more tokens of length >= 4.

On the live case: the question to Aditya yields tokens `{psychic, reading, party, cora, mom, end, going}`. Ria's snapshot contains psychic, reading, party, Cora. Aditya's contains none of them. Four borrowed tokens including a proper noun. **Fires.** The judge, on the same input, might or might not.

The partner snapshot is free: both people's `generation_log` rows share a `date`, and `generationLogFor(date)` (`ledger.ts:530`) already returns both, ordered by id.

Why it is more reliable than the judge *for this failure mode*:

- deterministic, reproducible, costs nothing, cannot drift when a model version rolls
- cannot agree with itself, because it has no self
- its failure output is an artifact, not an opinion: "borrowed: cora, psychic, party" is a fact about strings that a human can verify in one second, unlike "this question presupposes an event not in his memory", which requires trusting the judge

Where it is blind, stated plainly:

- **no stemming.** "parties" against "party" misses. Accepted; adding a stemmer to `contentWords` would change `nearestPrior`'s calibrated 0.5 threshold (`novelty.ts:62`) and its documented behaviour, which is not worth it for this.
- **referents with no shared surface form.** "How did the thing with your mom's friend go?" borrows without sharing a distinctive token.
- **specifics grounded in nobody's memory.** A hallucinated event fires nothing, because the token is in neither snapshot.
- **false positives on genuinely shared vocabulary.** Mitigated structurally: a token present in *both* snapshots is excluded by construction at step 3, so shared topics (the four the two of them actually share) cannot trip it. The length and proper-noun gates handle the rest.

### How the two combine

Run the pre-check first. If it fires, record `answerableByThem = false` with `failure_reasons` set to the borrowed tokens, and **do not call the judge at all**.

That ordering is the whole design. A judge allowed to overrule the pre-check is precisely the self-agreement risk: the model that wrote the question gets a chance to explain why the borrowed noun was fine. Structurally, the judge can only ever **add** failures the deterministic check cannot see, never remove ones it can. It also saves a call on the rows most likely to be interesting.

If the pre-check is clean, call the judge for the softer modes it cannot see. If `context_snapshot` is NULL, skip both and write NULL.

---

## 6. Build order

1. **`rubric.ts`**: export a single shared `AXES`, repoint `scoring.ts:18`, `eval-generated-prompts.ts:59` and `eval-static-bank.ts:51` at it. No behaviour change, and it is what stops step 5 from being applied to two files out of three.
2. **`src/eval/ownership.ts`** plus unit tests against `tests/eval/fixtures/memoryStates.ts`. Pure function, no I/O, no model. Include the real psychic-party case as a fixture-shaped regression test: it is the one input we know the truth for.
3. **Schema**: both `migrateSchema` steps, `PromptScoreEntry` / `GenerationLogEntry` types, `promptScores()` joined to `person`, `personPromptsBefore`. Nothing reads the new columns yet.
4. **Generation writes `context_snapshot`** in `adaptive.ts:129,144`. Invisible to everyone until step 5.
5. **`judgeAnswerableByThem`** in `judge.ts` plus its prompts in `rubric.ts`, then wire pre-check-then-judge into `scorePending` and update `passesAll`. Add `config.eval.model` and pass a distinct judge model at `index.ts:126`.
6. **`scripts/eval-generated-prompts.ts`**: per-person priors, per-person and cross-person stems, `(date, person)` keying, corrected fallback denominator, per-person breakdowns.

Steps 1 to 4 are invisible in production. Step 5 changes what the poller writes. Step 6 costs money to run and should be run once, deliberately, after step 5 has scored at least a week of real per-person days.

## Risks

- **False failures from incomplete memory** are the way this axis dies. The pass-by-default rule for broad questions, and the validation set in section 5, exist for that. If the first week shows a failure rate above roughly 20%, suspect the axis before the generator.
- **Snapshot staleness in reverse**: the snapshot is right by construction, but if `contextBudgetChars` is ever raised, old rows were judged against a smaller slice than new ones. `prompt_scores.model` records the judge but not the budget. Accept, or record the budget in the snapshot JSON.
- **`passed_all` changes meaning mid-table.** Six rows carry the old four-axis meaning. Distinguishable only by `answerable_by_them IS NULL`. Any quoted pass rate must say which.
- **Two judge calls per prompt** doubles the offline script's cost, and that script re-judges every historical row on every run (`eval-generated-prompts.ts:50`, no caching against `prompt_scores`). It already re-pays for the whole corpus each run; this makes it twice as expensive. Worth considering reading `prompt_scores` instead of re-judging, but that is a separate change.
- **Concurrent work.** `scoring.ts`, `judge.ts` and `ledger.ts` are all touched by other in-flight work. Step 1 (shared `AXES`) is the highest-conflict change and the one to land first and small.

## Out of scope

- **Rescoring the six existing `prompt_scores` rows.** They have no per-person context, so there is nothing to score them against.
- **Scoring the static bank on this axis.** `data/prompts.json` prompts belong to no person by design, and the fallback stays deliberately non-per-person (per-person design doc, blast-radius table).
- **A privacy-leak axis.** The 2026-07-27 incident had two halves; this doc addresses one. "Does A's question reveal something B told us in confidence" is a real second axis, `ADAPTIVE_SYSTEM_PROMPT` already forbids it (`generationPrompt.ts:14`) and `tests/eval/fixtures/memoryStates.ts:155` already has the fixture for it. It is deliberately deferred: it needs the partner's snapshot in the judge's view, which is the exact thing section 1 excludes, so it is a different judge call with a different design.
- **Semantic novelty via embeddings.** Still out, as in `novelty.ts:9-11`.
- **Fixing `history.ts:52`'s day-level stance label.** Real bug, different work.
- **Any change to how prompts are generated.** This doc measures; it does not generate.
