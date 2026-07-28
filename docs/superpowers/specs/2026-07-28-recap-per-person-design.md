# Weekly Recap Under Per-Person Prompts

Design doc, 2026-07-28. Status: proposed. Sections 2 and 4 contain owner-visible copy and product decisions that need explicit approval before shipping.

Follows on from `docs/superpowers/specs/2026-07-27-per-person-prompts-design.md`, step 4 ("Readers: recap, history, novelty, eval"). Per-person prompts are already implemented and committed. This doc does not redesign them.

## 1. What is actually broken

Per-person prompts changed the meaning of one column. `src/ledger/schema.sql:23` records it:

> `-- days.prompt_text now holds the day's shared theme, not the question.`

`src/engine/runtime.ts:102-106` writes it:

```ts
// days.prompt_text holds the shared theme, not a question anybody was
// asked. The questions themselves live per person, since they differ.
const themeId = effect.prompts.a.id;
const themeText = effect.theme ?? effect.prompts.a.text;
const day = ledger.createDay(effect.date, themeId, themeText, effect.at);
```

`src/recap/highlight.ts:42-53`, `buildUserPrompt`, still reads it as if it were the question:

```ts
lines.push(`[${day.date}] "${day.prompt_text}"`);
lines.push(`  ${names.a}: ${a.state === "answered" ? a.response_text : `(${a.state})`}`);
lines.push(`  ${names.b}: ${b.state === "answered" ? b.response_text : `(${b.state})`}`);
```

So from the day per-person prompts went live, the highlight LLM sees a two-to-six-word theme label in quotes, followed by two answers to two questions it is never shown. Every inference it draws about how the two answers relate is drawn from an incomplete transcript. This is the most emotionally visible output in the product (it goes to both people, and the voice was tuned over four rounds with the owner), so it is the highest-priority reader to fix.

One nuance that shapes everything below: `days.prompt_text` is **not reliably a theme**. Three cases produce three different kinds of string in that column:

| Case | `days.prompt_text` holds |
|---|---|
| Adaptive generation with a theme (`src/prompts/generationPrompt.ts:29` returns `"theme"`) | a short 2-6 word label |
| Adaptive generation with `theme` null (`src/prompts/adaptive.ts:30` types it `.nullable().optional()`) | person A's full question, via the `?? effect.prompts.a.text` fallback |
| Static bank fallback (`src/prompts/staticBank.ts:26` returns `{ theme: null, prompts: { a: chosen, b: chosen } }`) | the single shared bank question both people got |
| Historical days, pre-migration | the single shared question both people got |

Any format that labels this column "theme" must survive it sometimes being a full question sentence. Section 5 covers why that is fine and needs no branch.

Per-person question text is safe to read unconditionally. `Ledger.createDay` (`src/ledger/ledger.ts:228-244`) seeds both `person_days` rows at creation:

```ts
// Seeded from the day's prompt so a day is never in a state where
// somebody has no question. setPersonPrompt overwrites when the
// generator produces a tailored one.
```

and `migrateSchema` (`src/ledger/ledger.ts:195-206`) backfills historical rows with `COALESCE(... SELECT d.prompt_text FROM days d ...)`. `PersonDayRow.prompt_id` / `prompt_text` are still typed `string | null` (`src/ledger/ledger.ts:51-52`) with the comment "Populated for every row, including migrated ones, so consumers never branch on null."

## 2. How the week is presented to the highlight LLM

### 2.1 The layout

`buildUserPrompt` (`src/recap/highlight.ts:42`) emits a four-line block today (one day line plus two answer lines). The proposed block is five lines: one shared-angle line, then a question and an answer per person, grouped by person so the pairing is unambiguous.

Exact text to build:

```
Week: 2026-07-20 to 2026-07-26

[2026-07-20] shared angle: leftovers and small rituals
  Alex was asked: What is the one thing you always reheat badly?
  Alex said: I microwave pizza and I refuse to feel bad about it
  Sam was asked: What food would you never share, with anyone?
  Sam said: (no_response)

[2026-07-21] shared angle: how a week starts
  Alex was asked: What set the tone for your Monday?
  Alex said: A 7am recruiter call I did not agree to
  Sam was asked: What is the first thing you did today that was just for you?
  Sam said: Read forty pages before anyone else was up
```

