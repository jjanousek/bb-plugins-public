// The panel's polling clock, with no imports so it runs under node --test.
// Copied from chief-of-staff (components/cos/visible-poll.ts).

/** The part of `document` the poll reads. */
export interface VisibilitySource {
  visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** The timer calls the poll makes, injectable so a test can drive the clock. */
export interface PollTimers {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/**
 * Call `tick` every `pollMs` while the document is visible, and once when it
 * becomes visible again. Returns the cleanup.
 *
 * Without this, the panel's 20 s poll kept rebuilding the
 * roster in a hidden tab, up to 4,320 times a day per tab. The timer keeps
 * running and each tick is a no-op while hidden, the same rule row-marks.ts
 * already uses for the sidebar. With no document (a server render) it polls
 * as before.
 */
export function startVisiblePoll(
  doc: VisibilitySource | null,
  tick: () => void,
  pollMs: number,
  timers: PollTimers = { setInterval: (h, ms) => setInterval(h, ms), clearInterval: (h) => clearInterval(h as never) },
): () => void {
  const visible = () => doc === null || doc.visibilityState === "visible";
  const handle = timers.setInterval(() => {
    if (visible()) tick();
  }, pollMs);
  let wasVisible = visible();
  const onChange = () => {
    const now = visible();
    if (now && !wasVisible) tick();
    wasVisible = now;
  };
  doc?.addEventListener("visibilitychange", onChange);
  return () => {
    timers.clearInterval(handle);
    doc?.removeEventListener("visibilitychange", onChange);
  };
}
