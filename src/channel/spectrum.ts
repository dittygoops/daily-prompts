import { Spectrum, attachment } from "spectrum-ts";
import type { ContentBuilder } from "spectrum-ts";
import { imessage, background, effect } from "spectrum-ts/providers/imessage";
import type { IMessageMessageEffect } from "spectrum-ts/providers/imessage";
import type { PersonId } from "../config";
import type { Channel, ChannelInbound, Effect, Outbound } from "./types";

// This file is the only place allowed to know the vendor effect ids: core
// logic asks for the semantic Effect and never sees these constants.
const VENDOR_EFFECT: Record<Effect, IMessageMessageEffect> = {
  celebrate: imessage.effect.message.confetti,
  emphasize: imessage.effect.message.slam,
  gentle: imessage.effect.message.gentle,
};

/** Turns an Outbound into the ordered list of things to send: background
 * first, then image, then text, each as a separate item so ordering holds
 * across the sequential sends in send(). Exported so composition is testable
 * without a live connection. */
export function outboundContents(message: string | Outbound): (string | ContentBuilder)[] {
  if (typeof message === "string") return [message];
  const items: (string | ContentBuilder)[] = [];
  if (message.background !== undefined) {
    items.push(
      message.background === "clear"
        ? background("clear")
        : background(message.background.bytes, { mimeType: message.background.mimeType }),
    );
  }
  if (message.image !== undefined) {
    items.push(
      attachment(message.image.bytes, { mimeType: message.image.mimeType, name: message.image.name }),
    );
  }
  // An effect with no text is dropped rather than sent alone: the vendor API
  // needs content to attach the effect to.
  if (message.text !== undefined) {
    items.push(
      message.effect !== undefined ? effect(message.text, VENDOR_EFFECT[message.effect]) : message.text,
    );
  }
  return items;
}

export type DecodedInbound =
  | { kind: "deliver"; msg: ChannelInbound }
  | { kind: "unknown"; address: string; text: string }
  | { kind: "drop"; reason: string }
  | { kind: "ignore" };

/** Pure decode step, factored out of handleMessage so every guard is
 * testable without a live connection. */
export function decodeInbound(
  message: unknown,
  spaceId: unknown,
  phones: Record<PersonId, string>,
  at: string,
): DecodedInbound {
  // The SDK's exported types for content/sender are not usable directly
  // (minified public surface); shapes below were verified against the
  // live API in the step 0 spike.
  type Part = {
    type: string;
    text?: string;
    id?: string;
    mimeType?: string;
    name?: string;
    size?: number;
  };

  const msg = message as {
    content: Part & { items?: unknown[] };
    sender: { address?: string; id?: string };
  };

  let parts: Part[];
  if (msg.content.type === "text" || msg.content.type === "attachment") {
    parts = [msg.content];
  } else if (msg.content.type === "group") {
    // A captioned photo arrives as one group message carrying an items array,
    // not as a bare attachment: each item is a full Message wrapper, so the
    // actual part (and the attachment GUID getAttachment needs) lives at
    // item.content, not on the wrapper itself. Tolerate a flattened shape too
    // (item itself as the part), matching a fallback seen in a live logger,
    // so a shape mismatch never silently drops a photo.
    if (!Array.isArray(msg.content.items)) return { kind: "ignore" };
    parts = msg.content.items.map((item) => {
      const inner = (item as { content?: unknown }).content;
      return (typeof inner === "object" && inner !== null ? inner : item) as Part;
    });
  } else {
    return { kind: "ignore" };
  }

  let text: string;
  // Named att, not attachment, to avoid shadowing the imported content builder.
  let att: ChannelInbound["attachment"];

  // First attachment part wins; a group with more than one attachment is not
  // supported yet (no product need for multi-attachment delivery today).
  const attPart = parts.find(
    (p): p is Part & { id: string } => p.type === "attachment" && typeof p.id === "string",
  );
  const caption = parts.find(
    (p): p is Part & { text: string } => p.type === "text" && typeof p.text === "string",
  )?.text;

  if (attPart) {
    att = {
      id: attPart.id,
      mimeType: attPart.mimeType ?? "application/octet-stream",
      name: attPart.name ?? "",
      size: attPart.size ?? 0,
    };
    // A blank caption must never become an answer part, but the photo still delivers.
    text = caption !== undefined && caption.trim().length > 0 ? caption : "";
  } else if (caption !== undefined) {
    text = caption;
    if (text.trim().length === 0) return { kind: "ignore" }; // never let "" become an answer part
  } else {
    return { kind: "ignore" };
  }

  const address = msg.sender.address ?? msg.sender.id;
  const person: PersonId | null =
    address === phones.a ? "a" : address === phones.b ? "b" : null;
  if (!person) return { kind: "unknown", address: address ?? "unknown", text };

  // Require the message's conversation to be the participant's own 1:1
  // space (id tail is the phone number, per spike): a participant's text
  // arriving via any other space (e.g. a group thread that includes the
  // shared line) must never be ingested as their intimate daily answer.
  const spaceTail = String(spaceId).split(";").pop();
  if (spaceTail !== phones[person]) {
    return { kind: "drop", reason: `dropped message from ${person} in non-participant space` };
  }

  return { kind: "deliver", msg: { person, text, at, ...(att ? { attachment: att } : {}) } };
}

