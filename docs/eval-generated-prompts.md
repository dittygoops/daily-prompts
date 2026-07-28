# Eval: Generated Prompts (Phase 2)

Generated 2026-07-28T01:07:59.361Z. Judge model: google/gemini-2.5-flash. Source: `generation_log` in the live ledger.

## Summary

- 7 generation attempt(s) recorded; 7 produced a generated prompt, 0 fell back to the static bank.
- 7/7 generated prompts pass all four rubric axes (answerable, single question, appropriate length, emotionally safe).
- **Comparison to the static-bank baseline: 7/7 (100%) generated vs 26/30 (87%) static bank.**
- 0 generated prompt(s) near-duplicate a prompt that preceded them (Jaccard over content words, threshold 0.5).

## Aggregate

### Fallback rate

0/7 (0%) of days fell back to the static bank.

### Explore / exploit mix

Read from the recorded stance column, falling back to classifying the rationale for rows predating it:

| stance | count | share |
|---|---|---|
| exploit | 1 | 14% |
| explore | 5 | 71% |
| unclear | 1 | 14% |

### Axis failure distribution

| axis | failures | rate |
|---|---|---|
| answerable | 0 | 0% |
| singleQuestion | 0 | 0% |
| appropriateLength | 0 | 0% |
| emotionallySafe | 0 | 0% |

## Novelty against prior history

| date | person | prompt | closest prior (theirs) | similarity | near-dup |
|---|---|---|---|---|---|
| 2026-07-21 | (shared) | What's a food or drink you loved as a child that you still enjoy today? | What's your favorite family tradition? | 0.00 | ✅ |
| 2026-07-22 | (shared) | What's an unexpected sound or noise you secretly enjoy? | What's a food or drink you loved as a child that you still enjoy today? | 0.09 | ✅ |
| 2026-07-23 | (shared) | What's one thing you're looking forward to doing or experiencing this week? | What's your favorite family tradition? | 0.00 | ✅ |
| 2026-07-24 | (shared) | What's one thing you're hoping to learn or discover about yourself this week? | What's one thing you're looking forward to doing or experiencing this week? | 0.20 | ✅ |
| 2026-07-25 | (shared) | What's one thing you're currently trying to improve or get better at? | What's one thing you're looking forward to doing or experiencing this week? | 0.10 | ✅ |
| 2026-07-26 | (shared) | What's one small thing that always makes you feel better when you're feeling tired or burnt out? | What's one thing you're currently trying to improve or get better at? | 0.17 | ✅ |
| 2026-07-27 | (shared) | How did the psychic reading party with Cora and her mom end up going? | What's your favorite family tradition? | 0.00 | ✅ |

### Template repetition

Content-word overlap is blind to shared scaffolding, so opening templates are checked separately: two prompts can score near zero on Jaccard while being built from the identical sentence frame.

No day gave both people the same opening frame.

- `whats one thing youre...` used 3 times:
  - "What's one thing you're looking forward to doing or experiencing this week?"
  - "What's one thing you're hoping to learn or discover about yourself this week?"
  - "What's one thing you're currently trying to improve or get better at?"

## Failing prompts

None.

## Full results

| date | prompt | answerable | single | length | safe | novelty | fell back |
|---|---|---|---|---|---|---|---|
| 2026-07-21 | What's a food or drink you loved as a child that you still enjoy today? | ✅ | ✅ | ✅ | ✅ | ✅ | no |
| 2026-07-22 | What's an unexpected sound or noise you secretly enjoy? | ✅ | ✅ | ✅ | ✅ | ✅ | no |
| 2026-07-23 | What's one thing you're looking forward to doing or experiencing this week? | ✅ | ✅ | ✅ | ✅ | ✅ | no |
| 2026-07-24 | What's one thing you're hoping to learn or discover about yourself this week? | ✅ | ✅ | ✅ | ✅ | ✅ | no |
| 2026-07-25 | What's one thing you're currently trying to improve or get better at? | ✅ | ✅ | ✅ | ✅ | ✅ | no |
| 2026-07-26 | What's one small thing that always makes you feel better when you're feeling tired or burnt out? | ✅ | ✅ | ✅ | ✅ | ✅ | no |
| 2026-07-27 | How did the psychic reading party with Cora and her mom end up going? | ✅ | ✅ | ✅ | ✅ | ✅ | no |

## Recorded rationales

- `2026-07-21` (explore): I am exploring food preferences, as both Aditya and Ria have mentioned specific food items they enjoy, but haven't directly compared childhood favorites versus current ones yet.
- `2026-07-22` (explore): Both aditya and ria have shared music-related facts, but not personal sound preferences, making this prompt a good exploration of a new, low-stakes topic.
- `2026-07-23` (explore): This prompt offers a chance to explore positive future-oriented thoughts for both individuals, balancing exploration and providing a general, safe topic.
- `2026-07-24` (unclear): Both Aditya and Ria have open threads that could lead to self-discovery (chores and psychic reading, respectively), so this explores their personal growth without being too prescriptive.
- `2026-07-25` (explore): This explores a current interest of Aditya (self-improvement) while being a broad enough topic for Ria to also answer without difficulty.
- `2026-07-26` (explore): This explores a new topic related to self-care and coping mechanisms, touching on Aditya's recent mood without being intrusive and is generally applicable to anyone.
- `2026-07-27` (exploit): I am exploiting Ria's upcoming psychic reading party, which is a specific, recent, and unasked-about event in her context.
