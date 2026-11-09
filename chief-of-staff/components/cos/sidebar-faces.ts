// Worker faces in bb's sidebar: the avatar at the start of each worker's row,
// and Bloom while it works.
//
// bb gives a plugin one sanctioned status glyph on the right of a row and
// nothing on the left, so this draws on bb's own sidebar DOM, which bb's plugin
// rules allow from a content script ("Styling or decorating existing app-shell
// DOM belongs in a content script"), on condition that everything it adds is
// removed when it stops. It does not change bb's rows: it lays a small
// element in the indent at the start of each worker's row, and hides the
// "In project ..." folder bb draws after the title, so the title gets that
// room back.
//
// THIS DEPENDS ON bb's ROW MARKUP, which bb does not promise to keep. What it
// relies on, from bb 0.48.1's thread-list plugin, and where it fails safe:
//
// - Each row's link carries `data-sidebar-thread-id="<threadId>"`. This is a
//   documented contract (bb's keyboard shortcuts find rows by it), so it is the
//   least likely thing to change. If it disappears, nothing is drawn.
// - The folder is `[data-sidebar-thread-cross-project]`, somewhere inside the
//   span that holds the link: after the title, one span down, on bb 0.48.1. If
//   it is missing, the face is still drawn in the indent before the title.
//
// Every decision about which worker gets what is made on the server
// (`sidebarFaces` in core.ts, via the same `thread_marks` RPC row-marks.ts
// polls); this file only paints. The avatar picture is the same one the plugin
// draws everywhere (`avatarInner` from avatars.ts, pure).
import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import { avatarInner, avatarKey } from "../../avatars";
import { BLOOM_FRAMES, BLOOM_FRAME_MS } from "./bloom";
import { FINISHED_LABEL } from "./mark-labels";

export interface Face {
  threadId: string;
  avatar: { shape: string; color: string } | null;
  working: boolean;
}

/**
 * What to draw: the faces, and which rows carry the "finished, not read" mark.
 *
 * The finished rows are their own list, not a flag on a face: a worker with no
 * avatar, or the faces setting off, has no face but still has the mark, and
 * bb's Circle is a ring that reads as an empty circle rather than its
 * filled grey dot. So the mark still goes through bb's slot (bb reserves the
 * space and fades it on hover), and this draws bb's own unread dot over it:
 * 5px, muted foreground at 60%.
 */
export interface SidebarPaint {
  faces: readonly Face[];
  finished: ReadonlySet<string>;
}

/** Marks every node this script creates, so cleanup can find them all. */
const OWNED = "data-cos-face";
/** On bb's slot glyph while our filled dot replaces it. Removed with the dot. */
const DOTTED = "data-cos-dotted";
/** Marks the filled dot this script draws. */
const DOT = "data-cos-dot";
/** On bb's folder, while a face covers it. Removed with the face. */
const COVERED = "data-cos-face-covered";
const STYLE_ID = "cos-sidebar-faces-style";

const CSS = `
[${OWNED}]{position:absolute;display:flex;align-items:center;justify-content:center;width:20px;height:20px;
pointer-events:none;z-index:32;border-radius:4px;background:var(--sidebar)}
[${OWNED}] svg{width:16px;height:16px;display:block}
[${OWNED}][data-kind="bloom"]{font-size:15px;line-height:1;color:var(--warning-text,var(--warning));
font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}
[${OWNED}][data-kind="bloom"]::before{content:var(--cos-bloom,"\\00B7")}
.group\\/thread-row:not(.bb-sidebar-selected-row):hover [${OWNED}],
.group\\/thread-row:not(.bb-sidebar-selected-row):has([data-state="open"]) [${OWNED}]{background:var(--sidebar-accent)}
.bb-sidebar-selected-row [${OWNED}]{background-image:linear-gradient(var(--state-active),var(--state-active))}
[${COVERED}]{display:none!important}
[${DOTTED}]{position:relative}
[${DOTTED}] > svg{visibility:hidden}
[${DOT}]{position:absolute;inset:0;margin:auto;width:5px;height:5px;border-radius:9999px;pointer-events:none;
background:color-mix(in oklab,var(--muted-foreground) 60%,transparent)}
@media (prefers-reduced-motion:reduce){[${OWNED}][data-kind="bloom"]::before{content:"\\2733"}}
`;

/**
 * The smallest element holding every sidebar row, or null before any exist.
 * Rows are found by the one documented attribute, so no class name of bb's is
 * assumed here.
 */
