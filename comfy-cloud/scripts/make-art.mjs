// Turn a generated Seedream drawing into a themeable alpha mask for the panel.
//
//   node scripts/make-art.mjs               build every piece into assets/art
//   node scripts/make-art.mjs mark no-key   build only the named pieces
//   node scripts/make-art.mjs --check       build, then write a preview PNG per piece
//                                           into qa/ for checking by eye
//
// Run by hand, never at build time. `sharp` is not a dependency of this plugin:
// install it yourself and set SHARP_FROM to the folder whose node_modules holds
// it (default: this plugin folder).
//
// The pipeline per piece: greyscale, normalise, trim the paper margin, invert
// luminance into an alpha channel (ink opaque, paper transparent), thicken the
// ink so a hairline still reads once the browser shrinks the mask into a
// 160 px box, resize the long edge to 512 px, write a white RGBA PNG whose
// only information is the alpha channel. The frontend paints it with
// background-color: currentColor, so one file serves light and dark.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(path.join(process.env.SHARP_FROM ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "node_modules", "/"));
const sharp = require("sharp");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "assets", "art");
const CHECK_DIR = path.join(ROOT, "qa");
const SOURCE_ROOT = process.env.COMFY_ART_SOURCES ?? path.join(os.homedir(), ".bb", "plugins", "comfy-cloud", "assets");

/** Long edge of the written mask. */
const MASTER_PX = 512;
/** The box the panel actually draws these in (size-40). Proofs are rendered at this size. */
const DISPLAY_PX = 160;

// Sources are images you generate with `bb comfy image` and pick by eye: dark
// line art on a white ground works best. The asset ids below are placeholders;
// put ids from your own library in their place.
// `ink` is the dilation radius in source pixels, `gain` the gamma applied to
// alpha after the resize (below 1 makes soft edges more solid).
const PIECES = [
  { name: "empty-library", asset: "img_art00001", ink: 5, gain: 0.62 },
  { name: "empty-search", asset: "img_art00002", ink: 4, gain: 0.62 },
  { name: "idle-jobs", asset: "img_art00003", ink: 4, gain: 0.6 },
  { name: "mark", asset: "img_art00004", ink: 0, gain: 1 },
  { name: "no-key", asset: "img_art00005", ink: 5, gain: 0.62 },
];

// Levels for the inverted luminance, in 0-255. The generator leaves a faint
// paper texture (a near-white grey, so a few levels of alpha); PAPER_FLOOR drops it
// and INK_FULL makes anything close to a drawn stroke solid, which keeps the
// dilation from smearing the texture into a grey fog.
const PAPER_FLOOR = 20;
const INK_FULL = 140;
/** Trim tolerance against pure white, in 0-255. */
const TRIM_THRESHOLD = 12;

/** Absolute path of a generated asset, found under <assets>/<date>/<id>.png. */
function findSource(assetId) {
  const dates = fs.existsSync(SOURCE_ROOT) ? fs.readdirSync(SOURCE_ROOT).sort().reverse() : [];
  for (const date of dates) {
    const file = path.join(SOURCE_ROOT, date, `${assetId}.png`);
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`source ${assetId}.png not found under ${SOURCE_ROOT}; run 'bb comfy show ${assetId}' to see where it went`);
}

/** Grow the ink by `r` pixels with a separable max filter, so hairlines survive the downscale. */
function dilate(alpha, width, height, r) {
  if (r <= 0) return alpha;
  const wide = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const from = x - r < 0 ? 0 : x - r;
      const to = x + r >= width ? width - 1 : x + r;
      let max = 0;
      for (let i = from; i <= to; i += 1) if (alpha[row + i] > max) max = alpha[row + i];
      wide[row + x] = max;
    }
  }
  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      const from = y - r < 0 ? 0 : y - r;
      const to = y + r >= height ? height - 1 : y + r;
      let max = 0;
      for (let j = from; j <= to; j += 1) if (wide[j * width + x] > max) max = wide[j * width + x];
      out[y * width + x] = max;
    }
  }
  return out;
}

/** Invert luminance into alpha: 255 for ink, 0 for paper, with the levels above applied. */
function inkAlpha(grey, stride, pixels) {
  const alpha = new Uint8Array(pixels);
  const span = INK_FULL - PAPER_FLOOR;
  for (let i = 0; i < pixels; i += 1) {
    const v = 255 - grey[i * stride] - PAPER_FLOOR;
    alpha[i] = v <= 0 ? 0 : v >= span ? 255 : Math.round((v * 255) / span);
  }
  return alpha;
}

