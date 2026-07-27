# Per-Person Daily Prompts

Design doc, 2026-07-27. Status: approved, not yet implemented.

## The problem, observed live

On 2026-07-27 the daily prompt was:

> How did the psychic reading party with Cora and her mom end up going?

The psychic reading party is Ria's thread. Aditya received the identical question and had no way to answer it. His words: "This is Ria's memory, I have no way of responding."

Nothing malfunctioned. The generator picked the most alive item in memory, asked in the past tense because the event had passed, and obeyed the exploit stance it was assigned. The design was wrong, not the execution.

Two distinct failures come out of one root cause:

1. **Unanswerable questions.** One identical prompt drawn from a memory holding two separate people means every exploit is a coin flip on whether the other person can participate at all.
2. **A privacy vector.** An exploit on one person's thread tells the other person that they mentioned it. Here that was harmless. For something not yet shared, it would not be.

## Why the obvious fix does not work

The cheaper option was to restrict exploits to mutual ground. Live coverage data as of 2026-07-27:

| | Aditya | Ria | Shared |
|---|---|---|---|
| Topics | 26 | 22 | **4** |

The only shared topics are `family-dynamics`, `family-traditions`, `food-preferences`, `music-preferences`. Four broad categories, against a standing no-repeat rule, so exploits would exhaust them within weeks and then either repeat or stop firing.

Meanwhile all 13 open threads are one-sided: Aditya has job search, guitar, burnout; Ria has reading, fitness, the psychic party. **The alive material is one-sided by nature.** That is not a flaw in extraction, it is two people with separate lives. Restricting exploits to mutual ground restricts them to the least interesting things the couple has in common.

This is also why a prompt-wording fix is insufficient on its own. A widening instruction is already in place as a stopgap, but it relies on model judgment, and this generator has drifted past soft guidance twice: 0/6 exploit under "aim for a mix", then 0/3 under an explicit 1-in-3 target, which is why stance is now decided in code.

## Decision

**Each person gets their own prompt, generated from their own memory.**

One LLM call returns both prompts, rather than two independent calls. This keeps cost at one call, and lets the model give the two questions a common thread so the ritual still feels shared rather than like two unrelated surveys.

The sharing step gets richer as a direct result, because the partner's question is now worth showing:

```
Ria was asked:
  How did the psychic reading party go?

She said:
  ...
```

## Stance under per-person prompts

`decideStance` stays day-level, preserving the roughly 1-in-3 cadence and the existing tests. One refinement: the assigned stance is a day-level intent, and a person with no open threads falls back to explore for that day even on an exploit day. Without this, a person with an empty thread list on an exploit day gets a forced follow-up about nothing.

## Data model

`person_days` gains the prompt, because the prompt is now a per-person fact:

- `person_days.prompt_id TEXT`
- `person_days.prompt_text TEXT`

`days.prompt_text` is retained and repurposed to hold the day's shared **theme** when the generator supplies one, since a day still needs a single label for recap and history purposes. It is no longer the question anybody was asked.

`generation_log` gains a nullable `person` column, one row per person per generation. Nullable because fallback rows represent a day where no per-person generation happened. This also makes `prompt_scores` per person for free, since it already keys off `generation_id`.

**Migration.** Additive only, in the existing `migrateSchema` pattern (`CREATE TABLE IF NOT EXISTS` never reaches an existing ledger, which is why that helper exists). Backfill `person_days.prompt_id` and `prompt_text` from the owning day for every historical row, so old days keep reading correctly and no query needs a null branch for history.

## Blast radius

Everything that assumes one question per day:

| Area | Change |
|---|---|
| `PromptSource` | Returns a prompt per person rather than one prompt |
| `EngineRuntime` dispatch | Sends each person their own prompt |
| Share step (`copy.ts`) | Carries the partner's question alongside their answer |
| `history.ts` | Recent-prompt history and no-repeat become per person |
| `novelty.ts` usage | Near-duplicate checks run within a person's own history |
| Weekly recap | Assembles per-person question and answer pairs |
| Eval scripts | Score two prompts per day, grouped by person |
| Static bank fallback | Unchanged: degraded mode gives both people the same question, which is acceptable and simpler |

## Build order

1. **Schema and migration**, with backfill. Nothing reads the new columns yet.
2. **Generation**: one call returning both prompts, recorded per person.
3. **Dispatch and share**: the state machine sends per-person prompts and the richer share message.
4. **Readers**: recap, history, novelty, eval.

Steps 1 and 2 are invisible in production until step 3 lands, so they can be built and verified without changing what anybody receives.

## Risks

**This touches the state machine**, the most protected and most-tested code in the project. It must land before Phase 2 of the messaging-personality work, which modifies the same code. Doing both at once would be a mess.

**The shared ritual weakens.** The product's premise is that both people answer the same question and then see each other. Different questions dilute that, which is why the single generation call should give the two prompts a common thread rather than treating them as independent.

**The eval harness cannot currently catch the bug this fixes.** Its `answerable` axis scores a question in isolation, so the psychic-party prompt passes cleanly. A rubric axis for "answerable by this specific person given their memory" is needed regardless, and belongs with step 4.

## Out of scope

Per-person prompt *timing* (both still dispatch together). Per-person nudges beyond what already exists. Changing the static-bank fallback to be per person.
