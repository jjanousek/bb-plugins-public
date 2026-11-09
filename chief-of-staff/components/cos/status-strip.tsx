// The one line that answers "where do things stand" on both surfaces.
//
// Left: how the chief itself is doing. Right: the counts worth acting on, as
// a segmented control of plain words. A group with nothing in it is not shown
// at all, so the line is short whenever the day is quiet; the one exception is
// the count that is currently filtering, which stays on screen at zero so it
// can be tapped to clear. In the Mission tab the counts are
// filters; on the homepage they open the panel.
import type { ReactNode } from "react";
import type { Summary } from "@/contract";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { cn } from "@/lib/utils";
import { StatusDot } from "./status-dot";
import { TEXT_URGENT } from "./tone";
import { Segmented, useIsFingerSurface, type SegmentOption } from "./ui";
import { chiefLine, chiefTone, relativeTime } from "./use-cos";

/** The five groups the counts select, loudest first. */
export type MissionFilter = "needs-you" | "decisions" | "routing" | "working" | "idle";

export const MISSION_FILTERS: readonly MissionFilter[] = [
  "needs-you",
  "decisions",
  "routing",
  "working",
  "idle",
];

/** [one, many]. "1 needs you" reads better than "1 need you". */
const FILTER_LABEL: Record<MissionFilter, [string, string]> = {
  "needs-you": ["needs you", "need you"],
  decisions: ["decision", "decisions"],
  routing: ["for the chief", "for the chief"],
  working: ["working", "working"],
  idle: ["idle", "idle"],
};

export function filterCount(summary: Summary, filter: MissionFilter): number {
  switch (filter) {
    case "needs-you":
      return summary.needsYou;
    case "decisions":
      return summary.decisions;
    // Chief-directed needs. Quiet by construction: no tone, and it only shows
    // up at all when a worker has actually routed something.
    case "routing":
      return summary.routing;
    case "working":
      return summary.busy;
    case "idle":
      return summary.idle;
  }
}

/**
 * `-my-3 py-3` turns the 20px count line into a 44px hit area without moving
 * the line it sits on.
 */
const COMPACT_COUNT_HIT_AREA = "-my-3 py-3";

/**
 * One option per group that has anything in it, plus the group that is doing
 * the filtering even when its count has fallen to zero.
 *
 * That exemption is what stops the board going blank: the strip renders only
 * the active option on compact, so dropping it would leave nothing on screen
 * carrying the filter and no way to clear it. Callers that
 * report rather than filter (the home card, the at-a-glance strip) pass no
 * `active` and keep every non-empty option.
 */
export function filterOptions(
  summary: Summary,
  active: MissionFilter | null = null,
): SegmentOption[] {
  const options: SegmentOption[] = [];
  for (const filter of MISSION_FILTERS) {
    const count = filterCount(summary, filter);
    if (count === 0 && filter !== active) continue;
    const [one, many] = FILTER_LABEL[filter];
    options.push({
      id: filter,
      label: count === 1 ? one : many,
      count,
      ...(filter === "needs-you"
        ? { tone: "urgent" as const }
        : filter === "decisions"
          ? { tone: "attention" as const }
          : {}),
    });
  }
  return options;
}

export interface StatusStripProps {
  summary: Summary;
  /** The underlined count, or null when nothing is filtered. */
  active?: MissionFilter | null;
  /** Called with the clicked count. Toggling is the caller's business. */
  onSelect: (filter: MissionFilter) => void;
  /** Hidden while a view that the counts do not filter is showing. */
  showCounts?: boolean;
  /** Rendered at the far right (Delegate, and so on). */
  actions?: ReactNode;
  /** When set, the chief line itself is the way into the chief's conversation. */
  onOpenChief?: () => void;
  className?: string;
}

