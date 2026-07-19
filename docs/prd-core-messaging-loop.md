# PRD: Core Messaging Loop (System 1)

Parent: `prd-daily-imessage-checkin.md` · Consumed by: `prd-memory-ontology.md` (reads the ledger), `prd-adaptive-prompt-generation.md` (plugs in behind the prompt-source interface)

## Overview

The backbone of the daily check-in product: an always-on daemon on Aditya's Mac that, at a configured time each day, sends the same short prompt to two phone numbers over a hosted iMessage API, collects each person's reply (bundling multi-text answers with a settle window), and, once both have answered, shares each answer verbatim with the other. It handles skips, waiting notices, feedback capture, out-of-band messages, and expiry, recording everything in a local SQLite ledger that is the single source of truth for day state. In this milestone the daily prompt comes from a static, hand-seeded prompt bank behind a `prompt-source` interface; LLM generation (System 3) replaces the bank later without touching this system.

## Problem Statement

Nothing else in the product can exist until messages reliably go out, come back, and drive a correct day state machine. The hard, risky engineering lives here: provider integration, webhook ingress on a sleeping Mac, idempotent state transitions, and the social contract (you see theirs only when yours is in) that makes the ritual fair. This system must be independently shippable and testable with dumb static prompts, so that the couple can start the daily ritual before any learning exists.

## Goals & Non-Goals

