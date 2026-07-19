import type { PersonId } from "../config";

export interface ChannelInbound {
  person: PersonId;
  text: string;
  at: string; // ISO timestamp
}

/** Transport for participant messaging. Implementations: SpectrumChannel
 * (production), FakeChannel (tests). Unknown senders never reach this
 * interface; implementations drop and log them. */
export interface Channel {
  send(person: PersonId, text: string): Promise<void>;
  onMessage(handler: (msg: ChannelInbound) => void): void;
}
