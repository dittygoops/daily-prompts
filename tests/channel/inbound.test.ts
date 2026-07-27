import { test, expect, describe } from "bun:test";
import { decodeInbound } from "../../src/channel/spectrum";
import type { PersonId } from "../../src/config";

const PHONES: Record<PersonId, string> = { a: "+15550001111", b: "+15550002222" };
const AT = "2026-07-27T00:00:00.000Z";

function textMessage(text: string, address = PHONES.a) {
  return { content: { type: "text", text }, sender: { address } };
}

describe("decodeInbound", () => {
  test("a text message from a known sender in their own space delivers", () => {
    const decoded = decodeInbound(
      textMessage("hi there"),
      "imessage;-;+15550001111",
      PHONES,
      AT,
    );
    expect(decoded.kind).toBe("deliver");
    if (decoded.kind !== "deliver") throw new Error("expected deliver");
    expect(decoded.msg).toEqual({ person: "a", text: "hi there", at: AT });
    expect(decoded.msg.attachment).toBeUndefined();
  });

  test("an attachment message delivers with text \"\" and full metadata", () => {
    const message = {
      content: { type: "attachment", id: "att-1", mimeType: "image/png", name: "photo.png", size: 1234 },
      sender: { address: PHONES.a },
    };
    const decoded = decodeInbound(message, "imessage;-;+15550001111", PHONES, AT);
    expect(decoded.kind).toBe("deliver");
    if (decoded.kind !== "deliver") throw new Error("expected deliver");
    expect(decoded.msg.text).toBe("");
    expect(decoded.msg.attachment).toEqual({
      id: "att-1",
      mimeType: "image/png",
      name: "photo.png",
      size: 1234,
    });
  });

  test("size defaults to 0 and mimeType/name fall back when omitted", () => {
    const message = {
      content: { type: "attachment", id: "att-2" },
      sender: { address: PHONES.a },
    };
    const decoded = decodeInbound(message, "imessage;-;+15550001111", PHONES, AT);
    expect(decoded.kind).toBe("deliver");
    if (decoded.kind !== "deliver") throw new Error("expected deliver");
    expect(decoded.msg.attachment).toEqual({
      id: "att-2",
      mimeType: "application/octet-stream",
      name: "",
      size: 0,
    });
  });

  test("an attachment from an unknown sender returns kind: unknown", () => {
    const message = {
      content: { type: "attachment", id: "att-3" },
      sender: { address: "+15559999999" },
    };
    const decoded = decodeInbound(message, "imessage;-;+15559999999", PHONES, AT);
    expect(decoded.kind).toBe("unknown");
    if (decoded.kind !== "unknown") throw new Error("expected unknown");
    expect(decoded.address).toBe("+15559999999");
    expect(decoded.text).toBe("");
  });

  test("a known sender in a non participant (group) space returns kind: drop", () => {
    const message = {
      content: { type: "attachment", id: "att-4" },
      sender: { address: PHONES.a },
    };
    // Group space id ends in b's number, not a's: a's message here must not deliver.
    const decoded = decodeInbound(message, "imessage;-;+15550002222", PHONES, AT);
    expect(decoded.kind).toBe("drop");
    if (decoded.kind !== "drop") throw new Error("expected drop");
    expect(decoded.reason).toBe("dropped message from a in non-participant space");
  });

  test("a whitespace only text still returns kind: ignore", () => {
    const decoded = decodeInbound(textMessage("   \n\t "), "imessage;-;+15550001111", PHONES, AT);
    expect(decoded.kind).toBe("ignore");
  });

  test("an unsupported content type returns kind: ignore", () => {
    const message = { content: { type: "reaction" }, sender: { address: PHONES.a } };
    const decoded = decodeInbound(message, "imessage;-;+15550001111", PHONES, AT);
    expect(decoded.kind).toBe("ignore");
  });

  test("decodeInbound never calls read()", () => {
    const read = () => {
      throw new Error("read() must not be called during decode");
    };
    const message = {
      content: { type: "attachment", id: "att-5", mimeType: "image/png", name: "x.png", size: 1, read },
      sender: { address: PHONES.a },
    };
    expect(() => decodeInbound(message, "imessage;-;+15550001111", PHONES, AT)).not.toThrow();
  });
});

