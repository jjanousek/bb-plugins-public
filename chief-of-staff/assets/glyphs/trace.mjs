// PNG (black pictogram on white) -> single-path 24x24 SVG. Usage: node trace.mjs in.png out.svg [threshold]
import sharp from "sharp";
import potrace from "potrace";
import { writeFileSync } from "node:fs";
const [, , input, output, thr = "160"] = process.argv;
const img = sharp(input).flatten({ background: "#ffffff" }).grayscale();
const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
// bounding box of dark pixels
let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
  if (data[y * info.width + x] < Number(thr)) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
}
if (maxX < 0) { console.error("no dark pixels"); process.exit(1); }
const w = maxX - minX + 1, h = maxY - minY + 1, side = Math.max(w, h);
const pad = Math.round(side * 0.06);
const size = side + pad * 2;
const left = Math.max(0, minX - pad - Math.floor((side - w) / 2));
const top = Math.max(0, minY - pad - Math.floor((side - h) / 2));
const square = await sharp(input).flatten({ background: "#ffffff" }).grayscale()
  .extract({ left, top, width: Math.min(size, info.width - left), height: Math.min(size, info.height - top) })
  .resize(512, 512, { fit: "contain", background: "#ffffff" })
  .threshold(Number(thr)).png().toBuffer();
potrace.trace(square, { threshold: 128, turdSize: 24, optTolerance: 0.3, alphaMax: 1.0 }, (err, svg) => {
  if (err) throw err;
  const d = [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]).join(" ");
  const scale = 24 / 512;
  const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><g transform="scale(${scale.toFixed(6)})"><path fill-rule="evenodd" d="${d}"/></g></svg>\n`;
  writeFileSync(output, out);
  console.log(output, out.length, "bytes; bbox", w, "x", h, "of", info.width);
});
