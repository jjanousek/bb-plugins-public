// What the chief and its workers did, grouped by day.
//
// It sits behind the Board / Activity switch at the top of the Mission tab,
// not in a fixed tab of its own: the host draws the plugin icon for every
// fixed tab, so each extra tab is another identical glyph.
import { experimental_useAppPanel } from "@get-bb/plugin-sdk/app";
import type { ActivityEvent, WorkerStatus } from "@/contract";
import { cn } from "@/lib/utils";
import { WORKER_TAB } from "./tabs";
import { TEXT_URGENT } from "./tone";
import {
  Age,
  EmptyState,
  LevelDot,
  NameLine,
  Row,
  RowDetail,
  RowList,
  SectionLabel,
  StaleNote,
  useRovingRows,
} from "./ui";
import { WorkerMark } from "./avatar";
import { dayKey, dayLabel, displayName, stripKindPrefix, useActivity, useRoster } from "./use-cos";

type ActivityKind = ActivityEvent["kind"];

/** The short word each event is filed under. */
const KIND_LABEL: Record<ActivityKind, string> = {
  "chief-created": "Chief started",
  delegate: "Delegated",
  spawn: "Worker created",
  report: "Reported",
  failed: "Failed",
  adopt: "Adopted",
  retire: "Retired",
  forward: "Forwarded",
  import: "Imported",
  // Its own kind, not "failed": a chief crash is not a worker report, so it
  // must not feed "last report Xm ago" or name a worker that does not exist.
  "chief-failed": "Chief failed",
  "chief-restart": "Chief restarted",
  dismiss: "Dismissed",
  remodel: "Remodelled",
  move: "Moved",
  "rate-limited": "Rate-limited",
  retry: "Retried",
  steer: "Steered",
  stop: "Stopped",
  answer: "Answered",
  "board-add": "For you",
  "board-move": "Board",
  maintenance: "Maintenance",
};

/**
 * Who the event is about, by the name the board uses. Activity rows carry the
 * slug and project; the roster maps those to the worker's title. A retired or
 * unknown worker keeps its slug, which is still the truth about it.
 */
/** The worker's title, or its slug, or the project. The row's first cell. */
function subject(event: ActivityEvent, workers: ReadonlyMap<string, WorkerStatus>): string | null {
  if (event.workerName === null && event.projectName === null) return null;
  if (event.workerName === null) return event.projectName;
  const worker = workers.get(`${event.projectName ?? ""}:${event.workerName}`);
  return worker === undefined ? event.workerName : displayName(worker);
}

/**
 * How loud the event is. The same three levels the other two views use, so the
 * dot column means one thing down the whole panel.
 */
function levelOf(kind: ActivityKind): "urgent" | "attention" | "neutral" {
  if (kind === "failed" || kind === "chief-failed") return "urgent";
  if (kind === "rate-limited") return "attention";
  return "neutral";
}

interface Day {
  key: string;
  label: string;
  events: ActivityEvent[];
}

/** Newest first, split into consecutive days. */
export function groupByDay(events: readonly ActivityEvent[]): Day[] {
  const sorted = [...events].sort((a, b) => b.at - a.at);
  const days: Day[] = [];
  for (const event of sorted) {
    const key = dayKey(event.at);
    const last = days[days.length - 1];
    if (last !== undefined && last.key === key) last.events.push(event);
    else days.push({ key, label: dayLabel(event.at), events: [event] });
  }
  return days;
}

export function ActivityList() {
  const panel = experimental_useAppPanel();
  const activity = useActivity(150);
  const roster = useRoster();
  // The worker itself, not just its title: the row's lead box wants the avatar,
  // which is the one thing that makes a log scannable by who did it.
  const workers = new Map<string, WorkerStatus>();
  for (const worker of roster.data?.workers ?? []) {
    workers.set(`${worker.projectName}:${worker.name}`, worker);
  }

  // Above every early return, because a hook has to run on every render. A
  // hook below an early return makes the first render after loading call one
  // more hook than the render before it, which React refuses with error #310.
  // Neither tsc nor the unit tests can see it: a hook-order fault only exists
  // while the thing is running.
  const days = activity.data === null ? [] : groupByDay(activity.data);
  const navigation = useRovingRows(
    days.flatMap((day) => day.events.map((event) => String(event.id))),
  );

  if (activity.error !== null && activity.data === null) {
    return <p className={cn("py-3 text-[13px]", TEXT_URGENT)}>{activity.error}</p>;
  }
  if (activity.data === null) {
    return <p className="py-3 text-[13px] text-muted-foreground">Loading</p>;
  }
  if (activity.data.length === 0) {
    return (
      <div>
        {activity.stale ? (
          <StaleNote error={activity.error ?? ""} onRetry={activity.refetch} />
        ) : null}
        <EmptyState
          title="No activity yet"
          detail="Delegations, worker reports, and failures show up here."
        />
      </div>
    );
  }

  const open = (threadId: string) => {
    panel.openFixedTab({ surface: { kind: "current" }, tab: WORKER_TAB, target: { threadId } });
  };

  return (
    <div className="@[860px]/cos:max-w-[860px]" {...navigation.containerProps}>
      {activity.stale ? (
        <StaleNote error={activity.error ?? ""} onRetry={activity.refetch} />
      ) : null}
      {days.map((day) => (
        <section key={day.key}>
          {/* No count: the rows are right there, and a number on a label
              adds nothing. */}
          <SectionLabel label={day.label} />
          <RowList ariaLabel={day.label}>
            {day.events.map((event) => {
              const key = `${event.projectName ?? ""}:${event.workerName ?? ""}`;
              const worker = workers.get(key);
              const who = subject(event, workers);
              const chief =
                event.kind === "chief-created" ||
                event.kind === "chief-failed" ||
                event.kind === "chief-restart";
              const threadId = event.threadId;
              return (
                <Row
                  key={event.id}
                  rowKey={String(event.id)}
                  tabIndex={navigation.tabIndexFor(String(event.id))}
                  dot={<LevelDot level={levelOf(event.kind)} />}
                  // The same 20px box the other two views spend on a face or a
                  // chevron, so all three lists share a left edge. An event
                  // whose worker is gone, or a chief event, gets the empty ring
                  // rather than a gap.
                  lead={<WorkerMark avatar={worker?.avatar ?? null} label={who ?? ""} />}
                  title={
                    // The subject is the name and the kind is the note, which
                    // is the same shape the Board uses, so the fact that says
                    // what happened is never the smallest thing on the row.
                    <NameLine
                      name={who ?? KIND_LABEL[event.kind]}
                      note={who === null ? undefined : KIND_LABEL[event.kind].toLowerCase()}
                      noteTone={levelOf(event.kind) === "urgent" ? "urgent" : "muted"}
                      project={event.projectName ?? undefined}
                      hideProjectWhenNarrow
                    />
                  }
                  body={
                    <RowDetail
                      text={stripKindPrefix(event.excerpt)}
                      clamp={2}
                      size="sm"
                      tone="muted"
                    />
                  }
                  age={<Age at={event.at} />}
                  onOpen={threadId === null ? undefined : () => open(threadId)}
                  openLabel={
                    threadId === null ? undefined : chief ? "Open the chief thread" : "Open this worker"
                  }
                  shortcuts={threadId === null ? undefined : { thread: () => open(threadId) }}
                />
              );
            })}
          </RowList>
        </section>
      ))}
    </div>
  );
}
