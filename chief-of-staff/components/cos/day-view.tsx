// The day, as lanes.
//
// Activity is a list, and a list cannot show rhythm: who worked overnight,
// whether a team stalled all at once, whether seven failures were seven
// problems or one. This draws the same log as one lane per worker across a
// home-zone day. It sits beside the log, never instead of it.
//
// A bar runs from a dispatch to the turn's ending. An ending with no dispatch
// in front of it is drawn as a tick, never as a bar with an invented start:
// day.ts carries that rule and its test. A burst of failures is also said in
// words, above the lanes, because a cluster of red ticks is easy to miss and
// "7 failed within 2 minutes" is not.
//
// Deliberately NOT here: a quota line. Nothing keeps quota history, only the
// current reading, and drawing a line from one number would be inventing the
// rest of it.
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { DOT_ATTENTION, TEXT_ATTENTION, TEXT_TERTIARY, TEXT_URGENT } from "./tone";
import { BAR_WORD_HIT_AREA, QuietButton, StaleNote, useIsFingerSurface } from "./ui";
import { useActivityDay } from "./use-cos";
import { HOME_UTC_OFFSET_MS, dayMarks, failureBursts, homeDay, laneOrder, type DayMark, type DayMarkKind } from "./day";

/**
 * One hue family per kind, chosen for BOTH canvases. `limited` takes the
 * attention token, 5.12:1 on white and 7.81:1 on dark, the same level the Log
 * view gives it. A destructive tint at 60% comes out about 1.03:1 against the
 * grey report bar on white, so a rate limit would read as one more report.
 */
const KIND_CLASS: Record<DayMarkKind, string> = {
  report: "bg-muted-foreground/70",
  failed: "bg-destructive",
  limited: DOT_ATTENTION,
};

/**
 * A SHAPE per kind as well as a hue, so the lanes still read in grayscale or
 * to a colour-blind eye. A failure fills the lane's full height,
 * a report sits in the middle, a rate limit is a thin line near the base.
 * Hue alone fails on the one thing this view exists to show: a lone failure in
 * a busy lane looks like one more report.
 */
const KIND_SHAPE: Record<DayMarkKind, string> = {
  report: "top-1 h-2",
  failed: "top-0 h-4",
  limited: "top-[11px] h-[3px]",
};

const KIND_WORD: Record<DayMarkKind, string> = {
  report: "report",
  failed: "failed",
  limited: "rate-limited",
};

const HOUR = 3_600_000;