function sidebarRoot(): Element | null {
  const links = document.querySelectorAll("a[data-sidebar-thread-id]");
  if (links.length === 0) return null;
  let root: Element | null = links[0]!.parentElement;
  const last = links[links.length - 1]!;
  while (root !== null && !root.contains(last)) root = root.parentElement;
  // Up to the scroll container, so rows bb windows in at either end stay inside.
  while (root !== null && root !== document.body) {
    const overflow = getComputedStyle(root).overflowY;
    if (overflow === "auto" || overflow === "scroll") return root;
    root = root.parentElement;
  }
  return null;
}

/** Where to put a face for this row, or null when the row is not on screen. */
function anchorFor(link: HTMLAnchorElement): { host: HTMLElement; left: number; folder: HTMLElement | null } | null {
  // bb 0.48.1: row > span > [the link (empty, laid over the row), span >
  // [title, folder, chevron]]. The face goes at the start of the row, in the
  // indent, and bb's "in another project" folder is
  // hidden wherever bb puts it in the link's span: its position differs
  // between bb versions, so it is looked up at any depth rather than at one
  // position.
  const titleSpan = link.parentElement;
  const row = titleSpan?.parentElement;
  if (!titleSpan || !row) return null;
  const rowRect = row.getBoundingClientRect();
  if (rowRect.height === 0) return null;
  const folder = titleSpan.querySelector<HTMLElement>("[data-sidebar-thread-cross-project]");
  const t = titleSpan.getBoundingClientRect();
  return { host: row, left: t.left - rowRect.left - 22, folder };
}

function paintFace(face: Face, link: HTMLAnchorElement, frame: string): HTMLElement | null {
  const anchor = anchorFor(link);
  if (anchor === null || anchor.left < 0) return null;
  if (getComputedStyle(anchor.host).position === "static") return null;
  let node = anchor.host.querySelector<HTMLElement>(`:scope > [${OWNED}]`);
  if (node === null) {
    node = document.createElement("span");
    node.setAttribute(OWNED, face.threadId);
    node.setAttribute("aria-hidden", "true");
    anchor.host.appendChild(node);
  }
  const left = `${Math.round(anchor.left)}px`;
  if (node.style.left !== left) node.style.left = left;
  if (node.style.top !== "50%") {
    node.style.top = "50%";
    node.style.transform = "translateY(-50%)";
  }
  const kind = face.working ? "bloom" : "avatar";
  if (node.dataset.kind !== kind || (kind === "avatar" && node.dataset.avatar !== faceKey(face))) {
    node.dataset.kind = kind;
    node.dataset.avatar = faceKey(face);
    node.innerHTML =
      kind === "avatar" && face.avatar
        ? `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">${avatarInner(face.avatar, 16)}</svg>`
        : "";
  }
  if (kind === "bloom") node.style.setProperty("--cos-bloom", `"${frame}"`);
  if (anchor.folder && !anchor.folder.hasAttribute(COVERED)) anchor.folder.setAttribute(COVERED, "");
  return node;
}

function faceKey(face: Face): string {
  return face.avatar ? avatarKey(face.avatar) : "";
}

/** Remove everything this script put on the page. */
export function clearFaces(root: ParentNode = document): void {
  for (const node of Array.from(root.querySelectorAll(`[${OWNED}]`))) node.remove();
  for (const node of Array.from(root.querySelectorAll(`[${COVERED}]`))) node.removeAttribute(COVERED);
  for (const node of Array.from(root.querySelectorAll(`[${DOT}]`))) node.remove();
  for (const node of Array.from(root.querySelectorAll(`[${DOTTED}]`))) node.removeAttribute(DOTTED);
}

/**
 * Swap bb's outline circle for its filled unread dot on a finished row. The
 * slot is bb's own `[data-sidebar-thread-trailing-indicator]`; this only hides
 * the glyph inside it and lays a dot on top, so bb keeps the slot's size, its
 * hover fade and its accessible label. No slot on the row, no dot.
 */
function paintDot(link: HTMLAnchorElement): Element | null {
  const row = link.parentElement?.parentElement ?? null;
  if (row === null) return null;
  const slot = row.querySelector<HTMLElement>("[data-sidebar-thread-trailing-indicator]");
  if (slot === null) return null;
  // Only ever the plugin's own finished glyph, found by the label bb copies
  // onto it. bb's spinner, failure cross and question are svgs in the same
  // slot and outrank the plugin, so a bare svg test would hide them behind a dot.
  if (slot.querySelector(`:scope > svg[aria-label="${FINISHED_LABEL}"]`) === null) return null;
  slot.setAttribute(DOTTED, "");
  let dot = slot.querySelector(`:scope > [${DOT}]`);
  if (dot === null) {
    dot = document.createElement("span");
    dot.setAttribute(DOT, "");
    dot.setAttribute("aria-hidden", "true");
    slot.appendChild(dot);
  }
  return dot;
}

