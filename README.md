# daily-prompts

A tiny always-on agent that texts the same short daily question to two people (a couple) over iMessage, collects their answers, and shares each person's answer with the other only once both are in. Skipping is one word (SKIP). Feedback is welcome any time after you answer.

Docs: product overview in `docs/prd-daily-imessage-checkin.md`, system PRDs and the build spec alongside it in `docs/`.

## Privacy, plainly

Messages transit two third parties: **Photon** (the iMessage delivery service, photon.codes) and, once prompt generation ships, **OpenRouter** (LLM API). Conversation history lives in a local SQLite file (`ledger.db`) on the machine running the daemon. Both participants should know this before the first prompt goes out.

## Self-hosting

1. **Photon**: sign up at [app.photon.codes](https://app.photon.codes), create a project, note the project ID and secret. The free shared-line tier is sufficient. Use a project that nothing else shares, or inbound replies will cross-route.
2. **Install**: `bun install` (needs [Bun](https://bun.sh)).
3. **Configure**: copy `.env.example` to `.env` and set `SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET` (Spectrum is Photon's SDK; the credentials come from your Photon project). Copy `config.example.json` to `config.json` (two names + E.164 phone numbers, dispatch time, IANA timezone).
4. **Run**: `bun index.ts` (foreground), or install the launchd job for always-on:

```bash
cp ops/com.dailyprompts.daemon.plist ~/Library/LaunchAgents/
# edit the four absolute paths inside (bun binary, working directory, two log paths)
launchctl load ~/Library/LaunchAgents/com.dailyprompts.daemon.plist
tail -f ~/Library/Logs/daily-prompts.log
```

The daemon reconnects its message stream after sleep; messages sent while it was down are delivered on reconnect. A dispatch missed while asleep is sent late the same calendar day, and abandoned entirely after midnight.

## Development

```bash
bun test          # full suite; all logic is tested against fakes
bunx tsc --noEmit # typecheck
```

Development follows TDD (tests first, red before green). The state machine (`src/engine/stateMachine.ts`) is pure and owns all product rules; `src/engine/runtime.ts` executes its effects against the ledger, timers, and channel; `src/channel/spectrum.ts` is the only file that talks to Photon.