function hhmm(at: number): string {
  // Home-zone wall clock (HOME_UTC_OFFSET_MS), independent of the browser's zone.
  const d = new Date(at + HOME_UTC_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function DayView({ onOpenThread }: { onOpenThread: (threadId: string) => void }) {
  // The day picked, as an absolute start, or null for "today". An offset
  // from now would slide a past day forward at midnight along with today, and
  // a memo on the offset would freeze "Today" at the day the view opened. Only
  // "today" follows the clock.
  const [picked, setPicked] = useState<number | null>(null);
  const today = homeDay(Date.now());
  const day = picked === null ? today : homeDay(picked);
  const isToday = day.start === today.start;
  const step = (days: number) => {
    const next = day.start + days * 24 * HOUR + HOUR;
    setPicked(homeDay(next).start >= today.start ? null : next);
  };
  // Twelve hours before the day starts too, so a turn dispatched last night
  // and ending this morning has its start in the log.
  const live = useActivityDay(day.start - 12 * HOUR, day.end);
  const [hover, setHover] = useState<DayMark | null>(null);
  // A selected turn belongs to the day it was picked on, so Earlier or Later
  // clears it: otherwise yesterday's lanes would show today's turn and, on a
  // finger, offer to open today's thread.
  useEffect(() => setHover(null), [day.start]);
  const finger = useIsFingerSurface();
  /**
   * The turn nearest a tap along a lane. On a phone an hour is about 10px and
   * a mark is 3 to 8px, so no single mark can be a 44px target without
   * overlapping its neighbours: the lane row is the target, and the tap picks
   * the mark closest to where it landed. A tap SELECTS on a finger rather than
   * opening the thread, because the detail line is what this view adds and
   * opening the thread would leave the view to read it.
   */
  /** Arrow keys step through one lane's turns; Enter opens the selected one. */
  const stepLane = (lane: string, event: React.KeyboardEvent<HTMLDivElement>) => {
    const inLane = marks.filter((m) => m.lane === lane);
    if (inLane.length === 0) return;
    const at = hover !== null && hover.lane === lane ? inLane.indexOf(hover) : -1;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      const next = at === -1 ? (step === 1 ? 0 : inLane.length - 1) : Math.min(inLane.length - 1, Math.max(0, at + step));
      setHover(inLane[next]!);
    } else if (event.key === "Enter" && at !== -1 && inLane[at]!.threadId) {
      event.preventDefault();
      onOpenThread(inLane[at]!.threadId!);
    }
  };

  const pickNearest = (lane: string, event: React.MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    const at = day.start + ((event.clientX - box.left) / box.width) * 24 * HOUR;
    let best: DayMark | null = null;
    for (const m of marks) {
      if (m.lane !== lane) continue;
      const inside = m.start !== null && at >= m.start && at <= m.end;
      const distance = inside ? 0 : Math.min(Math.abs(at - m.end), m.start === null ? Infinity : Math.abs(at - m.start));
      const bestDistance =
        best === null
          ? Infinity
          : best.start !== null && at >= best.start && at <= best.end
            ? 0
            : Math.min(Math.abs(at - best.end), best.start === null ? Infinity : Math.abs(at - best.start));
      if (distance < bestDistance) best = m;
    }
    if (best !== null) setHover(best);
  };

  const marks = useMemo(
    () => (live.data === null ? [] : dayMarks(live.data.events, day.start, day.end)),
    [live.data, day.start, day.end],
  );
  const lanes = useMemo(() => laneOrder(marks), [marks]);
  const bursts = useMemo(() => failureBursts(marks), [marks]);
  const now = Date.now();
  const nowPct = now >= day.start && now < day.end ? ((now - day.start) / (24 * HOUR)) * 100 : null;
  const pct = (at: number) => ((at - day.start) / (24 * HOUR)) * 100;
  // Counted apart, like the legend, so a day of rate limits and no failures
  // does not read "3 failed" beside amber bars the legend calls rate-limited.
  const counts = {
    turns: marks.length,
    failed: marks.filter((m) => m.kind === "failed").length,
    limited: marks.filter((m) => m.kind === "limited").length,
  };

  return (
    <div className="pt-2">
      <div className={cn("flex items-center gap-3 pb-2 text-[12px] leading-5", finger && "pt-4")}>
        <QuietButton
          onClick={() => step(-1)}
          className={finger ? BAR_WORD_HIT_AREA : undefined}
        >
          Earlier
        </QuietButton>
        <span className="text-foreground">{isToday ? `Today, ${day.label}` : day.label}</span>
        <QuietButton
          onClick={() => step(1)}
          disabled={isToday}
          className={finger ? BAR_WORD_HIT_AREA : undefined}
        >
          Later
        </QuietButton>
        <span className={cn("ml-auto", TEXT_TERTIARY)}>home time</span>
      </div>

      {live.stale ? <StaleNote error={live.error ?? ""} onRetry={live.refetch} /> : null}
      {live.data === null ? (
        <p className="py-3 text-[13px] text-muted-foreground">{live.error ?? "Loading"}</p>
      ) : (
        <>
          <p className={cn("pb-2 text-[12px] leading-5", TEXT_TERTIARY)}>
            {counts.turns === 0
              ? "No turns ended this day."
              : [
                  `${counts.turns} turns ended`,
                  `${counts.failed} failed`,
                  ...(counts.limited > 0 ? [`${counts.limited} rate-limited`] : []),
                ].join(" · ")}
            {live.data.truncated ? " · the day was too busy to draw in full" : null}
          </p>

          {/* The pattern this view exists for, in words rather than left to the eye. */}
          {bursts.map((burst) => (
            <p key={burst.at} className={cn("pb-1 text-[12px] leading-5", burst.limitedOnly ? TEXT_ATTENTION : TEXT_URGENT)}>
              {burst.count} {burst.limitedOnly ? "rate-limited" : "failed"} together at {hhmm(burst.at)}, across{" "}
              {burst.lanes.length} {burst.lanes.length === 1 ? "worker" : "workers"}: most likely one cause, not{" "}
              {burst.count}.
            </p>
          ))}

          {lanes.length === 0 ? null : (
            <div className="mt-2">
              {/* The hour axis. */}
              <div className="grid grid-cols-[minmax(0,120px)_1fr] gap-x-2">
                <span />
                <div className={cn("relative h-4 text-[10px] tabular-nums", TEXT_TERTIARY)}>
                  {[0, 6, 12, 18, 24].map((h) => (
                    // The ends are anchored inward so "00" and "24" do not hang
                    // off the lane; the middle ticks centre on their hour.
                    <span
                      key={h}
                      className={cn("absolute", h === 0 ? "" : h === 24 ? "-translate-x-full" : "-translate-x-1/2")}
                      style={{ left: `${(h / 24) * 100}%` }}
                    >
                      {String(h).padStart(2, "0")}
                    </span>
                  ))}
                </div>
              </div>
              {lanes.map((lane) => (
                <div
                  key={lane}
                  className={cn(
                    "grid grid-cols-[minmax(0,120px)_1fr] items-center gap-x-2 py-[3px]",
                    finger && "min-h-11",
                  )}
                >
                  <span className="truncate text-[12px] leading-5 text-muted-foreground">{lane}</span>
                  {/*
                    One tab stop per lane, not one per bar: a busy day has a
                    great many bars, and Tab would walk every one. Arrow keys move
                    between this lane's turns and Enter opens the selected one.
                  */}
                  <div
                    role="group"
                    aria-label={`${lane}, ${marks.filter((m) => m.lane === lane).length} turns`}
                    tabIndex={0}
                    onKeyDown={(event) => stepLane(lane, event)}
                    onClick={finger ? (event) => pickNearest(lane, event) : undefined}
                    className="relative h-4 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring bg-[repeating-linear-gradient(90deg,transparent_0,transparent_calc(100%/4_-_1px),var(--border)_calc(100%/4_-_1px),var(--border)_calc(100%/4))]"
                  >
                    {marks
                      .filter((m) => m.lane === lane)
                      .map((m) => {
                        const left = pct(m.start ?? m.end);
                        const width = m.start === null ? 0 : pct(m.end) - pct(m.start);
                        return (
                          <button
                            key={`${m.lane}${m.end}`}
                            type="button"
                            tabIndex={-1}
                            onMouseEnter={() => setHover(m)}
                            onClick={(event) => {
                              if (finger) {
                                event.stopPropagation();
                                setHover(m);
                                return;
                              }
                              if (m.threadId) onOpenThread(m.threadId);
                            }}
                            aria-label={`${m.lane}, ${KIND_WORD[m.kind]} at ${hhmm(m.end)}`}
                            className={cn(
                              "absolute rounded-[2px] hover:outline hover:outline-1 hover:outline-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-foreground",
                              KIND_SHAPE[m.kind],
                              KIND_CLASS[m.kind],
                            )}
                            // A tick is 3px wide, so an ending with no known
                            // start is visible without pretending to a duration.
                            style={{ left: `${left}%`, width: m.start === null ? "3px" : `max(3px, ${width}%)` }}
                          />
                        );
                      })}
                    {nowPct === null ? null : (
                      <span className="absolute -inset-y-1 w-px bg-foreground/70" style={{ left: `${nowPct}%` }} aria-hidden />
                    )}
                  </div>
                </div>
              ))}

              <div
                aria-live="polite"
                className="mt-3 min-h-[44px] border-t border-border pt-2 text-[12px] leading-5 text-muted-foreground"
              >
                {hover === null ? (
                  finger
                    ? "Tap a lane to read the turn nearest your tap."
                    : "Point at a bar, or Tab to a lane and use the arrow keys, to read how a turn ended."
                ) : (
                  <>
                    <span className="font-medium text-foreground">{hover.lane}</span>
                    {" · "}
                    {hover.start === null ? `ended ${hhmm(hover.end)}` : `${hhmm(hover.start)} to ${hhmm(hover.end)}`}
                    {" · "}
                    {KIND_WORD[hover.kind]}
                    {hover.text === "" ? null : (
                      <span className="mt-0.5 block truncate">{hover.text.split("\n")[0]}</span>
                    )}
                    {/* On a finger a tap selects, so opening needs its own word. */}
                    {finger && hover.threadId !== null ? (
                      <QuietButton
                        tone="primary"
                        className={cn("mt-1", BAR_WORD_HIT_AREA)}
                        onClick={() => onOpenThread(hover.threadId!)}
                      >
                        Open thread
                      </QuietButton>
                    ) : null}
                  </>
                )}
              </div>

              <div className={cn("mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]", TEXT_TERTIARY)}>
                {(Object.keys(KIND_WORD) as DayMarkKind[]).map((kind) => (
                  <span key={kind} className="inline-flex items-center gap-1.5">
                    <i className="relative inline-block h-4 w-3">
                      <i className={cn("absolute inset-x-0 rounded-[2px]", KIND_SHAPE[kind], KIND_CLASS[kind])} />
                    </i>
                    {KIND_WORD[kind]}
                  </span>
                ))}
                <span>A thin tick is a turn whose start is not in the log.</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
