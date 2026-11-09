// The homepage section: the Mission tab's status line, and the decisions the
// chief is waiting on, in the same flat language. No card, no chips.
//
// On a compact viewport the host has already turned the panel into a drawer
// and dropped the sidebar accessory, so this card is one of only three ambient
// signals left. It collapses to two lines: the chief line with
// a single trailing `Delegate`, then the one loudest count as a full-width
// 44px row. Everything else is reachable by tapping through to the panel.
//
// Every row deep links to what its own text names: the chief line to the
// chief's conversation, a count to the Mission board, a decision to that
// worker's composer. A bare `toPluginPanel(CHIEF_PANEL_PATH)` on all three
// would put a phone tap on "2 decisions" into the chief transcript.
import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { cn } from "@/lib/utils";
import { useCosBridge } from "./bridge";
import { homeNowItems } from "./board-rows";
import { topSignal } from "./panel-chrome";
import { StatusDot } from "./status-dot";
import { StatusStrip } from "./status-strip";
import {
  CHIEF_PANEL_PATH,
  DELEGATE_SUBPATH,
  MISSION_SUBPATH,
  SESSIONS_SUBPATH,
  WORKER_SUBPATH_PREFIX,
} from "./tabs";
import { TEXT_TERTIARY } from "./tone";
import { Age, NameLine, QuietButton, Row, RowDetail, RowList } from "./ui";
import {
  bucketRoster,
  chiefLine,
  chiefTone,
  displayName,
  errorText,
  levelWord,
  projectLabel,
  useCosRpc,
  useBoard,
  useRoster,
  useSummary,
  workerNote,
  workerStatus,
} from "./use-cos";

/** One preview is all a phone has room for; a desktop card affords two. */
const TOP_DECISIONS_COMPACT = 1;
const TOP_DECISIONS_WIDE = 2;

/**
 * `-my-3 py-3` grows a 20px word to a 44px hit area without moving anything
 * around it, so a compact card stays two lines tall.
 */
const COMPACT_WORD_HIT_AREA = "-my-3 py-3";

