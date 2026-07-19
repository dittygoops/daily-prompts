# PRD: Memory & Ontology Pipeline (System 2)

Parent: `prd-daily-imessage-checkin.md` · Depends on: `prd-core-messaging-loop.md` (reads its ledger) · Feeds: `prd-adaptive-prompt-generation.md`

## Overview

A background pipeline that turns each resolved day in the core loop's ledger into durable, structured knowledge about each participant. After a day closes (shared, skipped, or expired), an extraction step reads the raw responses and feedback and writes per-person observations — facts, themes, moods, interests, feedback signals — into a memory backend behind a `memory` interface. v0 backend is self-hosted Supermemory running on the same Mac (open-source, single self-contained binary, built-in graph engine and local embeddings), so derived knowledge never leaves the machine. The pipeline is a pure consumer of the ledger: the core loop does not know it exists, and it can ship days after System 1 with zero changes to it.

## Problem Statement

Without memory, every prompt is generated (or picked) from nothing, and the product is just a question-a-day calendar. The whole differentiator — "it starts to actually know you" — requires that what each person says today is available, in usable form, when tomorrow's prompt is conceived. Raw message logs aren't usable form: they need distillation into an ontology per person that an LLM can be given as compact context. This system owns that distillation and its storage.

## Goals & Non-Goals

### Goals
- After each day resolves, extract structured observations per person from responses and feedback, and persist them keyed to that person.
- Accumulate an ontology per participant that improves with use: recurring themes, stated interests, open threads (worries, projects), likes/dislikes about prompts themselves.
- `memory` interface with a retrieval surface adequate for System 3: "give me relevant context about person X" (and "what threads are open / what's unexplored").
- Self-hosted-first: default deployment is the Supermemory binary on the same Mac; hosted Supermemory is a config option.
- Idempotent, replayable extraction: reprocessing a day must not duplicate observations, and the ledger can rebuild memory from scratch.

### Non-Goals
- Generating or selecting prompts (System 3).
- Any participant-facing surface to view/edit/delete their memory (product v2).
- Real-time extraction during the day; end-of-day batch is sufficient.
- Cross-person inference (modeling the relationship itself rather than two people) — interesting, deferred.

## User Stories

- As a participant, prompts increasingly reference things I actually said — last week's worry, a topic I lit up about — so the ritual feels like it knows me.
- As a participant, my stated tastes about prompts themselves ("shorter", "loved this one") persist instead of being re-learned weekly.
- As the operator, I can wipe and rebuild memory from the ledger after changing the extraction logic, so early bad extractions aren't permanent.
- As a future self-hoster, memory runs on my own machine by default; adopting the product never requires shipping intimate data to a memory SaaS.
- As System 3, I can ask the memory interface for compact, relevant context about a person and get something an LLM prompt can actually hold.

## Requirements

### Functional

**F1. Trigger & input**
- Runs when a day reaches a terminal state in the ledger (shared / partially answered / skipped / expired). Input: that day's prompt text, each person's response or skip, and any feedback captured since the previous prompt.

**F2. Extraction**
- One OpenRouter LLM call (or few) per person per day distills the raw material into typed observations, e.g.: `fact` (stable attribute), `thread` (open, follow-up-able situation), `interest`, `mood-signal` (dated, decaying relevance), `prompt-preference` (from feedback and from answer length/energy).
- Observations carry provenance: source day, verbatim snippet they derive from.
- Extraction is conservative: no invented facts; uncertain readings are stored with hedged phrasing or dropped.

**F3. Storage**
- Writes through a `memory` interface. v0 backend: **self-hosted Supermemory** on the same Mac. Hosted Supermemory selectable by config; **Mem0** is the designated fallback if self-hosted Supermemory proves immature (validated in spec).
- Each participant is a distinct memory subject; no observation is ever written to the wrong person or to a shared blob.

**F4. Retrieval (the System 3 contract)**
- `getContext(person, budget)`: compact relevant context for prompt generation — recent mood signals, open threads, durable facts/interests, prompt preferences.
- `getCoverage(person)`: some representation of what topic territory has and hasn't been explored, to support the explore side of explore/exploit.
- Exact shapes settled in spec, but this PRD commits that both exist and are the only coupling surface with System 3.

**F5. Rebuild & idempotency**
- A `rebuild` operation replays the entire ledger through current extraction logic into a fresh memory store.
- Re-running extraction for an already-processed day is a no-op or clean replacement, never a duplicate.

### Non-Functional
- **Privacy**: with the self-hosted default, derived knowledge never leaves the Mac; extraction calls transit OpenRouter (already an accepted party). If hosted Supermemory is configured instead, the README says so plainly.
- **Cost/footprint**: a few small LLM calls per day; Supermemory binary's resource use must be tolerable on a personal Mac (validated in spec).
- **Latency**: none user-facing; extraction may lag day-close by minutes without harm, but must complete before the next day's prompt generation needs it.
- **Auditability**: every observation traceable to its source day and snippet.

## Edge Cases & Open Questions

### Edge cases (handled by design)
- Skipped or expired day → still processed; a skip on a heavy prompt is itself a weak signal, and captured feedback is extracted regardless.
- Extraction call fails → retried; a day that repeatedly fails is flagged and skipped, never blocking subsequent days (rebuild recovers it later).
- Contradictory observations over time (she loved X in March, hates X in June) → both stored with dates; recency weighting is retrieval's problem.
- Memory service down at extraction time → extraction queues; System 3 degrades gracefully (generates with whatever context is retrievable, or none).

### Open questions
1. **Self-hosted Supermemory maturity** (spec): API parity with hosted, resource footprint, durability of its local store; Mem0 fallback if it disappoints.
2. **Observation schema**: the exact type set and whether Supermemory's native graph obviates a custom schema.
3. **Decay/recency policy**: how mood-signals age out of `getContext` results.
4. **Coverage representation**: what "unexplored territory" concretely looks like (topic taxonomy? embedding clusters?) — needed for F4's `getCoverage`.
