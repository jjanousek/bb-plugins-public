// The Viewer's touch arithmetic: when a drag becomes a swipe, how far zoom goes
// and where it centres, and how far a zoomed picture may be dragged. Held as
// numbers because a gesture that feels wrong is otherwise only ever caught by
// a thumb, and nobody has one on a phone while tests run.
import { describe, expect, it } from "vitest";
import {
  DOUBLE_TAP_ZOOM,
  EDGE_RESISTANCE,
  IDENTITY,
  MAX_ZOOM,
  SWIPE_DISTANCE_PX,
  clampPan,
  clampZoom,
  dragOffset,
  isDoubleTap,
  isTap,
  isZoomed,
  lockAxis,
  onVideoControls,
  panBy,
  pinchTo,
  pullDistance,
  pullTriggers,
  swipeDecision,
  toggleZoom,
  wheelScale,
  zoomAt,
} from "../components/comfy/gestures";

const STAGE = { width: 390, height: 390 };
const SQUARE = { width: 390, height: 390 };

describe("swipe between neighbours", () => {
  const both = { hasPrev: true, hasNext: true };

  it("moves on once the finger has travelled 40 px, and not before", () => {
    // Slow on purpose, so only the distance can decide.
    expect(swipeDecision({ dx: -(SWIPE_DISTANCE_PX - 1), dy: 0, ms: 800, ...both })).toBe("stay");
    expect(swipeDecision({ dx: -SWIPE_DISTANCE_PX, dy: 0, ms: 800, ...both })).toBe("next");
    expect(swipeDecision({ dx: SWIPE_DISTANCE_PX, dy: 0, ms: 800, ...both })).toBe("prev");
  });

  it("takes a short fast flick, but not a tap that slid", () => {
    // 30 px in 60 ms is 0.5 px per ms: a flick.
    expect(swipeDecision({ dx: -30, dy: 2, ms: 60, ...both })).toBe("next");
    // 8 px in 10 ms is fast, but a finger lands that sloppily on a plain tap.
    expect(swipeDecision({ dx: -8, dy: 0, ms: 10, ...both })).toBe("stay");
    // The same 30 px spread over a second is somebody changing their mind.
    expect(swipeDecision({ dx: -30, dy: 0, ms: 1000, ...both })).toBe("stay");
  });

  it("never swipes a drag that went more down than across, which is a scroll", () => {
    expect(swipeDecision({ dx: -60, dy: 80, ms: 200, ...both })).toBe("stay");
  });

  it("stays when there is nothing on that side", () => {
    expect(swipeDecision({ dx: -120, dy: 0, ms: 200, hasPrev: true, hasNext: false })).toBe("stay");
    expect(swipeDecision({ dx: 120, dy: 0, ms: 200, hasPrev: false, hasNext: true })).toBe("stay");
  });

  it("follows the finger, and only reluctantly towards an empty side", () => {
    expect(dragOffset(-100, true, true)).toBe(-100);
    expect(dragOffset(-100, true, false)).toBeCloseTo(-100 * EDGE_RESISTANCE);
    expect(dragOffset(100, false, true)).toBeCloseTo(100 * EDGE_RESISTANCE);
  });

  it("commits to an axis only after a few pixels", () => {
    expect(lockAxis(3, 4)).toBe(null);
    expect(lockAxis(12, 3)).toBe("x");
    expect(lockAxis(3, 12)).toBe("y");
  });
});

describe("taps", () => {
  it("tells a tap from a drag and a double tap from two taps", () => {
    expect(isTap(3, 4, 120)).toBe(true);
    expect(isTap(12, 0, 120)).toBe(false);
    expect(isTap(0, 0, 900)).toBe(false);
    const first = { at: 1000, x: 100, y: 100 };
    expect(isDoubleTap(null, first)).toBe(false);
    expect(isDoubleTap(first, { at: 1250, x: 110, y: 104 })).toBe(true);
    expect(isDoubleTap(first, { at: 1400, x: 100, y: 100 })).toBe(false);
    expect(isDoubleTap(first, { at: 1100, x: 180, y: 100 })).toBe(false);
  });
});

