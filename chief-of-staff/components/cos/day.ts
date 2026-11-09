// Pure helpers for the day view. No imports.
//
// Activity is a list, and a list cannot show rhythm: who worked overnight,
// whether a team stalled all at once, whether seven failures were seven
// problems or one. This lays the same events out as lanes across a day.
//
// WHAT A BAR IS, stated because the data does not hold a turn's duration. The
// log records a dispatch (`delegate`, `steer`, `retry`, `spawn`) and, later,
// how the turn ended (`report`, `failed`). A bar runs from the latest dispatch
// before an ending to that ending. An ending with no dispatch in front of it
// inside `PAIR_WINDOW_MS` is a turn someone else started, or one that began
// before the log did, and it is drawn as a tick at its end rather than as a bar
// with an invented start.

export type DayMarkKind = "report" | "failed" | "limited";

export interface DayMark {
  lane: string;
  /** Null when the start is not in the log: drawn as a tick at `end`. */
  start: number | null;
  end: number;
  kind: DayMarkKind;
  text: string;
  threadId: string | null;
}

export interface DayEvent {
  at: number;
  kind: string;
  workerName: string | null;
  threadId: string | null;
  excerpt: string;
}

/** A turn longer than this is not paired: the dispatch was for something else. */
export const PAIR_WINDOW_MS = 3 * 3_600_000;

const STARTS = new Set(["delegate", "steer", "retry", "spawn"]);

/**
 * The home zone's offset from UTC, fixed. Keep it equal to HOME_TIME_ZONE in
 * core.ts (UTC as shipped; set both to your own zone).
 */
export const HOME_UTC_OFFSET_MS = 0;

/**
 * The user's calendar day in the home zone, [start, end), holding `at`. A
 * fixed offset rather than Intl, so the browser's own zone never moves the day.
 */
export function homeDay(at: number): { start: number; end: number; label: string } {
  const offset = HOME_UTC_OFFSET_MS;
  const local = at + offset;
  const startLocal = local - (((local % 86_400_000) + 86_400_000) % 86_400_000);
  const d = new Date(startLocal);
  const label = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return { start: startLocal - offset, end: startLocal - offset + 86_400_000, label };
}

/**
 * One mark per ended turn in [dayStart, dayEnd). A turn that started the day
 * before is clipped to the day's start rather than dropped, so an overnight run
 * still shows.
 *
 * `limited` is a rate-limit ending, kept apart from `failed` because several
 * of those at one minute are one fact.
 *
 * There is no "asked you" kind on purpose. It could only read a Need line out
 * of the report's excerpt, and the excerpt is the report's FIRST 300
 * characters while the status block is its LAST lines, so the excerpt rarely
 * holds a Need line and the count would read "0 asked you" while a worker is
 * waiting. A count that can only ever be zero is the "could not look, answered
 * nothing there" defect, so the claim is not made.
 */
export function dayMarks(events: readonly DayEvent[], dayStart: number, dayEnd: number): DayMark[] {
  const byThread = new Map<string, DayEvent[]>();
  for (const e of events) {
    if (e.threadId === null || e.workerName === null) continue;
    const list = byThread.get(e.threadId) ?? [];
    list.push(e);
    byThread.set(e.threadId, list);
  }
  const marks: DayMark[] = [];
  for (const [threadId, list] of byThread) {
    list.sort((a, b) => a.at - b.at);
    let lastStart: number | null = null;
    for (const e of list) {
      if (STARTS.has(e.kind)) {
        lastStart = e.at;
        continue;
      }
      if (e.kind !== "report" && e.kind !== "failed" && e.kind !== "rate-limited") continue;
      const start = lastStart !== null && e.at - lastStart <= PAIR_WINDOW_MS ? lastStart : null;
      lastStart = null;
      if (e.at < dayStart || e.at >= dayEnd) continue;
      const kind: DayMarkKind = e.kind === "failed" ? "failed" : e.kind === "rate-limited" ? "limited" : "report";
      marks.push({
        lane: e.workerName!,
        start: start === null ? null : Math.max(start, dayStart),
        end: e.at,
        kind,
        text: e.excerpt,
        threadId,
      });
    }
  }
  return marks.sort((a, b) => a.end - b.end);
}

/**
 * Failures that happened together, which is the one pattern this view is for.
 *
 * Three or more failures inside `window` are one burst. Returned so the view
 * can say "3 failed within 2 minutes" in words, beside the bars, rather than
 * leave the reader to count red ticks.
 */
export function failureBursts(
  marks: readonly DayMark[],
  window = 5 * 60_000,
  min = 3,
): { at: number; count: number; lanes: string[]; limitedOnly: boolean }[] {
  const failed = marks.filter((m) => m.kind === "failed" || m.kind === "limited").sort((a, b) => a.end - b.end);
  const bursts: { at: number; count: number; lanes: string[]; limitedOnly: boolean }[] = [];
  let i = 0;
  while (i < failed.length) {
    let j = i;
    while (j + 1 < failed.length && failed[j + 1]!.end - failed[i]!.end <= window) j += 1;
    const run = failed.slice(i, j + 1);
    if (run.length >= min) {
      bursts.push({
        at: run[0]!.end,
        count: run.length,
        lanes: [...new Set(run.map((m) => m.lane))],
        // A burst of rate limits is a quota fact, not a failure, and is said
        // and coloured as one; a mixed burst stays a failure.
        limitedOnly: run.every((m) => m.kind === "limited"),
      });
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return bursts;
}

/** Lanes that had anything that day, busiest first, then by name. */
export function laneOrder(marks: readonly DayMark[]): string[] {
  const count = new Map<string, number>();
  for (const m of marks) count.set(m.lane, (count.get(m.lane) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([lane]) => lane);
}
