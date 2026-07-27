/** A single downloaded animal image, ready to attach to an outgoing prompt. */
export interface AnimalImage {
  /** Stable identifier for recency de-duplication; the caller persists it. */
  id: string;
  bytes: Buffer;
  mimeType: string;
  name: string;
}

/** Source of animal images for prompts. Throws on any failure (network,
 * timeout, oversize, non-image body); the caller degrades and the prompt
 * still goes out with no image. `recentIds` is a best-effort avoid-list,
 * never a reason to fail. */
export interface AnimalImageSource {
  fetch(recentIds?: string[]): Promise<AnimalImage>;
}

interface AnimalProviderContext {
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

/** A named unit that resolves to a downloadable image URL, plus an optional
 * stable id when the upstream API hands one out. A provider whose endpoint
 * returns image bytes directly (cataas) just returns its own URL here; the
 * actual download always happens in one shared place afterward. */
export interface AnimalProvider {
  name: string;
  resolve(ctx: AnimalProviderContext): Promise<{ url: string; id?: string }>;
}

const CATAAS: AnimalProvider = {
  name: "cataas",
  async resolve() {
    // cataas returns image bytes directly from this URL; no discovery step needed.
    return { url: "https://cataas.com/cat" };
  },
};

const THECATAPI: AnimalProvider = {
  name: "thecatapi",
  async resolve(ctx) {
    const res = await ctx.fetchImpl("https://api.thecatapi.com/v1/images/search", {
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`HttpAnimalImageSource(thecatapi): request failed: ${res.status}`);
    }
    const data: unknown = await res.json();
    const first = Array.isArray(data) ? (data[0] as unknown) : undefined;
    if (
      !first ||
      typeof first !== "object" ||
      typeof (first as { url?: unknown }).url !== "string"
    ) {
      throw new Error(`HttpAnimalImageSource(thecatapi): unexpected response shape`);
    }
    const url = (first as { url: string }).url;
    const id = (first as { id?: unknown }).id;
    return { url, id: typeof id === "string" ? id : undefined };
  },
};

const DOGCEO: AnimalProvider = {
  name: "dogceo",
  async resolve(ctx) {
    const res = await ctx.fetchImpl("https://dog.ceo/api/breeds/image/random", {
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`HttpAnimalImageSource(dogceo): request failed: ${res.status}`);
    }
    const data: unknown = await res.json();
    const message = (data as { message?: unknown } | null)?.message;
    if (typeof message !== "string") {
      throw new Error(`HttpAnimalImageSource(dogceo): unexpected response shape`);
    }
    return { url: message };
  },
};

/** Default provider list; exported so tests (and callers) can inject a subset. */
export const DEFAULT_ANIMAL_PROVIDERS: AnimalProvider[] = [CATAAS, THECATAPI, DOGCEO];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Identifies the real image format from magic bytes, ignoring whatever the
 * server's Content-Type header claims (a lying 200 with an HTML error page
 * must be rejected, not trusted). */
function detectMimeType(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return "image/png";
  }
  if (bytes.length >= 6) {
    const header = bytes.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function extFor(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      // Unreachable: detectMimeType only ever returns one of the above.
      throw new Error(`HttpAnimalImageSource: no extension mapping for ${mimeType}`);
  }
}

