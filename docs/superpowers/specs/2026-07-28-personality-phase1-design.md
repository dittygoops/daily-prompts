# Personality Phase 1: Animal Images, Effects, and Intensity Config

Design spec, 2026-07-28. Status: proposed, not implemented.

Parent design: `docs/superpowers/specs/2026-07-27-messaging-personality-design.md` (approved). This spec covers **Phase 1 only**, described there at line 138: "widen the `Channel` interface, add animal images to the daily prompt, add semantic effects, add the intensity config. Touches no participant data and never modifies the state machine."

## What already exists

Five modules are built, committed, and unit tested, but nothing imports them outside their own tests. This spec is entirely about wiring them in.

| Module | Status | Phase |
|---|---|---|
| `src/channel/types.ts` | `Outbound`, `Effect`, `ChannelInbound.attachment`, `Channel.fetchAttachment?` all defined (lines 5-30) | 1 (partly), 2 |
| `src/channel/spectrum.ts` | `outboundContents` (line 20), `send` loops sequentially (lines 179-185), `decodeInbound` handles attachments and captioned groups (lines 53-139) | 1, 2 |
| `src/channel/fake.ts` | `sent` records `Outbound` (line 5), `outboundTo` (line 44), `injectAttachment` (line 26) | 1, 2 |
| `src/media/animals.ts` | `AnimalImageSource`, `HttpAnimalImageSource`, `FakeAnimalImageSource` (lines 14, 196, 248) | **1** |
| `src/engine/effects.ts` | `effectFor(event, intensity)` (line 52) | **1** |
| `src/media/convert.ts` | `toBackgroundImage` (line 96) | 3 only, stays unwired |
| `src/photos/schedule.ts` | `isPhotoDay`, `turnHolder`, `resolveBackground` | 3 only, stays unwired |

The inbound half of `types.ts` (`attachment`, `fetchAttachment`) and the `background` half of `Outbound` are already in the type surface but remain unused after Phase 1. That is fine: the types were landed together deliberately, and leaving them unused is cheaper than a second interface change later.

## 1. Config shape

### Zod schema addition

`src/config.ts` builds `rawConfigSchema` from line 12 to line 64. Add the block after `weeklyRecap` (line 63), following the exact `.object({...}).default({...})` shape already used by `nudge` (lines 49-55) and `weeklyRecap` (lines 56-63):

```ts
  personality: z
    .object({
      /** Master control. "off" is a hard kill switch honoured inside
       * effectFor itself (src/engine/effects.ts:54), not just here. */
      intensity: z.enum(["off", "subtle", "playful"]).default("playful"),
      /** Independently switchable from effects: the two enrichments have
       * different failure modes (an outbound network fetch vs a local
       * vendor flag) and different annoyance profiles, so one can be
       * turned off without silencing the other. Ignored when
       * intensity is "off", which suppresses everything. */
      animalImage: z.boolean().default(true),
      /** Hard wall-clock deadline for the whole animal fetch, including
       * HttpAnimalImageSource's internal retries (up to MAX_ATTEMPTS = 3
       * at src/media/animals.ts:192, each with its own 8s timeout at
       * line 190). Without an outer deadline three slow-but-not-failing
       * attempts could stall dispatch for 24s. */
      animalTimeoutMs: z.number().int().positive().default(10_000),
    })
    .default({ intensity: "playful", animalImage: true, animalTimeoutMs: 10_000 }),
```

And the matching field on the `Config` interface (`src/config.ts` lines 66-82), inserted after `weeklyRecap` at line 78:

```ts
  personality: { intensity: "off" | "subtle" | "playful"; animalImage: boolean; animalTimeoutMs: number };
```

No change is needed in `loadConfig` (line 93) or `loadConfigFile` (line 137): the block passes through the `...config` spread at line 123 untouched, like every other pure-JSON block. No new environment variable, because both animal providers that need a network call (`THECATAPI` at `src/media/animals.ts:40`, `DOGCEO` at line 64) are keyless, as is `CATAAS` at line 32.

`EffectIntensity` is already exported from `src/engine/effects.ts:15` as exactly `"off" | "subtle" | "playful"`. The zod enum duplicates those three strings rather than importing, because `src/config.ts` currently imports nothing but zod and is depended on by nearly every module (`PersonId` at line 84); an import from `src/engine/` would invert that dependency direction. Guard the duplication with a compile-time assertion in the config test instead (see section 6).

### config.example.json addition

Append after the `weeklyRecap` block (`config.example.json` lines 18-23):

