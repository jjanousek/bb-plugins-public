// The faces: flat one-colour shapes with two white eye slits. A shape and a
// colour make one face; 10 shapes and 12 colours make 120.
//
// Pure module, shared by the server (which hands faces out and remembers
// them) and the app (which draws them). No Node or DOM imports.

export interface FaceShape {
  id: string;
  /** SVG body in a 100x100 viewBox. `FILL` is replaced with the colour. */
  body: string;
  /** Centre of the pair of eyes, and how far the pair leans. */
  eyes: { cx: number; cy: number; tilt: number };
}

export interface FaceColour {
  id: string;
  hex: string;
}

export interface Face {
  shape: string;
  colour: string;
}

/** What a thread is doing, as the face shows it. */
export type ThreadState = "running" | "waiting" | "idle";

export const COLOURS: readonly FaceColour[] = [
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

// Every outline is built from curves, so nothing reads as a sharp corner at
// 16px. The eyes sit in the lower half of the body.
export const SHAPES: readonly FaceShape[] = [
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

export const FACE_COUNT = SHAPES.length * COLOURS.length;

/** How a face is stored and sent: "egg/teal". */
export function faceKey(face: Face): string {
  return `${face.shape}/${face.colour}`;
}

/** The face a stored key names, or null when it names none. */
export function faceFromKey(key: string): Face | null {
  const parts = key.split("/");
  if (parts.length !== 2) return null;
  const [shape, colour] = parts as [string, string];
  return SHAPES.some((s) => s.id === shape) && COLOURS.some((c) => c.id === colour) ? { shape, colour } : null;
}

/**
 * A face as a person writes it: "teal egg", "egg teal" or "egg/teal", in any
 * case. Null when the words do not name exactly one shape and one colour.
 */
export function parseFace(input: string): Face | null {
  const words = input.trim().toLowerCase().split(/[\s/]+/).filter((word) => word !== "");
  if (words.length !== 2) return null;
  const shape = words.find((word) => SHAPES.some((s) => s.id === word));
  const colour = words.find((word) => COLOURS.some((c) => c.id === word));
  return shape !== undefined && colour !== undefined ? { shape, colour } : null;
}

/** "teal egg". */
export function faceName(face: Face): string {
  return `${face.colour} ${face.shape}`;
}

/** FNV-1a, 32 bit: the same number on the server and in the browser. */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function faceAt(index: number): Face {
  const i = ((index % FACE_COUNT) + FACE_COUNT) % FACE_COUNT;
  // Shapes change first, so neighbouring numbers differ in outline, which is
  // the easier of the two to tell apart at 16px.
  return { shape: SHAPES[i % SHAPES.length]!.id, colour: COLOURS[Math.floor(i / SHAPES.length)]!.id };
}

function indexOf(face: Face): number {
  const shape = SHAPES.findIndex((s) => s.id === face.shape);
  const colour = COLOURS.findIndex((c) => c.id === face.colour);
  return Math.max(shape, 0) + Math.max(colour, 0) * SHAPES.length;
}

/**
 * A thread's first face: the one its id hashes to, or the first one after it
 * that no other live thread has (`taken` holds their keys). With all 120 in
 * use it shares the hashed one rather than fail.
 */
export function pickFace(threadId: string, taken: ReadonlySet<string>): Face {
  const start = hashString(threadId) % FACE_COUNT;
  for (let step = 0; step < FACE_COUNT; step += 1) {
    const face = faceAt(start + step);
    if (!taken.has(faceKey(face))) return face;
  }
  return faceAt(start);
}

/**
 * Steps between one "New face" and the next. 11 shares no factor with 120, so
 * repeated steps visit every face once, and each step moves both the shape
 * and the colour on by one, so a new face never looks like the old one.
 */
const NEW_FACE_STEP = 11;

/** The face "New face" gives: the next one along that no other live thread has. */
export function nextFace(current: Face, taken: ReadonlySet<string>): Face {
  const start = indexOf(current);
  for (let n = 1; n <= FACE_COUNT; n += 1) {
    const face = faceAt(start + n * NEW_FACE_STEP);
    if (!taken.has(faceKey(face))) return face;
  }
  return current;
}

/**
 * The SVG markup inside a 100x100 viewBox. Cheeks only from 28px up; below
 * that they read as smudges.
 */
export function faceSvgInner(face: Face, size: number): string {
  const shape = SHAPES.find((s) => s.id === face.shape) ?? SHAPES[0]!;
  const hex = COLOURS.find((c) => c.id === face.colour)?.hex ?? COLOURS[0]!.hex;
  const { cx, cy, tilt } = shape.eyes;
  // Two white slits, 14 by 30 and 12 apart, each leaning 6 degrees inward at
  // the top; the pair then takes the shape's own lean.
  const eye = (x: number, lean: number) =>
    `<rect fill="#ffffff" x="${x - 7}" y="${cy - 15}" width="14" height="30" rx="7" transform="rotate(${lean} ${x} ${cy})"/>`;
  const cheek = (x: number) => `<ellipse fill="#ffffff" fill-opacity="0.45" cx="${x}" cy="${cy + 15}" rx="9" ry="5.5"/>`;
  const features =
    `<g transform="rotate(${tilt} ${cx} ${cy})">` +
    (size < 28 ? "" : cheek(cx - 19) + cheek(cx + 19)) +
    eye(cx - 13, 6) +
    eye(cx + 13, -6) +
    `</g>`;
  return shape.body.replaceAll("FILL", hex) + features;
}

/** A whole SVG document of a face, for the command line and for previews. */
export function faceSvg(face: Face, size = 256): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">${faceSvgInner(face, size)}</svg>`;
}

/** The six glyphs a running thread's face cycles through, 250ms each. */
export const BLOOM_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"] as const;
export const BLOOM_FRAME_MS = 250;
/** The one glyph shown instead when the system asks for reduced motion. */
export const BLOOM_STILL = "✳";

/** bb statuses that mean a turn is under way. */
const BUSY: Record<string, true> = { starting: true, active: true, provisioning: true, stopping: true };

/**
 * What a thread is doing, from what bb reports for it in the sidebar.
 * Waiting on the user outranks running, as it does in bb's own row glyph, and
 * a value bb adds later reads as idle.
 */
export function threadState(thread: {
  status: string;
  runtimeStatus: string;
  hasPendingInteraction: boolean;
  indicator: string;
}): ThreadState {
  if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input") return "waiting";
  if (BUSY[thread.runtimeStatus] === true || BUSY[thread.status] === true || thread.indicator === "runtime") return "running";
  return "idle";
}
