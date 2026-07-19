# Daily iMessage Check-In: Product Overview

A small always-on agent that texts the same short daily prompt to two people (a couple) over iMessage via a hosted API, collects their replies, and, once both have answered, shares each person's answer verbatim with the other. Prompts are designed to be answerable in 15–30 seconds. Over time the agent builds a per-person memory from responses and feedback and uses it to ask better questions: sometimes digging deeper into known threads, sometimes opening new territory. v0 is hardcoded to exactly two participants, one prompt plus one feedback ask per day, no free-form conversation, and is built to be publishable on GitHub so others can self-host with their own keys and numbers.

## Why

Couples want a low-effort daily ritual for learning what's on each other's mind. Generic question-a-day apps ask everyone the same static questions, remember nothing, and live in yet another app. This lives in iMessage, takes under a minute, creates a fair exchange (you see theirs only when yours is in), and gets more personal the longer it runs.

## System PRDs

The product splits into three systems along "ships and runs without the others" seams:

1. **[Core Messaging Loop](prd-core-messaging-loop.md)** — channel/provider integration, scheduler, day state machine, settle-window response collection, verbatim sharing, SKIP, feedback *capture*, out-of-band handling, SQLite ledger, Mac daemon runtime. Independently shippable with a static prompt bank. All engineering risk lives here. **Build first.**
2. **[Memory & Ontology Pipeline](prd-memory-ontology.md)** — end-of-day extraction of structured per-person observations from the ledger into self-hosted Supermemory, behind a `memory` interface. Pure ledger consumer; System 1 doesn't know it exists.
3. **[Adaptive Prompt Generation](prd-adaptive-prompt-generation.md)** — OpenRouter generation grounded in memory, coverage, history, and feedback *consumption*, with explore/exploit at the agent's judgment. Replaces the static bank behind System 1's `prompt-source` interface.

The feedback seam is deliberate and mirrors the sibling `networks` project's capture/learning split: System 1 captures feedback faithfully in the ledger; System 3 consumes it.

## Cross-Cutting Decisions (bind all systems)

- **Hosted iMessage API: Photon Spectrum Cloud** (free tier, shared line) behind a `channel` interface; shared-pool sender identity and provider transit are accepted trade-offs. Inbound rides Spectrum's persistent gRPC stream, so there is no webhook and no public surface.
- **Runtime**: always-on daemon on Aditya's Mac (launchd); stream reconnect + ledger reconciliation after sleep. Stack: TypeScript + Bun.
- **Privacy parties**: iMessage provider and OpenRouter only, named plainly in the README; memory is self-hosted Supermemory on the same Mac by default, so derived knowledge never leaves the machine. Both participants informed before first use. No participant data-access surface in v0.
- **SKIP** is exactly the word "SKIP" (case-insensitive); anything else is an answer. Skip forfeits both ways.
- **Sharing is always verbatim**; no mediation, no private-marking.
- **Configuration over code** everywhere (numbers, times, keys), for the self-hosting story.
- **Development process**: all implementation follows test-driven development (superpowers TDD skill) — tests written first, red before green, for every feature and bugfix.
- **Seed prompts**: the v0 static bank is `prompt-bank-seed.md` (30 prompts).

## Product-Wide v2 Parking Lot

- Reminder nudges to the slow responder; recycling expired prompts.
- Weekly recap digest.
- Participant data access (view/delete your memory).
- Multi-couple support; free-form conversation; mediated sharing options.
- Prompt evaluation harness feeding both generation quality and a real explore/exploit policy.
