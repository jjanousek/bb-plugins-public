// The plugin mark, computed from geometry rather than drawn by hand or taken
// from an icon set. Run by hand, never at build time:
//
//   node scripts/make-icon.mjs            write assets/icon.svg from MARK
//   node scripts/make-icon.mjs -          print the shipped mark
//   node scripts/make-icon.mjs <name>     print one alternative shape
//   node scripts/make-icon.mjs --all      write every shape as an SVG into
//                                         qa/marks/ (created if missing), to
//                                         compare them side by side by eye
//
// bb draws the mark as a CSS mask at 16 px in the sidebar row and the panel
// header, so only the silhouette survives: filled shapes in a 24x24 box, no
// strokes, nothing that needs colour.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The shape that ships. */
export const MARK = "notch";

const f = (v) => {
  const s = v.toFixed(2).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};
const sub = (p, q) => [p[0] - q[0], p[1] - q[1]];
const add = (p, q) => [p[0] + q[0], p[1] + q[1]];
const mul = (p, s) => [p[0] * s, p[1] * s];
const len = (p) => Math.hypot(p[0], p[1]);
const unit = (p) => mul(p, 1 / len(p));
/** A closed polygon with every corner rounded to at most `r`, which may be one
 * number or one per point, so a shape can be flush on one side and round on the
 * other. */
function poly(points, r) {
  const n = points.length;
  let d = "";
  for (let i = 0; i < n; i += 1) {
    const p = points[(i - 1 + n) % n];
    const c = points[i];
    const q = points[(i + 1) % n];
    const back = sub(p, c);
    const fwd = sub(q, c);
    const lim = Math.min(Array.isArray(r) ? r[i] : r, len(back) / 2, len(fwd) / 2);
    const a = add(c, mul(unit(back), lim));
    const b = add(c, mul(unit(fwd), lim));
    const cross = (c[0] - p[0]) * (q[1] - c[1]) - (c[1] - p[1]) * (q[0] - c[0]);
    d += `${i === 0 ? "M" : "L"}${f(a[0])} ${f(a[1])}`;
    if (lim > 0.005) d += `A${f(lim)} ${f(lim)} 0 0 ${cross > 0 ? 1 : 0} ${f(b[0])} ${f(b[1])}`;
  }
  return `${d}Z`;
}

const rect = (x, y, w, h, r) => poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], r);
const dot = (cx, cy, r) =>
  `M${f(cx - r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 0 ${f(cx + r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 0 ${f(cx - r)} ${f(cy)}Z`;

/**
 * The shipped mark and a few alternative shapes, each returning paths.
 * `rule: "evenodd"` is a shape with a hole; the subpaths of a plain path may
 * overlap freely, which is how a wire joins a dot.
 */
