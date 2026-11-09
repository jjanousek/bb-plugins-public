// The arithmetic behind the Viewer's touch gestures and the Library's pull to
// refresh. Plain .ts with no React and no DOM, so every threshold here is a
// number a test can hold rather than a feel somebody has to remember.
//
// Coordinates: a point is measured from the centre of the stage, and the
// picture is drawn centred in it, so zoom and pan are one `translate(x, y)
// scale(s)` with the transform origin at the picture's centre. A point `p` of
// the picture (from its own centre) lands on screen at `t + s * p`.

// ---------- swipe between neighbours ----------

/** How far a finger has to travel sideways before a release moves to the neighbour. */
export const SWIPE_DISTANCE_PX = 40;
/** A flick this fast moves on even when it is shorter than the distance above. */
export const SWIPE_VELOCITY_PX_PER_MS = 0.3;
/** A flick still has to be a real movement, not a tap that slid a little. */
export const SWIPE_MIN_FLICK_PX = 12;
/** Movement before a gesture commits to one axis. Under it, it is still a tap. */
export const AXIS_SLOP_PX = 8;
/** Pulling towards a side with nothing there moves the picture this fraction of the finger. */
export const EDGE_RESISTANCE = 0.3;
/** How long the slide to the neighbour takes, and the snap back when it stays. */
export const SNAP_MS = 180;

export type Axis = "x" | "y" | null;

/** Which way a drag is going, once it has gone far enough to say. */
export function lockAxis(dx: number, dy: number, slop = AXIS_SLOP_PX): Axis {
  if (Math.hypot(dx, dy) < slop) return null;
  return Math.abs(dx) > Math.abs(dy) ? "x" : "y";
}

export interface SwipeInput {
  /** Finger travel since the gesture started, in CSS pixels. */
  dx: number;
  dy: number;
  /** How long the gesture took, in milliseconds. */
  ms: number;
  hasPrev: boolean;
  hasNext: boolean;
}

export type SwipeResult = "prev" | "next" | "stay";

/**
 * Where a released horizontal drag goes. A finger moving left pulls the next
 * picture in from the right, the way every photo viewer does it. A drag that
 * was more vertical than sideways is a scroll, never a swipe.
 */
export function swipeDecision({ dx, dy, ms, hasPrev, hasNext }: SwipeInput): SwipeResult {
  const distance = Math.abs(dx);
  if (distance <= Math.abs(dy)) return "stay";
  const velocity = distance / Math.max(1, ms);
  const far = distance >= SWIPE_DISTANCE_PX;
  const flick = velocity >= SWIPE_VELOCITY_PX_PER_MS && distance >= SWIPE_MIN_FLICK_PX;
  if (!far && !flick) return "stay";
  if (dx < 0) return hasNext ? "next" : "stay";
  return hasPrev ? "prev" : "stay";
}

/** How far the picture follows the finger: all the way, or a little towards an empty side. */
export function dragOffset(dx: number, hasPrev: boolean, hasNext: boolean): number {
  if ((dx > 0 && !hasPrev) || (dx < 0 && !hasNext)) return dx * EDGE_RESISTANCE;
  return dx;
}

// ---------- taps ----------

/** A second tap inside this window and this distance is a double tap. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP_PX = 24;
/** A press that moved less than this and lasted less than TAP_MAX_MS is a tap. */
export const TAP_SLOP_PX = 10;
export const TAP_MAX_MS = 500;

export interface Tap {
  at: number;
  x: number;
  y: number;
}

export function isTap(dx: number, dy: number, ms: number): boolean {
  return Math.hypot(dx, dy) < TAP_SLOP_PX && ms < TAP_MAX_MS;
}

export function isDoubleTap(previous: Tap | null, next: Tap): boolean {
  if (previous === null) return false;
  const gap = next.at - previous.at;
  return gap >= 0 && gap <= DOUBLE_TAP_MS && Math.hypot(next.x - previous.x, next.y - previous.y) <= DOUBLE_TAP_SLOP_PX;
}

// ---------- zoom and pan ----------

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
/** What a double tap zooms to. */
export const DOUBLE_TAP_ZOOM = 2.5;