export function HomepageSection() {
  useCosBridge();
  const rpc = useCosRpc();
  const navigate = useBbNavigate();
  const summary = useSummary();
  const roster = useRoster();
  const board = useBoard();
  const compact = useIsCompactViewport();
  const [pending, setPending] = useState(false);

  const start = async () => {
    setPending(true);
    try {
      await rpc.call("chief_ensure", null);
      summary.refetch();
      toast.success("Chief of staff is ready");
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setPending(false);
    }
  };

  if (summary.data === null) {
    return (
      <p className="py-2 text-[13px] text-muted-foreground">{summary.error ?? "Loading"}</p>
    );
  }

  const data = summary.data;

  if (data.chiefThreadId === null) {
    return (
      <div className="flex flex-wrap items-center gap-3 py-1">
        <p className="min-w-0 flex-1 text-[13px] leading-5 text-muted-foreground">
          One thread that delegates every task to reusable workers and never does the work
          itself.
        </p>
        <Button size="sm" onClick={() => void start()} disabled={pending}>
          {pending ? "Starting" : "Start chief of staff"}
        </Button>
      </div>
    );
  }

  const topDecisions = compact ? TOP_DECISIONS_COMPACT : TOP_DECISIONS_WIDE;
  // A For you item the chief marked "now" leads, then the top worker decisions
  // fill what room is left.
  const nowItems = board.data === null ? [] : homeNowItems(board.data).slice(0, topDecisions);
  const decisions =
    roster.data === null
      ? []
      : bucketRoster(roster.data).decisions.slice(0, Math.max(0, topDecisions - nowItems.length));
  // The chief's own conversation. The chief line always points
  // here; every other row on the card names something else and goes there.
  const openPanel = () => navigate.toPluginPanel(CHIEF_PANEL_PATH);
  const openMission = () =>
    navigate.toPluginPanel(CHIEF_PANEL_PATH, { subPath: MISSION_SUBPATH });
  const openWorker = (threadId: string) =>
    navigate.toPluginPanel(CHIEF_PANEL_PATH, {
      subPath: `${WORKER_SUBPATH_PREFIX}${threadId}`,
    });
  const openDelegate = () =>
    navigate.toPluginPanel(CHIEF_PANEL_PATH, { subPath: DELEGATE_SUBPATH });
  // The same loudest-first cascade the panel header and the sidebar read, so the three
  // can never disagree about what today's loudest number is.
  const loudest = topSignal(data);
  const chiefText = chiefLine(data.chiefStatus);
  // The cascade's trailing branch is the chief's own failure, which the line
  // above it already says; two lines of the same three words is not a second
  // signal. Matched on the condition rather than on the exact string, because
  // that branch is the only reason `topSignal` ever names the chief and it is
  // reached only when every worker count is zero.
  const loudestRepeatsChief =
    loudest !== null && data.chiefStatus === "error" && /\bchief\b/i.test(loudest.text);
  // The least urgent thing on the card, so it yields to anything that is
  // actually waiting on the user, at every width. The count is the server's
  // `externalUnimported` and is never recomputed here, so the card and the
  // Mission tab's session archive answer to one rule: an import counts only
  // while the worker it created is un-retired.
  const showSessions = data.externalUnimported > 0 && data.decisions === 0 && data.needsYou === 0;

  return (
    <div>
      {compact ? (
        <>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={openPanel}
              // The state word has to be in the accessible name: an aria-label
              // replaces the span, so without it a screen reader hears the
              // destination and never hears that the chief failed.
              aria-label={`${chiefText}. Open the chief conversation.`}
              className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <StatusDot status={data.chiefStatus ?? "idle"} />
              <span
                className={cn(
                  "min-w-0 truncate text-[12px] leading-5",
                  // A failed chief is a word, not just a red dot.
                  // Shared with the strip so the two cannot drift.
                  chiefTone(data.chiefStatus) ?? "text-foreground",
                )}
              >
                {chiefText}
              </span>
            </button>
            <QuietButton onClick={openDelegate} className={COMPACT_WORD_HIT_AREA}>
              Delegate
            </QuietButton>
          </div>
          {loudest === null || loudestRepeatsChief ? null : (
            <button
              type="button"
              onClick={openMission}
              aria-label={loudest.ariaLabel}
              className={cn(
                "flex min-h-11 w-full cursor-pointer items-center rounded-sm text-left text-[13px] leading-5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                loudest.className,
              )}
            >
              {loudest.text}
            </button>
          )}
        </>
      ) : (
        <StatusStrip
          summary={data}
          // A count is a name for a group of rows, so it opens the board that
          // holds them, not the chief's transcript. The chief line itself is
          // the way into the chief's conversation, as on compact, so there is
          // no separate "Open" word to confuse with the counts.
          onSelect={openMission}
          onOpenChief={openPanel}
          className="pb-2"
          actions={
            // A hairline sets the one verb apart from the counts beside it.
            <div className="flex items-center border-l border-border pl-4">
              <QuietButton tone="primary" onClick={openDelegate}>
                Delegate
              </QuietButton>
            </div>
          }
        />
      )}

      {decisions.length === 0 && nowItems.length === 0 ? null : (
        <div className="border-t border-border">
          <RowList>
            {nowItems.map((item) => (
              <Row
                key={item.id}
                dot={<StatusDot status="idle" urgency="urgent" />}
                title={
                  <NameLine
                    name={item.headline}
                    note="now"
                    noteTone="urgent"
                  />
                }
                age={<Age at={item.createdAt} tone="urgent" />}
                // The Mission tab opens on For you, where the item and its
                // answers are.
                onOpen={openMission}
                openLabel={`Open For you: ${item.headline}`}
              />
            ))}
            {decisions.map((worker) => (
              <Row
                key={worker.id}
                dot={<StatusDot status={workerStatus(worker)} urgency={worker.urgency} />}
                title={
                  <NameLine
                    name={displayName(worker)}
                    slug={worker.name}
                    project={projectLabel(worker)}
                    // Attention always carries a word, the
                    // same word the board uses, so the two never disagree.
                    note={workerNote(worker) ?? levelWord(worker)}
                    // A decision is urgent or attention and nothing else, so
                    // the state word carries the level and the age only turns
                    // when the row is already urgent.
                    noteTone={worker.urgency === "urgent" ? "urgent" : "attention"}
                  />
                }
                body={
                  worker.lastNeed === null ? undefined : (
                    <RowDetail text={worker.lastNeed} clamp={2} size="sm" tone="foreground" label="Needs:" />
                  )
                }
                age={
                  <Age
                    at={worker.lastReportAt ?? worker.lastUsedAt}
                    tone={worker.urgency === "urgent" ? "urgent" : "tertiary"}
                  />
                }
                // The row names one worker's decision, so it opens that
                // worker with the composer focused, the same place the
                // board's "Answer" lands.
                onOpen={() => openWorker(worker.threadId)}
                openLabel={`Answer the decision from ${displayName(worker)}`}
              />
            ))}
          </RowList>
        </div>
      )}

      {showSessions ? (
        <div className="flex min-h-11 items-center gap-3 border-t border-border py-2">
          <span
            className={cn("min-w-0 truncate text-[12px] leading-5", TEXT_TERTIARY)}
          >
            {data.externalUnimported} external{" "}
            {data.externalUnimported === 1 ? "session" : "sessions"} not yet imported
          </span>
          <div className="ml-auto">
            <QuietButton
              onClick={() =>
                navigate.toPluginPanel(CHIEF_PANEL_PATH, { subPath: SESSIONS_SUBPATH })
              }
              className={compact ? COMPACT_WORD_HIT_AREA : undefined}
            >
              Import
            </QuietButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}
