// The Viewer's stage: the picture, what a finger can do to it, and how it
// arrives. The arithmetic lives in gestures.ts; this file only wires pointer
// events to it and draws the result.
//
// - **Swipe** between neighbours: the picture follows the finger with the
//   neighbour's thumbnail sliding in beside it, and snaps to the neighbour or
//   back on release. Vertical drags are left to the page (`touch-action:
//   pan-y`), so the reading column under the stage still scrolls.
// - **Zoom**: double tap toggles 1x and 2.5x at the tapped point, two fingers
//   pinch between 1x and 4x, ctrl plus the wheel (a trackpad pinch) zooms at
//   the pointer. While zoomed one finger pans and swipe navigation is off.
// - **Tap** on the picture toggles the chrome on a phone.
// - A video keeps its own control bar: a press there is never a swipe.
//
// Reduced motion keeps the direct manipulation (the picture still follows the
// finger, because that is the finger, not an animation) and drops every
// animated slide, snap, zoom and fade.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Asset } from "../../contract";
import { aspectOf, hasStill, mediaUrl } from "./format";
import {
  DOUBLE_TAP_MS,
  IDENTITY,
  SNAP_MS,
  clampPan,
  dragOffset,
  isDoubleTap,
  isTap,
  isZoomed,
  lockAxis,
  onVideoControls,
  panBy,
  pinchTo,
  swipeDecision,
  toggleZoom,
  wheelScale,
  zoomAt,
} from "./gestures";
import type { Point, Size, Tap, View } from "./gestures";
import type { PreviewBase } from "./use-comfy";

/** Black air between two pictures while one slides over the other. */
const SLIDE_GAP_PX = 16;
/** The stage's own fades: thumbnail to view copy, and zoom on a double tap. */
export const STAGE_FADE_MS = 150;

type Gesture =
  | { kind: "idle" }
  | { kind: "press"; id: number; x0: number; y0: number; t0: number; view0: View; focal: Point }
  | { kind: "swipe"; id: number; x0: number; y0: number; t0: number }
  | { kind: "pan"; id: number; x0: number; y0: number; view0: View }
  | { kind: "pinch"; d0: number; mid0: Point; view0: View };

