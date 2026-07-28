import { test, expect, describe } from "bun:test";
import { outboundContents } from "../../src/channel/spectrum";
import { FakeChannel } from "../../src/channel/fake";
import type { Outbound } from "../../src/channel/types";

const EFFECT_IDS = {
  celebrate: "com.apple.messages.effect.CKConfettiEffect",
  emphasize: "com.apple.MobileSMS.expressivesend.impact",
  gentle: "com.apple.MobileSMS.expressivesend.gentle",
} as const;

describe("outboundContents", () => {
  test("a plain string yields one item, unchanged", () => {
    expect(outboundContents("hello")).toEqual(["hello"]);
  });

  test("an explicit empty string still yields one item", () => {
    expect(outboundContents("")).toEqual([""]);
  });

  test("{ text } with no effect yields one raw string item", () => {
    expect(outboundContents({ text: "hi" })).toEqual(["hi"]);
  });

  test("text plus effect yields one item, not two", () => {
    const items = outboundContents({ text: "hi", effect: "celebrate" });
    expect(items).toHaveLength(1);
  });

  test("background plus image plus text yields three items in that order", async () => {
    const message: Outbound = {
      background: "clear",
      image: { bytes: Buffer.from("img"), mimeType: "image/png" },
      text: "caption",
    };
    const items = outboundContents(message);
    expect(items).toHaveLength(3);
    // Order: background, image, text. Confirm text is last and is the raw string.
    expect(items[2]).toBe("caption");
    // background/image are ContentBuilders (not strings).
    expect(typeof items[0]).not.toBe("string");
    expect(typeof items[1]).not.toBe("string");
  });

  test("a background with bytes yields one builder, distinct from clear", () => {
    const withBytes = outboundContents({
      background: { bytes: Buffer.from("jpeg"), mimeType: "image/jpeg" },
    });
    expect(withBytes).toHaveLength(1);
    expect(typeof withBytes[0]).not.toBe("string");
    expect(outboundContents({ background: "clear" })).toHaveLength(1);
  });

  test("{} yields nothing", () => {
    expect(outboundContents({})).toEqual([]);
  });

  test("effect with no text is dropped", () => {
    expect(outboundContents({ effect: "celebrate" })).toEqual([]);
  });

  test("Phase 1 shape { text, image, effect } yields two items, image first", () => {
    const message: Outbound = {
      text: "hi",
      image: { bytes: Buffer.from("img"), mimeType: "image/png" },
      effect: "emphasize",
    };
    const items = outboundContents(message);
    expect(items).toHaveLength(2);
    expect(typeof items[0]).not.toBe("string"); // the image builder
    expect(typeof items[1]).not.toBe("string"); // text+effect, also a builder
  });

  // The real proof that intensity "off" is byte-identical on the wire: a
  // plain string produces exactly one raw item, nothing decorated added.
  test("outboundContents(plain string) returns exactly [\"plain text\"]", () => {
    expect(outboundContents("plain text")).toEqual(["plain text"]);
  });

  test("{ text: \"\" } still yields one item", () => {
    expect(outboundContents({ text: "" })).toEqual([""]);
  });

  for (const key of ["celebrate", "emphasize", "gentle"] as const) {
    test(`${key} maps to the correct vendor effect id`, async () => {
      const items = outboundContents({ text: "hey", effect: key });
      expect(items).toHaveLength(1);
      const built = await (items[0] as { build(): Promise<unknown> }).build();
      expect((built as { effect: string }).effect).toBe(EFFECT_IDS[key]);
    });
  }
});

describe("FakeChannel structured sends", () => {
  test("sentTo still returns plain strings for string sends", async () => {
    const ch = new FakeChannel();
    await ch.send("a", "hello");
    expect(ch.sentTo("a")).toEqual(["hello"]);
  });

  test("an image only send does not appear in sentTo but does in outboundTo", async () => {
    const ch = new FakeChannel();
    await ch.send("a", { image: { bytes: Buffer.from("x"), mimeType: "image/jpeg" } });
    expect(ch.sentTo("a")).toEqual([]);
    expect(ch.outboundTo("a")).toHaveLength(1);
    expect(ch.outboundTo("a")[0]?.image?.mimeType).toBe("image/jpeg");
  });

  test("fetchAttachment returns seeded bytes", async () => {
    const ch = new FakeChannel();
    const bytes = Buffer.from("seeded");
    ch.attachmentBytes.set("att1", bytes);
    const result = await ch.fetchAttachment("a", "att1");
    expect(result).toBe(bytes);
  });

  test("fetchAttachment throws when nothing was seeded", async () => {
    const ch = new FakeChannel();
    await expect(ch.fetchAttachment("a", "missing")).rejects.toThrow();
  });
});