export function StatusStrip({
  summary,
  active = null,
  onSelect,
  showCounts = true,
  actions,
  onOpenChief,
  className,
}: StatusStripProps) {
  // Two different questions, kept in two variables. How
  // many counts fit is a viewport question; how big a target has to be is
  // a pointer question. A coarse-pointer tablet in landscape is over 767px,
  // so tying both to the viewport would give it 20px counts directly above
  // the 44px view words one line below.
  const compact = useIsCompactViewport();
  const finger = useIsFingerSurface();
  const countHitArea = finger ? COMPACT_COUNT_HIT_AREA : undefined;
  const status = summary.chiefStatus;
  const chiefClassName = chiefTone(status);
  const options = filterOptions(summary, active);
  // On a phone the strip says one thing. That is the loudest
  // count, which is the first option because MISSION_FILTERS is already
  // loudest first, unless a filter is on: the active count has to stay on
  // screen, because tapping it again is how a phone clears the filter.
  const loudest = options.find((option) => option.id === active) ?? options[0];
  const loudestOnly = loudest === undefined ? [] : [loudest];
  // The chief line. The number after it is the newest worker report, not the
  // chief's own, and the wording says so.
  // `truncate` sits on the report-age clause, not on the paragraph. On the
  // paragraph it would cut whatever comes last, which is the failure count.
  // The loudest thing on the line must not be the first casualty of width.
  // The gap is on the paragraph, not in the text: each clause is a flex item,
  // and a flex item drops its own leading space.
  const chiefText = (
    <p className="flex min-w-0 items-baseline gap-x-1 text-[12px] leading-5 text-muted-foreground">
      <span className={cn("shrink-0", chiefClassName ?? "text-foreground")}>{chiefLine(status)}</span>
      {compact ? null : (
        <>
          {/* Panel width is a container fact, not a viewport one: on a
              narrow container the report age goes, the count
              stays. */}
          {/* The one clause that may be cut, and the first to go on width. */}
          <span className="min-w-0 truncate @max-[560px]/cos:hidden">
            {summary.lastActivityAt === null
              ? "· no worker reports yet"
              : `· last worker report ${relativeTime(summary.lastActivityAt)} ago`}
          </span>
          {/* Two coloured words on one line is a bug, and
              a dead chief outranks a worker failure count. */}
          {/* "of them", because a stopped worker is already inside the needs-you
              count: the summary loop counts `failed` under the same condition,
              so there is no state where failed is above zero and needs-you is
              not. Two overlapping numbers side by side read as two separate
              claims on the reader's attention. */}
          {summary.failed === 0 || chiefClassName !== undefined ? null : (
            <span className={cn("shrink-0", TEXT_URGENT)}>
              {"· "}
              {summary.needsYou > 0
                ? `${summary.failed} of them stopped`
                : `${summary.failed} stopped`}
            </span>
          )}
        </>
      )}
    </p>
  );
  return (
    <div
      className={cn(
        // One line, always, at every width: a wrapped strip pushes Delegate
        // off a 390px card and zig-zags a 230px panel.
        "flex min-w-0 flex-nowrap items-center gap-x-4",
        className,
      )}
    >
      {onOpenChief === undefined ? (
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot status={status ?? "idle"} />
          {chiefText}
        </div>
      ) : (
        <button
          type="button"
          onClick={onOpenChief}
          aria-label={`${chiefLine(status)}. Open the chief conversation.`}
          className="flex min-w-0 cursor-pointer items-center gap-2 rounded-sm text-left hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <StatusDot status={status ?? "idle"} />
          {chiefText}
        </button>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-6">
        {!showCounts ? null : compact ? (
          <Segmented
            options={loudestOnly}
            value={active}
            onSelect={(id) => onSelect(id as MissionFilter)}
            optionClassName={countHitArea}
          />
        ) : (
          <>
            {/* Every count when the panel has room; only the loudest on a
                narrow container, where the rest would wrap onto a second line
                (the one-line rule, applied to the container). Without a named container ancestor
                neither variant matches, so the homepage and the at-a-glance
                strip keep the full set. */}
            <Segmented
              className="@max-[420px]/cos:hidden"
              options={options}
              value={active}
              onSelect={(id) => onSelect(id as MissionFilter)}
              optionClassName={countHitArea}
            />
            <Segmented
              className="hidden @max-[420px]/cos:flex"
              options={loudestOnly}
              value={active}
              onSelect={(id) => onSelect(id as MissionFilter)}
              optionClassName={countHitArea}
            />
          </>
        )}
        {actions}
      </div>
    </div>
  );
}