Rules for constructing it:

- The `Week:` header line is unchanged from `src/recap/highlight.ts:44`.
- One blank line between day blocks. The current format has none. This is the only pure-readability addition, and it costs one token per day; with five lines per block, an unseparated wall is genuinely harder to segment.
- `shared angle:` label rather than `theme:`, and unquoted. Unquoted because the current `"${day.prompt_text}"` quoting is what invites the model to treat the string as a quotable question. "Shared angle" is true in all four cases from the table in section 1: on a theme day it is the theme, and on a fallback or historical day the single shared question genuinely was the day's shared angle.
- `X was asked:` / `X said:` deliberately mirrors `copy.weeklyRecapMessage`'s sibling, `copy.shareMessage` (`src/engine/copy.ts:18-20`), which already reads `${partnerName} was asked:\n${questionText}\n\nThey said:\n\n${responseText}`. The same vocabulary in the transcript and in the message the couple actually received keeps the model's mental model aligned with theirs.
- Non-answered states keep the existing `(${state})` convention from `src/recap/highlight.ts:49-50` verbatim. No change.
- Question text comes from `ledger.personDay(day.id, person).prompt_text`, with `?? day.prompt_text` as the null guard, matching `personHistoryFor` in `src/prompts/history.ts:31` and its comment ("the fallback to dayPromptText only matters for rows written before that seeding existed").

### 2.2 Token cost

Per day the block grows from roughly 3 content lines to 5, adding two question sentences and swapping a short theme label in for what used to be a question. For a full 7-day week that is on the order of 200 to 300 extra input tokens on a single weekly call. That is negligible against the ~700-token system prompt, and it is the minimum needed for the model to know what each answer is answering. Nothing else in the transcript should grow: do not add prompt ids, stances, states beyond the existing parenthetical, or per-day metadata.

### 2.3 One line that stays out

Do **not** emit `prompt_id` or the generator's stance. `recentPromptHistory` (`src/prompts/history.ts:45`) carries stance because the generator needs to see its own drift. The highlight writer has no use for it and it is one more thing to accidentally quote.

## 3. What this does to the highlight's core instruction

This section is owner-visible copy. **Nothing here ships without the owner reading the exact strings.** The voice was tuned over four rounds and two of the four approved examples are load-bearing on an assumption that is no longer true.

### 3.1 The problem in the instruction

Current wording, `src/recap/highlight.ts:12`, second half of the "highlight" clause:

> Pick ONE thing, and it must involve BOTH people's answers: the best coincidence, echo, or contrast between something each of them said this week. Never build the highlight around only one person's answer. Only if the week truly has no link between their answers, take one small moment from each person and weave them into a single thought (not two separate blurbs). Skip everything else from the week.

The both-people requirement is the emotional core of the feature and is not in question. What breaks is the evidence available to satisfy it.

When both people answered the same question, "coincidence, echo, or contrast" was cheap and honest: the questions were held constant, so any difference in the answers was a real difference between the people. With different questions, two distinct failure modes open up:

1. **False sameness.** "You both said X" was previously a statement about two people converging. Now the model can produce it from two answers that only look similar because the shared theme steered both questions at the same subject. That is the theme talking, not the couple.
2. **Manufactured contrast, which is worse.** If Alex was asked about a hard week and Sam was asked about a small win, an answer pair that reads as "one of you is struggling and one of you is thriving" is an artifact of the two questions. Shipping that to both people as an observation about their relationship is the single most damaging thing this feature could do, and the current wording actively encourages hunting for contrast.

**Does the shared theme rescue it?** Partially, and it is worth being precise about how much. The generator is instructed to give the two questions "one angle, mood, or subject, asked of each person through their own life" (`src/prompts/generationPrompt.ts:13`), which keeps the two answers in adjacent territory, so genuine echoes remain findable. That is a real rescue for failure mode 1. It does nothing for failure mode 2, because the theme guarantees adjacency, not symmetry, and the same prompt line explicitly permits a fallback where the model picks "a broad human theme both questions can hang off" when the contexts have no common angle. On those days the adjacency is nominal. The instruction has to carry the weight on its own.