async function build(piece) {
  const source = findSource(piece.asset);
  // sharp reorders operations internally, so normalise-then-trim needs two passes
  // to be sure the trim sees the normalised greyscale and not the original pixels.
  // normalise() defaults to the 1st and 99th percentile, and these drawings are
  // 99 percent paper, so the default stretches the paper texture across the whole
  // range. Full range endpoints keep paper at paper and ink at ink.
  const flat = await sharp(source).greyscale().normalise({ lower: 0, upper: 100 }).png().toBuffer();
  const trimmed = await sharp(flat)
    .trim({ background: "#ffffff", threshold: TRIM_THRESHOLD })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = trimmed.info;
  // greyscale() leaves an sRGB grey (3 channels) in a PNG round trip, so read the first channel.
  const alpha = dilate(inkAlpha(trimmed.data, channels, width * height), width, height, piece.ink);
  const rgba = Buffer.alloc(width * height * 4, 0xff);
  for (let i = 0; i < alpha.length; i += 1) rgba[i * 4 + 3] = alpha[i];

  const long = Math.max(width, height);
  const scale = MASTER_PX / long;
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const small = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .resize({ width: outW, height: outH, fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer();
  // The downscale averages ink with paper; the gamma pulls those middle values
  // back up so a one pixel line still looks like a line and not a smudge. The
  // colour channels carry no information (the caller paints the mask with
  // currentColor), so force them back to white: it compresses better and a
  // renderer that reads the mask as luminance instead of alpha still works.
  for (let i = 0; i < small.length; i += 4) {
    small[i] = 0xff;
    small[i + 1] = 0xff;
    small[i + 2] = 0xff;
    if (piece.gain !== 1) small[i + 3] = Math.round(255 * (small[i + 3] / 255) ** piece.gain);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${piece.name}.png`);
  await sharp(small, { raw: { width: outW, height: outH, channels: 4 } })
    .png({ compressionLevel: 9, palette: false })
    .toFile(out);

  let ink = 0;
  for (let i = 3; i < small.length; i += 4) if (small[i] > 128) ink += 1;
  const coverage = (ink / (outW * outH)) * 100;
  const bytes = fs.statSync(out).size;
  console.log(
    `${piece.name.padEnd(14)} ${path.basename(source).padEnd(17)} source ${width}x${height} -> ${outW}x${outH}  ` +
      `ink ${coverage.toFixed(1)}%  ${(bytes / 1024).toFixed(0)} KB`,
  );
  if (bytes > 60 * 1024) console.warn(`  warning: ${piece.name}.png is ${(bytes / 1024).toFixed(0)} KB, over the 60 KB budget`);
  return out;
}

/** Paint the mask in `ink` over `paper` at `box` pixels, the way the panel will. */
async function panel(file, paper, ink, box) {
  const { data, info } = await sharp(file)
    .resize({ width: box, height: box, fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const painted = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i += 1) {
    painted[i * 4] = ink[0];
    painted[i * 4 + 1] = ink[1];
    painted[i * 4 + 2] = ink[2];
    painted[i * 4 + 3] = data[i * info.channels + 3];
  }
  return sharp({ create: { width: DISPLAY_PX + 32, height: DISPLAY_PX + 32, channels: 4, background: { r: paper[0], g: paper[1], b: paper[2], alpha: 1 } } })
    .composite([{ input: painted, raw: { width: info.width, height: info.height, channels: 4 }, gravity: "centre" }])
    .png()
    .toBuffer();
}

/**
 * A preview per piece: the mask painted at every size the panel uses (160, 112
 * and 80 px boxes), light row over mid grey, dark row over near black. A mask
 * that reads at 160 px can vanish at 80 px, so the small sizes are on the sheet too.
 */
async function check(name) {
  const file = path.join(OUT_DIR, `${name}.png`);
  const sizes = [DISPLAY_PX, 112, 80];
  const box = DISPLAY_PX + 32;
  const tiles = [];
  for (const [column, size] of sizes.entries()) {
    tiles.push({ input: await panel(file, [0xd4, 0xd4, 0xd8], [0x3f, 0x3f, 0x46], size), left: column * box, top: 0 });
    tiles.push({ input: await panel(file, [0x0a, 0x0a, 0x0b], [0xd4, 0xd4, 0xd8], size), left: column * box, top: box });
  }
  fs.mkdirSync(CHECK_DIR, { recursive: true });
  const out = path.join(CHECK_DIR, `art-check-${name}.png`);
  await sharp({ create: { width: box * sizes.length, height: box * 2, channels: 4, background: { r: 0x88, g: 0x88, b: 0x88, alpha: 1 } } })
    .composite(tiles)
    .png()
    .toFile(out);
  console.log(`proof ${out}`);
}

const args = process.argv.slice(2);
const wantCheck = args.includes("--check");
const names = args.filter((a) => !a.startsWith("--"));
const chosen = names.length === 0 ? PIECES : PIECES.filter((p) => names.includes(p.name));
if (chosen.length === 0) {
  console.error(`no such piece. known: ${PIECES.map((p) => p.name).join(", ")}`);
  process.exit(2);
}
for (const piece of chosen) {
  await build(piece);
  if (wantCheck) await check(piece.name);
}