```json
  "personality": {
    "intensity": "playful",
    "animalImage": true,
    "animalTimeoutMs": 10000
  }
```

### An existing config.json that lacks the block

Because the block carries `.default({...})`, `rawConfigSchema.safeParse` (`src/config.ts:97`) succeeds on a config with no `personality` key at all, and `config.personality` comes back as `{ intensity: "playful", animalImage: true, animalTimeoutMs: 10000 }`. No error, no migration, no restart failure.

That is the correct schema behaviour and it is also the single biggest rollout hazard in this spec: the owner's live `config.json` today has no `personality` key, so the first daemon restart after this ships would silently turn playful effects and animal images on for **both** participants, including Ria. That is precisely the failure mode the standing rule exists to prevent (the weekly recap went out unannounced when it was enabled). The schema default stays `"playful"` because that is the owner's stated choice for the steady state; the rollout in section 7 makes the first live deploy explicit rather than defaulted.

## 2. Where the animal image is fetched

### Constraint

`src/engine/stateMachine.ts` is pure: `DayMachine.step` (line 59) is synchronous, returns `{ state, effects }`, and every branch builds effects from `copy.*` strings only. It cannot fetch. `src/engine/runtime.ts` executes effects and is the only async layer. So the fetch is somewhere in the runtime, and the question is *when* inside the runtime.

The rejected option is fetching lazily inside `execute` for `case "Send"` (`src/engine/runtime.ts:122-157`). That call is already inside the serialized event queue (`enqueue`, line 68), and it runs while the day's `CreateDay` has committed but the prompt has not gone out. A slow animal API there directly delays the daily question, which the parent design forbids at line 132: "The daily question going out is the product's core function and nothing decorative may ever block it."

### Decision

Fetch in `EngineRuntime.dispatch` (`src/engine/runtime.ts:54-63`), concurrently with the prompt generation that is already awaited there, and stash the result on a private field that `execute` consumes.

```ts
async dispatch(date: string): Promise<void> {
  // Concurrent, not sequential: the animal fetch rides alongside the
  // adaptive generator's LLM round trip, which already dominates dispatch
  // latency, so in the normal case it adds zero observable delay.
  const [daily, animal] = await Promise.all([
    this.opts.promptSource.nextPrompts(date),
    this.fetchAnimal(),
  ]);
  this.pendingAnimal = animal;
  await this.enqueue({ type: "DispatchDue", date, at: this.now(), prompts: daily.prompts, theme: daily.theme });
}
```

Three reasons this is the right seam:

1. **It is outside the event queue.** Nothing about the day exists yet when the fetch runs, so a slow fetch cannot hold the queue or interleave with an inbound message.
2. **It is concurrent with work that is already slow.** `promptSource.nextPrompts` is `FallbackPromptSource` wrapping `AdaptivePromptSource` (`index.ts:47`), which makes an OpenRouter call. A `Promise.all` with an 8s animal fetch usually costs nothing at all in wall clock.
3. **It fetches once per day, not once per person.** Both participants get the same animal, consistent with the project's existing "identical prompts, identical recaps" posture (`src/recap/send.ts:37-38` sends the same text to both). One fetch per day also makes the recency ledger (section 4) trivially one row per day.

### Failure behaviour, precisely

The only try/catch lives in one new private method on `EngineRuntime`. It never rethrows, so `Promise.all` above can never reject because of it:

```ts
/** The single place animal-image failure is absorbed. Returns null on
 * ANY failure: network error, non-image body, oversize, or simply taking
 * longer than the configured deadline. The prompt then goes out with text
 * only. Never throws, never retries beyond what the source does itself. */
private async fetchAnimal(): Promise<AnimalImage | null> {
  const p = this.opts.personality;
  if (!p || p.intensity === "off" || !p.animalImage || !this.opts.animals) return null;
  try {
    const recent = this.opts.ledger.recentAnimalImageIds(RECENT_ANIMAL_WINDOW);
    return await Promise.race([
      this.opts.animals.fetch(recent),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), p.animalTimeoutMs)),
    ]);
  } catch (err) {
    this.log(`animal image fetch failed, sending prompt without one: ${err}`);
    return null;
  }
}
```

Notes on this, all grounded in the existing code:

- `HttpAnimalImageSource.fetch` (`src/media/animals.ts:216`) is documented as throwing on any failure, and its own guards already cover the dangerous cases: an `AbortSignal.timeout` per request (lines 133, 44, 68), a `content-length` cap and a post-download size cap against `maxBytes` (default 5MB, line 191), and `detectMimeType` magic-byte validation that rejects a lying 200 serving an HTML error page (lines 90, 159-164). This runtime adds no validation of its own; it only absorbs.
- The `Promise.race` deadline exists because the source can make up to 3 attempts (`MAX_ATTEMPTS`, line 192) and recency collisions cause re-loops (line 232). Three 8s attempts is 24s of dispatch delay in the worst case. The losing `fetch` promise is left to settle and be garbage collected; it holds no lock and writes nothing.
- The log line is at `log` level, not thrown, matching how every other decorative failure in this codebase degrades (`src/engine/runtime.ts:128`, `index.ts:115`, `index.ts:167`).
- `animals` and `personality` are **optional** on `EngineRuntimeOptions`, so every existing construction of `EngineRuntime` in `tests/runtime.test.ts` and `tests/rebuild.test.ts` keeps compiling and keeps behaving identically.

### Options additions

`EngineRuntimeOptions` (`src/engine/runtime.ts:8-17`) gains two optional fields:

```ts
  /** Omit to disable all personality enrichment (the default for tests). */
  personality?: { intensity: EffectIntensity; animalImage: boolean; animalTimeoutMs: number };
  /** Omit and no image is ever attached, regardless of intensity. */
  animals?: AnimalImageSource;
```

and `index.ts` passes them at the `EngineRuntime` construction (`index.ts:49-56`):

```ts
  personality: config.personality,
  animals: new HttpAnimalImageSource(),
```

## 3. Effect wiring

`effectFor(event, intensity)` (`src/engine/effects.ts:52`) takes an `EffectEvent`, which is a **product moment**, not a message kind. Every call site has to translate. There are two shapes of call site: the engine path, where the machine has already chosen a `MessageKind`, and the two side pipelines, which construct messages themselves.

### 3a. Engine path: map MessageKind to EffectEvent

The state machine must not change, so the translation happens where the `Send` effect is executed. But the *policy* (which kind means which moment) belongs with the rest of the policy, so add a second pure export to `src/engine/effects.ts`:

```ts
import type { MessageKind } from "../ledger/ledger";

/** Translates the machine's message kind into the product moment the effect
 * policy is written in terms of. Returns null for kinds that are plumbing
 * rather than a moment: an acknowledgement, a holding message, or a reply to
 * an out-of-band text is not an occasion for a flourish. */
export function effectEventForKind(kind: MessageKind): EffectEvent | null {
  switch (kind) {
    case "prompt":
      return "daily_prompt";
    case "share":
      return "day_resolved_both_answered";
    case "skip_notice":
      return "day_resolved_skipped";
    default:
      return null;
  }
}
```

Every mapping above is exact against `src/engine/stateMachine.ts`:

| MessageKind | Emitted at | EffectEvent | Effect at "playful" |
|---|---|---|---|
| `prompt` | `onDispatch`, lines 91-98, once per person | `daily_prompt` | `emphasize` |
| `share` | `onTerminal`, lines 221-232, **only** in the both-answered branch, once per person | `day_resolved_both_answered` | `celebrate` |
| `skip_notice` | `onTerminal` line 238 (I answered, they skipped) and line 259 (I skipped, they were terminal) | `day_resolved_skipped` | `gentle` |
| `waiting_notice` | line 248, day not yet resolved | none | none |
| `feedback_ask` | lines 233, 243 | none | none |
| `skip_ack` | line 158 | none | none |
| `oob_reply` | lines 127, 147 | none | none |

`share` is a safe proxy for "day resolved with both answered" because it is emitted nowhere else: the only `kind: "share"` in the file is inside `if (me.state === "answered") { if (them.state === "answered")` at lines 217-232, immediately followed by `ResolveDay` with `"resolved_shared"` at line 234. `skip_notice` likewise appears only on paths that push `ResolveDay` with `"resolved_skipped"` (lines 244, 263).

`waiting_notice` deliberately gets nothing: it is the "your partner has not answered yet" holding message and there is no `EffectEvent` for it. Adding one is out of scope; the vocabulary in `src/engine/effects.ts:8-13` is fixed for Phase 1.

### 3b. Engine path: building the Outbound

`execute`'s `case "Send"` (`src/engine/runtime.ts:122-157`) is the single engine call site. The change is confined to the `channel.send` call inside the existing try (line 126):

