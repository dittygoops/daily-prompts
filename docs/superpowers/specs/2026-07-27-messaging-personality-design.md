# Messaging Personality: Photos, Backgrounds, and Effects

Design doc, 2026-07-27. Status: approved, not yet implemented.

## Goal

Make the daily check-in feel like its own place rather than a text broadcast from an unknown number. Three additions: photos exchanged between the two participants, a conversation background drawn from those photos, and lightweight visual flourishes (animal images, send effects) on the everyday messages.

## Capability spike (2026-07-27)

Everything below was verified live against the shared free-tier Photon line, sending to Aditya only. Nothing here is assumed.

| Capability | Result |
|---|---|
| Text, effects (confetti, fireworks, invisible ink) | works |
| Image attachment outbound | works |
| Typing indicator | works |
| `background()` set and `background("clear")` | works |
| Inbound photo reaches us | works, arrives as `content.type: "attachment"` |
| `getAttachment(id, phone)` then `read()` | works, returned all 2,615,473 bytes |
| Re-sending received photo bytes to a participant | works |
| Received HEIC as a background | **fails**, "Unknown server error" |
| Same photo converted to JPEG as background | works |

### Inbound photo shapes (verified live, 2026-07-27)

A photo arrives in one of two shapes, and both must be handled:

- **No caption**: `content.type: "attachment"` directly, with `id`, `name`, `mimeType`, `size`, and `read()`.
- **With a caption**: `content.type: "group"` on a SINGLE message, carrying an `items` array where each item has its own `content`. Observed exactly:

```
group with 2 part(s):
  [0] type=attachment  name=IMG_0991.HEIC  mime=image/heic  size=2053225
  [1] type=text        text="Test caption beta"
```

This matters because the caption travels WITH the photo rather than as a separate message, so the share step never has to correlate two arrivals. It also means a decoder that handles only `text` and `attachment` silently drops every captioned photo: the sender sees no acknowledgement and nothing is logged. That was the actual behaviour before this was found, and it is the reason the shape was worth testing before Phase 2 rather than after.

Three findings that shaped the design:

1. **iPhone photos are HEIC and HEIC is rejected as a background.** PNG and JPEG both work. Conversion is mandatory. `sips` is built into macOS, which we already require in order to run iMessage at all, so this needs no dependency: 2.5MB HEIC became a 552KB JPEG at 1600px.
2. **`getAttachment(id, phone)` fetches bytes on demand.** We do not need a second consumer of the message stream, which removes the cross-routing hazard that broke the sibling `networks` project.
3. **Photos are large**, ~2.6MB each, so storage is a deliberate decision rather than an accident.

Ruled out on evidence: `customizedMiniApp` (requires an Apple Developer team ID and a shipped iOS extension) and `richlink` (requires a publicly fetchable URL, which this deliberately local stack does not have). `avatar()` is untested and deferred because it is account-level and would change what Ria sees, so it is not isolatable to one participant.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Intensity | Playful, most days carry something | Owner's call, made after seeing a restrained alternative |
| Participant photos | Shared and displayed, **never** analyzed | No image bytes reach any AI provider |
| Companion image source | Animals only (cataas, thecatapi, dog.ceo) | Worst case is a dull cat; Reddit memes are unmoderated and would reach Ria unreviewed |
| Photo day cadence | Every other day, configurable | |
| Wrong answer type | Always accepted | Rejecting a genuine answer to enforce a format is hostile |
| Background | Both participants get the **same** photo, alternating whose turn | Consistent with identical prompts and identical recaps |

## Architecture

### Channel interface

`Channel.send(person, text: string)` is deliberately narrow so the state machine never learns that iMessage exists. Widening it risks leaking vendor concepts into core logic, so the interface stays semantic:

```ts
export type Effect = "celebrate" | "emphasize" | "gentle";

export interface Outbound {
  text?: string;
  image?: { bytes: Buffer; mimeType: string; name?: string };
  effect?: Effect;
  background?: { bytes: Buffer; mimeType: string } | "clear";
}

send(person: PersonId, message: string | Outbound): Promise<void>;
```

Core logic asks for `"celebrate"`. Only `src/channel/spectrum.ts` knows that maps to `CKConfettiEffect`. A future Telegram or Honcho implementation maps it differently or ignores it. Accepting a plain string keeps every existing call site unchanged.

Inbound gains attachment **metadata only**, never bytes:

```ts
export interface ChannelInbound {
  person: PersonId;
  text: string; // "" for a photo with no caption
  attachment?: { id: string; mimeType: string; name: string; size: number };
  at: string;
}
```

