import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ANIMAL_PROVIDERS,
  FakeAnimalImageSource,
  HttpAnimalImageSource,
} from "../../src/media/animals";
import type { AnimalImage } from "../../src/media/animals";

// Real magic-byte prefixes so our own validator accepts them.
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 1, 2, 3, 4]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const HTML_BYTES = Buffer.from("<html><body>oops</body></html>");

function fakeFetch(
  responses: { status?: number; body: Buffer | object; headers?: Record<string, string> }[],
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let i = 0;
  const fn = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses[i]!;
    i++;
    const headers = new Headers(r.headers ?? {});
    const isBuffer = Buffer.isBuffer(r.body);
    const bodyInit = isBuffer ? (r.body as Buffer) : JSON.stringify(r.body);
    if (!headers.has("content-type")) {
      headers.set("content-type", isBuffer ? "application/octet-stream" : "application/json");
    }
    return new Response(bodyInit as Bun.BodyInit, { status: r.status ?? 200, headers });
  };
  return { fn, calls };
}

describe("HttpAnimalImageSource providers", () => {
  test("cataas: single direct-bytes GET, id derived from content hash", async () => {
    const { fn, calls } = fakeFetch([
      { body: PNG_BYTES, headers: { "content-type": "image/png" } },
    ]);
    const source = new HttpAnimalImageSource({
      fetchImpl: fn as typeof fetch,
      random: () => 0,
      sources: [DEFAULT_ANIMAL_PROVIDERS[0]!], // cataas
    });
    const image = await source.fetch();
    expect(calls.map((c) => c.url)).toEqual(["https://cataas.com/cat"]);
    expect(image.mimeType).toBe("image/png");
    expect(image.name).toBe("cataas.png");
    expect(image.bytes.equals(PNG_BYTES)).toBe(true);
    expect(image.id.startsWith("cataas:sha256-")).toBe(true);
    expect(image.id.length).toBe("cataas:sha256-".length + 16);
  });

  test("thecatapi: search then fetch, id from API id", async () => {
    const { fn, calls } = fakeFetch([
      { body: [{ id: "abc123", url: "https://cdn.thecatapi.com/abc123.jpg", width: 10, height: 10 }] },
      { body: JPEG_BYTES, headers: { "content-type": "image/jpeg" } },
    ]);
    const source = new HttpAnimalImageSource({
      fetchImpl: fn as typeof fetch,
      random: () => 0,
      sources: [DEFAULT_ANIMAL_PROVIDERS[1]!], // thecatapi
    });
    const image = await source.fetch();
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.thecatapi.com/v1/images/search",
      "https://cdn.thecatapi.com/abc123.jpg",
    ]);
    expect(image.id).toBe("thecatapi:abc123");
    expect(image.mimeType).toBe("image/jpeg");
    expect(image.name).toBe("thecatapi.jpg");
    expect(image.bytes.equals(JPEG_BYTES)).toBe(true);
  });

  test("dogceo: random then fetch, id from final url", async () => {
    const dogUrl = "https://images.dog.ceo/breeds/hound-afghan/n02088094_1003.jpg";
    const { fn, calls } = fakeFetch([
      { body: { message: dogUrl, status: "success" } },
      { body: JPEG_BYTES, headers: { "content-type": "image/jpeg" } },
    ]);
    const source = new HttpAnimalImageSource({
      fetchImpl: fn as typeof fetch,
      random: () => 0,
      sources: [DEFAULT_ANIMAL_PROVIDERS[2]!], // dogceo
    });
    const image = await source.fetch();
    expect(calls.map((c) => c.url)).toEqual([
      "https://dog.ceo/api/breeds/image/random",
      dogUrl,
    ]);
    expect(image.id).toBe(`dogceo:${dogUrl}`);
    expect(image.name).toBe("dogceo.jpg");
  });

  test("random selection is deterministic and covers all indices", async () => {
    const cases = [
      {
        randomValue: 0,
        expectedUrl: "https://cataas.com/cat",
        responses: [{ body: PNG_BYTES, headers: { "content-type": "image/png" } }],
      },
      {
        randomValue: 0.4,
        expectedUrl: "https://api.thecatapi.com/v1/images/search",
        responses: [
          { body: [{ id: "z", url: "https://cdn.thecatapi.com/z.jpg" }] },
          { body: JPEG_BYTES, headers: { "content-type": "image/jpeg" } },
        ],
      },
      {
        randomValue: 0.9,
        expectedUrl: "https://dog.ceo/api/breeds/image/random",
        responses: [
          { body: { message: "https://images.dog.ceo/x.jpg", status: "success" } },
          { body: JPEG_BYTES, headers: { "content-type": "image/jpeg" } },
        ],
      },
    ] as const;
    for (const { randomValue, expectedUrl, responses } of cases) {
      const { fn, calls } = fakeFetch([...responses]);
      const source = new HttpAnimalImageSource({ fetchImpl: fn as typeof fetch, random: () => randomValue });
      await source.fetch();
      expect(calls[0]!.url).toBe(expectedUrl);
    }
  });

  test("non-2xx on the first request throws", async () => {
    const { fn } = fakeFetch([{ status: 503, body: { error: "down" } }]);
    const source = new HttpAnimalImageSource({
      fetchImpl: fn as typeof fetch,
      random: () => 0,
      sources: [DEFAULT_ANIMAL_PROVIDERS[2]!], // dogceo
    });
    await expect(source.fetch()).rejects.toThrow(/HttpAnimalImageSource\(dogceo\)/);
  });

  test("non-2xx on the second (image) request throws", async () => {
    const { fn } = fakeFetch([
      { body: { message: "https://images.dog.ceo/x.jpg", status: "success" } },
      { status: 500, body: {} },
    ]);
    const source = new HttpAnimalImageSource({
      fetchImpl: fn as typeof fetch,
      random: () => 0,
      sources: [DEFAULT_ANIMAL_PROVIDERS[2]!],
    });
    await expect(source.fetch()).rejects.toThrow(/HttpAnimalImageSource\(dogceo\)/);
  });

  test("an HTML error page returned with status 200 and text/html is rejected", async () => {
    const { fn } = fakeFetch([{ body: HTML_BYTES, headers: { "content-type": "text/html" } }]);
    const source = new HttpAnimalImageSource({
      fetchImpl: fn as typeof fetch,
      random: () => 0,
      sources: [DEFAULT_ANIMAL_PROVIDERS[0]!], // cataas
    });
    await expect(source.fetch()).rejects.toThrow(/HttpAnimalImageSource\(cataas\)/);
  });

  test("bytes that pass a lying image/jpeg header but are actually HTML are rejected via magic bytes", async () => {
    const { fn } = fakeFetch([{ body: HTML_BYTES, headers: { "content-type": "image/jpeg" } }]);
    const source = new HttpAnimalImageSource({
      fetchImpl: fn as typeof fetch,
      random: () => 0,
      sources: [DEFAULT_ANIMAL_PROVIDERS[0]!],
    });
    await expect(source.fetch()).rejects.toThrow(/HttpAnimalImageSource\(cataas\)/);
  });

  test("Content-Length over maxBytes throws without downloading further", async () => {
    const { fn } = fakeFetch([
      { body: PNG_BYTES, headers: { "content-type": "image/png", "content-length": "999999999" } },
    ]);
    const source = new HttpAnimalImageSource({
      fetchImpl: fn as typeof fetch,
      random: () => 0,
      sources: [DEFAULT_ANIMAL_PROVIDERS[0]!],
      maxBytes: 100,
    });
    await expect(source.fetch()).rejects.toThrow(/HttpAnimalImageSource\(cataas\)/);
  });

  test("oversized actual body throws even without a Content-Length header", async () => {
    const bigBody = Buffer.concat([PNG_BYTES, Buffer.alloc(1000)]);
    const { fn } = fakeFetch([{ body: bigBody, headers: { "content-type": "image/png" } }]);
    const source = new HttpAnimalImageSource({
      fetchImpl: fn as typeof fetch,
      random: () => 0,
      sources: [DEFAULT_ANIMAL_PROVIDERS[0]!],
      maxBytes: 100,
    });
    await expect(source.fetch()).rejects.toThrow(/HttpAnimalImageSource\(cataas\)/);
  });

  test("a network-level fetch rejection propagates to the caller", async () => {
    const source = new HttpAnimalImageSource({
      fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
      random: () => 0,
      sources: [DEFAULT_ANIMAL_PROVIDERS[0]!],
    });
    await expect(source.fetch()).rejects.toThrow("ECONNREFUSED");
  });

  test("the abort signal is passed on every request", async () => {
    const { fn, calls } = fakeFetch([
      { body: { message: "https://images.dog.ceo/x.jpg", status: "success" } },
      { body: JPEG_BYTES, headers: { "content-type": "image/jpeg" } },
    ]);
    const source = new HttpAnimalImageSource({
      fetchImpl: fn as typeof fetch,
      random: () => 0,
      sources: [DEFAULT_ANIMAL_PROVIDERS[2]!],
    });
    await source.fetch();
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test("recentIds: a duplicate id causes a re-fetch and a different image is returned", async () => {
    // cataas ids are content-hash derived, so two distinct bodies across
    // attempts yield two distinct ids.
    const { fn, calls } = fakeFetch([
      { body: PNG_BYTES, headers: { "content-type": "image/png" } },
      { body: JPEG_BYTES, headers: { "content-type": "image/jpeg" } },
    ]);
    const source = new HttpAnimalImageSource({
      fetchImpl: fn as typeof fetch,
      random: () => 0,
      sources: [DEFAULT_ANIMAL_PROVIDERS[0]!],
    });
    // Compute the id the first response would produce, and pre-seed it as "recent".
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(PNG_BYTES);
    const firstId = `cataas:sha256-${hasher.digest("hex").slice(0, 16)}`;

    const image = await source.fetch([firstId]);
    expect(calls.length).toBe(2);
    expect(image.id).not.toBe(firstId);
    expect(image.mimeType).toBe("image/jpeg");
  });

  test("recentIds: when every attempt duplicates, the image is still returned rather than throwing", async () => {
    const { fn, calls } = fakeFetch([
      { body: PNG_BYTES, headers: { "content-type": "image/png" } },
      { body: PNG_BYTES, headers: { "content-type": "image/png" } },
      { body: PNG_BYTES, headers: { "content-type": "image/png" } },
    ]);
    const source = new HttpAnimalImageSource({
      fetchImpl: fn as typeof fetch,
      random: () => 0,
      sources: [DEFAULT_ANIMAL_PROVIDERS[0]!],
    });
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(PNG_BYTES);
    const alwaysId = `cataas:sha256-${hasher.digest("hex").slice(0, 16)}`;

    const image = await source.fetch([alwaysId]);
    expect(calls.length).toBe(3); // exactly 3 total attempts, then gives up
    expect(image.id).toBe(alwaysId);
  });
});

describe("FakeAnimalImageSource", () => {
  test("returns images in order, cycling, and records recentIds passed to it", async () => {
    const img1: AnimalImage = { id: "a", bytes: Buffer.from("1"), mimeType: "image/png", name: "a.png" };
    const img2: AnimalImage = { id: "b", bytes: Buffer.from("2"), mimeType: "image/png", name: "b.png" };
    const source = new FakeAnimalImageSource([img1, img2]);

    expect(await source.fetch(["x"])).toBe(img1);
    expect(await source.fetch()).toBe(img2);
    expect(await source.fetch(["y", "z"])).toBe(img1); // cycles
    expect(source.calls).toEqual([["x"], undefined, ["y", "z"]]);
  });

  test("default image is a valid tiny PNG with id fake:1", async () => {
    const source = new FakeAnimalImageSource();
    const image = await source.fetch();
    expect(image.id).toBe("fake:1");
    expect(image.mimeType).toBe("image/png");
    expect(image.bytes.length).toBeGreaterThan(0);
    expect(image.bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      true,
    );
  });

  test("error mode throws", async () => {
    const source = new FakeAnimalImageSource(undefined, new Error("boom"));
    await expect(source.fetch()).rejects.toThrow("boom");
  });
});
