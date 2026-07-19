import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type { PersonId } from "../config";
import type { Channel, ChannelInbound } from "./types";

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
  private spaces = new Map<PersonId, { send(text: string): Promise<unknown> }>();
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

  async send(person: PersonId, text: string): Promise<void> {
    const space = await this.spaceFor(person);
    await space.send(text);
  }

  onMessage(handler: (msg: ChannelInbound) => void): void {
    this.handler = handler;
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

  private personFor(address: string | undefined): PersonId | null {
    if (address === this.opts.phones.a) return "a";
    if (address === this.opts.phones.b) return "b";
    return null;
  }

  private handleMessage(space: { id: unknown }, message: unknown): void {
    const at = new Date().toISOString();
    // The SDK's exported types for content/sender are not usable directly
    // (minified public surface); shapes below were verified against the
    // live API in the step 0 spike.
    const msg = message as {
      content: { type: string; text?: string };
      sender: { address?: string; id?: string };
    };
    if (msg.content.type !== "text" || typeof msg.content.text !== "string") return;
    const text = msg.content.text;
    if (text.trim().length === 0) return; // never let "" become an answer part
    const address = msg.sender.address ?? msg.sender.id;
    const person = this.personFor(address);
    if (!person) {
      this.log(`dropped message from unknown sender`);
      this.opts.onUnknown?.(address ?? "unknown", text, at);
      return;
    }
    // Require the message's conversation to be the participant's own 1:1
    // space (id tail is the phone number, per spike): a participant's text
    // arriving via any other space (e.g. a group thread that includes the
    // shared line) must never be ingested as their intimate daily answer.
    const spaceTail = String(space.id).split(";").pop();
    if (spaceTail !== this.opts.phones[person]) {
      this.log(`dropped message from ${person} in non-participant space`);
      return;
    }
    this.handler?.({ person, text, at });
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
