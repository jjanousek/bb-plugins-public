// The sidebar's missing intuition: what a thread *needs*.
//
// bb lets a plugin put one status glyph on any thread row
// (`experimental_setThreadRowStatus`, content-script only), and that status
// replaces bb's own unless bb's is runtime, unread-error or waiting-for-input.
// So a glyph here is paid for by hiding whatever bb would have drawn, which is
// usually its grey "finished, unread" dot. Painting identity, which never
// changes, would hide that dot permanently on every marked row, so this paints
// only the two states bb cannot see for itself: a worker whose last turn
// failed, and a worker waiting on an answer from the user.
//
// Every decision is made on the server (`threadStatusMarks` in `core.ts`, via
// the `thread_marks` RPC); this file only paints. The plugin's own RPC is
// fetched over the same origin because a content script gets no hooks, so
// `useRpc` is not available here.
import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import { mountSidebarFaces, type Face, type SidebarPaint } from "./sidebar-faces";
import { threadIdFromPath } from "./route";

interface RowMark {
  threadId: string;
  kind?: string;
  icon: string;
  label: string;
  tone?: "default" | "error" | "running" | "success";
}

/**
 * How often to re-ask while the window is in front.
 *
 * A worker failing, or finishing a turn with a question, is a fact that
 * changes while the user is looking at the sidebar, so it has to be polled,
 * not only refreshed on focus. The interval is cleared on `visibilitychange` whenever the
 * tab goes hidden, so a backgrounded window stops costing anything from that
 * point; a window that mounts hidden starts the interval once and clears it on
 * its first visibility event, and each tick checks `visibilityState` before it
 * fetches, so nothing is requested meanwhile.
 */
const POLL_MS = 30_000;
/** While a worker is working, often enough that Bloom stops soon after the turn ends. */
const FAST_POLL_MS = 5_000;
/** How soon after opening a finished worker its dot clears. */
const SEEN_CHECK_MS = 1_500;
/** After a mark-read that did not take, how long before asking again. */
const SEEN_RETRY_MS = 30_000;

/**
 * The marks, or null when the answer could not be trusted.
 *
 * Null and an empty array are different facts and the caller acts on them
 * differently: empty means nothing is marked and the rows should be cleared,
 * null means ask again later and leave the screen alone. Returning `[]` for
 * both is not safe: the source is `rosterStatus`, which lists threads and
 * reads one output per live worker, and the 30s poll would turn a rare
 * failure into up to 120 chances an hour to blank every mark on the sidebar.
 */