/**
 * Paint every face whose row is in the DOM right now, and remove faces whose
 * worker is no longer in the list or whose row went away. Returns how many
 * were painted, for the caller's own checks.
 */
export function paintFaces({ faces, finished }: SidebarPaint, frame: string, root: Document = document): number {
  const wanted = new Map(faces.map((face) => [face.threadId, face]));
  let painted = 0;
  const seen = new Set<Element>();
  const dots = new Set<Element>();
  for (const link of Array.from(root.querySelectorAll<HTMLAnchorElement>("a[data-sidebar-thread-id]"))) {
    const id = link.getAttribute("data-sidebar-thread-id") ?? "";
    if (finished.has(id)) {
      const dot = paintDot(link);
      if (dot) dots.add(dot);
    }
    const face = wanted.get(id);
    if (!face) continue;
    const node = paintFace(face, link, frame);
    if (node) {
      seen.add(node);
      painted += 1;
    }
  }
  for (const dot of Array.from(root.querySelectorAll(`[${DOT}]`))) {
    if (dots.has(dot)) continue;
    dot.parentElement?.removeAttribute(DOTTED);
    dot.remove();
  }
  // Anything of ours not painted this pass belongs to a worker that is gone or
  // a row bb re-rendered elsewhere: remove it and uncover its folder.
  for (const node of Array.from(root.querySelectorAll(`[${OWNED}]`))) {
    if (seen.has(node)) continue;
    // The folder this face hid, wherever it sits in the row.
    node.parentElement?.querySelector(`[${COVERED}]`)?.removeAttribute(COVERED);
    node.remove();
  }
  return painted;
}

/**
 * Mount: add one style element, repaint when bb re-renders the sidebar, step
 * Bloom's frame, and take everything away on abort.
 *
 * `getPaint` is the latest list the row-marks poll fetched; this script does
 * not fetch on its own, so the two can never disagree about who is working.
 */
export function mountSidebarFaces(
  context: PluginContentScriptContext,
  getPaint: () => SidebarPaint,
  subscribe: (listener: () => void) => () => void,
): () => void {
  let stopped = false;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);

  let frameIndex = 0;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const frame = () => (reduced.matches ? "\u2733" : BLOOM_FRAMES[frameIndex % BLOOM_FRAMES.length]!);

  let scheduled = false;
  const repaint = () => {
    if (stopped || scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (stopped) return;
      watch();
      paintFaces(getPaint(), frame());
    });
  };

  // bb re-renders rows on its own schedule (scroll windowing, collapse, a new
  // title). Watching only for added or removed nodes keeps this cheap: it never
  // reacts to its own style changes, and ignores attribute churn entirely.
  const ours = (node: Node): boolean =>
    node instanceof Element && (node.hasAttribute(OWNED) || node.hasAttribute(DOT));
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type !== "childList") continue;
      // Our own svg going into a face, or a dot going in or out.
      if (record.target instanceof Element && record.target.closest(`[${OWNED}],[${DOT}]`) !== null) continue;
      const touched = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
      if (touched.length > 0 && touched.every(ours)) continue;
      repaint();
      return;
    }
  });
  // The sidebar only, not the whole page: a streaming reply in the thread pane
  // adds nodes every frame, and each one would schedule a full pass. The root is the
  // nearest ancestor holding every row; body until rows exist, and re-found
  // when bb replaces it.
  let watched: Element | null = null;
  const watch = () => {
    const root = sidebarRoot() ?? document.body;
    if (root === watched && root.isConnected) return;
    observer.disconnect();
    observer.observe(root, { childList: true, subtree: true });
    // bb swapping the sidebar out (a layout change) must still be seen.
    if (root !== document.body) observer.observe(document.body, { childList: true });
    watched = root;
  };
  watch();

  // Bloom steps only while some face is working and the tab is visible.
  const timer = setInterval(() => {
    if (document.visibilityState !== "visible" || reduced.matches) return;
    if (!getPaint().faces.some((face) => face.working)) return;
    frameIndex += 1;
    const glyph = frame();
    for (const node of Array.from(document.querySelectorAll<HTMLElement>(`[${OWNED}][data-kind="bloom"]`))) {
      node.style.setProperty("--cos-bloom", `"${glyph}"`);
    }
  }, BLOOM_FRAME_MS);

  const unsubscribe = subscribe(repaint);
  repaint();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    observer.disconnect();
    unsubscribe();
    clearFaces();
    style.remove();
  };
  context.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
