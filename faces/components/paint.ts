// Draws the faces on bb's sidebar rows.
//
// bb has no slot for a picture at the start of its own thread rows, so this
// runs as a content script, the place bb's plugin guide gives for decorating
// its existing DOM. It changes none of bb's elements: it puts one small
// element inside each row's provider icon and hides that icon's own picture
// with a stylesheet, so the row's layout and titles stay exactly as bb drew
// them. Everything it adds goes away when it stops.
//
// It relies on two things in bb's row markup (checked on bb 0.48.1):
// - each row's link carries `data-sidebar-thread-id`, the documented hook
//   bb's keyboard shortcuts use;
// - the provider icon, `[data-sidebar-thread-provider]`, sits inside the
//   span that holds that link.
// A row without either gets no face; nothing is drawn in the wrong place.
//
// What to draw comes from `publishFaces`, which the app overlay in app.tsx
// feeds from bb's own thread list and the server's faces.
import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import { BLOOM_FRAMES, BLOOM_FRAME_MS, BLOOM_STILL, faceKey, faceSvgInner, type Face, type ThreadState } from "../lib/faces.ts";

export interface PaintedFace {
  face: Face;
  state: ThreadState;
}

/** The faces to draw now, by thread id. */
let wanted: ReadonlyMap<string, PaintedFace> = new Map();
const listeners = new Set<() => void>();

export function publishFaces(next: ReadonlyMap<string, PaintedFace>): void {
  wanted = next;
  for (const listener of listeners) listener();
}

/** On every element this script creates. */
const FACE = "data-faces-face";
/** On a provider icon while a face covers it. */
const COVERED = "data-faces-covered";
const STYLE_ID = "bb-plugin-faces-style";
const ROW_LINK = "a[data-sidebar-thread-id]";
const PROVIDER = "[data-sidebar-thread-provider]";

const CSS = `
[${COVERED}] > :not([${FACE}]) { visibility: hidden; }
[${FACE}] { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; }
[${FACE}] svg { width: 16px; height: 16px; display: block; overflow: visible; }
[${FACE}][data-state="running"] svg { display: none; }
[${FACE}][data-state="running"]::before {
  content: var(--faces-bloom, "${BLOOM_STILL}");
  font: 15px/1 ui-sans-serif, system-ui, -apple-system, sans-serif;
  color: var(--warning-text, var(--warning, #d97706));
}
[${FACE}][data-state="waiting"] svg { animation: bb-plugin-faces-wait 1.6s ease-in-out infinite; transform-origin: 50% 60%; }
@keyframes bb-plugin-faces-wait { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.84); } }
@media (prefers-reduced-motion: reduce) {
  [${FACE}][data-state="running"]::before { content: "${BLOOM_STILL}"; }
  [${FACE}][data-state="waiting"] svg { animation: none; opacity: 0.55; }
}
`;

/**
 * Draw the wanted faces on every row in the page and take faces off rows
 * that no longer want one. `frame` is the bloom glyph for running threads.
 * Returns how many faces are on screen.
 */
export function paintFaces(faces: ReadonlyMap<string, PaintedFace>, frame: string, root: Document = document): number {
  const kept = new Set<Element>();
  for (const link of Array.from(root.querySelectorAll<HTMLAnchorElement>(ROW_LINK))) {
    const want = faces.get(link.getAttribute("data-sidebar-thread-id") ?? "");
    const slot = link.parentElement?.querySelector<HTMLElement>(PROVIDER) ?? null;
    if (want === undefined || slot === null) continue;
    let node = slot.querySelector<HTMLElement>(`:scope > [${FACE}]`);
    if (node === null) {
      node = root.createElement("span");
      node.setAttribute(FACE, "");
      node.setAttribute("aria-hidden", "true");
      slot.appendChild(node);
    }
    const key = faceKey(want.face);
    if (node.dataset.face !== key) {
      node.dataset.face = key;
      node.innerHTML = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">${faceSvgInner(want.face, 16)}</svg>`;
    }
    if (node.dataset.state !== want.state) node.dataset.state = want.state;
    if (want.state === "running") node.style.setProperty("--faces-bloom", `"${frame}"`);
    if (!slot.hasAttribute(COVERED)) slot.setAttribute(COVERED, "");
    kept.add(node);
  }
  for (const node of Array.from(root.querySelectorAll(`[${FACE}]`))) {
    if (kept.has(node)) continue;
    node.parentElement?.removeAttribute(COVERED);
    node.remove();
  }
  // A provider icon bb redrew without our element must show its own picture again.
  for (const slot of Array.from(root.querySelectorAll(`[${COVERED}]`))) {
    if (slot.querySelector(`:scope > [${FACE}]`) === null) slot.removeAttribute(COVERED);
  }
  return kept.size;
}

