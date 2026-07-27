import { test, expect, describe, afterAll } from "bun:test";
import { toBackgroundImage } from "../../src/media/convert";

/** sips is a hard requirement for the whole conversion path and for building
 * fixtures (HEIC derivation, pixel-dimension verification). If it's missing
 * on this machine, every test that depends on it must skip loudly rather
 * than silently pass, so a missing binary reads as "not run" not "green".
 * Resolved at module load (not in beforeAll) because test.skipIf needs the
 * answer at registration time, which is what produces a real "skipped" count. */
const sipsAvailable = await Bun.file("/usr/bin/sips").exists();
if (!sipsAvailable) {
  console.error(
    "SKIPPING media/convert tests: /usr/bin/sips not found on this machine. " +
      "These tests require macOS sips and cannot verify conversion behavior without it.",
  );
}
const sipsTest = test.skipIf(!sipsAvailable);

const testTmpFiles: string[] = [];

afterAll(async () => {
  for (const path of testTmpFiles) {
    await Bun.$`rm -f ${path}`.quiet().nothrow();
  }
});

// ---- CRC32 (needed for valid PNG chunks) ----
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i]!;
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(buf: Uint8Array): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]!) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/** Bun.deflateSync emits raw DEFLATE (RFC 1951), not zlib (RFC 1950): the
 * output starts with 0x63/... rather than the zlib 0x78 header, and has no
 * Adler-32 trailer. PNG's IDAT stream requires the zlib wrapper specifically,
 * so it has to be built by hand: a 2-byte zlib header plus the deflate bytes
 * plus a big-endian Adler-32 of the *uncompressed* data. Skipping this
 * produces a PNG whose IHDR (and therefore pixel dimensions) reads fine but
 * whose pixel data is corrupt, confirmed against this repo by feeding an
 * unwrapped version through `sips`, which silently produced a truncated,
 * dimension-less JPEG. */
function zlibWrap(raw: Uint8Array): Uint8Array {
  const deflated = Bun.deflateSync(new Uint8Array(raw));
  const header = Buffer.from([0x78, 0x9c]);
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE(adler32(raw), 0);
  return Buffer.concat([header, Buffer.from(deflated), trailer]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(typeBytes), Buffer.from(data)]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([lenBuf, body, crcBuf]);
}

/** Builds a minimal but genuinely valid 8-bit RGB PNG (color type 2) at
 * arbitrary dimensions: one zero filter byte per scanline (filter "None"),
 * raw pixel bytes, deflated with Bun.deflateSync (zlib wrapper, which is
 * exactly what the PNG IDAT stream requires). */