```ts
case "Send": {
  const outbound = this.outboundFor(effect); // string | Outbound
  try {
    await this.opts.channel.send(effect.person, outbound);
  } catch (err) {
    // The enrichment must never cost us the message. An attachment the
    // vendor rejects would otherwise abort the whole send: spectrum's
    // send() loops the contents sequentially (src/channel/spectrum.ts:182)
    // with the image BEFORE the text (line 30 vs 37), so a failing image
    // means the text never leaves. Retry once, text only.
    if (typeof outbound !== "string" && (outbound.image || outbound.effect)) {
      this.log(`enriched send to ${effect.person} (${effect.kind}) failed, retrying plain: ${err}`);
      try {
        await this.opts.channel.send(effect.person, effect.text);
      } catch (err2) { /* existing send_failed path, unchanged */ }
    } else { /* existing send_failed path, unchanged */ }
  }
  // ... existing ledger.recordMessage / markShareSent / markFeedbackAskSent, unchanged
}
```

`outboundFor` is a small private method that consults `effectEventForKind`, `effectFor`, and `this.pendingAnimal`:

- `kind === "prompt"` and `pendingAnimal !== null` and `personality.animalImage`: `{ text, image: { bytes, mimeType, name }, effect }`.
- any other kind with a non-null `effectFor` result: `{ text, effect }`.
- otherwise: the bare `effect.text` string, byte-identical to today's behaviour.

The plain-string fallback matters: it is why `personality.intensity: "off"` produces a diff of exactly zero against current behaviour, at the channel and at the ledger.

`pendingAnimal` is cleared after the dispatch's prompt sends (set to `null` at the end of `handleEvent` when `event.type === "DispatchDue"`), so a later day whose fetch failed cannot silently reuse yesterday's cat.

The ledger row is unaffected: `recordMessage` at lines 141-155 still writes `effect.text`. The image and the effect are transport decoration and do not belong in the message history.

### 3c. Nudges (side pipeline)

`src/nudge/pipeline.ts:58` sends directly: `await deps.channel.send(person, messageFor(trigger, person, deps.names))`. This bypasses `EngineRuntime` entirely, by design (comment at lines 33-38). It therefore needs its own wiring:

```ts
// NudgePipelineDeps gains:
  intensity?: EffectIntensity; // omit for no effect, which is what tests do

// and the send at line 58 becomes:
  const text = messageFor(trigger, person, deps.names);
  const fx = effectFor("nudge", deps.intensity ?? "off");
  await deps.channel.send(person, fx ? { text, effect: fx } : text);
```

`index.ts:155-164` passes `intensity: config.personality.intensity` into `checkAndSendNudges`. `effectFor("nudge", ...)` is `"gentle"` at both `"subtle"` and `"playful"` and never escalates (`src/engine/effects.ts:46, 47`, with the reasoning at lines 33-34).

No animal image on nudges. A nudge is already the mildly awkward message in the product; attaching a cat to "you have not answered yet" is the reading the effects policy explicitly guards against.

### 3d. Weekly recap (side pipeline)

`src/recap/send.ts:37-38` sends the same text to both:

```ts
  await deps.channel.send("a", text);
  await deps.channel.send("b", text);
```

`SendRecapDeps` (lines 8-16) gains `intensity?: EffectIntensity`, and both sends become:

```ts
  const fx = effectFor("weekly_recap", deps.intensity ?? "off");
  const out = fx ? { text, effect: fx } : text;
  await deps.channel.send("a", out);
  await deps.channel.send("b", out);
```

`checkAndSendWeeklyRecap` (`src/recap/checker.ts:28`) threads it through: `RecapCheckerDeps` gains the same optional field, and the `sendWeeklyRecap` call at lines 37-41 passes it. `index.ts:192-201` supplies `intensity: config.personality.intensity`.

Note that `sendWeeklyRecap`'s existing failure posture is unchanged and is worth restating: `hasRecapFor` gates at line 25 and `recordRecap` runs at line 40 **after** both sends, so if the first send throws the recap is retried in full on the next poll. Adding an effect does not change that, and an effect cannot fail independently of the text (see section 5).

### Call-site map, complete

| Product moment | EffectEvent | Call site | Effect at playful | Image |
|---|---|---|---|---|
| Daily prompt goes out | `daily_prompt` | `src/engine/runtime.ts` `execute` case `"Send"`, kind `prompt` (line 122) | `emphasize` | animal |
| Day resolves, both answered | `day_resolved_both_answered` | same, kind `share` | `celebrate` | none |
| Day resolves with a skip | `day_resolved_skipped` | same, kind `skip_notice` | `gentle` | none |
| Nudge | `nudge` | `src/nudge/pipeline.ts:58` | `gentle` | none |
| Weekly recap | `weekly_recap` | `src/recap/send.ts:37-38` | `celebrate` | none |

