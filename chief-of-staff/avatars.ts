// Worker avatars: flat single-colour blob shapes with two white rounded eye
// slits, drawn in one consistent flat style.
//
// Pure module shared by server.ts (assignment, file export) and the app
// (inline rendering). No node imports here. A shape times a colour is one
// combination; the palette and the shape list give 120 of them. The first
// choice is a hash of "<project>:<name>", so the same worker always gets the
// same starting point, and the store walks forward from there to the first
// combination nobody else holds. Once assigned, a combination is stored and
// never recomputed, so an avatar is stable for the worker's whole life.

export interface AvatarShape {
  id: string;
  /** SVG body in a 100x100 viewBox. `FILL` is replaced with the colour. */
  body: string;
  /** Eye pair centre. */
  eyes: { cx: number; cy: number; tilt: number };
}

export interface AvatarColor {
  id: string;
  hex: string;
}

export interface Avatar {
  shape: string;
  color: string;
}

export const AVATAR_COLORS: readonly AvatarColor[] = [
  { id: "gray", hex: "#8e8e93" },
  { id: "blue", hex: "#5b9cf6" },
  { id: "orange", hex: "#f28c4a" },
  { id: "black", hex: "#3a3a3c" },
  { id: "green", hex: "#6cc48a" },
  { id: "brown", hex: "#a07c5a" },
  { id: "red", hex: "#ef6b6b" },
  { id: "yellow", hex: "#f2c03d" },
  { id: "purple", hex: "#a07cf0" },
  { id: "teal", hex: "#3fbfb0" },
  { id: "pink", hex: "#f27bb0" },
  { id: "navy", hex: "#5c74b8" },
];

// Every silhouette is built from arcs only, so nothing reads as a corner at
// 20px. Eye centres sit in the lower half of the body; `tilt` leans the pair
// a few degrees on some shapes, such as the cloud and the circle.
export const AVATAR_SHAPES: readonly AvatarShape[] = [
  {
    id: "teardrop",
    body: `<path fill="FILL" d="M50 8 C56 22 64 32 74 42 C90 58 84 90 50 92 C16 90 10 58 26 42 C36 32 44 22 50 8 Z"/>`,
    eyes: { cx: 50, cy: 64, tilt: 0 },
  },
  {
    id: "triangle",
    body: `<path fill="FILL" d="M50 12 C58 12 62 18 66 26 L88 66 C94 78 88 90 74 90 L26 90 C12 90 6 78 12 66 L34 26 C38 18 42 12 50 12 Z"/>`,
    eyes: { cx: 50, cy: 68, tilt: 0 },
  },
  {
    id: "cloud",
    body: `<path fill="FILL" d="M30 84 C16 84 10 72 16 62 C6 54 14 38 28 40 C30 24 50 16 62 28 C76 20 92 32 88 46 C98 54 92 70 80 70 C82 84 66 90 56 82 C48 90 36 90 30 84 Z"/>`,
    eyes: { cx: 52, cy: 58, tilt: -10 },
  },
  {
    id: "circle",
    body: `<circle fill="FILL" cx="50" cy="52" r="42"/>`,
    eyes: { cx: 50, cy: 56, tilt: 10 },
  },
  {
    id: "pill",
    body: `<rect fill="FILL" x="6" y="26" width="88" height="52" rx="26"/>`,
    eyes: { cx: 50, cy: 54, tilt: 0 },
  },
  {
    id: "splat",
    body: `<path fill="FILL" d="M46 10 C58 6 68 14 70 24 C84 22 94 34 88 46 C98 58 92 74 78 78 C78 92 60 96 50 86 C38 96 22 90 20 76 C6 74 4 56 16 48 C10 34 22 22 34 26 C36 16 40 12 46 10 Z"/>`,
    eyes: { cx: 51, cy: 56, tilt: 6 },
  },
  {
    id: "squircle",
    body: `<rect fill="FILL" x="10" y="10" width="80" height="82" rx="38"/>`,
    eyes: { cx: 50, cy: 56, tilt: 0 },
  },
  {
    id: "hexagon",
    body: `<path fill="FILL" stroke="FILL" stroke-width="22" stroke-linejoin="round" d="M50 20 L78 36 L78 66 L50 82 L22 66 L22 36 Z"/>`,
    eyes: { cx: 50, cy: 56, tilt: 0 },
  },
  {
    id: "egg",
    body: `<path fill="FILL" d="M50 8 C72 8 86 36 86 60 A36 36 0 0 1 14 60 C14 36 28 8 50 8 Z"/>`,
    eyes: { cx: 50, cy: 62, tilt: 0 },
  },
  {
    id: "bean",
    body: `<path fill="FILL" d="M32 12 C54 4 84 16 90 42 C96 68 74 94 48 92 C22 90 6 70 10 44 C14 28 22 16 32 12 Z"/>`,
    eyes: { cx: 50, cy: 54, tilt: -8 },
  },
];

