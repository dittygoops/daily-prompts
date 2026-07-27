export interface BackgroundImage {
  bytes: Buffer;
  mimeType: string;
}

/** Every temp directory this module creates is prefixed the same way so callers
 * (and tests) can find and count leftovers without the module exporting any
 * test-only internals. */
const TEMP_PREFIX = "daily-prompts-media-";

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function hasMagic(bytes: Buffer, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

/** PNG dimensions live in the IHDR chunk, which by spec is always the first
 * chunk immediately after the 8-byte signature: 4-byte length, 4-byte type
 * "IHDR", then width/height as big-endian uint32 at fixed offsets. Returns
 * null (never throws) on anything unexpected so the caller can fall back to
 * the safe conversion path instead of guessing. */
function readPngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/** JPEG has no fixed header layout: dimensions are inside a Start-Of-Frame
 * marker segment reached by walking variable-length segments from offset 2.
 * SOF markers are 0xFFC0-0xFFCF excluding 0xFFC4/C8/CC (those are DHT, JPG,
 * DAC, not frame headers). Bails to null (never throws or guesses) on any
 * malformed/truncated/unrecognized structure so the caller falls back to sips. */
function readJpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === undefined) return null;
    // Standalone markers with no length/payload (0xD0-0xD9 restart/SOI/EOI region).
    if (marker >= 0xd0 && marker <= 0xd9) {
      offset += 2;
      continue;
    }
    const segmentLength = bytes.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 > bytes.length) return null;
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }
    if (marker === 0xda) return null; // Start of Scan: no SOF found before entropy data
    offset += 2 + segmentLength;
  }
  return null;
}

interface DetectedImage {
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
}

/** Format + dimension detection used only for the pass-through optimization.
 * Any ambiguity here must resolve to null so callers fall through to the sips
 * path rather than risk shipping an oversized or wrongly-typed image. */
function detect(bytes: Buffer): DetectedImage | null {
  if (hasMagic(bytes, PNG_MAGIC)) {
    const dims = readPngDimensions(bytes);
    if (!dims) return null;
    return { mimeType: "image/png", ...dims };
  }
  if (hasMagic(bytes, JPEG_MAGIC)) {
    const dims = readJpegDimensions(bytes);
    if (!dims) return null;
    return { mimeType: "image/jpeg", ...dims };
  }
  return null;
}

/** Converts arbitrary input image bytes into a JPEG whose longest side is at
 * most maxDimension, using macOS `sips` (the only dependency-free HEIC-capable
 * converter available). Skips the sips round trip entirely when the input is
 * already a JPEG/PNG within bounds, since that's the common case (most photos
 * shared aren't HEIC) and sips is comparatively slow. */
export async function toBackgroundImage(
  bytes: Buffer,
  opts?: { maxDimension?: number },
): Promise<BackgroundImage> {
  if (bytes.length === 0) {
    throw new Error("toBackgroundImage: input bytes are empty, nothing to convert");
  }
  const maxDimension = opts?.maxDimension ?? 1600;

  const detected = detect(bytes);
  if (detected && detected.width <= maxDimension && detected.height <= maxDimension) {
    return { bytes, mimeType: detected.mimeType };
  }

  return convertWithSips(bytes, maxDimension, detected?.mimeType);
}

/** sips picks its decoder from the input file's extension, and unlike some
 * tools it does NOT sniff content when the extension is for a real, distinct
 * format: a genuine JPEG saved as ".heic" fails to decode ("Cannot extract
 * image from file"). So the extension must match the actual content type
 * when known (from detect()); the fallback to .heic covers the documented
 * use case (iPhone photos) and any other format sips can still sniff. */
function inputExtensionFor(mimeType: "image/jpeg" | "image/png" | undefined): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  return "heic";
}

async function convertWithSips(
  bytes: Buffer,
  maxDimension: number,
  sourceMimeType?: "image/jpeg" | "image/png",
): Promise<BackgroundImage> {
  const base = process.env.TMPDIR ?? "/tmp";
  const dir = `${base}/${TEMP_PREFIX}${crypto.randomUUID()}`;
  const inputPath = `${dir}/in.${inputExtensionFor(sourceMimeType)}`;
  const outputPath = `${dir}/out.jpg`;

  try {
    await Bun.$`mkdir -p ${dir}`.quiet();
    await Bun.write(inputPath, bytes);

    let exitCode: number;
    let stderr: string;
    try {
      const result = await Bun.$`sips -s format jpeg -Z ${maxDimension} ${inputPath} --out ${outputPath}`
        .quiet()
        .nothrow();
      exitCode = result.exitCode;
      stderr = result.stderr.toString().trim();
    } catch (err) {
      // Bun.$ can throw outright (e.g. spawn failure) rather than returning
      // a non-zero exit, most commonly when the sips binary itself is missing.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `toBackgroundImage: failed to invoke sips (is it installed at /usr/bin/sips?): ${message}`,
      );
    }

    if (exitCode !== 0) {
      const notFound = /command not found|no such file|enoent/i.test(stderr);
      if (notFound) {
        throw new Error(
          `toBackgroundImage: sips is unavailable on this machine (expected at /usr/bin/sips): ${stderr}`,
        );
      }
      throw new Error(`toBackgroundImage: sips conversion failed (exit ${exitCode}): ${stderr}`);
    }

    const outFile = Bun.file(outputPath);
    if (!(await outFile.exists())) {
      throw new Error("toBackgroundImage: sips exited successfully but produced no output file");
    }
    const outBytes = Buffer.from(await outFile.arrayBuffer());
    if (outBytes.length === 0) {
      throw new Error("toBackgroundImage: sips produced an empty output file");
    }
    if (!hasMagic(outBytes, JPEG_MAGIC)) {
      throw new Error("toBackgroundImage: sips output is missing JPEG magic bytes, conversion did not produce a valid JPEG");
    }

    return { bytes: outBytes, mimeType: "image/jpeg" };
  } finally {
    // Cleanup must never itself throw or mask whatever error (if any) is
    // already propagating out of the try block above.
    await Bun.$`rm -rf ${dir}`.quiet().nothrow();
  }
}
