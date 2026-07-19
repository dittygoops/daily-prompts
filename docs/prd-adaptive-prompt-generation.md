# PRD: Adaptive Prompt Generation (System 3)

Parent: `prd-daily-imessage-checkin.md` · Depends on: `prd-core-messaging-loop.md` (implements its `prompt-source` interface), `prd-memory-ontology.md` (consumes `getContext` / `getCoverage`)

## Overview

The intelligence that replaces the core loop's static prompt bank. Each day, before dispatch time, it composes one short prompt via an OpenRouter LLM call, informed by each person's memory context, topic coverage, recent prompt history, and captured feedback — including explicitly suggested prompt ideas, which should tend to surface within a few days. It balances exploitation (digging into known open threads: "you mentioned the thesis stress Tuesday...") against exploration (territory never asked about), at the agent's judgment in v0. It plugs in behind the same `prompt-source` interface the static bank implements, so adopting it changes nothing in System 1.

## Problem Statement

A static bank runs dry and never gets more personal; the product's promise is that day 60 feels different from day 3 because the questions come from accumulated understanding. Separately, the feedback the core loop faithfully captures is worthless until something consumes it. This system is where knowing-the-person becomes asking-better-questions.

## Goals & Non-Goals

### Goals
- Generate one prompt per day, identical for both participants, answerable in 15–30 seconds (encoded as system-prompt guidance, not a hard validator, in v0).
- Ground generation in: memory context for both people, coverage gaps, recent prompt history (no repeats or near-repeats), and feedback/prompt ideas.
- Explicit participant prompt ideas surface within the next few days when reasonable.
- Balance exploration vs exploitation at the agent's judgment (examples: exploitation = follow up on her Tuesday thesis worry; exploration = childhood, never yet touched).
- Honor taste feedback ("too long", "loved this kind") as standing generation constraints.
- Clean seams for the future evaluation harness: log the full generation context and reasoning per prompt so quality can be judged offline later.

### Non-Goals
- A quality evaluation harness, automated prompt scoring, or a tuned explore/exploit policy (explicitly future work; v0 is prompt-engineering vibes plus logged material for later evaluation).
- Hard rejection/regeneration loops on the 15–30-second bar.
- Per-person divergent prompts (both always get the same prompt; divergence is a possible v2).
- Multi-day arcs or scheduled themed series.

## User Stories

- As a participant, prompts increasingly reference what I actually said before, so it feels like a curious friend rather than a calendar.
- As a participant, when I suggest a prompt idea, some version of it shows up within a few days, so contributing feels worthwhile.
- As a participant, when I say prompts are too long or a topic isn't fun, that changes what I get, and I never have to say it twice.
- As a participant, the mix keeps a rhythm between going deeper on things I've shared and surprising me with something new.
- As the operator, every generated prompt is logged with the exact context and rationale that produced it, so when the eval harness arrives there is history to evaluate against.

## Requirements

### Functional

**F1. Generation**
- Implements System 1's `prompt-source` interface; invoked shortly before dispatch time; returns one prompt string.
- OpenRouter LLM call whose context assembles: `getContext` for both people, `getCoverage`, the last ~N prompts with response-energy signals (answered/skipped, length), and outstanding feedback items.
- System prompt encodes: 15–30-second answerability, shortness, emotional safety for a couple's daily ritual, no repeats, and the explore/exploit balancing instruction (agent's judgment).

**F2. Feedback consumption**
- Reads feedback captured by System 1 from the ledger: taste signals become standing constraints; explicit prompt ideas enter a candidate queue with a bias to surface within a few days; used ideas are marked consumed.
- Skips and thin answers on a topic register as negative signal for that territory.

**F3. Traceability**
- Every generated prompt is logged with the full assembled context, the model/params used, and which feedback items or memory threads it drew on. This log is the future eval harness's raw material and the debugging surface for "why did it ask that?".

**F4. Fallback**
- If generation fails (OpenRouter outage, empty memory early on) the `prompt-source` falls back to the static bank so the daily ritual never misses a day. Day 1 with empty memory is exactly this path plus pure exploration.

### Non-Functional
- **Latency/reliability**: generation completes before dispatch time with margin; any failure falls back rather than delaying the day's prompt.
- **Cost**: one or few OpenRouter calls per day; model tier chosen in spec.
- **Privacy**: memory context transits OpenRouter (an already-accepted party); no new parties introduced.
- **Tunability**: prompt templates and explore/exploit instruction live in editable prompt files, not code, so iteration doesn't require deploys.

## Edge Cases & Open Questions

### Edge cases (handled by design)
- Empty or sparse memory (first days) → exploration-heavy generation or static-bank fallback; no crash, no weirdly presumptuous questions.
- Contradictory feedback between the two participants (one wants deeper, one wants lighter) → agent splits the difference and alternates; logged so the tension is visible.
- A suggested prompt idea is inappropriate for the format (too long, too heavy) → adapted rather than used verbatim, or dropped with the adaptation logged.
- Generated prompt near-duplicates a recent one → recent-history context instructs against it; v0 accepts the residual risk (no hard similarity check).

### Open questions
1. **Model choice** (spec): which OpenRouter model tier balances quality and cost for one small daily call.
2. **Explore/exploit policy**: agent judgment in v0; a real policy awaits the evaluation harness (future work, out of scope here).
3. **Context budget**: how much memory context fits before prompts get over-fitted and creepy versus warm; needs live iteration.
4. **Response-energy heuristics**: how crudely can "they loved this topic" be inferred from length/latency without an eval harness?