## 4. Recency persistence for animal image ids

`AnimalImageSource.fetch(recentIds?)` (`src/media/animals.ts:15`) documents `recentIds` as "a best-effort avoid-list, never a reason to fail", and `HttpAnimalImageSource.fetch` returns the last successful image anyway if every attempt collides (line 235). So the persistence layer can be lossy without hurting anything. That widens the options rather than narrowing them.

### Options considered

**A file**, e.g. `animal-recent.json`. Rejected. It introduces a second durable store next to `ledger.db`, with its own write-atomicity, its own `chmod 600` decision (compare `Ledger.open` at `src/ledger/ledger.ts:216-220`), and its own backup story. The project already learned that copying the ledger needs care because of WAL; a second file is a second thing to get wrong for no benefit.

**A dedicated table**, e.g. `animal_images (day_id, image_id, sent_at)`. Rejected for Phase 1, but it is the right shape if this ever becomes more than one image per day (a Phase 2 photo-day image, a recap image). The existing `nudges` table (`src/ledger/schema.sql:106-112`) is the precedent for that shape. Today there is exactly one fetch per dispatch (section 2), so a table buys a join and nothing else.

**Recommended: an additive column on `days`.** One image per day, and `days` is already where day-level facts live (`prompt_id`, `prompt_text`, `state`, `dispatched_at`, `resolved_at`, `src/ledger/schema.sql:1-10`). Recency then falls out of the existing day ordering with no new index.

### Schema

Add to `src/ledger/schema.sql` inside `CREATE TABLE IF NOT EXISTS days` for fresh databases:

```sql
  -- Animal image actually attached to this day's prompt, for recency
  -- de-duplication only. Null means no image went out (fetch failed,
  -- disabled, or a day that predates the feature).
  animal_image_id TEXT
```

### Migration

`Ledger.migrateSchema` (`src/ledger/ledger.ts:183-207`) is a sequence of `has(table, column)` guards followed by `ALTER TABLE ... ADD COLUMN`. Follow it exactly, appending after the `person_days` backfill at line 206:

```ts
    if (!has("days", "animal_image_id")) {
      db.exec("ALTER TABLE days ADD COLUMN animal_image_id TEXT");
    }
```

No backfill. Unlike the `person_days.prompt_text` case (lines 201-206), there is no correct historical value: days before this feature genuinely had no image, and null is the honest encoding. Every read path treats null as "no image".

### Ledger methods

```ts
/** Recency avoid-list for the next animal image, newest first. */
recentAnimalImageIds(limit: number): string[] {
  return this.db
    .query<{ animal_image_id: string }, [number]>(
      `SELECT animal_image_id FROM days
        WHERE animal_image_id IS NOT NULL ORDER BY id DESC LIMIT ?`,
    )
    .all(limit)
    .map((r) => r.animal_image_id);
}

/** Recorded only after an image actually went out, so the avoid-list never
 * contains an image nobody saw. Idempotent: both persons' prompt sends
 * write the same id for the same day. */
setDayAnimalImage(dayId: number, imageId: string): void {
  this.db.query(`UPDATE days SET animal_image_id = ? WHERE id = ?`).run(imageId, dayId);
}
```

`RECENT_ANIMAL_WINDOW` is a module constant in `src/engine/runtime.ts`, value **14**. Two weeks is long enough that a repeat is not noticeable and short enough that the avoid-list never grows unbounded, and `HttpAnimalImageSource` only compares with `recentIds.includes(id)` on up to 3 attempts (line 232), so the list length costs nothing.

The write happens in `execute`'s `case "Send"` after the first successful `prompt` send, inside the existing `if (this.currentDayId !== null)` block (`src/engine/runtime.ts:141`), alongside the `share` and `feedback_ask` marks at lines 150-154. Ordering is safe: `CreateDay` (line 102) has already run and set `this.currentDayId` (line 112) before any `Send` effect is executed, because `onDispatch` pushes `CreateDay` at line 90 before the prompt sends at lines 91-98, and `handleEvent` executes effects in order (`for (const effect of effects) await this.execute(effect)`, lines 92-94).

A caveat worth stating: ids are only unique-ish. `computeId` (`src/media/animals.ts:169`) uses the API id where one exists, a sha256 of the bytes for cataas (because its URL is constant, lines 172-177), and the URL otherwise. Two different dog.ceo URLs pointing at the same picture will not collide. That is acceptable for a best-effort avoid-list.

## 5. Ordering and what the participant sees

### One Outbound, not two sends

