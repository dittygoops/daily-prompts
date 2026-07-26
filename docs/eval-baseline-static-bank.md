# Eval Baseline: Static Prompt Bank (Phase 0)

Generated 2026-07-21T00:06:57.965Z. Model: google/gemini-2.5-flash.

## Summary

- 30 prompts scored.
- 26/30 pass all four rubric axes (answerable, single question, appropriate length, emotionally safe).
- 0 exact within-bank duplicate(s).

## Failing prompts

### `p13`: "What's your most-used emoji, and why that one?"
- **answerable**: FAIL — Choosing and explaining a 'most-used' emoji requires recall and a small explanation, which might take longer than 15-30 seconds to formulate.
- **singleQuestion**: FAIL — This is a compound question asking for two things: the emoji and the reason.

### `p14`: "Window or aisle seat, and what's the reasoning?"
- **singleQuestion**: FAIL — The prompt asks two distinct questions: 1) 'Window or aisle seat?' and 2) '...and what's the reasoning?'

### `p18`: "What's your favorite time of day, and what makes it yours?"
- **answerable**: FAIL — Two questions are asked.
- **singleQuestion**: FAIL — This is two questions bunched into one, but separated by 'and'.

### `p30`: "What's the first concert/movie/book you remember loving as a kid?"
- **singleQuestion**: FAIL — This is a compound question: "concert OR movie OR book?"

## Full results

| id | prompt | answerable | single | length | safe |
|---|---|---|---|---|---|
| `p01` | What's your favorite thing to cook? | ✅ | ✅ | ✅ | ✅ |
| `p02` | Best movie you've seen in the last 6 months? | ✅ | ✅ | ✅ | ✅ |
| `p03` | What song have you had on repeat lately? | ✅ | ✅ | ✅ | ✅ |
| `p04` | What's your ideal breakfast? | ✅ | ✅ | ✅ | ✅ |
| `p05` | How old were you when you learned to ride a bike? | ✅ | ✅ | ✅ | ✅ |
| `p06` | What's a smell that instantly takes you back somewhere? | ✅ | ✅ | ✅ | ✅ |
| `p07` | What's your dream coffee/drink order if money and calories didn't matter? | ✅ | ✅ | ✅ | ✅ |
| `p08` | What's the last thing that made you laugh out loud? | ✅ | ✅ | ✅ | ✅ |
| `p09` | What's your go-to comfort show? | ✅ | ✅ | ✅ | ✅ |
| `p10` | If you could teleport anywhere just for dinner tonight, where? | ✅ | ✅ | ✅ | ✅ |
| `p11` | What's a small purchase (under $25) that genuinely improved your life? | ✅ | ✅ | ✅ | ✅ |
| `p12` | What were you obsessed with at age 10? | ✅ | ✅ | ✅ | ✅ |
| `p13` | What's your most-used emoji, and why that one? | ❌ | ❌ | ✅ | ✅ |
| `p14` | Window or aisle seat, and what's the reasoning? | ✅ | ❌ | ✅ | ✅ |
| `p15` | What's one food you flat-out refuse to eat? | ✅ | ✅ | ✅ | ✅ |
| `p16` | Best concert or live event you've ever been to? | ✅ | ✅ | ✅ | ✅ |
| `p17` | What did 8-year-old you want to be when you grew up? | ✅ | ✅ | ✅ | ✅ |
| `p18` | What's your favorite time of day, and what makes it yours? | ❌ | ❌ | ✅ | ✅ |
| `p19` | Which app do you open first in the morning? | ✅ | ✅ | ✅ | ✅ |
| `p20` | What's a skill you'd download Matrix-style right now if you could? | ✅ | ✅ | ✅ | ✅ |
| `p21` | What was your favorite class you ever took in school? | ✅ | ✅ | ✅ | ✅ |
| `p22` | Best meal you've had this month? | ✅ | ✅ | ✅ | ✅ |
| `p23` | Free Saturday, zero obligations: what does it look like? | ✅ | ✅ | ✅ | ✅ |
| `p24` | What's a tiny thing that always makes your day a little better? | ✅ | ✅ | ✅ | ✅ |
| `p25` | Who was your first celebrity crush? | ✅ | ✅ | ✅ | ✅ |
| `p26` | What's your favorite family tradition? | ✅ | ✅ | ✅ | ✅ |
| `p27` | What game (board, video, card, anything) could you play forever? | ✅ | ✅ | ✅ | ✅ |
| `p28` | What's something you've been meaning to try but still haven't? | ✅ | ✅ | ✅ | ✅ |
| `p29` | Best gift you've ever received? | ✅ | ✅ | ✅ | ✅ |
| `p30` | What's the first concert/movie/book you remember loving as a kid? | ✅ | ❌ | ✅ | ✅ |