function makePng(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: RGB
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = chunk("IHDR", ihdrData);

  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const off = rowStart + 1 + x * 3;
      raw[off] = (x * 255) / Math.max(1, width - 1);
      raw[off + 1] = (y * 255) / Math.max(1, height - 1);
      raw[off + 2] = 128;
    }
  }
  const compressed = zlibWrap(raw);
  const idat = chunk("IDAT", compressed);

  const iend = chunk("IEND", new Uint8Array(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

async function pixelDims(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  const path = `${process.env.TMPDIR ?? "/tmp"}/daily-prompts-test-${crypto.randomUUID()}`;
  testTmpFiles.push(path);
  await Bun.write(path, bytes);
  const result = await Bun.$`sips -g pixelWidth -g pixelHeight ${path}`.quiet();
  const out = result.stdout.toString();
  const widthMatch = out.match(/pixelWidth:\s*(\d+)/);
  const heightMatch = out.match(/pixelHeight:\s*(\d+)/);
  if (!widthMatch || !heightMatch) throw new Error(`could not parse sips output: ${out}`);
  return { width: Number(widthMatch[1]), height: Number(heightMatch[1]) };
}

async function tempDirCount(): Promise<number> {
  const base = process.env.TMPDIR ?? "/tmp";
  const result = await Bun.$`sh -c ${`ls -1 ${base} 2>/dev/null | grep -c '^daily-prompts-media-' || true`}`
    .quiet()
    .nothrow();
  const n = Number(result.stdout.toString().trim());
  return Number.isFinite(n) ? n : 0;
}

describe("toBackgroundImage", () => {
  sipsTest("sanity: generated PNG is genuinely valid (readable and decodable by sips)", async () => {
    const png = makePng(100, 50);
    const dims = await pixelDims(png);
    expect(dims).toEqual({ width: 100, height: 50 });

    // Dimensions alone only prove the IHDR header parses; they don't prove
    // the pixel data (IDAT) decodes. Round-tripping through a real format
    // conversion forces sips to actually decode every pixel, which a merely
    // header-valid-but-corrupt PNG would fail (this caught a real bug: an
    // earlier version of this fixture used unwrapped raw DEFLATE instead of
    // zlib-wrapped DEFLATE and produced a PNG that reported correct
    // dimensions but silently failed to convert to JPEG).
    const pngPath = `${process.env.TMPDIR ?? "/tmp"}/daily-prompts-test-${crypto.randomUUID()}.png`;
    const jpgPath = `${process.env.TMPDIR ?? "/tmp"}/daily-prompts-test-${crypto.randomUUID()}.jpg`;
    testTmpFiles.push(pngPath, jpgPath);
    await Bun.write(pngPath, png);
    const conv = await Bun.$`sips -s format jpeg ${pngPath} --out ${jpgPath}`.quiet().nothrow();
    expect(conv.exitCode).toBe(0);
    const result = await Bun.$`sips -g pixelWidth -g pixelHeight ${jpgPath}`.quiet();
    const out = result.stdout.toString();
    const w = out.match(/pixelWidth:\s*(\d+)/);
    const h = out.match(/pixelHeight:\s*(\d+)/);
    if (!w || !h) throw new Error(`could not parse sips output: ${out}`);
    expect({ width: Number(w[1]), height: Number(h[1]) }).toEqual({ width: 100, height: 50 });
  });

  sipsTest("a. oversized PNG is converted, resized, and re-encoded as JPEG", async () => {
    const png = makePng(2000, 1200);
    const result = await toBackgroundImage(png);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.bytes[0]).toBe(0xff);
    expect(result.bytes[1]).toBe(0xd8);
    expect(result.bytes[2]).toBe(0xff);
    const dims = await pixelDims(result.bytes);
    expect(dims).toEqual({ width: 1600, height: 960 });
  });

  sipsTest("b. custom maxDimension is honoured", async () => {
    const png = makePng(2000, 1200);
    const result = await toBackgroundImage(png, { maxDimension: 400 });
    expect(result.mimeType).toBe("image/jpeg");
    const dims = await pixelDims(result.bytes);
    expect(dims.width).toBe(400);
    expect(dims.height).toBe(240);
  });

  sipsTest("c. HEIC input converts to valid JPEG", async () => {
    const png = makePng(300, 200);
    const pngPath = `${process.env.TMPDIR ?? "/tmp"}/daily-prompts-test-${crypto.randomUUID()}.png`;
    const heicPath = `${process.env.TMPDIR ?? "/tmp"}/daily-prompts-test-${crypto.randomUUID()}.heic`;
    testTmpFiles.push(pngPath, heicPath);
    await Bun.write(pngPath, png);
    const conv = await Bun.$`sips -s format heic ${pngPath} --out ${heicPath}`.quiet().nothrow();
    if (conv.exitCode !== 0 || !(await Bun.file(heicPath).exists())) {
      console.warn("SKIPPING HEIC test: this machine's sips cannot write HEIC output.");
      return;
    }
    const heicBytes = Buffer.from(await Bun.file(heicPath).arrayBuffer());
    const result = await toBackgroundImage(heicBytes);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.bytes[0]).toBe(0xff);
    expect(result.bytes[1]).toBe(0xd8);
    expect(result.bytes[2]).toBe(0xff);
  });

  sipsTest("d. small PNG within limits is returned byte-identical, no re-encode", async () => {
    const png = makePng(100, 50);
    const result = await toBackgroundImage(png);
    expect(result.mimeType).toBe("image/png");
    expect(Buffer.compare(result.bytes, png)).toBe(0);
  });

  sipsTest("e. small JPEG within limits is returned byte-identical, no re-encode", async () => {
    const png = makePng(100, 50);
    const pngPath = `${process.env.TMPDIR ?? "/tmp"}/daily-prompts-test-${crypto.randomUUID()}.png`;
    const jpgPath = `${process.env.TMPDIR ?? "/tmp"}/daily-prompts-test-${crypto.randomUUID()}.jpg`;
    testTmpFiles.push(pngPath, jpgPath);
    await Bun.write(pngPath, png);
    const conv = await Bun.$`sips -s format jpeg ${pngPath} --out ${jpgPath}`.quiet().nothrow();
    expect(conv.exitCode).toBe(0);
    const jpgBytes = Buffer.from(await Bun.file(jpgPath).arrayBuffer());

    const result = await toBackgroundImage(jpgBytes);
    expect(result.mimeType).toBe("image/jpeg");
    expect(Buffer.compare(result.bytes, jpgBytes)).toBe(0);
  });

  sipsTest("f. JPEG larger than maxDimension is re-encoded and shrunk", async () => {
    const png = makePng(2000, 1200);
    const pngPath = `${process.env.TMPDIR ?? "/tmp"}/daily-prompts-test-${crypto.randomUUID()}.png`;
    const jpgPath = `${process.env.TMPDIR ?? "/tmp"}/daily-prompts-test-${crypto.randomUUID()}.jpg`;
    testTmpFiles.push(pngPath, jpgPath);
    await Bun.write(pngPath, png);
    const conv = await Bun.$`sips -s format jpeg ${pngPath} --out ${jpgPath}`.quiet().nothrow();
    expect(conv.exitCode).toBe(0);
    const jpgBytes = Buffer.from(await Bun.file(jpgPath).arrayBuffer());

    const result = await toBackgroundImage(jpgBytes);
    expect(result.mimeType).toBe("image/jpeg");
    expect(Buffer.compare(result.bytes, jpgBytes)).not.toBe(0);
    const dims = await pixelDims(result.bytes);
    expect(dims).toEqual({ width: 1600, height: 960 });
  });

  sipsTest("g. garbage bytes reject with a clear error", async () => {
    const garbage = Buffer.from("this is not an image, just text bytes padded out a bit more");
    await expect(toBackgroundImage(garbage)).rejects.toThrow(/sips conversion failed/);
  });

  sipsTest("h. empty input rejects", async () => {
    await expect(toBackgroundImage(Buffer.alloc(0))).rejects.toThrow(/input bytes are empty/);
  });

  sipsTest("i. temp directories are cleaned up on success and on failure", async () => {
    const before = await tempDirCount();

    const png = makePng(2000, 1200);
    await toBackgroundImage(png);

    const garbage = Buffer.from("not an image, definitely not, padded out further still");
    await toBackgroundImage(garbage).catch(() => {});

    const after = await tempDirCount();
    expect(after).toBe(before);
  });
});