interface SpectrumChannelOptions {
  projectId: string;
  projectSecret: string;
  phones: Record<PersonId, string>;
  /** Messages from numbers other than the two participants. */
  onUnknown?: (address: string, text: string, at: string) => void;
  log?: (msg: string) => void;
}

type SpectrumApp = Awaited<ReturnType<typeof Spectrum>>;

const MAX_CONSECUTIVE_STREAM_FAILURES = 30;

export class SpectrumChannel implements Channel {
  private handler: ((msg: ChannelInbound) => void) | null = null;
  private spaces = new Map<PersonId, { send(content: string | ContentBuilder): Promise<unknown> }>();
  private readonly log: (msg: string) => void;
  private stopped = false;

  private constructor(
    private app: SpectrumApp,
    private readonly opts: SpectrumChannelOptions,
  ) {
    this.log = opts.log ?? console.error;
  }

  private static makeApp(opts: SpectrumChannelOptions): Promise<SpectrumApp> {
    return Spectrum({
      projectId: opts.projectId,
      projectSecret: opts.projectSecret,
      platforms: [imessage.config()],
    });
  }

  static async connect(opts: SpectrumChannelOptions): Promise<SpectrumChannel> {
    return new SpectrumChannel(await SpectrumChannel.makeApp(opts), opts);
  }

  async send(person: PersonId, message: string | Outbound): Promise<void> {
    const space = await this.spaceFor(person);
    // Sequential, not Promise.all, so background/image/text ordering holds.
    for (const content of outboundContents(message)) {
      await space.send(content);
    }
  }

  onMessage(handler: (msg: ChannelInbound) => void): void {
    this.handler = handler;
  }

  async fetchAttachment(person: PersonId, id: string): Promise<Buffer> {
    const att = await imessage(this.app).getAttachment(id, this.opts.phones[person]);
    // The retention window for inbound attachment bytes is not guaranteed,
    // so callers must be ready for this to throw.
    if (!att) throw new Error(`Attachment "${id}" is no longer available`);
    return await att.read();
  }

  /** Begin consuming the inbound stream. Call after onMessage is registered. */
  start(): void {
    void this.readLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.app.stop();
  }

  private async spaceFor(person: PersonId) {
    let space = this.spaces.get(person);
    if (!space) {
      const im = imessage(this.app);
      space = await im.space.create(this.opts.phones[person]);
      this.spaces.set(person, space);
    }
    return space;
  }

  private handleMessage(space: { id: unknown }, message: unknown): void {
    const at = new Date().toISOString();
    const decoded = decodeInbound(message, space.id, this.opts.phones, at);
    switch (decoded.kind) {
      case "deliver":
        this.handler?.(decoded.msg);
        return;
      case "unknown":
        this.log(`dropped message from unknown sender`);
        this.opts.onUnknown?.(decoded.address, decoded.text, at);
        return;
      case "drop":
        this.log(decoded.reason);
        return;
      case "ignore":
        return;
    }
  }

  private async readLoop(): Promise<void> {
    let consecutiveFailures = 0;
    while (!this.stopped) {
      try {
        for await (const [space, message] of this.app.messages) {
          consecutiveFailures = 0;
          try {
            this.handleMessage(space, message);
          } catch (err) {
            this.log(`inbound handling error: ${err}`);
          }
        }
        this.log("spectrum message stream ended");
      } catch (err) {
        this.log(`spectrum stream error: ${err}`);
      }
      if (this.stopped) break;
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_STREAM_FAILURES) {
        // The client is not recovering; exit and let launchd start us fresh.
        this.log(`stream failed ${consecutiveFailures} times consecutively; exiting for supervisor restart`);
        process.exit(1);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 5_000 * Math.min(consecutiveFailures, 6)),
      );
      // Re-iterating a dead stream on the same client reconnects nothing:
      // rebuild the Spectrum client (and drop cached spaces) instead.
      try {
        await this.app.stop().catch(() => {});
        this.app = await SpectrumChannel.makeApp(this.opts);
        this.spaces = new Map();
        this.log("spectrum client rebuilt after stream failure");
      } catch (err) {
        this.log(`spectrum client rebuild failed: ${err}`);
      }
    }
  }
}