async function downloadImage(
  url: string,
  providerName: string,
  ctx: AnimalProviderContext,
  maxBytes: number,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const res = await ctx.fetchImpl(url, { signal: AbortSignal.timeout(ctx.timeoutMs) });
  if (!res.ok) {
    throw new Error(`HttpAnimalImageSource(${providerName}): request failed: ${res.status}`);
  }

  const contentLength = res.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(
      `HttpAnimalImageSource(${providerName}): content-length ${contentLength} exceeds max ${maxBytes} bytes`,
    );
  }

  const contentType = res.headers.get("content-type");
  if (contentType && !contentType.startsWith("image/")) {
    throw new Error(
      `HttpAnimalImageSource(${providerName}): unexpected content-type "${contentType}"`,
    );
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > maxBytes) {
    throw new Error(
      `HttpAnimalImageSource(${providerName}): body size ${bytes.length} exceeds max ${maxBytes} bytes`,
    );
  }

  const mimeType = detectMimeType(bytes);
  if (!mimeType) {
    // Catches servers that lie in Content-Type (or omit it) and serve an
    // HTML error page or other non-image body with a 200 status.
    throw new Error(`HttpAnimalImageSource(${providerName}): response bytes are not a recognized image`);
  }

  return { bytes, mimeType };
}

function computeId(providerName: string, apiId: string | undefined, url: string, bytes: Buffer): string {
  if (apiId) return `${providerName}:${apiId}`;
  // cataas always resolves to the same bare URL regardless of which cat comes
  // back, so a URL-based id would collide on every fetch; hash the bytes
  // instead so recency de-duplication actually has something stable to key on.
  if (providerName === "cataas") {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    return `${providerName}:sha256-${hasher.digest("hex").slice(0, 16)}`;
  }
  return `${providerName}:${url}`;
}

export interface HttpAnimalImageSourceOptions {
  fetchImpl?: typeof fetch;
  random?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  sources?: AnimalProvider[];
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_ATTEMPTS = 3;

/** Fetches a real cat or dog image over HTTP from one of several public,
 * keyless APIs, picked at random. */
export class HttpAnimalImageSource implements AnimalImageSource {
  private readonly fetchImpl: typeof fetch;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly sources: AnimalProvider[];

  constructor(options: HttpAnimalImageSourceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.random = options.random ?? Math.random;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.sources = options.sources ?? DEFAULT_ANIMAL_PROVIDERS;
  }

  private pickProvider(): AnimalProvider {
    const idx = Math.min(this.sources.length - 1, Math.max(0, Math.floor(this.random() * this.sources.length)));
    return this.sources[idx]!;
  }

  async fetch(recentIds: string[] = []): Promise<AnimalImage> {
    const ctx: AnimalProviderContext = { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs };
    let lastImage: AnimalImage | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const provider = this.pickProvider();
      const resolved = await provider.resolve(ctx);
      const { bytes, mimeType } = await downloadImage(resolved.url, provider.name, ctx, this.maxBytes);
      const id = computeId(provider.name, resolved.id, resolved.url, bytes);
      const image: AnimalImage = { id, bytes, mimeType, name: `${provider.name}.${extFor(mimeType)}` };
      lastImage = image;

      // Recency avoidance is best effort and must never turn into a hard
      // failure: only a duplicate id triggers a re-loop, any real fetch
      // error propagates immediately. If every attempt collides, a repeated
      // cat beats no cat, so fall through and return the last successful fetch.
      if (!recentIds.includes(id)) return image;
    }

    return lastImage!;
  }
}

const DEFAULT_FAKE_IMAGE: AnimalImage = {
  id: "fake:1",
  bytes: Buffer.concat([PNG_SIGNATURE, Buffer.from([0, 0, 0, 0])]),
  mimeType: "image/png",
  name: "fake.png",
};

/** In-memory AnimalImageSource for tests. Hands out images from a fixed list
 * (cycling), or throws a fixed error if constructed with one. */
export class FakeAnimalImageSource implements AnimalImageSource {
  readonly calls: (string[] | undefined)[] = [];
  private index = 0;

  constructor(
    private readonly images?: AnimalImage[],
    private readonly error?: Error,
  ) {}

  async fetch(recentIds?: string[]): Promise<AnimalImage> {
    this.calls.push(recentIds);
    if (this.error) throw this.error;
    const images = this.images && this.images.length > 0 ? this.images : [DEFAULT_FAKE_IMAGE];
    const image = images[this.index % images.length]!;
    this.index++;
    return image;
  }
}