### 3.2 Proposed replacement wording

Replace the sentences quoted in 3.1 (from "Pick ONE thing" through "...not two separate blurbs).") with:

> Pick ONE thing, and it must involve BOTH people's answers: the best coincidence, echo, or contrast between something each of them said this week. They were asked different questions each day, angled at a shared subject through each person's own life, so the link you find must be between what they SAID, never between the questions. Do not say or imply they answered the same question unless their two question lines that day are word-for-word identical. Never present a difference that follows from the two questions being different as a difference between the two people. Never build the highlight around only one person's answer. Only if the week truly has no link between their answers, take one small moment from each person and weave them into a single thought (not two separate blurbs).

Design notes on that wording:

- "must be between what they SAID" reuses the existing capitalized-emphasis convention already in the prompt (`ONE`, `BOTH`, `NOT`).
- The word-for-word identity test is a mechanical, checkable rule that the model can apply from the transcript alone. It is also exactly what makes section 5 work: on historical and fallback days the two question lines *are* identical, so the old same-question framing stays available and honest on precisely the days where it is true, with no date logic anywhere.
- The manufactured-contrast ban is stated as a prohibition rather than a preference, matching the register of the surrounding "Never" clauses.

Additionally, add one line to the "Shared rules for both fields" block (`src/recap/highlight.ts:24-27`):

> - The "shared angle" line each day is context for you only. Never quote it or build the highlight around it.

Rationale: on days where `days.prompt_text` fell back to a full question (section 1 table), that line is a quotable sentence sitting in the transcript, and the model must not treat it as something either person said.

### 3.3 The examples also need owner sign-off

`src/recap/highlight.ts:18-22` gives four approved examples "to show the RANGE of the highlight voice". Two of them are built on the same-question assumption:

- Line 19: "Neither of you planned it, but you answered a question about home with the exact same street food stall. Someone owes someone a trip."
- Line 22: "You answered the comfort food question three hours apart with the same exact dish, neither of you having seen the other's answer. Different kitchens, same craving."

Leaving these in place is not neutral. Few-shot examples are the strongest signal in the prompt, and these two teach a shape that the data will now rarely support, directly against the new instruction in 3.2. The likely outcome is a model that reaches for the same-question framing and confabulates it.

Lines 20 and 21 are fine as written: line 20 already describes two answers on two different days, and line 21 is about how they each talk about a subject.

Proposed replacements, for owner approval, preserving the shape and rhythm of the originals:

- For line 19: "Neither of you planned it: two different questions, two answers, one identical street food stall. Someone owes someone a trip."
- For line 22: "You were asked different things three hours apart and both landed on the same dish, neither having seen the other's answer. Different kitchens, same craving."

The intent is minimal edit. Each keeps its opener, its beat count, and its closing line, and only removes the claim that the question was shared.

### 3.4 What does not change

- The topics field instruction (`src/recap/highlight.ts:10`). It already says topics are "broad categories, NOT the literal questions asked", which is if anything more true now that there are twice as many literal questions.
- The banned-words list (line 14). Note it already bans opening with "You both mentioned", which is a happy accident: that is exactly the false-sameness opener 3.1 warns about. Keep it.
- The humor rule (line 16) and the aggregate-"you two" ban. Untouched.
- The JSON contract, `responseSchema` (line 32), `MAX_ATTEMPTS` (line 34), `stripCodeFences` (line 38), and the throw-and-degrade behavior in `generateHighlight` (lines 63-91). Untouched.

## 4. The mechanical stats line

**Nothing in `src/recap/assemble.ts` reads the day-level prompt. No change is required there.**

Verified by reading the whole file:

- `assembleWeekStats` (lines 22-35) reads `day.date`, `day.id`, and `ledger.personDay(day.id, person).state`. It never touches `prompt_text` or `prompt_id` on either table.
- `WeekDayStat` (lines 4-8) carries `date`, `aState`, `bState` only.
- `mechanicalRecapText` (lines 44-50) formats `Week of ${formatWeekLabel(...)}: ${bothAnswered}/${totalDays} days answered together.` and reads no prompt text.