`SpectrumChannel.send` (`src/channel/spectrum.ts:179-185`) calls `outboundContents` and then loops `for (const content of outboundContents(message)) await space.send(content)`, with the explicit comment "Sequential, not Promise.all, so background/image/text ordering holds". `outboundContents` (lines 20-43) pushes background, then image, then text, and attaches the vendor effect to the text (line 39).

So one `Outbound` of `{ text, image, effect: "emphasize" }` produces exactly two iMessage bubbles, in this order:

1. the animal photo, on its own,
2. the prompt text, delivered with the slam effect (`VENDOR_EFFECT.emphasize` is `imessage.effect.message.slam`, `src/channel/spectrum.ts:13`).

One `Outbound` is correct rather than two `channel.send` calls, for three reasons:

- **Ordering is guaranteed by the transport**, not by the caller remembering to await in the right order. A second call site could get it backwards and put the question above the cat.
- **The ledger stays one row per `Send` effect.** `recordMessage` (`src/engine/runtime.ts:142-149`) writes one row with `effect.text`. Two sends would tempt a second row for an image with no text, which nothing downstream (extraction, recap, history) knows how to read.
- **The channel interface already models it.** `Outbound` exists precisely so a composed message is one semantic send; splitting it here would make the type pointless.

The cost is the failure coupling flagged in section 3b: image first means a rejected image aborts the text. The plain-text retry there is the mitigation, and it is the only reason the enrichment cannot cost the daily question.

Note also `outboundContents` lines 35-41: an effect with no text is dropped, because the vendor needs content to attach it to. Every effect in this spec rides a text message, so that branch is never hit on the Phase 1 paths.

### Copy stays in copy.ts

`src/engine/copy.ts` line 1 says it plainly: "All outbound message wording lives here, and only here." Phase 1 changes **nothing** in that file, and must not. There is no caption for the animal image, no "here's a cat" line, no wording change to `promptMessage` (line 3). The image is attached to the message the state machine already composed; the effect is a transport flag. If the image were ever to need a caption, that caption is a new exported function in `copy.ts` and nowhere else, and it would then flow through the machine's `Send.text` rather than being invented in the runtime.

## 6. Testing strategy

No network, no real messages. Everything below runs under `bun test`.

**Effect policy** (`tests/effects.test.ts` exists and already covers `effectFor` across all events and intensities, lines 9-17). Add cases for the new `effectEventForKind`: exhaustive over `MessageKind`, asserting `prompt`, `share`, and `skip_notice` map as tabled in section 3a and that every other kind returns null. This is the test that catches a future `MessageKind` addition silently getting no effect.

**Runtime with a fake source** (new `tests/personality.test.ts`, or extend `tests/runtime.test.ts`). Construct `EngineRuntime` with `FakeChannel` (`src/channel/fake.ts`) and `FakeAnimalImageSource` (`src/media/animals.ts:248`):