export interface View {
  scale: number;
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export const IDENTITY: View = { scale: 1, x: 0, y: 0 };

export function isZoomed(view: View): boolean {
  return view.scale > 1.001;
}

export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Keep the picture over the stage: a zoomed picture may be dragged until one of
 * its edges meets the stage edge, and no further, and a side that is smaller
 * than the stage stays centred on it.
 */
export function clampPan(view: View, content: Size, stage: Size): View {
  const maxX = Math.max(0, (content.width * view.scale - stage.width) / 2);
  const maxY = Math.max(0, (content.height * view.scale - stage.height) / 2);
  return { scale: view.scale, x: clamp(view.x, -maxX, maxX) + 0, y: clamp(view.y, -maxY, maxY) + 0 };
}

/**
 * Zoom to `nextScale` keeping the picture point under `focal` (measured from
 * the stage centre) exactly where it is, then clamp. Back at 1x the picture is
 * simply centred again.
 */
export function zoomAt(view: View, nextScale: number, focal: Point, content: Size, stage: Size): View {
  const scale = clampZoom(nextScale);
  if (scale <= MIN_ZOOM) return IDENTITY;
  const px = (focal.x - view.x) / view.scale;
  const py = (focal.y - view.y) / view.scale;
  return clampPan({ scale, x: focal.x - scale * px, y: focal.y - scale * py }, content, stage);
}

/** A double tap: in to DOUBLE_TAP_ZOOM at the tapped point, or back out to 1x. */
export function toggleZoom(view: View, focal: Point, content: Size, stage: Size): View {
  return isZoomed(view) ? IDENTITY : zoomAt(view, DOUBLE_TAP_ZOOM, focal, content, stage);
}

/** One finger dragging a zoomed picture, from where the view was when the finger went down. */
export function panBy(start: View, dx: number, dy: number, content: Size, stage: Size): View {
  return clampPan({ scale: start.scale, x: start.x + dx, y: start.y + dy }, content, stage);
}

/**
 * Two fingers: the scale follows the change in their distance, and the picture
 * point that was under their starting midpoint follows the midpoint now, so a
 * pinch can pan and zoom in one movement.
 */
export function pinchTo(start: View, startDistance: number, distance: number, startMid: Point, mid: Point, content: Size, stage: Size): View {
  const scale = clampZoom((start.scale * distance) / Math.max(1, startDistance));
  if (scale <= MIN_ZOOM) return IDENTITY;
  const px = (startMid.x - start.x) / start.scale;
  const py = (startMid.y - start.y) / start.scale;
  return clampPan({ scale, x: mid.x - scale * px, y: mid.y - scale * py }, content, stage);
}

/** A ctrl or trackpad pinch wheel step: the scale grows exponentially with the wheel. */
export function wheelScale(scale: number, deltaY: number): number {
  return clampZoom(scale * Math.exp(-deltaY * 0.01));
}

// ---------- the video's own controls ----------

/** Rough height of a native video control bar. */
export const VIDEO_CONTROLS_PX = 52;

/**
 * True when a press lands on the native control bar of a video drawn centred on
 * the stage, so the scrubber keeps its drag and no swipe steals it. `y` is from
 * the top of the stage.
 */
export function onVideoControls(y: number, stageHeight: number, drawnHeight: number, controls = VIDEO_CONTROLS_PX): boolean {
  if (stageHeight <= 0 || drawnHeight <= 0) return false;
  const bottom = (stageHeight + Math.min(stageHeight, drawnHeight)) / 2;
  return y >= bottom - controls && y <= bottom;
}

// ---------- pull to refresh ----------

/** How far the Library's indicator moves for a finger pulled down past the top. */
export const PULL_MAX_PX = 96;
/** Where a release starts a refresh. */
export const PULL_TRIGGER_PX = 56;

export function pullDistance(dy: number): number {
  if (!Number.isFinite(dy) || dy <= 0) return 0;
  return Math.min(PULL_MAX_PX, dy * 0.5);
}

export function pullTriggers(dy: number): boolean {
  return pullDistance(dy) >= PULL_TRIGGER_PX;
}
