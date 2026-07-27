import type { PersonId } from "../config";

/** Semantic, not vendor specific: core logic asks for "celebrate" and only
 * the transport decides what that looks like. */
export type Effect = "celebrate" | "emphasize" | "gentle";

export interface Outbound {
  text?: string;
  image?: { bytes: Buffer; mimeType: string; name?: string };
  effect?: Effect;
  background?: { bytes: Buffer; mimeType: string } | "clear";
}

export interface ChannelInbound {
  person: PersonId;
  text: string; // "" for an attachment with no caption
  attachment?: { id: string; mimeType: string; name: string; size: number };
  at: string; // ISO timestamp
}

/** Transport for participant messaging. Implementations: SpectrumChannel
 * (production), FakeChannel (tests). Unknown senders never reach this
 * interface; implementations drop and log them. */
export interface Channel {
  send(person: PersonId, message: string | Outbound): Promise<void>;
  onMessage(handler: (msg: ChannelInbound) => void): void;
  /** Optional: not every transport can retrieve inbound bytes, so callers
   * must feature check before using it. */
  fetchAttachment?(person: PersonId, id: string): Promise<Buffer>;
}
