import type { PersonId } from "../config";
import type { Channel, ChannelInbound, Outbound } from "./types";

export class FakeChannel implements Channel {
  readonly sent: { person: PersonId; message: Outbound }[] = [];
  /** Bytes fetchAttachment will hand back, keyed by attachment id. */
  readonly attachmentBytes = new Map<string, Buffer>();
  private handler: ((msg: ChannelInbound) => void) | null = null;

  async send(person: PersonId, message: string | Outbound): Promise<void> {
    const normalized = typeof message === "string" ? { text: message } : message;
    this.sent.push({ person, message: normalized });
  }

  onMessage(handler: (msg: ChannelInbound) => void): void {
    this.handler = handler;
  }

  /** Test hook: simulate an inbound text from a participant. */
  inject(person: PersonId, text: string, at = "t"): void {
    if (!this.handler) throw new Error("No handler registered");
    this.handler({ person, text, at });
  }

  /** Test hook: simulate an inbound attachment from a participant. */
  injectAttachment(
    person: PersonId,
    attachment: NonNullable<ChannelInbound["attachment"]>,
    at = "t",
    text = "",
  ): void {
    if (!this.handler) throw new Error("No handler registered");
    this.handler({ person, text, at, attachment });
  }

  // Skips entries whose text is undefined, so image only or background only
  // sends never pollute existing text assertions.
  sentTo(person: PersonId): string[] {
    return this.sent.flatMap((s) =>
      s.person === person && s.message.text !== undefined ? [s.message.text] : [],
    );
  }

  outboundTo(person: PersonId): Outbound[] {
    return this.sent.filter((s) => s.person === person).map((s) => s.message);
  }

  async fetchAttachment(person: PersonId, id: string): Promise<Buffer> {
    const bytes = this.attachmentBytes.get(id);
    if (!bytes) throw new Error(`No attachment bytes seeded for id "${id}"`);
    return bytes;
  }
}