Note that `handleMessage` currently drops all non-text content silently. That early return is why a photo produced no log line and no ledger row during the spike, and it is the specific line that has to change.

### New modules

Each is single-purpose, following the pure-logic-separated-from-IO pattern already used by `stance.ts` and `nudge/checker.ts`.

| Module | Purpose | Pure? |
|---|---|---|
| `src/photos/schedule.ts` | Is today a photo day; whose background turn is it | yes |
| `src/media/convert.ts` | HEIC to JPEG at 1600px via `sips` | no, shells out |
| `src/media/animals.ts` | `AnimalImageSource` interface, HTTP and Fake implementations | interface |
| `src/media/store.ts` | Cache photo bytes on disk, keyed by attachment id | no |
| `src/engine/effects.ts` | Which semantic effect belongs to which event | yes |

### Whose photo becomes the background

Deterministic, no randomness, so it is testable and predictable:

- Photo days are numbered in order, starting at 1. Even-numbered photo days are participant `a`'s turn, odd-numbered are `b`'s. Photo day 1 is therefore odd, so **`b` takes the first turn**. This is arbitrary but fixed, and stated explicitly because the natural reading of "a then b" suggests the opposite.
- If the person whose turn it is did not send a photo, the other person's photo is used instead. A turn is a preference, not a veto. **The turn is still consumed in that case**, so a person who never sends photos burns a slot on each of their turns. That is intentional: the alternative, holding their turn open indefinitely, produces the same visible outcome (the other person's photo is shown) while making the counter unpredictable.
- If neither sent a photo, the background does not change and the turn counter does not advance, so nobody loses their turn to a day both people missed.

### Photo lifecycle

1. **Receipt.** Fetch bytes immediately via `getAttachment` and cache to a gitignored `photos/` directory at `chmod 600`. Record the attachment id, mime type, and cache path in the ledger. Fetching eagerly rather than lazily because Photon's attachment retention window is unknown, and a share that fails days later is worse than a few hundred KB on disk.
2. **Share.** Send the original bytes to the partner, preserving quality; iMessage handles HEIC natively between devices.
3. **Background.** Convert to JPEG, then set on both chats. Only converted derivatives are cached beyond the original.

### Message composition

Every daily prompt carries an animal image. Effects fire on real events: `celebrate` when a day resolves with both people answered, `gentle` on nudges, `celebrate` on the weekly recap. All of it sits behind a `personality.intensity` config value so it can be dialled down without a code change.

## Failure behaviour

Unchanged from the rest of the system: every enrichment degrades silently and alone.

- Animal API down or slow: prompt goes out with no image.
- Conversion fails: photo is still shared, background simply does not change.
- Background call fails: everything else still happened.
- Attachment fetch fails: logged loudly, the day continues.

The daily question going out is the product's core function and nothing decorative may ever block it.

## Build order

This is too large for one implementation pass, and the phases have genuinely different risk profiles. Each ships something usable on its own and each is independently revertible.

**Phase 1: enrichment, no photos.** Widen the `Channel` interface, add animal images to the daily prompt, add semantic effects, add the intensity config. Touches no participant data and never modifies the state machine. Lowest risk, and it proves the widened interface before anything depends on it.

**Phase 2: inbound photos.** Accept attachments, cache them, share a photo answer with the partner. This is where the state machine changes and where the privacy posture shifts, so it lands on its own with the README updated in the same change.

**Phase 3: backgrounds.** Conversion, turn-taking, setting the wallpaper on both chats. Depends on Phase 2 and is the easiest to defer or undo if the churn proves annoying.

Test with Aditya alone before each phase reaches Ria, per the standing rule. Note that enabling a feature can trigger an immediate catch-up send, which is how the first weekly recap went out unannounced.

## Risks

**The state machine must change.** The share step currently sends text and will need to send an image when the answer was a photo. This is the most protected and most-tested code in the project. Extend it rather than special-casing photo days.

**This is a privacy escalation.** Real photos get stored on disk. The ledger already holds verbatim messages so it is consistent with the existing posture, but the README privacy section must state it plainly, and Ria should be told before the first photo day. No image bytes ever reach OpenRouter or any AI provider.

**Cadence churn.** Backgrounds change on photo days. If it proves distracting in practice, the schedule module is the single place to slow it down.

## Out of scope

Avatar and native contact card (account-level, affects Ria, needs a separate decision). Memes from Reddit. AI-generated images. Polls and voice messages. Vision analysis of photos.

## Open questions

None blocking. Revisit after a week of live use: whether the background changing every other day is too frequent, and whether `avatar()` is worth testing.