/** Remove everything this script put on the page. */
export function clearFaces(root: Document = document): void {
  for (const node of Array.from(root.querySelectorAll(`[${FACE}]`))) node.remove();
  for (const slot of Array.from(root.querySelectorAll(`[${COVERED}]`))) slot.removeAttribute(COVERED);
  root.getElementById(STYLE_ID)?.remove();
}

/**
 * The smallest element holding every row, widened to its scroll container so
 * rows bb windows in at either end are still inside; null before rows exist.
 */
function rowsRoot(): Element | null {
  const links = document.querySelectorAll(ROW_LINK);
  if (links.length === 0) return null;
  let root: Element | null = links[0]!.parentElement;
  const last = links[links.length - 1]!;
  while (root !== null && !root.contains(last)) root = root.parentElement;
  while (root !== null && root !== document.body) {
    const overflow = getComputedStyle(root).overflowY;
    if (overflow === "auto" || overflow === "scroll") return root;
    root = root.parentElement;
  }
  return null;
}

/** The content script: draw, keep drawing as bb redraws rows, step the bloom, and clean up on abort. */
export function mountFaces(context: Pick<PluginContentScriptContext, "signal">): () => void {
  let stopped = false;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);

  let frameIndex = 0;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const frame = (): string => (reduced.matches ? BLOOM_STILL : BLOOM_FRAMES[frameIndex % BLOOM_FRAMES.length]!);

  let scheduled = false;
  const repaint = (): void => {
    if (stopped || scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (stopped) return;
      watch();
      paintFaces(wanted, frame());
    });
  };

  // bb redraws rows on its own schedule (scrolling, collapsing, a new title).
  // Only added or removed nodes matter, and never the ones this script adds.
  const ours = (node: Node): boolean => node instanceof Element && node.hasAttribute(FACE);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target instanceof Element && record.target.closest(`[${FACE}]`) !== null) continue;
      const touched = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
      if (touched.length > 0 && touched.every(ours)) continue;
      repaint();
      return;
    }
  });
  // Watch the rows' container rather than the whole page, so a reply
  // streaming into a thread does not trigger a repaint on every frame. The
  // page body is still watched for bb swapping the sidebar out (the phone
  // drawer opening, a layout change).
  let watched: Element | null = null;
  const watch = (): void => {
    const root = rowsRoot() ?? document.body;
    if (root === watched && root.isConnected) return;
    observer.disconnect();
    observer.observe(root, { childList: true, subtree: true });
    if (root !== document.body) observer.observe(document.body, { childList: true });
    watched = root;
  };
  watch();

  // The bloom steps only while some face is running and the page is visible.
  const timer = setInterval(() => {
    if (document.visibilityState !== "visible" || reduced.matches) return;
    if (![...wanted.values()].some((face) => face.state === "running")) return;
    frameIndex += 1;
    const glyph = `"${frame()}"`;
    for (const node of Array.from(document.querySelectorAll<HTMLElement>(`[${FACE}][data-state="running"]`))) {
      node.style.setProperty("--faces-bloom", glyph);
    }
  }, BLOOM_FRAME_MS);

  listeners.add(repaint);
  repaint();

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    observer.disconnect();
    listeners.delete(repaint);
    clearFaces();
    style.remove();
  };
  context.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
