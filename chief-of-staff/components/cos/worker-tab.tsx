// Worker: one worker's chat, in place, with the same header vocabulary the
// Mission tab uses. When the worker's last report ended with a "Need:" line,
// that question sits above the transcript as one quiet line, so the answer can
// be typed without scrolling back for it.
import type { KeyboardEvent } from "react";
import {
  ThreadChat,
  experimental_useAppPanel,
  experimental_useFixedTabTarget,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { cn } from "@/lib/utils";
import { WorkerMark } from "./avatar";
import { StatusDot } from "./status-dot";
import { ThreadExecutionBar } from "./thread-execution-bar";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { useDeepLinkTab } from "./deep-link";
import { EXECUTION_TAB, MISSION_TAB, WORKER_TAB } from "./tabs";
import { relativeTime } from "./format";
import { TEXT_ATTENTION, TEXT_TERTIARY, TEXT_URGENT } from "./tone";
import { COMPACT_WORD_HIT_AREA, ChoiceWord, EmptyState, NameLine, QuietButton } from "./ui";
import { toast } from "sonner";
import { LocalFileLinks } from "./local-file-links";
import {

  displayName,
  errorText,
  useCosRpc,
  executionLabel,
  isLevelWord,
  unreadLabel,
  useWorkerForThread,
  workerStateWord,
  workerStatus,
} from "./use-cos";

/**
 * One worker's chat with its header. Exported because the page body renders it
 * directly when the host panel cannot be reached (see `InlineSurface` in
 * app.tsx); inside the panel it is wrapped by `WorkerTab`, which supplies the
 * thread id from the tab's own target.
 */
export function WorkerPane({
  threadId,
  focusRequest,
  onBack,
}: {
  threadId: string;
  focusRequest: number | undefined;
  onBack: () => void;
}) {
  const navigate = useBbNavigate();
  // The header words are 20px lines. On a finger surface they are also the two
  // controls reached with the keyboard up, so they carry the plugin's shared
  // 44px word hit area instead of the host's 20px default.
  const compact = useIsCompactViewport();
  const role = useWorkerForThread(threadId);
  const rpc = useCosRpc();
  const worker = role.data?.worker ?? null;
  /**
   * Draft one of the worker's own offered answers into the composer below.
   * The server re-reads the Need and refuses a label the worker did not offer;
   * the composer banner mounted in this chat takes the text on the next
   * signal. Nothing is sent.
   */
  const choose = async (label: string) => {
    if (worker === null) return;
    try {
      const result = await rpc.call("need_answer_draft", { workerId: worker.id, label });
      if (!result.ok) toast.error(result.text);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  };
  const isChief = role.data?.isChief ?? false;
  /**
   * Three answers, not two. "The fetch has not landed", "the fetch failed"
   * and "this thread is not a worker" are different. Reading null as the
   * third would flash "Unmanaged thread" for a round trip on every open, and a
   * `worker_for_thread` that rejects would leave it there for good, with the
   * name, the project, the state word and the open Need with its tappable
   * answers all gone, and no error and no retry.
   */
  const roleRead: "loading" | "failed" | "ok" =
    role.data !== null ? "ok" : role.error !== null && role.error !== undefined ? "failed" : "loading";
  const urgency = worker === null ? null : worker.urgency;
  // The word decides the colour, not the level alone: "waiting on you" may be
  // amber, "idle" never is, so a worker with an open decision never reads
  // "idle" in amber directly above its Needs line.
  const stateWord = worker === null ? null : workerStateWord(worker);
  const noteTone =
    stateWord !== null && isLevelWord(stateWord)
      ? urgency === "urgent"
        ? "urgent"
        : urgency === "attention"
          ? "attention"
          : "muted"
      : "muted";

  // Escape is Back, unless something is being typed: the composer owns its own.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA")
    ) {
      return;
    }
    event.preventDefault();
    onBack();
  };

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        {worker === null ? (
          <StatusDot status="idle" urgency={urgency ?? undefined} />
        ) : (
          <>
            <StatusDot
              status={workerStatus(worker)}
              urgency={urgency ?? undefined}
            />
            <WorkerMark
              avatar={worker.avatar}
              size={32}
              label={displayName(worker)}
            />
          </>
        )}
        {/* The name line's own box names the `/cos` container, because that is
            the width `NameLine`'s narrow rules are actually about. This header
            is the one place the line renders outside the Mission tab, which
            declares the name on its tab bodies; with no such ancestor the
            queries would match nothing and fail silently, and at 390 the line
            would neither wrap nor drop its execution words.

            On this element rather than the header row: at a 430 viewport the
            header is 430 wide but the name line has 197, because the dot,
            avatar, gaps and the two words on the right take 233. Naming the
            padded header row instead would give 398 and read as narrow at
            430 only because `px-4` happens to bring it under 420 — the right
            answer for the wrong reason, and 32px from being the wrong answer.

            Not on the pane root: inline-size containment also makes the box a
            containing block for fixed descendants, and the execution bar and
            the chat below own popovers that need to escape. */}
        <div className="@container/cos min-w-0 flex-1">
          {worker === null ? (
            <NameLine
              name={
                roleRead === "failed"
                  ? "Could not read this thread"
                  : roleRead === "loading"
                    ? "Reading this thread"
                    : isChief
                      ? "Chief of Staff"
                      : "Unmanaged thread"
              }
            />
          ) : (
            <NameLine
              name={displayName(worker)}
              slug={worker.name}
              project={worker.projectName}
              note={stateWord}
              noteTone={noteTone}
              trailing={[unreadLabel(worker)]}
              execution={executionLabel(worker)}
              // At 390 a long name wraps, and the second line ("· waiting on
              // you · 1 new") can leave the tail so little room that the
              // project renders as a bare "…" with no word behind it. At 430
              // the same header fits a short project whole, so this is the
              // threshold doing its job rather than a name that is too long.
              // An ellipsis standing in for a word is worse than the word
              // being gone, and the name gets the width on a
              // narrow container.
              hideProjectWhenNarrow
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {/* No horizontal padding: the row is `gap-3`, so widening both words
              sideways would leave 4px between two adjacent 44px targets. */}
          <QuietButton
            onClick={() => navigate.toThread(threadId)}
            className={compact ? COMPACT_WORD_HIT_AREA : undefined}
          >
            Open thread
          </QuietButton>
          {/* `min-w-11` because the word is 28px wide: the box grows sideways
              into the header's right padding, which nothing else uses. */}
          <QuietButton
            onClick={onBack}
            className={
              compact
                ? cn(COMPACT_WORD_HIT_AREA, "min-w-11 text-right")
                : undefined
            }
          >
            Back
          </QuietButton>
        </div>
      </div>
      {worker === null || worker.lastNeed === null ? null : (
        // Names the `/cos` container HERE, on the block, not on the row of
        // words inside it. A container query on an element cannot fire on that
        // same element, only on its descendants, so with the name on the flex
        // row the `@[420px]/cos` rules would never match: the words would
        // stack at every width with their 44px bleeds overlapping, and the
        // second word would intercept a click on the first.
        <div className="@container/cos shrink-0 border-b border-border px-4 py-2">
          <p className="line-clamp-3 text-[13px] leading-5 text-foreground">
            {/* Same size and measure as the question on the board (RowDetail),
                so it reads as the thing to answer and not as a footnote. */}
            {/* The label carries the level; the question itself stays plain ink.
                A dismissed need keeps printing so the answer is still findable,
                but its label is muted: it is no longer anyone's open question. */}
            {worker.needDismissed ? (
              <span className="text-muted-foreground">Dismissed need: </span>
            ) : (
              <span
                className={urgency === "urgent" ? TEXT_URGENT : TEXT_ATTENTION}
              >
                Needs:{" "}
              </span>
            )}
            {worker.lastNeed}
          </p>
          {/* Read from the report as it was routed, because the thread could not
              be read just now. Quiet, and only then: the question is still the
              worker's; only its freshness is in doubt. */}
          {worker.lastOutputStoredAt === null ? null : (
            <p className={cn("text-[11px] leading-5", TEXT_TERTIARY)}>
              From its last report, {relativeTime(worker.lastOutputStoredAt)}. The thread could not be read just now.
            </p>
          )}
          {/* The answers the worker offered, directly above the composer that
              sends one. This is the place the words earn the most: on the
              board a tap has to travel here first; here the draft lands in the
              box already being looked at. A dismissed need offers nothing,
              because it is no longer anyone's open question. */}
          {worker.needDismissed || worker.needChoices.length === 0 ? null : (
            <div className="mt-1 flex flex-col @[420px]/cos:flex-row @[420px]/cos:flex-wrap @[420px]/cos:items-center @[420px]/cos:gap-x-4 @[420px]/cos:gap-y-3">
              {worker.needChoices.map((label) => (
                <ChoiceWord
                  key={label}
                  label={label}
                  tabIndex={0}
                  onChoose={() => void choose(label)}
                />
              ))}
            </div>
          )}
        </div>
      )}
      <ThreadExecutionBar threadId={threadId} />
      <LocalFileLinks threadId={threadId} className="min-h-0 flex-1">
        <ThreadChat
          threadId={threadId}
          variant="compact"
          layout="contained"
          permissionPolicy="editable"
          focusRequest={focusRequest}
          className="h-full"
        />
      </LocalFileLinks>
    </div>
  );
}

export function WorkerTab({ subPath }: PluginNavPanelProps) {
  const target = experimental_useFixedTabTarget(WORKER_TAB);
  const panel = experimental_useAppPanel();
  const threadId = target?.target.threadId ?? null;

  // A deep link that names the board, or a different worker, is honoured from
  // here: the page component's own `openFixedTab` does not reach the panel
  // (see deep-link.ts).
  useDeepLinkTab(subPath, "worker", threadId);

  if (threadId === null || target === null) {
    // The two fixed tabs are identical plugin marks, so "Mission" is a word
    // nobody can see from here; "board" is the word on the toggle, and a way in
    // beats a hint.
    return (
      <div className="flex h-full items-start p-6">
        <EmptyState
          title="No worker open"
          detail="Pick a worker on the board and it opens here, with its chat."
          action={
            // Execution is the third identical tab glyph, so the empty tab,
            // which is where a tap on the wrong glyph lands, names it too.
            <div className="flex flex-wrap items-center gap-x-4">
              <QuietButton
                onClick={() =>
                  panel.openFixedTab({
                    surface: { kind: "current" },
                    tab: MISSION_TAB,
                  })
                }
              >
                Open the board
              </QuietButton>
              <QuietButton
                onClick={() =>
                  panel.openFixedTab({
                    surface: { kind: "current" },
                    tab: EXECUTION_TAB,
                  })
                }
              >
                Models and effort
              </QuietButton>
            </div>
          }
        />
      </div>
    );
  }

  // A target asking for focus bumps `focusRequest` through the tab's own
  // sequence, so answering the same worker twice still lands in the composer.
  const focusRequest =
    target.target.focus === true ? target.sequence : undefined;

  return (
    <WorkerPane
      key={threadId}
      threadId={threadId}
      focusRequest={focusRequest}
      onBack={() => {
        target.clear();
        panel.openFixedTab({ surface: { kind: "current" }, tab: MISSION_TAB });
      }}
    />
  );
}
