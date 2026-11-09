// A timer callback has no caller.
//
// Every other throw in this plugin lands somewhere: an RPC handler returns an
// error to the panel, the job loop catches and marks the row failed, a CLI
// command prints and exits. A `setTimeout` callback is different. Nothing is
// awaiting it and nothing is above it on the stack, so a throw inside one goes
// straight to the process as an uncaught exception.
//
// **The process is not ours.** bb runs every plugin in one shared plugin server,
// so an uncaught throw here does not restart this plugin, it takes down the
// shared server and every in-flight turn with it.
//
// So: nothing this plugin schedules runs bare. Wrap the body, log, carry on.
// The timer keeps its schedule either way, which is the point, because one
// failed throttled publish must not stop publishing.

/** The half of `bb.log` this needs, so a test can pass a plain object. */
export interface WarnLog {
  warn(message: string): void;
}

/**
 * Runs `fn` and swallows anything it throws, logging it against `label`.
 *
 * Returns true when the call completed, false when it threw, so a caller that
 * wants to count failures can. A throw from the logger itself is swallowed
 * too: a logger that fails inside a catch block would defeat the whole point.
 */
export function guarded(label: string, fn: () => void, log: WarnLog): boolean {
  try {
    fn();
    return true;
  } catch (cause) {
    try {
      log.warn(`${label} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } catch {
      // Nothing left to report it to, and the process still must not die.
    }
    return false;
  }
}