export interface ViewerStageProps {
  asset: Asset;
  prev: Asset | null;
  next: Asset | null;
  preview: PreviewBase | null;
  /** The drawn size of the current picture, which is what zoom and pan are measured against. */
  content: Size | null;
  /** Only a finished image zooms. */
  zoomable: boolean;
  /** The black darkroom stage of the phone layout. */
  dark: boolean;
  reducedMotion: boolean;
  onSelect: (id: string) => void;
  /** A single tap that was not the first half of a double tap. */
  onTap: () => void;
  /** Tells the viewer whether the picture is zoomed, so it can offer the original. */
  onZoomChange?: (zoomed: boolean) => void;
  children: ReactNode;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function ViewerStage({ asset, prev, next, preview, content, zoomable, dark, reducedMotion, onSelect, onTap, onZoomChange, children }: ViewerStageProps) {
  const surface = useRef<HTMLDivElement | null>(null);
  const [offset, setOffset] = useState(0);
  const [sliding, setSliding] = useState(false);
  const [view, setView] = useState<View>(IDENTITY);
  const [zoomEase, setZoomEase] = useState(false);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture>({ kind: "idle" });
  const lastTap = useRef<Tap | null>(null);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const zoomed = isZoomed(view);
  useEffect(() => {
    onZoomChange?.(zoomed);
  }, [zoomed, onZoomChange]);

  // A new asset starts centred, unzoomed and still. A layout effect, so the
  // track is back at zero in the same frame the new picture is drawn, and the
  // neighbour that had just slid in is replaced by itself rather than jumping.
  useLayoutEffect(() => {
    setOffset(0);
    setSliding(false);
    setView(IDENTITY);
    setZoomEase(false);
    gesture.current = { kind: "idle" };
    pointers.current.clear();
  }, [asset.id]);

  useEffect(
    () => () => {
      if (tapTimer.current !== null) clearTimeout(tapTimer.current);
      if (slideTimer.current !== null) clearTimeout(slideTimer.current);
    },
    [],
  );

  const stageSize = (): Size => {
    const rect = surface.current?.getBoundingClientRect();
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
  };
  /** A client point as an offset from the stage centre, which is where the picture's centre is. */
  const fromCentre = (clientX: number, clientY: number): Point => {
    const rect = surface.current?.getBoundingClientRect();
    if (rect === undefined) return { x: 0, y: 0 };
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  };
  const box = content ?? stageSize();

  const settleZoom = useCallback(
    (next: View, eased: boolean) => {
      setZoomEase(eased && !reducedMotion);
      setView(next);
    },
    [reducedMotion],
  );

  const slideTo = (target: "prev" | "next") => {
    const id = target === "next" ? next?.id : prev?.id;
    if (id === undefined) return;
    if (reducedMotion) {
      onSelect(id);
      return;
    }
    const width = stageSize().width;
    setSliding(true);
    setOffset(target === "next" ? -(width + SLIDE_GAP_PX) : width + SLIDE_GAP_PX);
    if (slideTimer.current !== null) clearTimeout(slideTimer.current);
    // The route change is what brings the neighbour in as the new current
    // picture; until it lands, the track holds the neighbour's thumbnail.
    slideTimer.current = setTimeout(() => {
      slideTimer.current = null;
      onSelect(id);
    }, SNAP_MS);
  };

  const snapBack = () => {
    setSliding(!reducedMotion);
    setOffset(0);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (asset.kind === "video") {
      const rect = surface.current?.getBoundingClientRect();
      if (rect !== undefined) {
        const drawn = Math.min(rect.height, rect.width / aspectOf(asset));
        if (onVideoControls(event.clientY - rect.top, rect.height, drawn)) return;
      }
    }
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size === 2 && zoomable) {
      const [a, b] = [...pointers.current.values()] as [Point, Point];
      setOffset(0);
      const mid = midpoint(a, b);
      gesture.current = { kind: "pinch", d0: distance(a, b), mid0: fromCentre(mid.x, mid.y), view0: viewRef.current };
      return;
    }
    if (pointers.current.size > 1) return;
    gesture.current = { kind: "press", id: event.pointerId, x0: point.x, y0: point.y, t0: event.timeStamp, view0: viewRef.current, focal: fromCentre(point.x, point.y) };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    const current = gesture.current;
    if (current.kind === "pinch") {
      const values = [...pointers.current.values()];
      if (values.length < 2) return;
      const [a, b] = values as [Point, Point];
      const mid = midpoint(a, b);
      settleZoom(pinchTo(current.view0, current.d0, distance(a, b), current.mid0, fromCentre(mid.x, mid.y), box, stageSize()), false);
      return;
    }
    if (current.kind === "press") {
      const dx = point.x - current.x0;
      const dy = point.y - current.y0;
      if (isZoomed(current.view0)) {
        if (lockAxis(dx, dy) === null) return;
        // Capture only once the drag is real, or a plain click would be
        // retargeted to the stage and a button over it could never be pressed.
        surface.current?.setPointerCapture?.(event.pointerId);
        gesture.current = { kind: "pan", id: current.id, x0: current.x0, y0: current.y0, view0: current.view0 };
        return;
      }
      const axis = lockAxis(dx, dy);
      if (axis === null) return;
      if (axis === "y") {
        // A scroll: the page has it.
        gesture.current = { kind: "idle" };
        return;
      }
      surface.current?.setPointerCapture?.(event.pointerId);
      setSliding(false);
      gesture.current = { kind: "swipe", id: current.id, x0: current.x0, y0: current.y0, t0: current.t0 };
      setOffset(dragOffset(dx, prev !== null, next !== null));
      return;
    }
    if (current.kind === "swipe") {
      setOffset(dragOffset(point.x - current.x0, prev !== null, next !== null));
      return;
    }
    if (current.kind === "pan") {
      settleZoom(panBy(current.view0, point.x - current.x0, point.y - current.y0, box, stageSize()), false);
    }
  };

