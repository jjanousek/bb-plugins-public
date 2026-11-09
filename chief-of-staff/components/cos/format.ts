// Formatting the whole panel shares. Plain TypeScript with no imports and no
// JSX, so `node --test` can load it: type stripping refuses a .tsx outright
// (ERR_UNKNOWN_FILE_EXTENSION), which means anything that lives in ui.tsx is
// unreachable from a unit test. A pure function that cannot be tested drifts.

/**
 * The one time format the panel uses, on every row of every view.
 *
 * Relative under a day, the date after it. Items added in one sitting all read
 * the same age in hours, and a column of near-identical hour counts
 * distinguishes nothing. An age is only useful while it is still an age.
 *
 * The month table is explicit rather than `toLocaleString`, which returns
 * "Sept" for September in en-GB, four characters in a rail sized for three, and
 * which moves between ICU versions. A rail whose width depends on the runtime
 * is not a rail.
 */
export function stamp(at: number, now: number): string {
  const hours = (now - at) / 3_600_000;
  if (hours < 24) {
    const minutes = Math.floor((now - at) / 60_000);
    return minutes < 60 ? `${Math.max(0, minutes)}m` : `${Math.floor(hours)}h`;
  }
  const date = new Date(at);
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/**
 * How long this has been waiting, for a rail that is triage rather than a log.
 *
 * `stamp` turns into a calendar date past 24 hours, which is right for the
 * Activity log, where the question is "when did this happen". On a decision
 * list the question is "how long has this been sitting", and a calendar date
 * makes the reader do the subtraction. It is also wider than an age like "4d",
 * which is the difference between a 44px rail and a 24px one next to a
 * sentence that wants the width.
 */
export function elapsed(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 60) return `${Math.max(0, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return weeks < 9 ? `${weeks}w` : `${Math.floor(days / 30)}mo`;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * Local "HH:MM" for a time today, with the date in front otherwise.
 *
 * Here rather than in core.ts because components never import core.ts: the
 * dependency runs the other way, core.ts re-exporting the no-import modules,
 * the way it already does for execution-levels.ts. One function serves the
 * CLI roster, the two rate-limit refusals and the board's own rate-limit note,
 * so they print the same string from the same fact, and it takes a `now` so it
 * can be tested.
 */
export function formatClock(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = new Date(now);
  const sameDay =
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  if (sameDay) return hhmm;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hhmm}`;
}

/**
 * Compact age: "12s", "4m", "3h", "2d", with the " ago" only where the caller
 * wants it.
 *
 * One bucket table for the server and the panel, so the two agree at the
 * boundaries, and it takes a `now` so it can be tested.
 */
export function relativeTime(at: number, now = Date.now(), { suffix = true }: { suffix?: boolean } = {}): string {
  const tail = suffix ? " ago" : "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s${tail}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m${tail}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h${tail}`;
  return `${Math.round(hours / 24)}d${tail}`;
}