export const CANDIDATES = {
  // The shipped mark. A node block plugged into the left edge of a picture
  // frame: the graph on one side, what it makes on the other. Everything is one
  // weight, the band is 3.2 units (2.1 px at 16) and the hole 9.6 by 12 (6.4 by
  // 8 px), which keeps both legible in a 16 px mask. The band is cut away
  // exactly behind the block, and the block's right corners are square, so the
  // two shapes meet flush instead of leaving nicks.
  notch: () => [
    {
      d: `${rect(6.4, 2.8, 16, 18.4, 3.5)} ${rect(9.6, 6, 9.6, 12, 1.5)} ${rect(6.4, 9.2, 3.2, 5.6, 0)}`,
      rule: "evenodd",
    },
    { d: poly([[1.8, 9.2], [9.6, 9.2], [9.6, 14.8], [1.8, 14.8]], [1.7, 0, 0, 1.7]) },
  ],

  // A node dot on a straight link into a frame.
  feed: () => [
    { d: `${rect(9, 5.4, 13, 13.2, 3)} ${rect(11.6, 8, 7.8, 8, 1.3)}`, rule: "evenodd" },
    { d: `${rect(5.8, 10.9, 4.4, 2.2, 1.1)} ${dot(3.9, 12, 2.4)}` },
  ],

  // A node in the corner, its link elbowing into the frame.
  elbow: () => [
    { d: `${rect(8.6, 8.6, 13.9, 13.9, 3.2)} ${rect(11.3, 11.3, 8.5, 8.5, 1.4)}`, rule: "evenodd" },
    {
      d: `${poly([[3, 4.2], [5.4, 4.2], [5.4, 14.35], [9.4, 14.35], [9.4, 16.75], [3, 16.75]], 1.15)} ${dot(4.2, 4.2, 2.7)}`,
    },
  ],

  // A node block on a diagonal cable.
  wire: () => [
    { d: `${rect(9.4, 9.4, 12.6, 12.6, 3)} ${rect(12.4, 12.4, 6.6, 6.6, 1.2)}`, rule: "evenodd" },
    {
      d: `${rect(2.6, 2.6, 5.6, 5.6, 1.6)} ${poly([[5.14, 7.26], [10.34, 12.46], [12.46, 10.34], [7.26, 5.14]], 0.6)}`,
    },
  ],

  // One frame cut in half and slid apart.
  offset: () => [
    {
      d: [
        poly([[2.6, 2.6], [16.6, 2.6], [16.6, 5], [5, 5], [5, 16.6], [2.6, 16.6]], 1.1),
        poly([[21.4, 21.4], [7.4, 21.4], [7.4, 19], [19, 19], [19, 7.4], [21.4, 7.4]], 1.1),
      ].join(" "),
    },
  ],

  // A three blade iris.
  iris: () => {
    const R = 9.55;
    const APERTURE = 5.7;
    const SEAM = 1.9;
    const at = (deg, r) => [12 + r * Math.cos((deg * Math.PI) / 180), 12 - r * Math.sin((deg * Math.PI) / 180)];
    const toRim = (P, d) => {
      const v = sub(P, [12, 12]);
      const b = v[0] * d[0] + v[1] * d[1];
      return -b + Math.sqrt(b * b - (v[0] * v[0] + v[1] * v[1] - R * R));
    };
    const V = [at(90, APERTURE), at(210, APERTURE), at(330, APERTURE)];
    const hole = [];
    for (let k = 0; k < 3; k += 1) {
      const A = V[k];
      const B = V[(k + 1) % 3];
      const third = V[(k + 2) % 3];
      const d = unit(sub(B, A));
      let n = [-d[1], d[0]];
      if ((third[0] - A[0]) * n[0] + (third[1] - A[1]) * n[1] < 0) n = [d[1], -d[0]];
      const E = add(B, mul(d, toRim(B, d)));
      hole.push(E, add(E, mul(n, SEAM)), add(B, mul(n, SEAM)));
    }
    return [
      {
        d: `${dot(12, 12, R)} M${hole.map((p) => `${f(p[0])} ${f(p[1])}`).join(" L")} Z`,
        rule: "evenodd",
      },
    ];
  },
};

export function svgFor(name) {
  const build = CANDIDATES[name];
  if (!build) throw new Error(`unknown mark ${name}; have ${Object.keys(CANDIDATES).join(", ")}`);
  const paths = build()
    .map((p) => `<path${p.rule === "evenodd" ? ' fill-rule="evenodd"' : ""} d="${p.d}"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">${paths}</svg>`;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = process.argv[2];
if (import.meta.url === `file://${process.argv[1]}`) {
  if (arg === "--all") {
    const dir = path.join(here, "..", "qa", "marks");
    fs.mkdirSync(dir, { recursive: true });
    for (const name of Object.keys(CANDIDATES)) {
      fs.writeFileSync(path.join(dir, `${name}.svg`), `${svgFor(name)}\n`);
    }
    console.log(`${dir} ${Object.keys(CANDIDATES).length} candidates`);
  } else if (arg && arg !== "-") {
    console.log(svgFor(arg));
  } else {
    const svg = svgFor(MARK);
    if (arg === "-") {
      console.log(svg);
    } else {
      const out = path.join(here, "..", "assets", "icon.svg");
      fs.writeFileSync(out, `${svg}\n`);
      console.log(`${out} ${MARK} ${svg.length} bytes`);
    }
  }
}