describe("decodeInbound group content", () => {
  // Real wrapper shape: each item is a full Message, the part itself is at item.content.
  function wrap(content: Record<string, unknown>, partIndex: number, parentId = "parent-1") {
    return { id: `p:${partIndex}/${parentId}`, partIndex, parentId, content };
  }

  function groupMessage(items: unknown[], address = PHONES.a) {
    return { content: { type: "group", items }, sender: { address } };
  }

  test("a captioned photo (attachment part plus text part) delivers one message with both", () => {
    const message = groupMessage([
      wrap({ type: "attachment", id: "att-guid-1", mimeType: "image/heic", name: "IMG_0991.HEIC", size: 2053225 }, 0),
      wrap({ type: "text", text: "Test caption beta" }, 1),
    ]);
    const decoded = decodeInbound(message, "imessage;-;+15550001111", PHONES, AT);
    expect(decoded.kind).toBe("deliver");
    if (decoded.kind !== "deliver") throw new Error("expected deliver");
    expect(decoded.msg.text).toBe("Test caption beta");
    expect(decoded.msg.attachment).toEqual({
      id: "att-guid-1",
      mimeType: "image/heic",
      name: "IMG_0991.HEIC",
      size: 2053225,
    });
  });

  test("the attachment id comes from item.content.id, not the wrapper id", () => {
    const message = groupMessage([
      wrap({ type: "attachment", id: "att-guid-1" }, 0, "parent-distinct"),
      wrap({ type: "text", text: "caption" }, 1, "parent-distinct"),
    ]);
    const decoded = decodeInbound(message, "imessage;-;+15550001111", PHONES, AT);
    expect(decoded.kind).toBe("deliver");
    if (decoded.kind !== "deliver") throw new Error("expected deliver");
    expect(decoded.msg.attachment?.id).toBe("att-guid-1");
    expect(decoded.msg.attachment?.id).not.toBe("p:0/parent-distinct");
  });

  test("part order does not matter: text first, attachment second, still delivers both", () => {
    const message = groupMessage([
      wrap({ type: "text", text: "caption first" }, 0),
      wrap({ type: "attachment", id: "att-guid-2" }, 1),
    ]);
    const decoded = decodeInbound(message, "imessage;-;+15550001111", PHONES, AT);
    expect(decoded.kind).toBe("deliver");
    if (decoded.kind !== "deliver") throw new Error("expected deliver");
    expect(decoded.msg.text).toBe("caption first");
    expect(decoded.msg.attachment?.id).toBe("att-guid-2");
  });

  test("a group with only text parts behaves like a plain text message", () => {
    const message = groupMessage([wrap({ type: "text", text: "just text" }, 0)]);
    const decoded = decodeInbound(message, "imessage;-;+15550001111", PHONES, AT);
    expect(decoded.kind).toBe("deliver");
    if (decoded.kind !== "deliver") throw new Error("expected deliver");
    expect(decoded.msg.text).toBe("just text");
    expect(decoded.msg.attachment).toBeUndefined();
  });

  test("a group whose only text part is whitespace only returns ignore", () => {
    const message = groupMessage([wrap({ type: "text", text: "   \n\t " }, 0)]);
    const decoded = decodeInbound(message, "imessage;-;+15550001111", PHONES, AT);
    expect(decoded.kind).toBe("ignore");
  });

  test("a group with only attachment parts delivers with text \"\"", () => {
    const message = groupMessage([wrap({ type: "attachment", id: "att-guid-3" }, 0)]);
    const decoded = decodeInbound(message, "imessage;-;+15550001111", PHONES, AT);
    expect(decoded.kind).toBe("deliver");
    if (decoded.kind !== "deliver") throw new Error("expected deliver");
    expect(decoded.msg.text).toBe("");
    expect(decoded.msg.attachment?.id).toBe("att-guid-3");
  });

  test("a captioned photo whose caption is whitespace only delivers the attachment with text \"\"", () => {
    const message = groupMessage([
      wrap({ type: "attachment", id: "att-guid-4" }, 0),
      wrap({ type: "text", text: "   " }, 1),
    ]);
    const decoded = decodeInbound(message, "imessage;-;+15550001111", PHONES, AT);
    expect(decoded.kind).toBe("deliver");
    if (decoded.kind !== "deliver") throw new Error("expected deliver");
    expect(decoded.msg.text).toBe("");
    expect(decoded.msg.attachment?.id).toBe("att-guid-4");
  });

  test("a group with two attachments takes the first", () => {
    const message = groupMessage([
      wrap({ type: "attachment", id: "att-guid-first" }, 0),
      wrap({ type: "attachment", id: "att-guid-second" }, 1),
    ]);
    const decoded = decodeInbound(message, "imessage;-;+15550001111", PHONES, AT);
    expect(decoded.kind).toBe("deliver");
    if (decoded.kind !== "deliver") throw new Error("expected deliver");
    expect(decoded.msg.attachment?.id).toBe("att-guid-first");
  });

  test("a group with neither text nor attachment parts returns ignore", () => {
    const message = groupMessage([wrap({ type: "reaction" }, 0)]);
    const decoded = decodeInbound(message, "imessage;-;+15550001111", PHONES, AT);
    expect(decoded.kind).toBe("ignore");
  });

  test("items missing returns ignore", () => {
    const message = { content: { type: "group" }, sender: { address: PHONES.a } };
    const decoded = decodeInbound(message, "imessage;-;+15550001111", PHONES, AT);
    expect(decoded.kind).toBe("ignore");
  });

  test("items not an array returns ignore", () => {
    const message = { content: { type: "group", items: "not-an-array" }, sender: { address: PHONES.a } };
    const decoded = decodeInbound(message, "imessage;-;+15550001111", PHONES, AT);
    expect(decoded.kind).toBe("ignore");
  });

  test("a group from an unknown sender returns unknown", () => {
    const message = groupMessage(
      [wrap({ type: "attachment", id: "att-guid-5" }, 0)],
      "+15559999999",
    );
    const decoded = decodeInbound(message, "imessage;-;+15559999999", PHONES, AT);
    expect(decoded.kind).toBe("unknown");
    if (decoded.kind !== "unknown") throw new Error("expected unknown");
    expect(decoded.address).toBe("+15559999999");
  });

  test("a group from a known sender in a non participant space returns drop", () => {
    const message = groupMessage([wrap({ type: "attachment", id: "att-guid-6" }, 0)]);
    // Group space id ends in b's number, not a's: a's message here must not deliver.
    const decoded = decodeInbound(message, "imessage;-;+15550002222", PHONES, AT);
    expect(decoded.kind).toBe("drop");
    if (decoded.kind !== "drop") throw new Error("expected drop");
    expect(decoded.reason).toBe("dropped message from a in non-participant space");
  });

  test("decode never calls read() on a group", () => {
    const read = () => {
      throw new Error("read() must not be called during decode");
    };
    const stream = () => {
      throw new Error("stream() must not be called during decode");
    };
    const message = groupMessage([
      wrap({ type: "attachment", id: "att-guid-7", mimeType: "image/heic", name: "IMG.HEIC", size: 5, read, stream }, 0),
      wrap({ type: "text", text: "caption" }, 1),
    ]);
    expect(() => decodeInbound(message, "imessage;-;+15550001111", PHONES, AT)).not.toThrow();
  });

  test("a flattened group (items are the parts directly, no content wrapper) still decodes", () => {
    const message = groupMessage([
      { type: "attachment", id: "att-guid-8", mimeType: "image/heic", name: "IMG.HEIC", size: 9 },
      { type: "text", text: "flattened caption" },
    ]);
    const decoded = decodeInbound(message, "imessage;-;+15550001111", PHONES, AT);
    expect(decoded.kind).toBe("deliver");
    if (decoded.kind !== "deliver") throw new Error("expected deliver");
    expect(decoded.msg.text).toBe("flattened caption");
    expect(decoded.msg.attachment?.id).toBe("att-guid-8");
  });
});
