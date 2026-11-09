// Turn a Seedream pictogram (black ink on white) into a compact, normalized
// SVG path for the plugin's glyph set.
//
// Steps: grayscale, trim the white margin down to the ink bounding box,
// threshold hard, trace with potrace, scale the path into a 100 unit box and
// centre it in a square viewBox, so every glyph renders at the same optical
// size regardless of its aspect ratio.
//
// usage: node trace.mjs <name> <input.png> [outDir]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import potrace from "potrace";

const [, , name, input, outDirArg] = process.argv;
if (!name || !input) {
  console.error("usage: node trace.mjs <name> <input.png> [outDir]");
  process.exit(2);
}
const outDir = outDirArg ?? path.join(os.homedir(), ".cache", "asset-pipeline", "out");
fs.mkdirSync(outDir, { recursive: true });

const WORK = 1024; // trace resolution
const PAD = 0.1; // square padding around the ink, as a fraction of the ink box

const prepared = await sharp(input)
  .flatten({ background: "#ffffff" })
  .grayscale()
  .normalise()
  .threshold(170)
  .trim({ background: "#ffffff", threshold: 10 })
  .resize({ width: WORK, height: WORK, fit: "inside", kernel: "lanczos3", background: "#ffffff" })
  .extend({ top: 8, bottom: 8, left: 8, right: 8, background: "#ffffff" })
  .threshold(170)
  .png()
  .toBuffer();

const traced = await new Promise((resolve, reject) => {
  potrace.trace(
    prepared,
    {
      threshold: 128,
      turdSize: 60,
      alphaMax: 1,
      optCurve: true,
      optTolerance: 0.6,
      turnPolicy: potrace.Potrace.TURNPOLICY_MINORITY,
    },
    (err, svg) => (err ? reject(err) : resolve(svg)),
  );
});

const width = Number(/width="(\d+(?:\.\d+)?)"/.exec(traced)?.[1]);
const height = Number(/height="(\d+(?:\.\d+)?)"/.exec(traced)?.[1]);
const rawPath = /<path[^>]*\sd="([^"]+)"/.exec(traced)?.[1];
if (!rawPath || !Number.isFinite(width) || !Number.isFinite(height)) {
  console.error(`${name}: could not parse the traced svg`);
  process.exit(1);
}

// Scale every coordinate into a 100 unit box. A pure scale is safe for both
// absolute and relative path commands, so no path parser is needed.
const scale = 100 / Math.max(width, height);
const d = rawPath.replace(/-?\d+(?:\.\d+)?/g, (n) => {
  const v = Number(n) * scale;
  return String(Number(v.toFixed(1)));
});

const side = 100 * (1 + PAD * 2);
const minX = (-(side - width * scale) / 2).toFixed(1);
const minY = (-(side - height * scale) / 2).toFixed(1);
const viewBox = `${minX} ${minY} ${side.toFixed(1)} ${side.toFixed(1)}`;

// Ink coverage is a rough proxy for stroke weight: too low reads as spidery at
// 16px, too high as a blob.
const { data, info } = await sharp(prepared).raw().toBuffer({ resolveWithObject: true });
let ink = 0;
for (let i = 0; i < data.length; i += info.channels) if (data[i] < 128) ink += 1;
const coverage = ink / (info.width * info.height);

fs.writeFileSync(
  path.join(outDir, `${name}.json`),
  JSON.stringify({ name, viewBox, d, coverage: Number(coverage.toFixed(4)), bytes: d.length }),
);
fs.writeFileSync(
  path.join(outDir, `${name}.svg`),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><path d="${d}" fill="currentColor"/></svg>`,
);
console.log(JSON.stringify({ name, coverage: Number(coverage.toFixed(3)), bytes: d.length }));