describe("zoom", () => {
  it("clamps to 1x through 4x", () => {
    expect(clampZoom(0.5)).toBe(1);
    expect(clampZoom(2)).toBe(2);
    expect(clampZoom(9)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it("zooms a double tap in to 2.5x on the tapped point, and back out to 1x", () => {
    // A tap 100 px right of and 50 px above the centre.
    const focal = { x: 100, y: -50 };
    const zoomed = toggleZoom(IDENTITY, focal, SQUARE, STAGE);
    expect(zoomed.scale).toBe(DOUBLE_TAP_ZOOM);
    // The picture point that was under the finger is still under it.
    const px = (focal.x - IDENTITY.x) / IDENTITY.scale;
    const py = (focal.y - IDENTITY.y) / IDENTITY.scale;
    expect(zoomed.x + zoomed.scale * px).toBeCloseTo(focal.x);
    expect(zoomed.y + zoomed.scale * py).toBeCloseTo(focal.y);
    expect(toggleZoom(zoomed, focal, SQUARE, STAGE)).toEqual(IDENTITY);
  });

  it("keeps an edge tap inside the picture rather than showing the stage behind it", () => {
    // Tapping the very corner would need a pan past the edge to keep the point put.
    const zoomed = zoomAt(IDENTITY, 2.5, { x: 195, y: 195 }, SQUARE, STAGE);
    const maxX = (SQUARE.width * 2.5 - STAGE.width) / 2;
    expect(Math.abs(zoomed.x)).toBeLessThanOrEqual(maxX);
    expect(Math.abs(zoomed.y)).toBeLessThanOrEqual(maxX);
  });

  it("pinches between 1x and 4x and carries the point under the fingers with them", () => {
    const start = IDENTITY;
    const mid = { x: 40, y: 20 };
    const twice = pinchTo(start, 100, 200, mid, mid, SQUARE, STAGE);
    expect(twice.scale).toBeCloseTo(2);
    expect(twice.x + twice.scale * mid.x).toBeCloseTo(mid.x);
    expect(pinchTo(start, 100, 1000, mid, mid, SQUARE, STAGE).scale).toBe(MAX_ZOOM);
    // Pinching in past 1x lands on 1x, centred, not on a shrunken picture.
    expect(pinchTo(twice, 200, 50, mid, mid, SQUARE, STAGE)).toEqual(IDENTITY);
  });

  it("turns a ctrl or trackpad pinch wheel into a gentle scale, clamped", () => {
    expect(wheelScale(1, -100)).toBeGreaterThan(1);
    expect(wheelScale(2, 100)).toBeLessThan(2);
    expect(wheelScale(4, -1000)).toBe(MAX_ZOOM);
    expect(wheelScale(1, 1000)).toBe(1);
  });
});

describe("pan", () => {
  it("drags a zoomed picture until its edge meets the stage edge, and no further", () => {
    const zoomed = { scale: 2, x: 0, y: 0 };
    const limit = (SQUARE.width * 2 - STAGE.width) / 2;
    expect(panBy(zoomed, 50, -30, SQUARE, STAGE)).toEqual({ scale: 2, x: 50, y: -30 });
    expect(panBy(zoomed, 5000, -5000, SQUARE, STAGE)).toEqual({ scale: 2, x: limit, y: -limit });
  });

  it("keeps a side smaller than the stage centred", () => {
    // A wide picture on a tall stage: at 1.5x it still does not fill the height.
    const wide = { width: 390, height: 220 };
    const tall = { width: 390, height: 700 };
    const view = clampPan({ scale: 1.5, x: 30, y: 200 }, wide, tall);
    expect(view.y).toBe(0);
    expect(view.x).toBe(30);
  });

  it("knows 1x from zoomed", () => {
    expect(isZoomed(IDENTITY)).toBe(false);
    expect(isZoomed({ scale: 1.2, x: 0, y: 0 })).toBe(true);
  });
});

describe("a video's own controls", () => {
  it("leaves the native control bar to the video", () => {
    // A 16:9 clip centred on a 390 x 400 stage is 219 px tall, so its bottom
    // edge is at 309.5 and the bar is the 52 px above that.
    expect(onVideoControls(300, 400, 219)).toBe(true);
    expect(onVideoControls(200, 400, 219)).toBe(false);
    expect(onVideoControls(350, 400, 219)).toBe(false);
  });
});

describe("pull to refresh", () => {
  it("damps the pull and triggers past the line", () => {
    expect(pullDistance(-20)).toBe(0);
    expect(pullDistance(40)).toBe(20);
    expect(pullTriggers(100)).toBe(false);
    expect(pullTriggers(120)).toBe(true);
    expect(pullDistance(1000)).toBe(96);
  });
});