async function fetchMarks(
  pluginId: string,
  signal: AbortSignal,
): Promise<{ marks: RowMark[]; faces: Face[] } | null> {
  const response = await fetch(`/api/v1/plugins/${pluginId}/rpc/thread_marks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
    signal,
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { result?: { marks?: RowMark[]; faces?: Face[] } };
  return { marks: body.result?.marks ?? [], faces: body.result?.faces ?? [] };
}

/**
 * Paint the marks and keep them current.
 *
 * Polled every 30 seconds while the window is visible, and refreshed when it
 * comes back to the front. There is still no live-turn glyph: bb draws its own
 * spinner in that slot during a turn, and its runtime indicator outranks
 * anything a plugin sets there anyway.
 */
export function mountRowMarks(context: PluginContentScriptContext): () => void {
  const setStatus = context.experimental_setThreadRowStatus;
  // Older clients do not ship the surface; the sidebar is simply unmarked.
  if (setStatus === undefined) return () => {};
  const painted = new Set<string>();
  let stopped = false;
  // The faces ride on the same fetch as the marks, so the avatar on the left
  // and the glyph on the right can never disagree about a worker.
  let paint: SidebarPaint = { faces: [], finished: new Set() };
  const faceListeners = new Set<() => void>();

  // The newest request wins. A slow response that lands after a newer one would
  // otherwise stick for a full poll interval; `use-cos.ts` guards its own
  // queries the same way.
  let generation = 0;
  let inFlight = false;
  let repeat = false;

  const apply = async (): Promise<void> => {
    if (stopped || context.signal.aborted) return;
    // Returning to the foreground fires visibilitychange and focus, so without
    // this a single return would build the roster twice.
    if (inFlight) {
      repeat = true;
      return;
    }
    inFlight = true;
    const mine = ++generation;
    let fetched: { marks: RowMark[]; faces: Face[] } | null;
    try {
      fetched = await fetchMarks(context.pluginId, context.signal);
    } catch {
      // Leave whatever is on screen; a failed refresh must not blank the rows.
      return;
    } finally {
      inFlight = false;
      if (repeat) {
        repeat = false;
        void apply();
      }
    }
    // A failure, not an empty board: ask again next tick and change nothing.
    if (fetched === null) return;
    if (stopped || context.signal.aborted || mine !== generation) return;
    const marks = fetched.marks;
    // The filled dot is drawn by the faces script, which needs to know which
    // rows carry the finished mark.
    paint = {
      faces: fetched.faces,
      finished: new Set(marks.filter((mark) => mark.kind === "finished").map((mark) => mark.threadId)),
    };
    for (const listener of faceListeners) listener();
    const wanted = new Set(marks.map((mark) => mark.threadId));
    for (const threadId of painted) {
      if (!wanted.has(threadId)) setStatus(threadId, null);
    }
    painted.clear();
    for (const mark of marks) {
      setStatus(mark.threadId, {
        icon: mark.icon,
        label: mark.label,
        ...(mark.tone === undefined ? {} : { tone: mark.tone }),
      });
      painted.add(mark.threadId);
    }
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  const stopPolling = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };
  const startPolling = (): void => {
    if (timer !== null || stopped) return;
    timer = setInterval(() => {
      if (document.visibilityState === "visible") void apply();
    }, POLL_MS);
  };

  const refresh = (): void => {
    if (document.visibilityState !== "visible") {
      stopPolling();
      return;
    }
    startPolling();
    void apply();
  };
  // Faces poll faster than marks while anything is working, so Bloom starts
  // and stops within a few seconds of the turn rather than half a minute.
  const stopFaces = mountSidebarFaces(
    context,
    () => paint,
    (listener) => {
      faceListeners.add(listener);
      return () => faceListeners.delete(listener);
    },
  );
  // OPENING A WORKER CLEARS ITS DOT. bb writes its read time only when the user types
  // in a thread or picks "Mark as read", so viewing a finished worker alone
  // leaves the dot up. While a finished worker's thread is on screen and the window
  // is in front, tell the plugin, which marks it read in bb. Checked on a
  // short tick rather than a navigation hook, because a content script gets
  // no route events and bb's router does not fire popstate on its own pushes.
  let lastSeen: string | null = null;
  const seenTimer = setInterval(() => {
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    const open = threadIdFromPath(window.location.pathname);
    if (open === null) return;
    // Only while this thread shows the dot. A turn that ends while the user is still
    // on the thread puts the dot back, and the next tick clears it again;
    // `lastSeen` only stops a second request for the same dot in flight.
    if (!paint.finished.has(open)) {
      if (lastSeen === open) lastSeen = null;
      return;
    }
    if (lastSeen === open) return;
    lastSeen = open;
    void fetch(`/api/v1/plugins/${context.pluginId}/rpc/thread_seen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: open }),
      signal: context.signal,
    })
      .then(async (response) => {
        const body = response.ok ? ((await response.json()) as { result?: { ok?: boolean } }) : null;
        if (body?.result?.ok !== true) throw new Error("not marked read");
        return apply();
      })
      .catch(() => {
        // Try again, but not every tick: a thread the server refuses would
        // otherwise be asked about every 1.5 seconds for as long as it is open.
        setTimeout(() => {
          if (lastSeen === open) lastSeen = null;
        }, SEEN_RETRY_MS);
      });
  }, SEEN_CHECK_MS);
  const fastTimer = setInterval(() => {
    if (document.visibilityState === "visible" && paint.faces.some((face) => face.working)) void apply();
  }, FAST_POLL_MS);
  void apply();
  startPolling();
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);

  return () => {
    stopped = true;
    stopPolling();
    clearInterval(fastTimer);
    clearInterval(seenTimer);
    stopFaces();
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", refresh);
    for (const threadId of painted) setStatus(threadId, null);
    painted.clear();
  };
}