The one phrase worth a second look is "days answered together" in line 49. Under per-person prompts that is still literally true: `bothAnswered` increments only when both `person_days.state` values are `answered` (line 31), which is a statement about participation on the same day, not about the same question. The mechanical tier means what it says and should be left exactly as is.

Consequence for the fallback path: when the highlight call throws, `buildWeeklyRecap` (`src/recap/recap.ts:39-41`) degrades to `mechanicalText` alone. That fallback is unaffected by anything in this document, which is a useful property: the riskiest change in this spec cannot break the safe tier.

`src/recap/assemble.ts` therefore stays untouched by this work. It is listed here only to close the question.

## 5. Migration and back-compatibility

The requirement is that a week spanning the change reads correctly with no special case. The design meets it structurally, not by branching.

The data situation, from section 1: every `person_days` row has a non-null `prompt_text`, either seeded at `createDay` (`src/ledger/ledger.ts:235-242`), written by `setPersonPrompt` (`src/ledger/ledger.ts:502`), or backfilled by `migrateSchema` (`src/ledger/ledger.ts:195-206`). Pre-change days therefore have both people's `prompt_text` equal to the day's single question. Post-change days have two different strings.

The layout in section 2 reads `person_days.prompt_text` unconditionally and prints it under each person's name. On a pre-change day that renders as:

```
[2026-07-19] shared angle: How did the psychic reading party with Cora and her mom end up going?
  Alex was asked: How did the psychic reading party with Cora and her mom end up going?
  Alex said: I could not answer this one, it is not my memory
  Sam was asked: How did the psychic reading party with Cora and her mom end up going?
  Sam said: It was chaotic, Cora's mom cried
```

Verbose, and correct. There is deliberately no dedupe branch. Three reasons:

1. A dedupe rule would make the block shape vary day to day inside a single transcript, which is harder for the model to parse than a uniformly repetitive one.
2. The repetition is itself the signal. The instruction in 3.2 licenses same-question framing exactly when "their two question lines that day are word-for-word identical", so the model needs to see both lines to apply the test. Collapsing them removes the evidence for the rule.
3. It is not a migration branch at all, so it also covers the static-bank fallback (`src/prompts/staticBank.ts:26`), which will keep producing identical-question days indefinitely. Any dedupe written for "old days" would silently also be a rule about degraded days, which nobody would remember.

Cost: roughly one extra repeated sentence per pre-change day, bounded to at most 7 days total since the backfill boundary passes out of the recap window within one week.

## 6. Build order

Each step is independently verifiable. Steps 1 and 2 change nothing anybody receives.

1. **Layout only.** Rewrite `buildUserPrompt` (`src/recap/highlight.ts:42-53`) to the section 2 format. System prompt untouched. Extend `tests/recap/highlight.test.ts`, which currently only asserts `calls[0]!.user` contains an answer string (line 38), with: both people's question text present; a day where the two questions differ renders both; a day where they are identical renders the sentence twice; non-answered states still render `(no_response)` and `(skipped)`. Fixtures build via `ledger.createDay(...)` plus `ledger.setPersonPrompt(...)` for the differing case, matching the existing test style at lines 22-25.
2. **Instruction rewrite, behind owner approval.** Apply 3.2, the shared-rules addition in 3.2, and the two example replacements in 3.3, as one reviewable diff of `HIGHLIGHT_SYSTEM_PROMPT`. Do not land this before the owner has read the literal strings.
3. **One live dry run before a real send.** Build a recap over the current straddling week against the real ledger and read the output by hand. This must be a build-only path (`buildWeeklyRecap` in `src/recap/recap.ts:26`), never `sendWeeklyRecap` (`src/recap/send.ts:20`), which sends to both people at lines 37-38 and writes `recordRecap` idempotency state at line 40. Per the standing rule, this goes to the owner first, not to both recipients.

`src/recap/assemble.ts`, `src/recap/recap.ts`, `src/recap/send.ts`, and `src/recap/checker.ts` need no edits in any step.

## 7. Should the recap be personalized?

**Recommendation: keep the recap identical for both people. This is an owner decision, not a technical one, and it is genuinely close.**

