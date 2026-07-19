import type { PersonId } from "../config";
import type { Channel, ChannelInbound } from "./types";

export class FakeChannel implements Channel {
  readonly sent: { person: PersonId; text: string }[] = [];
  private handler: ((msg: ChannelInbound) => void) | null = null;

  async send(person: PersonId, text: string): Promise<void> {
    this.sent.push({ person, text });
  }

  onMessage(handler: (msg: ChannelInbound) => void): void {
    this.handler = handler;
  }

  /** Test hook: simulate an inbound text from a participant. */
  inject(person: PersonId, text: string, at = "t"): void {
    if (!this.handler) throw new Error("No handler registered");
    this.handler({ person, text, at });
  }

  sentTo(person: PersonId): string[] {
    return this.sent.filter((s) => s.person === person).map((s) => s.text);
  }
}