### Goals
- One prompt per day to both participants at a configurable local time, drawn from a static prompt bank behind a `prompt-source` interface.
- Correct, auditable day state machine: dispatched → responses/skips collected → shared/expired, with every transition in the ledger.
- Verbatim mutual sharing gated on both having answered; early responder gets a waiting notice.
- SKIP keyword, feedback capture window, and out-of-band handling all working end to end.
- Provider hidden behind a `channel` interface (LoopMessage / Sendblue / Photon Spectrum — selected in this system's spec).
- Config-file-driven (numbers, names, send time/timezone, settle window, keys); publishable on GitHub for self-hosters.

### Non-Goals
- LLM prompt generation, personalization, explore/exploit (System 3).
- Memory extraction or any Supermemory integration (System 2). This system's obligation ends at faithful capture in the ledger.
- Reminder nudges, recaps, free-form conversation, participant data access, multi-couple (product-wide v2 parking lot).

## User Stories

- As a participant, I get a short prompt each morning that I can answer in under 30 seconds, so the ritual survives busy days.
- As a participant, when I answer first, I'm told my partner hasn't answered yet and that I'll get their response when they do, so the silence isn't confusing.
- As a participant, once we've both answered, I receive my partner's exact words, with no AI paraphrasing in between.
- As a participant, I can reply "SKIP" and the day is cleanly voided for me: I don't see my partner's answer and they're told I skipped, so no one is left waiting.
- As a participant, after I answer I'm asked for feedback or prompt ideas, and anything I send until the next prompt is captured.
- As the operator, I start the daemon with a config file (two numbers, keys, send time) and it runs unattended, surviving Mac sleep with a catch-up poll on wake.
- As a future self-hoster, I can clone the repo, plug in my own keys and numbers, and run the same product.

## Requirements

### Functional

**F1. Channel: hosted iMessage API**
- All outbound/inbound messages go through a hosted provider behind a `channel` interface. **Decided (spec phase): Photon Spectrum Cloud, free tier, shared line** — chosen over LoopMessage (free sandbox is testing-only and webhook-based) and Sendblue ($100/line/mo) for price, first-party TypeScript SDK, and stream-based inbound.
- Accepted trade-offs (decided): messages arrive from a shared-pool service number (dedicated line is a paid upgrade later, no code changes); content transits Photon's servers.
- Inbound arrives over Spectrum's persistent gRPC stream (an outbound connection from the daemon): **no webhook, no Tailscale Funnel, no public surface**. Messages from any number other than the two configured participants are dropped and logged.

**F2. Daily dispatch**
- At the configured local time, fetch today's prompt from the `prompt-source` interface and send the identical text to both numbers. v0 implementation of the interface: a static, hand-seeded bank with no-repeat tracking.
- The prompt message states the SKIP keyword so participants never have to guess.
- A new day's prompt supersedes yesterday's: any unanswered prior prompt expires (state closed, stored as unanswered).

**F3. Response collection**
- Settle window: collect inbound messages until a quiet gap (~2–3 minutes, configurable), then record the bundle as that person's response.
- On recording the first responder: send them a waiting notice and the feedback ask (F5).
- Skip: a reply of exactly "SKIP" (case-insensitive, ignoring surrounding whitespace) marks the person skipped. Nothing else counts; any other text is an answer. No LLM classification.

**F4. Sharing**
- When both responses are recorded, each person receives the other's response verbatim.
- Skip forfeits both ways: the skipper never receives the partner's answer; the partner is promptly told "they skipped today"; the partner's own answer is still recorded in the ledger.
- If the day ends with only one response, that response is stored but never shared; no further messaging about that day.

**F5. Feedback capture**
- One feedback ask per person per day, sent immediately after their answer is recorded: invites prompt ideas and reactions. Optional; silence is fine.
- The feedback channel stays open after the share: any message between the feedback ask and the next day's prompt is captured as feedback, not treated as a prompt answer.
- Obligation ends at faithful capture in the ledger, tagged per person. Consumption is System 3's problem.

**F6. Out-of-band messages**
- Any inbound message when no response/feedback window is open for that person gets one short canned reply explaining the bot only does the daily prompt; logged, not processed.

**F7. Runtime & configuration**
- Always-on daemon (launchd) on the Mac; on wake/restart, the Spectrum stream reconnects and ledger state is reconciled (whether Spectrum backfills messages received while disconnected is spike question SP-1 in the spec; late by hours is acceptable).
- Config file, not code: numbers + display names, send time and timezone, settle window, provider key, and (for later systems) OpenRouter/memory keys. No secrets committed.

**F8. Ledger**
- SQLite ledger records every message in/out, day state transition, skip, expiry, and feedback item with timestamps. It is the single source of truth for the state machine and the read surface for Systems 2 and 3.

### Non-Functional
- **Latency**: waiting notices, shares, and feedback asks within ~30 seconds of the triggering event (post-settle-window); daily prompt within 1 minute of the configured time.
- **Privacy**: content transits only the iMessage provider (named plainly in the README); ledger stays on the Mac; participants informed before first use.
- **Reliability**: send failures retry with backoff; a day that can't be dispatched within a few hours is marked failed and surfaced loudly to the operator, never silently dropped.
- **Auditability**: everything timestamped in the ledger, including rejected webhook traffic.
- **Portability**: no machine-specific paths or personal identifiers hardcoded.

## Edge Cases & Open Questions

### Edge cases (handled by design)
- Both answer within the same settle window → bundles recorded independently; shares go out once both close.
- Reply to yesterday's prompt after today's went out → treated as today's response (the only open window); ledger keeps honest timestamps.
- Thoughts trickle in after the settle window closed → they fall into the feedback channel, never amend the shared answer.
- Both skip → each told the other skipped; day closes.
- Unknown number → dropped and logged.
- Provider outage at prompt time → retry with backoff, then mark the day failed and surface it.
- Ambiguous reply ("ugh, today") → it's the answer; only a literal "SKIP" skips.

### Open questions
1. ~~Provider selection~~ — resolved: Photon Spectrum Cloud free tier (see `spec-core-messaging-loop.md`); residual spike questions SP-1/SP-2 live there.
2. **Timezone split**: v0 assumes both participants share the configured timezone; is one send time acceptable during travel?
3. ~~Stack~~ — resolved: TypeScript + Bun (bun:sqlite, bun test).
4. ~~Prompt bank seed~~ — resolved: 30 seed prompts live in `prompt-bank-seed.md`.