Current behavior, `src/recap/send.ts:18-19`:

```ts
/** Idempotent (via hasRecapFor) send of one week's recap to both people,
 * identical text, mirroring how the daily prompt is always identical. */
```

That doc comment's stated reason is now false: the daily prompt is no longer always identical. So the decision has to be re-argued on its own merits rather than inherited.

The case for personalizing (showing each person their own questions for the week) is real. Under per-person prompts, a recap that names a question no longer tells the reader which of them was asked it, and a reader can plausibly want their own week back.

The case for keeping it identical, which I think wins:

1. **The highlight is about the pair, and it is the whole point.** It is one observation connecting both people's answers. There is no version of it that is different per reader without becoming a different artifact. Personalizing the surrounding text while the centerpiece stays shared produces an asymmetric message where the important part is common and the framing is not, which is the worst of both.
2. **They already have their own questions.** Each person received their own at dispatch via `copy.promptMessage` (`src/engine/copy.ts:3`), and received their partner's question alongside their partner's answer via `copy.shareMessage` (`src/engine/copy.ts:18`), which was added for exactly this reason. Re-listing seven questions in the recap is redundancy, and the recap's whole design is a two-tier summary that deliberately does not recite the week (see the topics instruction, `src/recap/highlight.ts:10`: "NOT a recitation of each day").
3. **It is not free.** Personalizing means two `buildWeeklyRecap` outputs or a per-person assembly layer, a `recap_log` schema that can hold two texts (`recordRecap`, `src/ledger/ledger.ts:652`, stores a single `recap_text`), and a second copy surface to keep in the approved voice. That is real cost against a redundancy fix.
4. **A shared artifact is the product.** The ritual is already diluted by per-person questions, which the prior spec names as an accepted risk ("The shared ritual weakens"). The weekly recap is now the last thing in the product that both people receive identically. Splitting it removes the last shared surface.

If the owner wants the gap closed without splitting the message, there is a cheap middle path: allow the highlight to name a question inside the shared text when it needs to ("when Alex got asked about his week starting..."), which reads correctly to both people and needs no schema, no second send, and no new copy surface. It costs one permissive clause in the system prompt and is therefore also step-2 copy needing approval.

## 8. Risks

- **This is the emotionally visible output.** A regression here is felt directly by both people on a Sunday, unlike a bad daily question which is one awkward moment. The mitigation is step 3: read a real generated recap by hand before any send.
- **Prompt rewrites are not currently auditable after the fact.** `sendWeeklyRecap` passes `systemPrompt: null, userPrompt: null, rawResponse: null` to `recordRecap` (`src/recap/send.ts:44-46`) even though `RecapLogEntry` has fields for them. So after step 2 lands there is no stored record of which prompt version produced which historical recap. Recording them is a small change and would make voice regressions diagnosable, but it is out of scope here and should be raised separately.
- **Few-shot drift.** Changing two of four examples changes the voice distribution. The prior spec documents this generator family drifting past soft guidance twice (0/6, then 0/3 on stance). Do not assume the new examples land the intended range without reading real output.
- **The transcript grows.** Five lines per day rather than three gives the model more surface to quote from, and the two new question lines are quotable sentences. The "never quote the shared angle" rule covers the day line; the questions themselves are legitimately quotable, but if live output starts reciting questions rather than answers, that is the cause.
- **Concurrent work in this repo.** Other work is touching adjacent files. Step 1 and step 2 are confined to `src/recap/highlight.ts` and `tests/recap/highlight.test.ts`, which limits collision surface.

## 9. Out of scope

- Anything in `src/recap/assemble.ts`, per section 4. The mechanical tier is correct as written.
- Per-person recap text, unless the owner overrides section 7.
- The recap trigger and idempotency logic in `src/recap/checker.ts` and `src/recap/send.ts`. Untouched.
- Recording `system_prompt` / `user_prompt` / `raw_response` on `recap_log`. Worth doing, separate change.
- The eval harness and its axes, including the "answerable by this specific person" axis the prior spec calls for. Separate reader, separate change.
- `src/prompts/history.ts` and `novelty.ts`. Already per person.