  const finish = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const point = pointers.current.get(event.pointerId) ?? { x: event.clientX, y: event.clientY };
    pointers.current.delete(event.pointerId);
    const current = gesture.current;
    if (current.kind === "pinch") {
      // One finger left on the glass carries on as a pan from where it is.
      const rest = [...pointers.current.entries()][0];
      gesture.current =
        rest === undefined || !isZoomed(viewRef.current)
          ? { kind: "idle" }
          : { kind: "pan", id: rest[0], x0: rest[1].x, y0: rest[1].y, view0: viewRef.current };
      return;
    }
    gesture.current = { kind: "idle" };
    if (current.kind === "swipe") {
      const decision = cancelled ? "stay" : swipeDecision({ dx: point.x - current.x0, dy: point.y - current.y0, ms: event.timeStamp - current.t0, hasPrev: prev !== null, hasNext: next !== null });
      if (decision === "stay") snapBack();
      else slideTo(decision);
      return;
    }
    if (current.kind !== "press" || cancelled) return;
    if (!isTap(point.x - current.x0, point.y - current.y0, event.timeStamp - current.t0)) return;
    const tap: Tap = { at: event.timeStamp, x: point.x, y: point.y };
    if (zoomable && isDoubleTap(lastTap.current, tap)) {
      lastTap.current = null;
      if (tapTimer.current !== null) clearTimeout(tapTimer.current);
      tapTimer.current = null;
      settleZoom(toggleZoom(viewRef.current, current.focal, box, stageSize()), true);
      return;
    }
    lastTap.current = tap;
    if (tapTimer.current !== null) clearTimeout(tapTimer.current);
    // Wait out the double tap window before calling it a single tap, or the
    // chrome would blink on the first half of every zoom.
    tapTimer.current = setTimeout(
      () => {
        tapTimer.current = null;
        onTap();
      },
      zoomable ? DOUBLE_TAP_MS : 0,
    );
  };

  // Ctrl plus the wheel is what a trackpad pinch sends. React registers wheel
  // listeners as passive, which cannot stop the page zooming, so this one is
  // attached by hand.
  useEffect(() => {
    const element = surface.current;
    if (element === null || !zoomable) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const focal = fromCentre(event.clientX, event.clientY);
      const current = viewRef.current;
      settleZoom(zoomAt(current, wheelScale(current.scale, event.deltaY), focal, content ?? stageSize(), stageSize()), false);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomable, content?.width, content?.height, settleZoom]);

  // A stage that changes size (rotation, the panel resizing) keeps a zoomed
  // picture inside its new bounds.
  useEffect(() => {
    if (content === null || !isZoomed(viewRef.current)) return;
    setView((current) => clampPan(current, content, stageSize()));
  }, [content]);

  const ease = `${STAGE_FADE_MS}ms ease-out`;
  return (
    <div
      ref={surface}
      data-stage-surface
      className={cn("absolute inset-0 select-none overflow-hidden", dark ? "bg-black" : undefined)}
      // Vertical drags scroll the page until the picture is zoomed; then every
      // movement is a pan, and the page must not move under it.
      style={{ touchAction: zoomed ? "none" : "pan-y" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finish(event, false)}
      onPointerCancel={(event) => finish(event, true)}
      onDragStart={(event) => event.preventDefault()}
    >
      <div
        data-stage-track
        className="absolute inset-0"
        style={{ transform: `translateX(${offset}px)`, transition: sliding ? `transform ${SNAP_MS}ms ease-out` : "none" }}
        onTransitionEnd={(event) => {
          // The picture's own fade and zoom bubble up here too; only the
          // track's slide may end the slide.
          if (event.target === event.currentTarget) setSliding(false);
        }}
      >
        <NeighbourStill asset={prev} preview={preview} side="prev" />
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            data-stage-zoom
            className="flex max-h-full max-w-full items-center justify-center"
            style={{
              transform: zoomed ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})` : undefined,
              transition: zoomEase ? `transform ${ease}` : "none",
              willChange: zoomed ? "transform" : undefined,
            }}
            onTransitionEnd={(event) => {
              if (event.target === event.currentTarget) setZoomEase(false);
            }}
          >
            {children}
          </div>
        </div>
        <NeighbourStill asset={next} preview={preview} side="next" />
      </div>
    </div>
  );
}

/**
 * The neighbour's thumbnail, parked one stage width away so a swipe reveals it.
 * It is the same small copy the grid drew and the stage will open on, so the
 * hand over from this slot to the new current picture repaints nothing.
 */
function NeighbourStill({ asset, preview, side }: { asset: Asset | null; preview: PreviewBase | null; side: "prev" | "next" }) {
  if (asset === null || asset.status !== "completed" || asset.file === null) return null;
  if (asset.kind === "video" && !hasStill(asset)) return null;
  const url = mediaUrl(preview, asset, "thumb");
  if (url === null) return null;
  const shift = side === "prev" ? `calc(-100% - ${SLIDE_GAP_PX}px)` : `calc(100% + ${SLIDE_GAP_PX}px)`;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center" style={{ transform: `translateX(${shift})` }}>
      {/* Fills the stage the way the current picture's box does, so the hand
          over after the slide lands on the same pixels. */}
      <img src={url} alt="" decoding="async" draggable={false} className="size-full object-contain" />
    </div>
  );
}

export interface ProgressiveImageProps {
  asset: Asset;
  /** The thumbnail the grid has usually just drawn, painted first. */
  placeholder: string | null;
  /** The copy the stage settles on: the 2048 view copy, or the original once asked for. */
  full: string;
  /** What `full` is, for the line that says so when it will not load. */
  fullLabel: string;
  box: Size | null;
  dark: boolean;
  reducedMotion: boolean;
}

/**
 * The stage's picture: the thumbnail fills the frame at once, slightly blurred
 * because it is being drawn larger than it is, and the next copy cross-fades
 * in over it once decoded, 150 ms, or appears under reduced motion.
 *
 * Three ways progressive loading goes wrong, and what is done about each:
 *
 * - **A flash or a reflow.** The next copy is decoded in a detached `Image`
 *   before it is shown, and every frame is drawn in the same box (`box`, from
 *   the stage and the stored pixels), so nothing moves when one replaces
 *   another. The old frame stays under the new one until the fade is done.
 * - **A late arrival painting over the wrong picture.** The load belongs to one
 *   asset: the component is keyed on it, and the effect's cleanup drops the
 *   request, so swiping away cancels rather than letting an old copy land on
 *   the new image.
 * - **A soft copy passing for the real thing.** If the next copy fails, what is
 *   on screen stays up and a line on the stage says so.
 *
 * Asking for the original (Full resolution) is the same path again: what is on
 * screen stays until the original has decoded.
 */
export function ProgressiveImage({ asset, placeholder, full, fullLabel, box, dark, reducedMotion }: ProgressiveImageProps) {
  const first = placeholder ?? full;
  const [frame, setFrame] = useState(first);
  const [under, setUnder] = useState<string | null>(null);
  const [entering, setEntering] = useState(false);
  const [failed, setFailed] = useState(false);
  const [gone, setGone] = useState(false);
  const frameRef = useRef(frame);
  frameRef.current = frame;

  useEffect(() => {
    const start = frameRef.current;
    setFailed(false);
    // Nothing to upgrade to: the stage already shows the copy it settles on.
    if (start === full || typeof Image === "undefined") return;
    let live = true;
    const image = new Image();
    image.src = full;
    void (async () => {
      try {
        if (typeof image.decode === "function") await image.decode();
        else
          await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = reject;
          });
        if (!live) return;
        if (!reducedMotion) {
          setUnder(start);
          setEntering(true);
        }
        setFrame(full);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
      // Drops the request rather than leaving it to finish for an image nobody
      // is looking at any more.
      image.src = "";
    };
  }, [full, reducedMotion]);

  // The new frame mounts transparent and fades in once it has been painted
  // that way. Two frames, because a change made in the first one lands before
  // the browser has drawn the transparent state and there is nothing to fade.
  useEffect(() => {
    if (!entering || typeof requestAnimationFrame === "undefined") return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setEntering(false));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [entering]);

  // The frame underneath goes once the fade is over. On a timer rather than on
  // transitionend, which does not fire when a tab is hidden mid fade, and a
  // stale frame left under a picture with a transparent background (GPT Image
  // can make one) would show through it.
  useEffect(() => {
    if (entering || under === null) return;
    const timer = setTimeout(() => setUnder(null), STAGE_FADE_MS + 60);
    return () => clearTimeout(timer);
  }, [entering, under]);

  if (gone) {
    return (
      <p className={cn("m-auto max-w-72 px-4 text-center text-[12px]", dark ? "text-white/70" : "text-muted-foreground")}>
        The file for {asset.id} is no longer on disk. The prompt and the workflow are still here, so Regenerate still works.
      </p>
    );
  }
  const soft = (src: string) => placeholder !== null && src === placeholder && placeholder !== full;
  const sized = box === null ? undefined : { width: box.width, height: box.height };
  // The hairline keeps a black-ink-on-white picture from dissolving into a
  // light stage; on the black stage it would only be a grey line.
  const frameClass = cn("max-h-full max-w-full object-contain", dark ? undefined : "rounded-sm ring-1 ring-border");
  return (
    <div className="relative flex max-h-full max-w-full items-center justify-center" style={sized}>
      {under === null ? null : (
        <img src={under} alt="" aria-hidden decoding="async" draggable={false} className={cn(frameClass, "absolute inset-0 size-full", soft(under) && "blur-[2px]")} />
      )}
      <img
        key={frame}
        src={frame}
        alt={asset.prompt}
        decoding="async"
        draggable={false}
        width={box?.width}
        height={box?.height}
        style={sized}
        onError={() => {
          // A placeholder that fails is skipped for the real copy; the real
          // copy failing after a good placeholder is said out loud; the only
          // thing we had failing means the file is gone.
          if (frame !== full) setFrame(full);
          else if (under !== null || (placeholder !== null && placeholder !== full)) setFailed(true);
          else setGone(true);
        }}
        className={cn(
          frameClass,
          "relative",
          soft(frame) && "blur-[2px]",
          // Literal, so Tailwind can see it: 150 ms is STAGE_FADE_MS.
          "transition-opacity duration-150 ease-out motion-reduce:transition-none",
          entering ? "opacity-0" : "opacity-100",
        )}
      />
      {failed ? <StageNote>{`Showing a reduced copy: ${fullLabel} could not be loaded.`}</StageNote> : null}
    </div>
  );
}

/** A small solid line on the stage, readable over any picture and on the black stage. */
export function StageNote({ children }: { children: ReactNode }) {
  return (
    <p className="absolute bottom-2 left-1/2 z-10 w-max max-w-[calc(100%-1rem)] -translate-x-1/2 rounded-md bg-background/90 px-2 py-1 text-center text-[11px] leading-4 text-foreground">
      {children}
    </p>
  );
}