- Happy path: `dispatch(date)`, then assert `channel.outboundTo("a")[0]` has `image.mimeType === "image/png"`, `effect === "emphasize"`, and `text` equal to `copy.promptMessage(...)`. `outboundTo` is at `src/channel/fake.ts:44`.
- Failure path: `new FakeAnimalImageSource(undefined, new Error("boom"))` (the constructor's second parameter, line 254). Assert the prompt still goes out, that `sentTo("a")` (line 38) contains the prompt text unchanged, and that `message.image` is undefined. This is the guarantee that matters most.
- Timeout path: a hand-rolled `AnimalImageSource` whose `fetch` returns a never-settling promise, with `animalTimeoutMs: 5` and a real `setTimeout`. Assert the dispatch completes and the prompt has no image. Keep the deadline in milliseconds so the test is fast without a fake clock.
- Intensity off: `personality.intensity: "off"`. Assert every entry in `channel.sent` has `image === undefined` and `effect === undefined`, so the transport diff against today is zero.
- `animalImage: false` with `intensity: "playful"`: prompt has `effect: "emphasize"` but no image, proving the two switches are genuinely independent.
- Resolution effects: drive both people to answered through the existing settle machinery (`tests/settle.test.ts` and `tests/runtime.test.ts` already have the pattern) and assert the `share` outbounds carry `effect: "celebrate"`; drive a skip and assert `skip_notice` carries `"gentle"`.

**Recency** (extend `tests/ledger.test.ts`). Create days, `setDayAnimalImage` on some and not others, assert `recentAnimalImageIds(n)` returns newest first, skips nulls, and respects the limit. Then a runtime test asserting `FakeAnimalImageSource.calls` (the recorded `recentIds` array, `src/media/animals.ts:249`) received the ids from prior days.

**Migration** (extend `tests/ledger.test.ts`). Open a `:memory:` ledger, `ALTER TABLE days DROP COLUMN animal_image_id` is not needed: instead follow whatever pattern the existing migration tests use, or simply assert that opening an existing on-disk ledger twice is idempotent and that `PRAGMA table_info(days)` contains `animal_image_id`.

**Side pipelines.** `tests/nudge/pipeline.test.ts` and `tests/recap/send.test.ts` already exist and already use `FakeChannel`. Add one case each: with `intensity: "playful"`, the outbound is `{ text, effect: "gentle" }` and `{ text, effect: "celebrate" }` respectively; with the field omitted, the outbound is a bare string, proving existing behaviour is untouched.

**Composition.** `tests/channel/outbound.test.ts` already tests `outboundContents`. Add a case for the exact Phase 1 shape (`{ text, image, effect }`) asserting two items, image first.

**Config** (`tests/config.test.ts`). A config with no `personality` key parses and yields the documented defaults; an invalid intensity string is rejected with a `config.personality.intensity` path in the message (the error formatting at `src/config.ts:99-102`). Add a compile-time assertion that the zod enum and `EffectIntensity` agree, since section 1 duplicates the union deliberately:

```ts
const _check: EffectIntensity = "playful" as Config["personality"]["intensity"];
```

**No live-API test.** `HttpAnimalImageSource` is already covered by `tests/media/animals.test.ts` with an injected `fetchImpl` (`HttpAnimalImageSourceOptions.fetchImpl`, `src/media/animals.ts:183`). Phase 1 adds nothing there and must not add a test that hits cataas, thecatapi, or dog.ceo.

## 7. Rollout: one number first

The standing rule: any new live-messaging behaviour is tested against Aditya alone before it can reach Ria, because enabling a feature once triggered an immediate unannounced send to both.

**Why the usual hazard is smaller here, and where it is not.** Phase 1 adds no new poller, no new trigger, and no new reconciliation. It decorates sends that already happen. The catch-up hazards that exist today are `reconcile()` (`index.ts:64-73`), gated on `!ledger.hasDay(today)`, and `runRecapCheck()` at startup (`index.ts:225`), gated on `hasRecapFor` (`src/recap/send.ts:25`). Neither gate is touched. But the recap startup catch-up would carry a `celebrate` effect the first time it fires after the deploy, and the *default* config value (section 1) means it would do so without anyone having opted in. That is the exact rule violation to avoid.

The concrete sequence:

**Step 1: the whole test suite from section 6 passes.** No network, no sends.

**Step 2: a standalone smoke script against Aditya only.** During implementation, add `scripts/personality-smoke.ts` (a new file, not part of the daemon, not imported by `index.ts`). It:

- reads `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET` from the environment, the same two required vars as `src/config.ts:87-88`;
- constructs `SpectrumChannel.connect` directly with `phones: { a: <Aditya>, b: <Aditya> }`, deliberately bypassing `loadConfig`, which rejects identical phone numbers at `src/config.ts:106-110`. Both slots pointing at the same number means there is no code path by which a send can reach Ria's number, because her number is never handed to the channel;
- never opens the ledger and never constructs `EngineRuntime`, so it cannot create a day, resolve one, or trip any catch-up;
- sends, to `"a"` only: a real `HttpAnimalImageSource` fetch composed as `{ text: "smoke: daily prompt shape", image, effect: "emphasize" }`, then `{ text: "smoke: celebrate", effect: "celebrate" }`, then `{ text: "smoke: gentle", effect: "gentle" }`.

What to confirm by eye on the phone: the photo arrives above the text (section 5), all three vendor effects render, the image is not absurdly large, and no animal is objectionable enough to reconsider the provider list.

**Step 3: deploy with personality explicitly off.** Before restarting the daemon, add to the live `config.json`:

```json
  "personality": { "intensity": "off", "animalImage": false, "animalTimeoutMs": 10000 }
```

This is not optional and it is the whole reason the block's default is dangerous. With `"off"`, every send is a bare string (section 3b) and the deployed behaviour is byte-identical to today. Run one full day this way to prove the wiring changed nothing.

**Step 4: restart at a safe moment.** Restart after the day's dispatch has already gone out, so `ledger.hasDay(today)` is true and `reconcile()` (`index.ts:69`) does nothing. Not on the configured recap weekday, so the startup `runRecapCheck()` (`index.ts:225`) cannot fire on the first boot of the new code.

**Step 5: tell Ria, then flip.** Set `"intensity": "playful"`, `"animalImage": true`, and restart under the same step 4 timing rule. The first enriched message either participant sees is then the next daily prompt, at the normal dispatch time, which is the least surprising possible introduction.

**Rollback** is one config edit back to `"off"` plus a restart. No migration is undone (the `animal_image_id` column is additive and nullable), no ledger row is invalid, and the code path with personality off is the same path that ran for a full day in step 3.

## 8. Build order

Each step compiles and leaves the suite in a state where nothing existing changed behaviour.

1. **Config.** Zod block, `Config` interface field, `config.example.json`, `tests/config.test.ts` cases. Nothing reads it yet.
2. **Ledger.** `animal_image_id` in `schema.sql`, the `migrateSchema` guard, `recentAnimalImageIds`, `setDayAnimalImage`, ledger tests. Nothing writes it yet.
3. **Effect policy.** `effectEventForKind` in `src/engine/effects.ts` plus tests. Pure, no call sites yet.
4. **Runtime.** Optional `personality` and `animals` options, `fetchAnimal`, `pendingAnimal`, `outboundFor`, the plain-text retry, the `setDayAnimalImage` write. Runtime tests with the fakes. This is the largest and riskiest step and it is where review attention goes.
5. **Side pipelines.** Nudge and recap `intensity` threading, both with the omit-means-off default, plus their tests.
6. **index.ts wiring.** Construct `HttpAnimalImageSource`, pass `config.personality` to the runtime, the nudge check, and the recap check.
7. **Smoke script**, then the section 7 rollout.

Steps 1 to 3 are independently reviewable and independently revertible. Step 6 is the only step that changes live behaviour, and only in combination with a config edit.

## Risks

**The image-before-text failure coupling.** The single genuine risk in Phase 1. `outboundContents` puts the image first (`src/channel/spectrum.ts:30`) and `send` loops sequentially (line 182), so a vendor rejection of the attachment kills the question. The plain-text retry in section 3b is the mitigation and it must be in the first implementation, not a follow-up. The runtime test for it is not optional.

**A silent default.** `personality` defaults to `"playful"` on a config that lacks it, which means the feature is live the moment the daemon restarts. Section 7 step 3 is the control. If that feels too fragile to rely on a written step, the alternative is defaulting `intensity` to `"off"` in the schema and setting `"playful"` explicitly in `config.json`; that inverts which mistake is possible, at the cost of contradicting the owner's stated default. Flagged for the owner rather than decided here.

**Dispatch latency.** Bounded by `animalTimeoutMs` and usually zero because of the `Promise.all` with the LLM call. Worth watching in the logs for the first week: if `fetchAnimal` regularly hits the deadline, drop `animalImage` rather than raising the timeout.

**Unmoderated third-party images.** Reaching Ria unreviewed is the reason the parent design restricted the source to animals (line 54: "Worst case is a dull cat"). Nothing in Phase 1 relaxes that. `DEFAULT_ANIMAL_PROVIDERS` (`src/media/animals.ts:83`) must stay cats and dogs.

**Effect fatigue.** At `"playful"` a normal day carries `emphasize` on the prompt and `celebrate` on the share, which is two per day per person by design (`src/engine/effects.ts:22-24`). If it grates, `"subtle"` is a config edit and silences the daily prompt while keeping celebration for resolution.

## Out of scope

Explicitly deferred, and none of it may be smuggled into Phase 1:

- **Phase 2, inbound photos.** Accepting attachments, `fetchAttachment` (`src/channel/spectrum.ts:191`), caching bytes, `src/media/store.ts` (not yet written), and sharing a photo answer with the partner. This modifies `src/engine/stateMachine.ts`, which just absorbed per-person prompts; it waits.
- **Phase 3, backgrounds.** `Outbound.background` (`src/channel/types.ts:11`), `src/media/convert.ts`, `src/photos/schedule.ts`. All three stay unwired after this spec.
- **Copy changes.** `src/engine/copy.ts` is untouched.
- **State machine changes.** `src/engine/stateMachine.ts` is untouched. If Phase 1 appears to need a machine change, the design is wrong.
- **New EffectEvent values.** The vocabulary at `src/engine/effects.ts:8-13` is fixed. `waiting_notice`, `feedback_ask`, and `skip_ack` get nothing.
- **Animal images anywhere but the daily prompt.** Not on nudges, not on the recap, not on shares.
- **Avatar, contact card, richlink, customizedMiniApp.** Ruled out on evidence in the parent design (line 46).
- **Any image reaching an AI provider.** Unchanged and non-negotiable.
