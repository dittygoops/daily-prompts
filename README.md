# daily-prompts

A tiny always-on agent that texts the same short daily question to two people (a couple) over iMessage, collects their answers, and shares each person's answer with the other only once both are in. Skipping is one word (SKIP). Feedback is welcome any time after you answer. Over time the daily question is generated from each person's accumulated memory (recent threads, interests, coverage of past topics) rather than drawn from a fixed list — if generation ever fails, it falls back to a static 30-question bank so the daily ritual never misses a day.

Docs: product overview in `docs/prd-daily-imessage-checkin.md`, system PRDs and the build spec alongside it in `docs/`.

## Privacy, plainly

Messages and answers transit two third parties: **Photon** (the iMessage delivery service, photon.codes) and **OpenRouter** (LLM API, used to extract per-person memory from each day's answers, and to generate each day's question from that memory). Derived memory (not verbatim messages) is stored in a **self-hosted Supermemory** instance on the same machine (`~/.supermemory/data`) — it never leaves your Mac. Conversation history itself lives in a local SQLite file (`ledger.db`) on the machine running the daemon. Both participants should know this before the first prompt goes out.

## Self-hosting

1. **Photon**: sign up at [app.photon.codes](https://app.photon.codes), create a project, note the project ID and secret. The free shared-line tier is sufficient. Use a project that nothing else shares, or inbound replies will cross-route.
2. **OpenRouter**: sign up at [openrouter.ai](https://openrouter.ai), create an API key, add a few dollars of credit (see `docs/openrouter-cost-report.md` — expected spend is well under $1/month at this volume, but OpenRouter rejects requests outright once your balance drops near $0).
3. **Supermemory** (self-hosted, one-time):
   ```bash
   curl -fsSL https://supermemory.ai/install | bash
   ```
   Then point it at OpenRouter by editing `~/.supermemory/env`:
   ```
   OPENAI_BASE_URL=https://openrouter.ai/api/v1
   OPENAI_API_KEY=<your OpenRouter key>
   OPENAI_MODEL=google/gemini-2.5-flash
   ```
   Install it as an always-on service:
   ```bash
   cp ops/com.dailyprompts.supermemory.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.dailyprompts.supermemory.plist
   tail -f ~/Library/Logs/supermemory.log
   ```
   Its first boot prints an API key — you'll need it for the next step.
4. **Install**: `bun install` (needs [Bun](https://bun.sh)).
5. **Configure**: copy `.env.example` to `.env` and set `SPECTRUM_PROJECT_ID`/`SPECTRUM_PROJECT_SECRET` (from your Photon project), `OPENROUTER_API_KEY`, and `SUPERMEMORY_API_KEY` (from step 3). Copy `config.example.json` to `config.json` (two names + E.164 phone numbers, dispatch time, IANA timezone; the `extraction`/`generation` blocks' defaults are usually fine as-is).
6. **Run**: `bun index.ts` (foreground), or install the launchd job for always-on:

```bash
cp ops/com.dailyprompts.daemon.plist ~/Library/LaunchAgents/
# edit the four absolute paths inside (bun binary, working directory, two log paths)
launchctl load ~/Library/LaunchAgents/com.dailyprompts.daemon.plist
tail -f ~/Library/Logs/daily-prompts.log
```

The daemon reconnects its message stream after sleep; messages sent while it was down are delivered on reconnect. A dispatch missed while asleep is sent late the same calendar day, and abandoned entirely after midnight. Memory extraction runs on a poller (`extraction.pollMinutes`, default 5) plus a startup catch-up pass, and never blocks message dispatch even if OpenRouter or Supermemory are down — failed extractions retry automatically (up to 3 attempts) on the next poll.

Observations are stored with the date they were derived from, and the extractor resolves relative time references ("this weekend", "on Friday") to absolute dates before storing, since a stored observation is re-read months later when "this weekend" would still read as upcoming. The generator is told today's date alongside those dated lines, so it can tell a live thread from one that has since passed and ask about it in the past tense.

### Adaptive prompt generation

Each day's question is generated fresh from both people's memory context (facts, open threads, interests, topic coverage), recent prompt history (so it doesn't repeat), and any feedback or explicitly suggested prompt ideas.

Whether the day follows up on a known thread (exploit) or opens new territory (explore) is decided in code, not by the model: `src/prompts/stance.ts` assigns exploit when either person has an open thread and none of the recent days exploited one, giving a roughly 1-in-3 cadence, and the generator is told which mode it is in. This started as a model judgment call and it chose explore on 6 out of 6 live days, so the decision moved into code. The assigned stance is recorded in `generation_log.stance`. A generated prompt that near-duplicates one already sent is rejected and regenerated, using the same deterministic content-word check the eval harness uses. If generation fails for any reason — OpenRouter down, a malformed response, Supermemory unreachable — it falls back to the static 30-question bank (`data/prompts.json`) so the daily message always goes out; every fallback is logged loudly and recorded in the ledger's `generation_log` table alongside every successful generation's full context and reasoning, for later review. Suggested prompt ideas are tracked durably (never silently expire) until the generator actually uses one.

### Reminder nudges

If one or both of you hasn't answered yet, a gentle nudge can go out via three independent triggers, each fires at most once per person per day: **no_response** (neither of you has answered `nudge.afterHours` — default 4 — after the prompt went out), **partner_waiting** (your partner answered and it's been `nudge.afterHours` since then and you still haven't — worded as "X is waiting on you"), and **almost_due** (a last call within `nudge.beforeDueHours` — default 4 — of the next day's prompt, regardless of your partner's state). More than one can fire for the same person on the same day if their conditions are met at different times. Nudges never interrupt someone mid-answer (`collecting` state) and stop entirely once you've answered or skipped. On by default; set `nudge.pollMinutes` (default 10) to change how often the checks run, or all three hour values to change the timing.

### Weekly recap

Optional (`weeklyRecap.enabled`, default `false`) — both of you get an identical recap covering the trailing 7 days: mechanical stats (days answered together, topics touched, pulled from the ledger, never from the LLM) plus an LLM-synthesized highlight paragraph grounded in that week's actual answers. If the highlight generation fails, the recap still goes out with just the mechanical stats. It's triggered by state, not a fixed clock time: `weeklyRecap.dayOfWeek` (0=Sunday..6=Saturday) names the day that ends each week, and the recap fires as soon as that day's prompt has actually resolved, whether both of you answered (same-day), one did, or neither did (it fires once the next day's prompt dispatches and expires it). A poller checks this every `weeklyRecap.pollMinutes` (default 15); no separate missed-recap handling is needed since the next poll after any downtime catches up naturally.

### Personality

Optional flourishes on top of the plain-text product: `personality.intensity` (`off`/`subtle`/`playful`) decides how much decoration a message carries, `personality.animalImage` decides whether a real cat or dog photo rides along with the daily question, and `personality.animalTimeoutMs` (default 10000) caps how long the image fetch is allowed to take. `intensity` defaults to `"off"`, not `"playful"`, on purpose: a schema default of `"playful"` would silently turn the feature on the next time an existing `config.json` (written before this block existed) restarts with no `personality` key at all, and this project has already had a feature fire unannounced to a participant that way. `"playful"` is the intended steady state, but it has to be set explicitly.

At `"subtle"`, only genuine good news (both people answering, the weekly recap) gets a moment; a skipped day stays silent rather than reading as mocking someone for missing. At `"playful"`, the daily question itself is emphasized, shares and the recap are celebrated, a skipped day gets a gentle acknowledgement, and nudges are always gentle at either non-off level, never escalating, since a louder nudge reads as nagging.

`animalImage` is independent of `intensity`'s other effects: it can be switched off on its own to keep the wording-level flourishes without the network fetch, or the reverse. A failed or slow animal fetch never delays or blocks the daily question: the fetch races a deadline, any failure is absorbed silently, and the prompt goes out with text only (retried as plain text even if a vendor rejects the attachment after the fact). Images are attached only to the daily prompt itself, never to nudges, shares, or the recap.

### Prompt quality scoring

Every generated prompt is judged once against the rubric in `src/eval/rubric.ts` (answerable, single question, appropriate length, emotionally safe) and the verdict is written to the ledger's `prompt_scores` table, so quality drift shows up in the data rather than only when a report is run by hand. This runs on the extraction poller's tick, costs one judge call per generated day, and never blocks anything: a failed judging leaves the row pending for a later pass. Two on-demand reports go deeper:

```bash
bun scripts/eval-static-bank.ts config.json        # scores the 30 static prompts -> docs/eval-baseline-static-bank.md
bun scripts/eval-generated-prompts.ts config.json  # scores real generated prompts -> docs/eval-generated-prompts.md
```

The generated-prompt report adds what a single-prompt score cannot see: near-duplication against everything sent before it, reuse of an opening sentence frame, the explore/exploit mix, and the fallback rate.

### Rebuilding memory

If a bad extraction run needs undoing (a code/prompt bug, a misconfigured backend), memory is fully rederivable from the ledger, which is the durable source of truth:

```bash
# stop the daemon first — a concurrent extraction poll can race with a rebuild
launchctl unload ~/Library/LaunchAgents/com.dailyprompts.daemon.plist

bun scripts/rebuild-memory.ts config.json --dry-run   # preview, makes no changes
bun scripts/rebuild-memory.ts config.json --yes        # wipe + reprocess both people
bun scripts/rebuild-memory.ts config.json --person=a --yes  # just one person

launchctl load ~/Library/LaunchAgents/com.dailyprompts.daemon.plist
```

This permanently deletes the target person's derived memory before reprocessing, so it requires an explicit `--yes` (or `--dry-run` to preview harmlessly).

## Development

```bash
bun test          # full suite; all logic is tested against fakes
bunx tsc --noEmit # typecheck
```

Development follows TDD (tests first, red before green). The state machine (`src/engine/stateMachine.ts`) is pure and owns all product rules; `src/engine/runtime.ts` executes its effects against the ledger, timers, and channel; `src/channel/spectrum.ts` is the only file that talks to Photon.
