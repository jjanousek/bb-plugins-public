// Mission: everything the chief is running, ordered by how much of your
// attention it wants.
//
// Two views behind one quiet switch. Board reads top to bottom as a priority
// list: the status line, then the workers blocked on you, the decisions they
// asked you for, what they routed to the chief, what is running, what is
// parked, and last the two archives (unmanaged threads and Claude sessions
// found on disk), each collapsed to a single line. Activity is the same list
// of hairline rows, by day.
//
// There are no cards here. A group is a label, a row is a line, an action is
// a word that appears when you point at the row it belongs to. Width is read
// with container queries, never media queries: at an 820px viewport with the
// sidebar open this panel is a 250px column, which no viewport query can see.
import { useId, useState, type ReactNode } from "react";
import {
  experimental_useAppPanel,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { ExternalSession, OtherThread, Summary, WorkerStatus } from "@/contract";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { cn } from "@/lib/utils";
import { ActivityList } from "./activity-list";
import { BoardTab } from "./board-tab";
import { TeamsView, type TeamsActions } from "./teams-view";
import { DayView } from "./day-view";
import { useRememberedChoice } from "./remembered";
import { AdoptDialog } from "./adopt-dialog";
import { ImportDialog } from "./import-dialog";
import { RowActions, type RowActionItem } from "./row-actions";
import { WorkerMark } from "./avatar";
import { StatusDot } from "./status-dot";
import { StatusStrip, type MissionFilter } from "./status-strip";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { useDeepLinkTab } from "./deep-link";
import { CHIEF_PANEL_PATH, DELEGATE_SUBPATH, WORKER_TAB } from "./tabs";
import { TEXT_TERTIARY, TEXT_URGENT } from "./tone";
import {
  Age,
  BAR_WORD_HIT_AREA,
  COMPACT_WORD_HIT_AREA,
  ChoiceWord,
  ConfirmDialog,
  DisclosureRow,
  Elapsed,
  EmptyState,
  NameLine,
  QuietButton,
  Row,
  RowDetail,
  RowList,
  SectionLabel,
  Segmented,
  StaleNote,
  useIsFingerSurface,
  useNewRowKeys,
  useRovingRows,
  type SegmentOption,
} from "./ui";
import {
  bucketRoster,
  displayName,
  errorText,
  executionLabel,
  formatMb,
  groupSessionsByCwd,
  levelWord,
  needsYouLine,
  projectLabel,
  rowUrgency,
  newForYouLabel,
  unreadLabel,
  sessionLabel,
  unimportedSessions,
  useCosRpc,
  useProjects,
  useRoster,
  useSessions,
  useSummary,
  workerNote,
  workerStatus,
} from "./use-cos";

type View = "foryou" | "board" | "activity";

/**
 * The three views, with a count only where a count is information.
 *
 * Three, not four. A separate summary view whose middle band repeats the
 * "For you" list, from the same query, with the same three actions, would state
 * the number of open items three times on one screen before any content.
 *
 * "For you" and not "Board": the word Board is taken, and this list is not one.
 * It is what the chief has decided is worth the user's attention, which is a
 * different thing from what the workers are saying.
 */
function viewOptions(
  summary: Summary | null,
  view: View,
): readonly SegmentOption[] {
  const board = summary?.board ?? 0;
  // Only when the list is not the thing on screen. Standing the count next to
  // the list it counts would say the same number twice.
  const forYouCount =
    view !== "foryou" && board > 0
      ? { count: board, tone: "attention" as const }
      : {};
  // Board carries a count only on a narrow container, where the strip above has
  // collapsed to its single loudest number and this total is the only thing
  // saying the other buckets exist. The three are disjoint by construction: a
  // worker hits exactly one of them in the summary loop.
  const boardCount =
    summary === null
      ? 0
      : summary.needsYou + summary.decisions + summary.routing;
  return [
    { id: "foryou", label: "For you", ...forYouCount },
    {
      id: "board",
      label: "Board",
      // After the word, not before it: "3 Board" reads as three boards. The
      // strip one line up keeps its count in front, because its labels are
      // verb phrases and "3 need you" is a sentence.
      ...(boardCount > 0
        ? { count: boardCount, narrowOnly: true, countTrails: true }
        : {}),
    },
    // Never a count: a log's length is not a fact anyone acts on.
    { id: "activity", label: "Activity" },
  ];
}

/**
 * Board / Activity stay two underlined words; only their box grows, to a 44px
 * target, and the negative margin keeps the line where it was.
 * Applied on any finger surface, not only a compact one: a phone in landscape
 * is over 767px and is still a finger.
 */
const COMPACT_VIEW_HIT_AREA = `${COMPACT_WORD_HIT_AREA} px-1`;

/**
 * What a filter that matches nothing says. A blank board is never left
 * unexplained: the count that emptied is still on the strip, and this line
 * plus its Show all is the second way back out.
 */
const FILTER_EMPTY_LINE: Record<MissionFilter, string> = {
  "needs-you": "Nothing needs you right now.",
  decisions: "No decisions are waiting on you.",
  routing: "Nothing is waiting on the chief.",
  working: "Nothing is working right now.",
  idle: "No workers are idle.",
};

/** Props every board row shares: its place in the roving tab order, and whether it just arrived. */
interface BoardRowProps {
  tabIndex: number;
  isNew: boolean;
}

/** Props every board row shares: its place in the roving tab order, and whether it just arrived. */
interface BoardRowProps {
  tabIndex: number;
  isNew: boolean;
}

// --- rows -------------------------------------------------------------------

function NeedsYouRow({
  worker,
  tabIndex,
  isNew,
  onOpen,
  onAnswer,
  onThread,
}: BoardRowProps & {
  worker: WorkerStatus;
  onOpen: (threadId: string) => void;
  onAnswer: (worker: WorkerStatus) => void;
  onThread: (threadId: string) => void;
}) {
  const line = needsYouLine(worker);
  const noteId = useId();
  const urgency = rowUrgency(worker);
  const items: RowActionItem[] = [
    { id: "answer", label: "Answer", run: () => onAnswer(worker) },
    {
      id: "thread",
      label: "Open thread",
      run: () => onThread(worker.threadId),
    },
  ];
  return (
    <Row
      rowKey={worker.id}
      tabIndex={tabIndex}
      isNew={isNew}
      describedBy={noteId}
      dot={<StatusDot status={workerStatus(worker)} urgency={urgency} />}
      lead={<WorkerMark avatar={worker.avatar} />}
      title={
        <NameLine
          name={displayName(worker)}
          slug={worker.name}
          project={projectLabel(worker)}
          note={workerNote(worker) ?? "needs you"}
          noteTone="urgent"
          noteId={noteId}
          trailing={[unreadLabel(worker)]}
          execution={executionLabel(worker)}
          hideProjectWhenNarrow={line !== null}
        />
      }
      body={
        line === null ? undefined : (
          <RowDetail
            text={line}
            clamp={2}
            narrowPrefix={projectLabel(worker)}
          />
        )
      }
      age={
        <Age
          at={worker.lastReportAt ?? worker.lastUsedAt}
          tone={urgency === "urgent" ? "urgent" : "tertiary"}
        />
      }
      // One sheet, at every width and under every pointer, so the same row
      // answers "what can I do with this" the same way in every window.
      // Spelled out at rest, a screen of idle rows would carry three words
      // each, which is a wall rather than an affordance.
      actions={<RowActions ariaLabel={`Actions for ${displayName(worker)}`} items={items} />}
      shortcuts={{
        answer: () => onAnswer(worker),
        thread: () => onThread(worker.threadId),
      }}
      onOpen={() => onOpen(worker.threadId)}
      openLabel={`Open ${displayName(worker)} in the panel`}
    />
  );
}

function BlockedThreadRow({
  thread,
  tabIndex,
  isNew,
  onAdopt,
  onThread,
}: BoardRowProps & {
  thread: OtherThread;
  onAdopt: (thread: OtherThread) => void;
  onThread: (threadId: string) => void;
}) {
  const noteId = useId();
  const name = thread.title ?? "Untitled thread";
  const items: RowActionItem[] = [
    {
      id: "thread",
      label: "Open thread",
      run: () => onThread(thread.threadId),
    },
    { id: "adopt", label: "Adopt", run: () => onAdopt(thread) },
  ];
  return (
    <Row
      rowKey={thread.threadId}
      tabIndex={tabIndex}
      isNew={isNew}
      describedBy={noteId}
      dot={<StatusDot status={thread.displayStatus} urgency="urgent" />}
      title={
        <NameLine
          name={name}
          project={thread.projectName}
          note="needs approval"
          noteTone="urgent"
          noteId={noteId}
          hideProjectWhenNarrow
        />
      }
      body={
        <RowDetail
          text="Not a managed worker yet."
          clamp={1}
          narrowPrefix={thread.projectName}
        />
      }
      age={<Age at={thread.updatedAt} tone="urgent" />}
      actions={<RowActions ariaLabel={`Actions for ${name}`} items={items} />}
      compactActions={
        <RowActions ariaLabel={`Actions for ${name}`} items={items} />
      }
      onOpen={() => onThread(thread.threadId)}
      openLabel="Open this thread"
    />
  );
}

function DecisionRow({
  worker,
  tabIndex,
  isNew,
  onOpen,
  onSeen,
  onAnswer,
  onChoose,
  onAskChief,
  onDismiss,
  onThread,
}: BoardRowProps & {
  worker: WorkerStatus;
  onOpen: (threadId: string) => void;
  /** The user has looked at this need. Clears the "new" word, on the user rather than on the chief. */
  onSeen: (worker: WorkerStatus) => void;
  onAnswer: (worker: WorkerStatus) => void;
  /** The user tapped one of the answers the worker itself offered. Drafts it; never sends. */
  onChoose: (worker: WorkerStatus, label: string) => void;
  onAskChief: (worker: WorkerStatus) => void;
  /** The need was answered out of band; stop counting it. */
  onDismiss: (worker: WorkerStatus) => void;
  onThread: (threadId: string) => void;
}) {
  const noteId = useId();
  const finger = useIsFingerSurface();
  const urgency = rowUrgency(worker);
  // Attention always carries a word, so the level is never colour alone.
  const note = workerNote(worker) ?? levelWord(worker) ?? "waiting on you";
  // Every way of engaging with the row counts as having seen it. Opening the
  // worker, opening its thread, answering it or forwarding it to the chief all
  // mean the question has been read; only scrolling past does not.
  const seen = (run: () => void) => () => {
    onSeen(worker);
    run();
  };
  const answer = seen(() => onAnswer(worker));
  const askChief = seen(() => onAskChief(worker));
  const dismiss = seen(() => onDismiss(worker));
  const thread = seen(() => onThread(worker.threadId));
  const openHere = seen(() => onOpen(worker.threadId));
  const items: RowActionItem[] = [
    { id: "answer", label: "Answer", run: answer },
    { id: "thread", label: "Open thread", run: thread },
    { id: "ask-chief", label: "Ask chief", run: askChief },
    { id: "dismiss", label: "Dismiss", run: dismiss },
  ];
  return (
    <Row
      rowKey={worker.id}
      tabIndex={tabIndex}
      isNew={isNew}
      describedBy={noteId}
      dot={<StatusDot status={workerStatus(worker)} urgency={urgency} />}
      lead={<WorkerMark avatar={worker.avatar} />}
      title={
        <NameLine
          name={displayName(worker)}
          slug={worker.name}
          project={projectLabel(worker)}
          note={note}
          noteTone={urgency === "urgent" ? "urgent" : "attention"}
          noteId={noteId}
          trailing={[newForYouLabel(worker), unreadLabel(worker)]}
          execution={executionLabel(worker)}
          hideProjectWhenNarrow={worker.lastNeed !== null}
        />
      }
      body={
        worker.lastNeed === null ? undefined : (
          <RowDetail
            text={worker.lastNeed}
            clamp={3}
            size="sm"
            tone="foreground"
            label="Needs:"
            narrowPrefix={projectLabel(worker)}
          />
        )
      }
      // The worker's own offered answers, one tap each, in `extra` because it
      // is the only part of the text column that takes a tap (ui.tsx). Same
      // words and same behaviour as a curated item's choices on For you: it
      // drafts, it never sends, so a worker question is not only a blank
      // composer.
      extra={
        worker.needChoices.length === 0 ? undefined : (
          <div className="flex flex-col pl-0 @[420px]/cos:flex-row @[420px]/cos:flex-wrap @[420px]/cos:items-center @[420px]/cos:gap-x-4 @[420px]/cos:gap-y-3">
            {worker.needChoices.map((label) => (
              <ChoiceWord
                key={label}
                label={label}
                tabIndex={tabIndex}
                onChoose={seen(() => onChoose(worker, label))}
              />
            ))}
          </div>
        )
      }
      age={
        <Age
          at={worker.lastReportAt ?? worker.lastUsedAt}
          tone={urgency === "urgent" ? "urgent" : "tertiary"}
        />
      }
      // Answer stays visible at rest: it is the one action the user must never
      // have to hunt for. Every other word on the row is hover-only.
      restingAction={
        <QuietButton
          tone="primary"
          ariaLabel={`Answer ${displayName(worker)}`}
          title="Answer (a)"
          className={finger ? COMPACT_WORD_HIT_AREA : undefined}
          onClick={answer}
        >
          Answer
        </QuietButton>
      }
      // One sheet, at every width and under every pointer, so the same row
      // answers "what can I do with this" the same way in every window.
      // Spelled out at rest, a screen of idle rows would carry three words
      // each, which is a wall rather than an affordance.
      actions={<RowActions ariaLabel={`Actions for ${displayName(worker)}`} items={items} />}
      shortcuts={{
        answer,
        askChief,
        dismiss,
        thread,
      }}
      onOpen={openHere}
      openLabel={`Open ${displayName(worker)} in the panel`}
    />
  );
}

function RunRow({
  worker,
  variant,
  tabIndex,
  isNew,
  onOpen,
  onThread,
  onRetire,
  onStop,
  onRetry,
  onUndismiss,
}: BoardRowProps & {
  worker: WorkerStatus;
  variant: "working" | "idle";
  onOpen: (threadId: string) => void;
  onThread: (threadId: string) => void;
  onRetire: (worker: WorkerStatus) => void;
  /** End the running turn but keep the worker and its thread. */
  onStop: (worker: WorkerStatus) => void;
  /** Re-send the last brief the chief gave this worker. */
  onRetry: (worker: WorkerStatus) => void;
  /** Put a dismissed need back on the Decisions list. */
  onUndismiss: (worker: WorkerStatus) => void;
}) {
  // A Working or Idle row can never promote on age, so on a finger surface the
  // age is trivia competing with the name for 390px.
  const finger = useIsFingerSurface();
  const noteId = useId();
  const urgency = rowUrgency(worker);
  // A row lands here with a need only because the chief dismissed it. The undo
  // lives on this row, not in a dialog, so a wrong dismissal is one word away.
  const items: RowActionItem[] = [
    {
      id: "thread",
      label: "Open thread",
      run: () => onThread(worker.threadId),
    },
    // A working row can be stopped; an idle one can be sent its brief again.
    // Retire is for a closed topic, not the way to end either.
    ...(variant === "working"
      ? [{ id: "stop", label: "Stop turn", run: () => onStop(worker) }]
      : []),
    ...(variant === "idle" && worker.retryable
      ? [{ id: "retry", label: "Retry brief", run: () => onRetry(worker) }]
      : []),
    ...(worker.needDismissed
      ? [
          {
            id: "undismiss",
            label: "Restore need",
            run: () => onUndismiss(worker),
          },
        ]
      : []),
    {
      id: "retire",
      label: "Retire",
      run: () => onRetire(worker),
      tone: "urgent" as const,
    },
  ];
  // What is still open outranks what is finished, in both states, under the
  // same label. An idle row that prints only its receipt is
  // the whole board once every worker has stopped, and the open item is the
  // one line that says what is left. Open lines do go stale: the age rail is
  // what dates them, this is not a live queue.
  // An idle worker with nothing open is one line: name, project, age. Its
  // Done: receipt is in Activity and in its transcript; a two-line receipt on
  // every idle row would make the least important section the densest on the board.
  const line =
    worker.needDismissed && worker.lastNeed !== null
      ? `Dismissed need: ${worker.lastNeed}`
      : worker.lastOpen !== null
        ? `Open: ${worker.lastOpen}`
        : variant === "idle"
          ? null
          : worker.lastDone === null
            ? worker.lastOutputExcerpt
            : `Done: ${worker.lastDone}`;
  // The deadline parsed out of that open item is the row's one perishable
  // fact, so it is carried by a word. The row itself stays whatever level the
  // server gave it: Working and Idle never promote on age.
  const note =
    workerNote(worker) ??
    (worker.dueHint === null ? null : `due ${worker.dueHint}`);
  return (
    <Row
      rowKey={worker.id}
      tabIndex={tabIndex}
      isNew={isNew}
      describedBy={note === null ? undefined : noteId}
      dot={
        <StatusDot
          status={variant === "working" ? workerStatus(worker) : "idle"}
          urgency={variant === "working" ? urgency : "neutral"}
        />
      }
      lead={<WorkerMark avatar={worker.avatar} />}
      title={
        <NameLine
          name={displayName(worker)}
          slug={worker.name}
          project={projectLabel(worker)}
          note={note}
          noteTone={
            urgency === "urgent"
              ? "urgent"
              : urgency === "attention"
                ? "attention"
                : "muted"
          }
          noteId={noteId}
          trailing={[unreadLabel(worker)]}
          execution={executionLabel(worker)}
          hideProjectWhenNarrow={line !== null}
        />
      }
      body={
        line === null ? undefined : (
          <RowDetail
            text={line}
            clamp={variant === "idle" ? 1 : 2}
            narrowPrefix={projectLabel(worker)}
          />
        )
      }
      // A running turn has an elapsed time worth the rail on every surface: it
      // says whether the worker is moving. Without one (a turn that started
      // before the plugin restarted) the row keeps its last-turn age, and on a finger
      // that age is trivia competing with the name for 390px.
      age={
        variant === "working" && worker.turnStartedAt !== null ? (
          <Elapsed since={worker.turnStartedAt} />
        ) : finger ? undefined : (
          <Age at={worker.lastUsedAt} />
        )
      }
      // One sheet, at every width and under every pointer, so the same row
      // answers "what can I do with this" the same way in every window.
      // Spelled out at rest, a screen of idle rows would carry three words
      // each, which is a wall rather than an affordance.
      actions={<RowActions ariaLabel={`Actions for ${displayName(worker)}`} items={items} />}
      shortcuts={{
        thread: () => onThread(worker.threadId),
        retire: () => onRetire(worker),
        ...(worker.needDismissed ? { dismiss: () => onUndismiss(worker) } : {}),
      }}
      onOpen={() => onOpen(worker.threadId)}
      openLabel={`Open ${displayName(worker)} in the panel`}
    />
  );
}

/**
 * A need the worker addressed to the chief, not to the user. It stays on the
 * board because a routing request that is silently dropped is a lost ask, but
 * it is neutral: no Answer, no colour, and a plain word saying whose it is.
 */
function RoutingRow({
  worker,
  tabIndex,
  isNew,
  onOpen,
  onAskChief,
  onThread,
}: BoardRowProps & {
  worker: WorkerStatus;
  onOpen: (threadId: string) => void;
  onAskChief: (worker: WorkerStatus) => void;
  onThread: (threadId: string) => void;
}) {
  const noteId = useId();
  const items: RowActionItem[] = [
    {
      id: "thread",
      label: "Open thread",
      run: () => onThread(worker.threadId),
    },
    { id: "ask-chief", label: "Ask chief", run: () => onAskChief(worker) },
  ];
  return (
    <Row
      rowKey={worker.id}
      tabIndex={tabIndex}
      isNew={isNew}
      describedBy={noteId}
      dot={
        <StatusDot status={workerStatus(worker)} urgency={rowUrgency(worker)} />
      }
      lead={<WorkerMark avatar={worker.avatar} />}
      title={
        <NameLine
          name={displayName(worker)}
          slug={worker.name}
          project={projectLabel(worker)}
          note="for the chief"
          noteId={noteId}
          trailing={[unreadLabel(worker)]}
          execution={executionLabel(worker)}
          hideProjectWhenNarrow={worker.lastNeed !== null}
        />
      }
      body={
        worker.lastNeed === null ? undefined : (
          <RowDetail
            text={worker.lastNeed}
            clamp={2}
            narrowPrefix={projectLabel(worker)}
          />
        )
      }
      age={<Age at={worker.lastReportAt ?? worker.lastUsedAt} />}
      // One sheet, at every width and under every pointer, so the same row
      // answers "what can I do with this" the same way in every window.
      // Spelled out at rest, a screen of idle rows would carry three words
      // each, which is a wall rather than an affordance.
      actions={<RowActions ariaLabel={`Actions for ${displayName(worker)}`} items={items} />}
      shortcuts={{
        askChief: () => onAskChief(worker),
        thread: () => onThread(worker.threadId),
      }}
      onOpen={() => onOpen(worker.threadId)}
      openLabel={`Open ${displayName(worker)} in the panel`}
    />
  );
}

function ThreadRow({
  thread,
  onAdopt,
  onThread,
}: {
  thread: OtherThread;
  onAdopt: (thread: OtherThread) => void;
  onThread: (threadId: string) => void;
}) {
  const name = thread.title ?? "Untitled thread";
  const items: RowActionItem[] = [
    {
      id: "thread",
      label: "Open thread",
      run: () => onThread(thread.threadId),
    },
    { id: "adopt", label: "Adopt", run: () => onAdopt(thread) },
  ];
  return (
    <Row
      dot={<StatusDot status={thread.displayStatus} />}
      title={
        <NameLine name={name} project={thread.projectName} strong={false} />
      }
      age={<Age at={thread.updatedAt} />}
      actions={<RowActions ariaLabel={`Actions for ${name}`} items={items} />}
      compactActions={
        <RowActions ariaLabel={`Actions for ${name}`} items={items} />
      }
      onOpen={() => onThread(thread.threadId)}
      openLabel="Open this thread"
    />
  );
}

function SessionRow({
  session,
  onImport,
  onOpenWorker,
  workerThreadId,
}: {
  session: ExternalSession;
  onImport: (session: ExternalSession) => void;
  onOpenWorker: (threadId: string) => void;
  workerThreadId: string | null;
}) {
  const imported = session.importedWorkerName;
  const label = sessionLabel(session);
  // Transcript size is the definition of tertiary trivia, and a finger surface
  // has no room for it.
  const finger = useIsFingerSurface();
  const items: RowActionItem[] =
    imported === null
      ? [{ id: "import", label: "Import", run: () => onImport(session) }]
      : workerThreadId === null
        ? // Nothing to open: the worker was retired or renamed. The line is a
          // statement, so on a phone it is a disabled item.
          [
            {
              id: "imported",
              label: `imported as ${imported}`,
              run: () => {},
              disabled: true,
            },
          ]
        : [
            {
              id: "imported",
              label: `Open ${imported}`,
              run: () => onOpenWorker(workerThreadId),
            },
          ];
  return (
    <Row
      dot={<StatusDot status="external" />}
      title={
        <NameLine
          name={label}
          project={session.matchedProjectName ?? "no project"}
          note={finger ? null : formatMb(session.transcriptBytes)}
          strong={false}
        />
      }
      body={
        session.title === null ? undefined : (
          <RowDetail text={session.title} clamp={1} />
        )
      }
      age={<Age at={session.lastActivityAt} />}
      actions={<RowActions ariaLabel={`Actions for ${label}`} items={items} />}
      compactActions={
        <RowActions ariaLabel={`Actions for ${label}`} items={items} />
      }
      onOpen={
        workerThreadId === null ? undefined : () => onOpenWorker(workerThreadId)
      }
      openLabel={imported === null ? undefined : `Open the ${imported} worker`}
    />
  );
}

/** The last segment of a path, for a column too narrow to read the rest. */
function pathLeaf(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}

/** The working directory a group of sessions came from. Never uppercased. */
function PathLabel({ path, action }: { path: string; action?: ReactNode }) {
  // A full cwd is three lines of truncation on a phone. The leaf says which
  // project this is; the whole path stays in `title`.
  const compact = useIsCompactViewport();
  return (
    <div className="mb-0.5 mt-3 flex items-center gap-3">
      <p
        className={cn("min-w-0 truncate text-[11px] leading-4", TEXT_TERTIARY)}
        title={path}
      >
        {compact ? pathLeaf(path) : path}
      </p>
      {action === undefined ? null : (
        <div className="ml-auto shrink-0">{action}</div>
      )}
    </div>
  );
}

// --- the tab ----------------------------------------------------------------

export function MissionTab({ subPath }: PluginNavPanelProps) {
  // A deep link that names the Worker tab is honoured from here: the page
  // component's own `openFixedTab` does not reach the panel (see deep-link.ts).
  useDeepLinkTab(subPath, "mission", null);
  const rpc = useCosRpc();
  const panel = experimental_useAppPanel();
  const navigate = useBbNavigate();
  const summary = useSummary();
  const roster = useRoster();
  const sessions = useSessions();
  const projects = useProjects();
  const compact = useIsCompactViewport();
  const finger = useIsFingerSurface();

  // The curated list is where the user lands, rather than the worker roster,
  // which is the chief's view of its own staff and not a view of the day, or a
  // brief that restates the list's own length on top of it.
  const [view, setView] = useState<View>("foryou");
  const [activityShape, setActivityShape] = useRememberedChoice("activity", ["day", "log"] as const, "day");
  const [filter, setFilter] = useState<MissionFilter | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [showImported, setShowImported] = useState(false);
  const [adoptTarget, setAdoptTarget] = useState<OtherThread | null>(null);
  const [importTargets, setImportTargets] = useState<ExternalSession[] | null>(
    null,
  );
  const [retireTarget, setRetireTarget] = useState<WorkerStatus | null>(null);
  const [restarting, setRestarting] = useState(false);

  const buckets = roster.data === null ? null : bucketRoster(roster.data);
  const shows = (section: MissionFilter) =>
    filter === null || filter === section;

  const needsYouCount =
    buckets === null
      ? 0
      : buckets.needsYou.length + buckets.blockedThreads.length;
  // A count only narrows the board when a second group has rows. On an
  // all-idle board "7 idle" selects everything there is, and the only effects
  // it has left are hiding both archives and offering a Show all that undoes
  // itself. So the archives stay whenever the filter is not actually filtering.
  const groupsWithRows =
    buckets === null
      ? 0
      : [
          needsYouCount,
          buckets.decisions.length,
          buckets.routing.length,
          buckets.working.length,
          buckets.idle.length,
        ].filter((count) => count > 0).length;
  const showArchives = filter === null || groupsWithRows < 2;

  // Every board row in reading order. The keyboard walks this list, so it has
  // to follow what is actually on screen, filter and all.
  const rowKeys: string[] = [];
  // With no filter the Board is the teams view, which renders only the blocked
  // threads as roving rows; its member rows are plain buttons. Listing workers
  // here as well would hand the tab stop to rows that are not on screen, so Tab
  // would never reach a blocked thread and ArrowDown off it would lose the stop.
  if (buckets !== null && filter === null) {
    for (const thread of buckets.blockedThreads) rowKeys.push(thread.threadId);
  } else if (buckets !== null) {
    if (shows("needs-you")) {
      for (const worker of buckets.needsYou) rowKeys.push(worker.id);
      for (const thread of buckets.blockedThreads)
        rowKeys.push(thread.threadId);
    }
    if (shows("decisions"))
      for (const worker of buckets.decisions) rowKeys.push(worker.id);
    if (shows("routing"))
      for (const worker of buckets.routing) rowKeys.push(worker.id);
    if (shows("working"))
      for (const worker of buckets.working) rowKeys.push(worker.id);
    if (shows("idle"))
      for (const worker of buckets.idle) rowKeys.push(worker.id);
  }
  const navigation = useRovingRows(rowKeys);
  const newKeys = useNewRowKeys(rowKeys);
  const rowProps = (key: string): BoardRowProps => ({
    tabIndex: navigation.tabIndexFor(key),
    isNew: newKeys.has(key),
  });

  const openHere = (threadId: string) => {
    panel.openFixedTab({
      surface: { kind: "current" },
      tab: WORKER_TAB,
      target: { threadId },
    });
  };
  const openThread = (threadId: string) => navigate.toThread(threadId);

  // "Answer" lands in the worker's composer, not just on its transcript.
  const answer = (worker: WorkerStatus) => {
    panel.openFixedTab({
      surface: { kind: "current" },
      tab: WORKER_TAB,
      target: { threadId: worker.threadId, focus: true },
    });
  };

  /**
   * One of the worker's own offered answers, drafted into its composer and
   * the composer focused, exactly what Answer does but with the words already
   * there. The server re-reads the worker's Need and refuses a label it did
   * not offer, so the panel cannot put words in the user's mouth. Nothing is sent.
   */
  const choose = async (worker: WorkerStatus, label: string) => {
    try {
      const result = await rpc.call("need_answer_draft", { workerId: worker.id, label });
      if (!result.ok) {
        toast.error(result.text);
        return;
      }
      // Open the composer the draft is parked for; the banner mounted in it
      // takes the text on the next signal.
      answer(worker);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  };

  /**
   * The user has looked at this worker's question. Fire and forget: the marker is
   * cosmetic, and a failed mark must never get in the way of the action it
   * accompanies. The roster refetch is what clears the word on screen.
   */
  const markSeen = (worker: WorkerStatus) => {
    if (!worker.needIsNew || worker.lastNeed === null) return;
    // The need this row is showing, not just its id: the server refuses the
    // mark if the worker has since asked something else.
    void rpc
      .call("need_mark_seen", { workers: [{ id: worker.id, need: worker.lastNeed }] })
      .then(() => roster.refetch())
      .catch(() => {});
  };

  const askChief = async (worker: WorkerStatus) => {
    // A routing row's need was addressed to the chief in the first place, so
    // forwarding it must not arrive labelled as a decision for the user.
    const subject =
      worker.needAudience === "chief" ? "For the chief, from" : "Decision on";
    try {
      const result = await rpc.call("send_to_chief", {
        text: `${subject} ${displayName(worker)}: ${worker.lastNeed ?? ""}`,
        sourceThreadId: worker.threadId,
        note: "asked from Mission",
      });
      if (result.ok) toast.success(result.text);
      else toast.error(result.text);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  };

  // Dismiss and its undo share one RPC. No confirm dialog: the action is one
  // word to reverse and destroys nothing.
  const dismissNeed = async (worker: WorkerStatus, undo: boolean) => {
    try {
      const result = await rpc.call("worker_dismiss_need", {
        id: worker.id,
        undo,
      });
      if (result.ok) toast.success(result.text);
      else toast.error(result.text);
      roster.refetch();
      summary.refetch();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  };

  const retire = async (worker: WorkerStatus) => {
    try {
      const result = await rpc.call("worker_retire", { id: worker.id });
      // The worker row is retired either way; ok is false when its thread could
      // not be stopped or archived, and the text says what to do by hand.
      if (result.ok) toast.success(result.text);
      else toast.error(result.text);
      roster.refetch();
      summary.refetch();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  };

  // Stop and Retry need no confirm: a stop keeps the thread and everything in
  // it, and a retry re-sends a brief the chief already wrote.
  const stopTurn = async (worker: WorkerStatus) => {
    try {
      const result = await rpc.call("worker_stop", { id: worker.id });
      if (result.ok) toast.success(result.text);
      else toast.error(result.text);
      roster.refetch();
      summary.refetch();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  };

  const retryBrief = async (worker: WorkerStatus) => {
    try {
      const result = await rpc.call("worker_retry", { id: worker.id });
      if (result.ok) toast.success(result.text);
      else toast.error(result.text);
      roster.refetch();
      summary.refetch();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  };

  // The chief is not a worker, so it has no row action of its own: this is the
  // only way back from a failed chief without opening its thread and typing.
  const chiefThreadId =
    summary.data?.chiefThreadId ?? roster.data?.chiefThreadId ?? null;
  const restartChief = async () => {
    setRestarting(true);
    try {
      const result = await rpc.call("chief_restart", null);
      if (result.ok) toast.success(result.text);
      else toast.error(result.text);
      summary.refetch();
      roster.refetch();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setRestarting(false);
    }
  };

  /** What a team member row can do: the same verbs as a flat Board row. */
  const teamsActions: TeamsActions = {
    onOpen: openHere,
    onThread: openThread,
    onAnswer: (worker) => {
      markSeen(worker);
      answer(worker);
    },
    onChoose: (worker, label) => {
      markSeen(worker);
      void choose(worker, label);
    },
    onAskChief: (worker) => {
      markSeen(worker);
      void askChief(worker);
    },
    onDismiss: (worker) => {
      markSeen(worker);
      void dismissNeed(worker, false);
    },
    onUndismiss: (worker) => void dismissNeed(worker, true),
    onStop: (worker) => void stopTurn(worker),
    onRetry: (worker) => void retryBrief(worker),
    onRetire: setRetireTarget,
  };

  // "imported as <name>" links to the worker when the roster still has it.
  const importedWorkerThread = (session: ExternalSession): string | null => {
    const name = session.importedWorkerName;
    if (name === null) return null;
    const workers = roster.data?.workers ?? [];
    const worker =
      workers.find(
        (candidate) =>
          candidate.name === name &&
          (session.matchedProjectId === null ||
            candidate.projectId === session.matchedProjectId),
      ) ?? workers.find((candidate) => candidate.name === name);
    return worker?.threadId ?? null;
  };

  const dialogs = (
    <>
      <ImportDialog
        open={importTargets !== null}
        sessions={importTargets ?? []}
        allSessions={sessions.sessions}
        projects={projects.data ?? []}
        onOpenChange={(open) => {
          if (!open) setImportTargets(null);
        }}
        onImported={() => {
          sessions.refetch();
          roster.refetch();
          summary.refetch();
        }}
      />
      <AdoptDialog
        open={adoptTarget !== null}
        threadId={adoptTarget?.threadId ?? null}
        suggestedName={adoptTarget?.title ?? ""}
        onOpenChange={(open) => {
          if (!open) setAdoptTarget(null);
        }}
        onAdopted={() => {
          roster.refetch();
          summary.refetch();
        }}
      />
      <ConfirmDialog
        open={retireTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRetireTarget(null);
        }}
        title={`Retire ${retireTarget === null ? "this worker" : displayName(retireTarget)}?`}
        description="The worker's thread is stopped and archived. The chief stops counting the worker as available and will not reuse the name."
        confirmLabel="Retire"
        onConfirm={() => {
          const target = retireTarget;
          setRetireTarget(null);
          if (target !== null) void retire(target);
        }}
      />
    </>
  );

  // The strip and the view words. Each view wraps this in its own sticky frame,
  // because the curated list adds a third line to it (the selection bar and the
  // undo strip, which share one slot) and both have to stay on screen at any
  // scroll depth.
  const header = (trailing?: ReactNode) => (
    <>
      {summary.data === null ? (
        <p className="text-[12px] leading-5 text-muted-foreground">
          {summary.error ?? "Loading"}
        </p>
      ) : (
        <StatusStrip
          summary={summary.data}
          // Only the Board narrows in place, so only the Board underlines a
          // count. Elsewhere the same word is a way in rather than a filter.
          active={view === "board" ? filter : null}
          // On every view. These are headline counts above the list: they name
          // the things that are NOT on the list below, so the surface never
          // states one number three times.
          onSelect={(next) => {
            if (view === "board") {
              setFilter((current) => (current === next ? null : next));
              return;
            }
            // Local state, never `openFixedTab`: at phone widths this surface
            // renders in the page body and the panel cannot be reached at all
            // (see deep-link.ts).
            setView("board");
            setFilter(next);
          }}
          // The words "Chief idle" are a way into that thread: this surface's
          // primary verb drafts into it.
          onOpenChief={
            summary.data.chiefThreadId === null
              ? undefined
              : () => navigate.toThread(summary.data!.chiefThreadId!)
          }
        />
      )}
      {/* The view words keep their own line, left aligned, under the strip.
          Three of them fit a 218px content box where four would not, so this
          row does not wrap at a 250px panel. For you's own words (Select, Quick
          review / List) do wrap on a phone, onto a second line at the right;
          on a finger the rows sit 44px apart so the two lines' 44px targets
          do not overlap. */}
      <div className={cn("mt-2 flex flex-wrap items-center gap-x-3", finger ? "gap-y-6" : "gap-y-1")}>
        <Segmented
          options={viewOptions(summary.data, view)}
          value={view}
          onSelect={(id) => setView(id as View)}
          optionClassName={finger ? COMPACT_VIEW_HIT_AREA : undefined}
        />
        {view === "board" &&
        filter !== null &&
        !showArchives &&
        rowKeys.length > 0 ? (
          // The view line carries exactly one contextual word, at the right
          // edge, whatever the view. It is never hidden by width: hiding it
          // below 420px and on compact would hide it where a filter is hardest
          // to notice and hardest to undo.
          <div className="ml-auto">
            <QuietButton
              className={finger ? COMPACT_WORD_HIT_AREA : undefined}
              onClick={() => setFilter(null)}
            >
              Show all
            </QuietButton>
          </div>
        ) : (
          // The curated list's own word lands in the same slot, so the two
          // views cannot grow separate places to put a control.
          <div className="ml-auto">{trailing}</div>
        )}
      </div>
    </>
  );

  /**
   * Every view but the curated list wraps the header the same way.
   *
   * `-top-3 -mt-3 pt-3` rather than a plain `top-0`: the page-body scroller
   * carries its own `pt-3` (app.tsx), and a header pinned at the top of the
   * content box leaves that 12px strip uncovered, so rows slide visibly
   * through it at phone widths. The panel branch's padding
   * belongs to the host and is not readable from here; 12px is what bb's
   * panel branch uses.
   */
  const stickyHeader = (
    <div className="sticky -top-3 z-20 -mx-4 -mt-3 border-b border-border bg-background px-4 pb-2 pt-3">
      {header()}
    </div>
  );

  if (view === "foryou") {
    // The list owns its own frame: its selection bar and undo strip are the
    // header's third line, and the wording that explains what this list is
    // sits at the foot of the surface rather than above every visit.
    return (
      <>
        <BoardTab
          header={header}
          chiefThreadId={summary.data?.chiefThreadId}
          onRefresh={() => summary.refetch()}
        />
        {dialogs}
      </>
    );
  }

  if (view === "activity") {
    return (
      <div className="@container/cos overflow-x-clip">
        {stickyHeader}
        {/*
          The day beside the log, never instead of it. The same
          Segmented control as the view words above it, which shows the active
          option with an underline and aria-pressed: two QuietButtons with a
          colour step would be 1.94:1 apart on white and 1.15:1 on dark, so
          nothing would say which one is on.
        */}
        <div className="pt-2">
          <Segmented
            options={[
              { id: "day", label: "Day" },
              { id: "log", label: "Log" },
            ]}
            value={activityShape}
            onSelect={(id) => setActivityShape(id === "log" ? "log" : "day")}
            // min-w-11 as well as the height: two three-letter words are about
            // 29px wide, which the longer view words above never needed.
            optionClassName={finger ? BAR_WORD_HIT_AREA : undefined}
          />
        </div>
        {activityShape === "day" ? <DayView onOpenThread={openThread} /> : <ActivityList />}
        {dialogs}
      </div>
    );
  }

  if (roster.error !== null && buckets === null) {
    return (
      <div className="@container/cos overflow-x-clip">
        {stickyHeader}
        <p className={cn("py-3 text-[13px]", TEXT_URGENT)}>{roster.error}</p>
        {dialogs}
      </div>
    );
  }
  if (buckets === null) {
    return (
      <div className="@container/cos overflow-x-clip">
        {stickyHeader}
        <p className="py-3 text-[13px] text-muted-foreground">Loading</p>
        {dialogs}
      </div>
    );
  }

  const pending = unimportedSessions(sessions.sessions);
  const importedCount = sessions.sessions.length - pending.length;
  const pendingGroups = groupSessionsByCwd(pending);
  const importedGroups = groupSessionsByCwd(
    sessions.sessions.filter((session) => session.importedWorkerName !== null),
  );

  const hasArchives =
    buckets.otherThreads.length > 0 ||
    sessions.sessions.length > 0 ||
    !sessions.loaded;

  return (
    <div className="@container/cos overflow-x-clip">
      {stickyHeader}

      {roster.stale ? (
        <StaleNote error={roster.error ?? ""} onRetry={roster.refetch} />
      ) : null}

      {/* Past 860px the panel stops growing: 110 characters is not a measure. */}
      <div
        className="@[860px]/cos:max-w-[860px]"
        {...navigation.containerProps}
      >
        {/*
          A dead chief is the one thing on this board that stops every worker
          from being heard: their reports park in the outbox until it takes a
          turn again. It sits above the sections and outside the filter,
          because no count on the strip selects it.
        */}
        {summary.data !== null && summary.data.chiefStatus === "error" ? (
          <section>
            <SectionLabel label="Chief" />
            <RowList ariaLabel="Chief">
              <Row
                dot={<StatusDot status="error" urgency="urgent" />}
                title={
                  <NameLine
                    name="Chief of Staff"
                    note="failed"
                    noteTone="urgent"
                  />
                }
                body={
                  <RowDetail
                    text={
                      summary.data.chiefFailure ??
                      "Its last turn ended in an error."
                    }
                    label="Failed:"
                    clamp={2}
                  />
                }
                restingAction={
                  <QuietButton
                    tone="primary"
                    ariaLabel="Restart the chief thread"
                    title="Stop the failed turn, deliver parked reports, and put the chief back to work"
                    className={finger ? COMPACT_WORD_HIT_AREA : undefined}
                    // A word that changes to "Restarting" still takes clicks.
                    // The call is seconds long (stop the turn, then send every
                    // parked report), so a second press is easy and would
                    // start a second outbox drain alongside the first.
                    disabled={restarting}
                    onClick={() => void restartChief()}
                  >
                    {restarting ? "Restarting" : "Restart"}
                  </QuietButton>
                }
                {...(chiefThreadId === null
                  ? {}
                  : {
                      onOpen: () => openThread(chiefThreadId),
                      openLabel: "Open the chief thread",
                    })}
              />
            </RowList>
          </section>
        ) : null}

        {buckets.total === 0 && needsYouCount === 0 ? (
          <EmptyState
            title="No workers yet"
            detail="Delegate something to the chief. Workers are created on the first task and reused by name after that."
            action={
              <QuietButton
                className={finger ? COMPACT_WORD_HIT_AREA : undefined}
                onClick={() =>
                  navigate.toPluginPanel(CHIEF_PANEL_PATH, {
                    subPath: DELEGATE_SUBPATH,
                  })
                }
              >
                Delegate
              </QuietButton>
            }
          />
        ) : null}

        {filter !== null &&
        rowKeys.length === 0 &&
        (buckets.total > 0 || needsYouCount > 0) ? (
          <EmptyState
            title={FILTER_EMPTY_LINE[filter]}
            action={
              <QuietButton
                className={finger ? COMPACT_WORD_HIT_AREA : undefined}
                onClick={() => setFilter(null)}
              >
                Show all
              </QuietButton>
            }
          />
        ) : null}

        {/*
          TEAMS, NOT A LIST. With no filter the
          Board groups workers under their managers and opens only the teams
          holding something for the user. A filter from the strip still narrows to
          the flat sections below, because "show me everything waiting on me"
          is a question the teams view answers across teams, not inside one.

          Blocked threads are not workers and have no team, so they keep their
          own row above the teams.
        */}
        {filter === null ? (
          <>
            {buckets.blockedThreads.length === 0 ? null : (
              <section>
                <SectionLabel label="Needs you" />
                <RowList ariaLabel="Blocked threads">
                  {buckets.blockedThreads.map((thread) => (
                    <BlockedThreadRow
                      key={thread.threadId}
                      thread={thread}
                      {...rowProps(thread.threadId)}
                      onAdopt={setAdoptTarget}
                      onThread={openThread}
                    />
                  ))}
                </RowList>
              </section>
            )}
            <TeamsView
              workers={roster.data?.workers ?? []}
              actions={teamsActions}
              outsideNeeds={buckets.blockedThreads.length}
            />
          </>
        ) : (
          <>
        {shows("needs-you") && needsYouCount > 0 ? (
          <section>
            <SectionLabel label="Needs you" />
            <RowList ariaLabel="Needs you">
              {buckets.needsYou.map((worker) => (
                <NeedsYouRow
                  key={worker.id}
                  worker={worker}
                  {...rowProps(worker.id)}
                  onOpen={openHere}
                  onAnswer={answer}
                  onThread={openThread}
                />
              ))}
              {buckets.blockedThreads.map((thread) => (
                <BlockedThreadRow
                  key={thread.threadId}
                  thread={thread}
                  {...rowProps(thread.threadId)}
                  onAdopt={setAdoptTarget}
                  onThread={openThread}
                />
              ))}
            </RowList>
          </section>
        ) : null}

        {shows("decisions") && buckets.decisions.length > 0 ? (
          <section>
            <SectionLabel label="Decisions" />
            <RowList ariaLabel="Decisions">
              {buckets.decisions.map((worker) => (
                <DecisionRow
                  key={worker.id}
                  worker={worker}
                  {...rowProps(worker.id)}
                  onOpen={openHere}
                  onSeen={markSeen}
                  onAnswer={answer}
                  onChoose={(target, label) => void choose(target, label)}
                  onAskChief={(target) => void askChief(target)}
                  onDismiss={(target) => void dismissNeed(target, false)}
                  onThread={openThread}
                />
              ))}
            </RowList>
          </section>
        ) : null}

        {shows("routing") && buckets.routing.length > 0 ? (
          <section>
            <SectionLabel label="For the chief" />
            <RowList ariaLabel="For the chief">
              {buckets.routing.map((worker) => (
                <RoutingRow
                  key={worker.id}
                  worker={worker}
                  {...rowProps(worker.id)}
                  onOpen={openHere}
                  onAskChief={(target) => void askChief(target)}
                  onThread={openThread}
                />
              ))}
            </RowList>
          </section>
        ) : null}

        {shows("working") && buckets.working.length > 0 ? (
          <section>
            <SectionLabel label="Working" />
            <RowList ariaLabel="Working">
              {buckets.working.map((worker) => (
                <RunRow
                  key={worker.id}
                  worker={worker}
                  variant="working"
                  {...rowProps(worker.id)}
                  onOpen={openHere}
                  onThread={openThread}
                  onRetire={setRetireTarget}
                  onStop={(target) => void stopTurn(target)}
                  onRetry={(target) => void retryBrief(target)}
                  onUndismiss={(target) => void dismissNeed(target, true)}
                />
              ))}
            </RowList>
          </section>
        ) : null}

        {shows("idle") && buckets.idle.length > 0 ? (
          <section>
            <SectionLabel label="Idle" />
            <RowList ariaLabel="Idle">
              {buckets.idle.map((worker) => (
                <RunRow
                  key={worker.id}
                  worker={worker}
                  variant="idle"
                  {...rowProps(worker.id)}
                  onOpen={openHere}
                  onThread={openThread}
                  onRetire={setRetireTarget}
                  onStop={(target) => void stopTurn(target)}
                  onRetry={(target) => void retryBrief(target)}
                  onUndismiss={(target) => void dismissNeed(target, true)}
                />
              ))}
            </RowList>
          </section>
        ) : null}

          </>
        )}

        {showArchives && hasArchives ? (
          <div className="mt-4 divide-y divide-border border-t border-border">
            {buckets.otherThreads.length === 0 ? null : (
              <div>
                <DisclosureRow
                  open={showOthers}
                  label={`${buckets.otherThreads.length} other ${
                    buckets.otherThreads.length === 1 ? "thread" : "threads"
                  }`}
                  onToggle={() => setShowOthers((value) => !value)}
                />
                {showOthers ? (
                  <div className="pb-1 pl-[18px]">
                    <RowList ariaLabel="Other threads">
                      {buckets.otherThreads.map((thread) => (
                        <ThreadRow
                          key={thread.threadId}
                          thread={thread}
                          onAdopt={setAdoptTarget}
                          onThread={openThread}
                        />
                      ))}
                    </RowList>
                  </div>
                ) : null}
              </div>
            )}

            {sessions.sessions.length === 0 && sessions.loaded ? null : (
              <div>
                <DisclosureRow
                  open={showSessions}
                  label={
                    sessions.loaded
                      ? `${sessions.sessions.length} external ${
                          sessions.sessions.length === 1
                            ? "session"
                            : "sessions"
                        } · ${importedCount} imported · ${pending.length} to import`
                      : "Looking for external Claude sessions"
                  }
                  onToggle={() => setShowSessions((value) => !value)}
                  action={
                    pending.length === 0 ? undefined : (
                      <QuietButton
                        ariaLabel="Import the next external Claude session"
                        className={finger ? COMPACT_WORD_HIT_AREA : undefined}
                        onClick={() => {
                          const next = pending[0];
                          if (next !== undefined) setImportTargets([next]);
                        }}
                      >
                        Import
                      </QuietButton>
                    )
                  }
                />
                {showSessions ? (
                  <div className="pb-1 pl-[18px]">
                    {pendingGroups.length === 0 ? (
                      <p className="pb-2 text-[12px] leading-5 text-muted-foreground">
                        Every session found on this machine is already imported.
                      </p>
                    ) : (
                      pendingGroups.map((group) => (
                        <div key={group.cwd}>
                          <PathLabel
                            path={group.cwd}
                            action={
                              group.sessions.length > 1 ? (
                                <QuietButton
                                  className={
                                    finger ? COMPACT_WORD_HIT_AREA : undefined
                                  }
                                  onClick={() =>
                                    setImportTargets(group.sessions)
                                  }
                                >
                                  Import all
                                </QuietButton>
                              ) : undefined
                            }
                          />
                          <RowList ariaLabel={`Sessions in ${group.cwd}`}>
                            {group.sessions.map((session) => (
                              <SessionRow
                                key={session.sessionId}
                                session={session}
                                workerThreadId={null}
                                onImport={(target) =>
                                  setImportTargets([target])
                                }
                                onOpenWorker={openHere}
                              />
                            ))}
                          </RowList>
                        </div>
                      ))
                    )}

                    {importedCount === 0 ? null : (
                      <div className="mt-1 border-t border-border">
                        <DisclosureRow
                          open={showImported}
                          label={`${importedCount} already imported`}
                          onToggle={() => setShowImported((value) => !value)}
                        />
                        {showImported
                          ? importedGroups.map((group) => (
                              <div key={group.cwd}>
                                <PathLabel path={group.cwd} />
                                <RowList
                                  ariaLabel={`Imported sessions in ${group.cwd}`}
                                >
                                  {group.sessions.map((session) => (
                                    <SessionRow
                                      key={session.sessionId}
                                      session={session}
                                      workerThreadId={importedWorkerThread(
                                        session,
                                      )}
                                      onImport={(target) =>
                                        setImportTargets([target])
                                      }
                                      onOpenWorker={openHere}
                                    />
                                  ))}
                                </RowList>
                              </div>
                            ))
                          : null}
                      </div>
                    )}

                    {sessions.error === null ? null : (
                      <p className={cn("pt-2 text-[11px]", TEXT_URGENT)}>
                        {sessions.error}
                      </p>
                    )}
                    {/* The scan's caveats are a desktop footnote. */}
                    {sessions.note === "" || compact ? null : (
                      <p
                        className={cn(
                          "pt-2 text-[11px] leading-4",
                          TEXT_TERTIARY,
                        )}
                      >
                        {sessions.note}
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        ) : null}
      </div>

      {dialogs}
    </div>
  );
}