export const AVATAR_COMBINATIONS = AVATAR_SHAPES.length * AVATAR_COLORS.length;

export function avatarKey(avatar: Avatar): string {
  return `${avatar.shape}/${avatar.color}`;
}

/** FNV-1a, 32 bit. Deterministic across server and browser. */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function combinationAt(index: number): Avatar {
  const wrapped = ((index % AVATAR_COMBINATIONS) + AVATAR_COMBINATIONS) % AVATAR_COMBINATIONS;
  // Step through shapes first so neighbouring hashes differ in silhouette,
  // which is the more visible of the two axes at 20px.
  const shape = AVATAR_SHAPES[wrapped % AVATAR_SHAPES.length];
  const color = AVATAR_COLORS[Math.floor(wrapped / AVATAR_SHAPES.length)];
  if (shape === undefined || color === undefined) throw new Error("avatar table out of range");
  return { shape: shape.id, color: color.id };
}

/**
 * The avatar for a worker: hash the seed, then take the first free
 * combination at or after that point. `taken` holds the keys already in use.
 * When all 120 are taken the hashed combination is returned regardless, so
 * the caller never fails; it just stops being unique past 120 live workers.
 */
export function pickAvatar(seed: string, taken: ReadonlySet<string>): Avatar {
  const start = hashString(seed) % AVATAR_COMBINATIONS;
  for (let offset = 0; offset < AVATAR_COMBINATIONS; offset += 1) {
    const candidate = combinationAt(start + offset);
    if (!taken.has(avatarKey(candidate))) return candidate;
  }
  return combinationAt(start);
}

export function isKnownAvatar(avatar: Avatar): boolean {
  return (
    AVATAR_SHAPES.some((shape) => shape.id === avatar.shape) &&
    AVATAR_COLORS.some((color) => color.id === avatar.color)
  );
}

export function avatarHex(colorId: string): string {
  return AVATAR_COLORS.find((color) => color.id === colorId)?.hex ?? AVATAR_COLORS[0]!.hex;
}

/** The SVG inner markup (body plus eyes and cheeks) for a 100x100 viewBox.
 * @param size the rendered CSS pixel size; undefined means full detail (the
 * 256px exports). Cheeks are omitted below 28px, where they read as smudges.
 */
export function avatarInner(avatar: Avatar, size?: number): string {
  const shape = AVATAR_SHAPES.find((s) => s.id === avatar.shape) ?? AVATAR_SHAPES[0]!;
  const hex = avatarHex(avatar.color);
  const { cx, cy, tilt } = shape.eyes;
  // Two white slits, 14 wide by 30 tall with a 12 gap, fully rounded. Each eye
  // leans 6 degrees inward at the top, which reads as a soft, attentive look;
  // the whole pair then takes the shape's own tilt.
  const eye = (x: number, lean: number) =>
    `<rect fill="#ffffff" x="${x - 7}" y="${cy - 15}" width="14" height="30" rx="7" transform="rotate(${lean} ${x} ${cy})"/>`;
  // Two soft cheeks just below and outside the eyes: white at low opacity so
  // they work on every fill, including black.
  const cheek = (x: number) =>
    `<ellipse fill="#ffffff" fill-opacity="0.45" cx="${x}" cy="${cy + 15}" rx="9" ry="5.5"/>`;
  const face =
    `<g transform="rotate(${tilt} ${cx} ${cy})">` +
    (size !== undefined && size < 28 ? "" : cheek(cx - 19) + cheek(cx + 19)) +
    eye(cx - 13, 6) +
    eye(cx + 13, -6) +
    `</g>`;
  return shape.body.replaceAll("FILL", hex) + face;
}

/** A complete standalone SVG document, transparent background. */
export function avatarSvg(avatar: Avatar, size = 256): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}">` +
    avatarInner(avatar) +
    `</svg>`
  );
}

// The display title for a worker name lives with the other pure naming
// helpers so the app, the server and the tests share one copy.
export { titleFor } from "./components/cos/naming";
