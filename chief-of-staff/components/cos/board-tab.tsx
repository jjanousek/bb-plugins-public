// For you: the one list the user lands on and works off.
//
// This is not the Mission board. Mission shows what the workers are saying,
// live and unfiltered; this list is curated by hand, one item at a time, and
// nothing lands here on its own. The two never share a row. The chief
// keeps that boundary and does not use one queue for both: worker Need
// lines are neither curated nor addressed to the user, and
// many of them are requests for the chief.
//
// The one rule the whole surface is built around: nothing leaves silently.
// Address writes a draft and stops. An item only greys out once a message
// carrying it was actually sent, which the server observes on the chief
// thread's next turn, and even then it waits here until the chief resolves it.
//
// This is the landing surface. It reads oldest first, because this is a list
// you work off rather than one you add to, and it has one line of counts above
// it. That line is the status strip in mission-tab.tsx, and it only ever names
// things that are NOT on this list, so the number of open items is never stated
// twice: everything it says comes from `summary`, everything below comes from
// `board_list`, and the two can never disagree because they never state the
// same fact.
//
// A row opens in place, and everything about an item lives inside it: the full
// context, where it came from, what has happened to it since, and its
// controls. No context sits behind a clamp with nowhere to read the rest, and
// the report the item came out of is one press away rather than something to
// ask the chief to expand.
import { useEffect, useMemo, useRef, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { ReactNode } from "react";
import type { BoardItemDto, BoardStateDto } from "@/contract";
import { cn } from "@/lib/utils";
import { AnswerBox } from "./answer-box";
import { localFileLink } from "./local-file-link";
import { useOpenOrCopyLink } from "./local-file-links";
import { TEXT_ATTENTION, TEXT_TERTIARY, TEXT_URGENT } from "./tone";
import {
  Age,
  BAR_WORD_HIT_AREA,
  ChoiceRow,
  ChoiceWord,
  DisclosureRow,
  DraftWord,
  EmptyState,
  LogStamp,
  QuietButton,
  Row,
  RowDetail,
  RowList,
  SectionLabel,
  Segmented,
  SelectBox,
  StateMark,
  StaleNote,
  useIsFingerSurface,
  useRovingRows,
  type SegmentOption,
} from "./ui";
import { RowActions, type RowActionItem } from "./row-actions";
import { errorText, useBoard, useCosRpc } from "./use-cos";
import {
  BOARD_PRIORITY_ORDER,
  PRIORITY_WORD,
  boardBands,
  boardHistory,
  boardOrder,
  nextRowKey,
  queueFacts,
  undoLabel,
  undoMoves,
  type BoardPriority,
} from "./board-rows";
import { useBoardActions } from "./use-board-actions";
import { QueueView } from "./queue-view";
import type { QueueMark } from "./queue";
import { useRememberedChoice } from "./remembered";
import { AutoClosedNotice, type AutoClosedItem } from "./auto-closed-notice";

/**
 * The two ways to work For you, as a pair of words on the view line.
 *
 * "Quick review" is the name for the queue. Both words sit at the top in both
 * views, the active one underlined like the view words beside them, because a
 * way back placed at the foot of the list, under every item, cannot be found
 * once the list is on screen.
 */
const PRESENTATIONS = ["queue", "list"] as const;
const PRESENTATION_OPTIONS: readonly SegmentOption[] = [
  { id: "queue", label: "Quick review" },
  { id: "list", label: "List" },
];

/**
 * The ink each band header is set in. The word carries the level; the colour
 * only agrees with it, so the list still reads in grayscale.
 */
const PRIORITY_CLASS: Record<"now" | "soon" | "whenever", string | undefined> = {
  now: TEXT_URGENT,
  soon: TEXT_ATTENTION,
  whenever: undefined,
};

/** What this list is. One wording, printed once, at the foot of the surface. */
const BOUNDARY_LINE =
  "Only the chief adds to this list, one item at a time. Worker reports stay on the Board.";

/** A separator before a destructive word, so it never sits next to a reflex tap. */
function ActionGap() {
  return (
    <span
      aria-hidden
      className="ml-auto h-4 w-px shrink-0 bg-border"
    />
  );
}

/** What a row can be asked to do, once it is open. */
export interface RowActions {
  onAddress: () => void;
  /** Draft this item with the user's own words on its answer line; resolves false if it was refused. */
  onAnswer: (text: string) => Promise<boolean>;
  onSetState: (state: BoardStateDto) => void;
}

/**
 * The verb a curated item carries at rest, or null when it wants nothing.
 *
 * One word, always in the same place, chosen from the item's own state rather
 * than from the band it sits in, so "where do I click" has an answer before
 * any click, and `Put back` is not buried behind a disclosure and an
 * expansion.
 */
export function restingVerb(state: BoardStateDto): string | null {
  switch (state) {
    case "open":
      return "Draft";
    case "addressed":
      return "Resolve";
    case "resolved":
    case "dismissed":
      return "Put back";
  }
}

/**
 * One curated item: a sentence from the chief, and the answers to it.
 *
 * Nothing renders to the left of the sentence. The dismiss menu and the age
 * share the sentence's first line and are always there: hiding them until
 * hover would make a mouse row and a touch row offer different actions in
 * different places, and keeping them fixed lets the reader work through
 * open issues quickly.
 *
 * What does not go in front of the sentence, and why. A priority dot would
 * repeat the NOW / THIS WEEK header in colour on every row. An area glyph
 * would be the same drawing on most items, and the reader takes no different
 * action on one area than on another. A muted `from <sourceLabel>...` fragment
 * would be the first thing the eye hits on every row, truncated, because the
 * chief writes that field as prose (such as "site-builder, after the smoke
 * run") and prose does not fit a slot that shares its line with three other
 * things. And a "Draft" word identical on every open row would point at
 * nothing, while sitting beside a choice that also begins with the word Draft
 * and means something else.
 *
 * What is left is the sentence, then the answers, then a date and a `...` at
 * the lowest contrast on the row. The answers are the only coloured thing,
 * because they are the only thing the user touches.
 */
/**
 * A quiet text action under a row's answers.
 *
 * Deliberately not a `ChoiceWord`: these are not answers, and giving them the
 * same box would put them in the same visual class as the thing they sit
 * beside. Text at muted weight reads as "also available" without competing.
 */
function RowVerb({
  label,
  tabIndex,
  onRun,
}: {
  label: string;
  tabIndex: number;
  onRun: () => void;
}) {
  return (
    <button
      type="button"
      tabIndex={tabIndex}
      onClick={onRun}
      className={cn(
        "cursor-pointer text-[12px] leading-[18px] text-muted-foreground",
        "underline decoration-dotted underline-offset-4",
        "transition-colors hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      {label}
    </button>
  );
}

function BoardRow({
  item,
  variant,
  selected,
  selecting,
  anySelected,
  pick,
  onSelect,
  onShiftSelect,
  onOpenLink,
  expanded,
  onToggle,
  actions,
  onPutBack,
  onChoose,
  onPriority,
  tabIndex,
}: {
  item: BoardItemDto;
  variant: "open" | "addressed" | "closed";
  selected: boolean;
  /** Selection is a mode, entered from the header, not a column on every row. */
  selecting: boolean;
  /** Anything checked anywhere: keeps every box solid while a batch is being built. */
  anySelected: boolean;
  /** The answer staged for this item in the current batch, if any. */
  pick: string | null;
  onSelect: (next: boolean) => void;
  onShiftSelect: () => void;
  onOpenLink: (href: string, threadId: string | null) => void;
  expanded: boolean;
  onToggle: () => void;
  actions: RowActions;
  onPutBack: () => void;
  onChoose: (label: string) => void;
  onPriority: (level: BoardPriority) => void;
  tabIndex: number;
}) {
  const navigate = useBbNavigate();
  const finger = useIsFingerSurface();
  // An item is answered on the row itself; the draft carries the user's words.
  // Null is closed; the text lives here so a refused draft keeps it.
  const [answer, setAnswer] = useState<string | null>(null);
  const [savingAnswer, setSavingAnswer] = useState(false);
  const answering = answer !== null;
  const setAnswering = (open: boolean) => setAnswer(open ? "" : null);
  const context = item.context.trim();
  const wordClass = finger ? BAR_WORD_HIT_AREA : undefined;
  const facts = queueFacts(item);
  const history = boardHistory(item);
  const closed = variant === "closed";
  // Only a closed row carries one. "Draft" on every open item in the list
  // would be chrome, not an affordance.
  const verb = closed ? restingVerb(item.state) : null;

  // Everything the row can do, in one sheet, on every device, so mouse and
  // touch get the same words in the same place.
  const menu: RowActionItem[] = closed
    ? []
    : [
        // No "Draft" entry: the answers in the row are the draft action, and a
        // row with none carries "Draft a reply" in the same place. Listing it
        // here too would show the same word twice, one of them hidden.
        { id: "resolve", label: "Resolve", run: () => actions.onSetState("resolved") },
        ...BOARD_PRIORITY_ORDER.filter((level) => level !== item.priority).map((level) => ({
          id: `move-${level}`,
          label: `Move to ${PRIORITY_WORD[level]}`,
          run: () => onPriority(level),
        })),
        ...(item.sourceThreadId === null
          ? []
          : [{
              id: "source",
              label: "Open the thread it came from",
              run: () => navigate.toThread(item.sourceThreadId!),
            }]),
        { id: "dismiss", label: "Dismiss", run: () => actions.onSetState("dismissed"), tone: "urgent" as const },
      ];

  return (
    <Row
      rowKey={item.id}
      tabIndex={tabIndex}
      // No dot. Priority has exactly the three values the band headers above
      // already print, so a coloured mark in the gutter would say NOW twice, in
      // the one place that guarantees it is read before the sentence.
      lead={
        // ALWAYS PRESENT, not a mode. A batch reachable only after finding a
        // 12px "Select" word in the header and entering a mode is a feature
        // with no door.
        //
        // It is present but QUIET: transparent until the row is hovered or
        // focused, and solid the moment anything is checked. That keeps the
        // resting surface calm while making the first click discoverable.
        // `selecting` still forces
        // it visible so the header control keeps working for a finger, where
        // there is no hover to reveal anything.
        // OPEN ROWS ONLY. `chosen` is derived from the open list, so a ticked
        // addressed or closed row would be counted by nothing and acted on by
        // nothing: the bar would read "0 selected" beside a visible tick and
        // every batch verb would quietly do nothing to it. An always-available
        // checkbox makes that the obvious thing to try.
        variant !== "open" ? undefined : (
          <div
            className={cn(
              "transition-opacity",
              selecting || selected || anySelected
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
            )}
          >
            <SelectBox
              checked={selected}
              label={`Select "${item.headline}"`}
              tabIndex={tabIndex}
              onChange={onSelect}
              onShiftChange={onShiftSelect}
            />
          </div>
        )
      }
      // THE SENTENCE LEADS THE ROW. It is in `title` so it shares its first
      // line with the `...` and the age rail, so no meta line holding only a
      // trigger and a date sits ABOVE the sentence, where the least valuable
      // thing on the row would be the first thing read.
      //
      // Nothing here clamps, and `titleLeads` also pins the rail to the first
      // line so a three-line sentence does not push it to the middle. The real
      // cost: the rail reserves its width down the whole block, so a wrapped
      // line gives up 36px on a pointer and 44px on a finger.
      title={
        <RowDetail
          text={item.headline}
          // Never clamped. The headline IS the row: it is the only thing on
          // the surface the user has to read, and expanding shows the CONTEXT rather
          // than the rest of the headline, so a clamp here is a data-loss bug
          // with nowhere for the overflow to go.
          clamp="none"
          size={closed ? "sm" : "lead"}
          tone={closed ? "muted" : "foreground"}
          // The full column, not the 54ch reading measure. These are single
          // sentences, and a cap would cost a second line on longer ones to
          // protect a measure that only matters when there is a paragraph to
          // keep your place in.
          measure="full"
        />
      }
      extra={
        <>
          {/*
            The decision, in the chief's own order and its own words, on ONE
            wrapping line of boxes sized to their own text. A row nobody
            offered answers for gets one dashed box instead, so the shape of
            this line says "one tap" or "you will have to type" before the
            sentence above it has been read.

            Stacked full-width rows would each be a wide box holding a short
            label. On one line most answer sets fit and a few wrap to two.
            Wrapping is the degradation and it is fine - nothing is hidden and
            nothing is cut.
          */}
          {/*
            State first, on its OWN line rather than in the answer row. Inside
            the grid it would take a whole cell and push the first real answer
            into the second column, so the row would start with a fact instead
            of a choice.
          */}
          {facts.state === null ? null : (
            <div className="pb-1.5">
              <StateMark text={facts.state} />
            </div>
          )}
          {closed ? null : (
            <ChoiceRow>
              {item.choices.map((choice) => (
                <ChoiceWord
                  key={choice.label}
                  label={choice.label}
                  tabIndex={tabIndex}
                  chosen={pick === choice.label}
                  onChoose={() => onChoose(choice.label)}
                />
              ))}
              {item.choices.length > 0 ? null : (
                <DraftWord label="Draft a reply" tabIndex={tabIndex} onDraft={() => setAnswering(true)} />
              )}
            </ChoiceRow>
          )}
          {/*
            THE TWO MOVES THAT ARE NOT AN ANSWER, in the same place on every
            row: write my own, or get rid of it. Neither is buried in the `...`.

            They are NOT in the grid above. "Write an answer" in a cell would
            be wrong twice over: it would read as a fourth option with equal
            weight when it is an escape hatch, and on a two-answer row it would
            add a whole grid row, which is height spent to make the surface
            slower. Quiet text under the answers costs one
            18px line and says "these are the answers; here is what else you
            can do".
          */}
          {closed || !answering ? null : (
            <AnswerBox
              className="max-w-[560px] pt-2"
              headline={item.headline}
              value={answer}
              onChange={setAnswer}
              onSave={(text) => {
                setSavingAnswer(true);
                void actions
                  .onAnswer(text)
                  .then((ok) => {
                    if (ok) setAnswer(null);
                  })
                  .finally(() => setSavingAnswer(false));
              }}
              onCancel={() => setAnswering(false)}
              saveLabel="Draft to the chief"
              busy={savingAnswer}
            />
          )}
          {closed || answering ? null : (
            <div
              className={cn(
                "flex items-center gap-4 pt-2 transition-opacity",
                // Same treatment as the select box: present on the row being
                // worked, quiet everywhere else. Five rows each repeating
                // "Write an answer  Dismiss" is five copies of a fact learned
                // once, and at rest that repetition is most of what the eye has
                // to wade through to reach the next decision.
                //
                // No cost on a pointer: reaching the control means hovering the
                // row, so it is visible by the time it is wanted. `focus-within`
                // covers the keyboard, where the roving row focus reveals them
                // the same way.
                //
                // On a finger they are always shown: hover never happens there,
                // and leaving them to the `...` menu would put the one verb most
                // reached for behind a menu.
                finger ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
              )}
            >
              {/* With no choices, "Draft a reply" in the row above already opens
                  this same box, so a second word for it would be one control twice.
                  It stays where it is the only way to write
                  your own words instead of a choice. */}
              {item.choices.length > 0 ? (
                <RowVerb label="Write an answer" tabIndex={tabIndex} onRun={() => setAnswering(true)} />
              ) : null}
              <RowVerb label="Dismiss" tabIndex={tabIndex} onRun={() => actions.onSetState("dismissed")} />
            </div>
          )}
          {!expanded ? null : (
            <div className="space-y-2 pt-1">
              {context === "" ? null : (
                <p className="max-w-[54ch] whitespace-pre-wrap text-[12px] leading-5 text-muted-foreground">
                  {context}
                </p>
              )}
              <div className="space-y-0.5">
                {history.map((entry) => (
                  <p key={`${entry.at}-${entry.text}`} className="flex items-baseline gap-2">
                    <LogStamp at={entry.at} />
                    <span className="min-w-0 flex-1 text-[12px] leading-5 text-muted-foreground">
                      {entry.text}
                    </span>
                  </p>
                ))}
                {item.sourceLabel !== null ? null : (
                  <p className={cn("pl-[52px] text-[11px] leading-5", TEXT_TERTIARY)}>
                    The chief did not say where this came from.
                  </p>
                )}
              </div>
              {/*
                One links row. "Open the thread" folds in as the first entry, so
                there are not two hit areas on adjacent lines. Each carries a
                tertiary word saying what it does, so one label never means
                three different things.
              */}
              {item.sourceThreadId === null && item.links.length === 0 ? null : (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                  {item.sourceThreadId === null ? null : (
                    <LinkWord
                      label={item.sourceLabel ?? "the source"}
                      kind="thread"
                      wordClass={wordClass}
                      tabIndex={tabIndex}
                      onOpen={() => navigate.toThread(item.sourceThreadId!)}
                    />
                  )}
                  {item.links.map((link) => (
                    <LinkWord
                      key={link.href}
                      label={link.label}
                      kind={linkKind(link.href)}
                      wordClass={wordClass}
                      tabIndex={tabIndex}
                      onOpen={() => onOpenLink(link.href, item.sourceThreadId)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      }
      restingAction={
        verb === null ? undefined : (
          <QuietButton
            tone="primary"
            onClick={closed ? onPutBack : verb === "Draft" ? actions.onAddress : () => actions.onSetState("resolved")}
            className={wordClass}
            tabIndex={tabIndex}
            title={`${verb} (a)`}
            ariaLabel={`${verb}: ${item.headline}`}
          >
            {verb}
          </QuietButton>
        )
      }
      actions={
        menu.length === 0 ? undefined : (
          // A 44px trigger is the finger rule. Under a mouse it would make the
          // row's first line 44px tall while holding nothing but this and a
          // date, so a caller on a pointer shrinks it.
          <RowActions
            ariaLabel={`Actions for "${item.headline}"`}
            items={menu}
            triggerClassName="h-7 w-7 -mr-1"
          />
        )
      }
      compactActions={
        menu.length === 0 ? undefined : (
          <RowActions ariaLabel={`Actions for "${item.headline}"`} items={menu} />
        )
      }
      // The rail is the SAME TWO THINGS at the same x on every row: the `...`
      // and how long this has been waiting. Nothing conditional goes in it: a
      // state word there would move the `...` left and take width off the
      // sentence on just the rows that had it, and a rail the eye cannot park
      // on is not doing the job a rail exists for. State sits at the head of
      // the answers, which is what it
      // qualifies. Elapsed rather than a calendar date, because the question
      // on this list is how long something has been sitting, not which day it
      // arrived, and an elapsed age fits a narrow rail where a calendar date
      // would take width from the sentence beside it.
      age={<Age at={item.createdAt} variant="elapsed" />}
      titleLeads
      onOpen={onToggle}
      openLabel={expanded ? "Collapse this item" : "Open this item"}
      shortcuts={{ open: onToggle }}
    />
  );
}

/** What a link goes to, so one label cannot silently mean three things. */
function linkKind(href: string): string {
  if (href.startsWith("thr_")) return "thread";
  if (/^https?:/i.test(href)) return "web";
  // Opens in bb's file panel (useOpenOrCopyLink); only what cannot be opened is copied.
  if (localFileLink(href) !== null) return "file";
  return "copy";
}

function LinkWord({
  label,
  kind,
  wordClass,
  tabIndex,
  onOpen,
}: {
  label: string;
  kind: string;
  wordClass: string | undefined;
  tabIndex: number;
  onOpen: () => void;
}) {
  return (
    <QuietButton onClick={onOpen} className={wordClass} tabIndex={tabIndex}>
      {label}
      <span className={cn("ml-1.5 text-[11px]", TEXT_TERTIARY)}>{kind}</span>
    </QuietButton>
  );
}

/** What the last move was, and how to put it back exactly as it was. */
interface Undo {
  label: string;
  restore: readonly { id: string; state: BoardStateDto }[];
}

export function BoardTab({
  header,
  chiefThreadId,
  onRefresh,
}: {
  header: (trailing?: ReactNode) => ReactNode;
  /** Null when there is no chief thread, so Address has nowhere to draft. */
  chiefThreadId: string | null | undefined;
  /** Refetch the summary the header's counts read. Its own poll is 20s. */
  onRefresh: () => void;
}) {
  const navigate = useBbNavigate();
  const finger = useIsFingerSurface();
  const rpc = useCosRpc();
  const board = useBoard();
  /**
   * The queue is how For you opens. The list
   * stays, one word away, because it is still the only place for priorities,
   * the addressed and closed lists, and a multi-select across bands.
   */
  // Remembered per device, so a remount does not undo the choice. The stored
  // value is only ever the user's own pick.
  const [presentation, setPresentation] = useRememberedChoice("foryou.v2", PRESENTATIONS, "queue");
  // The queue's staged answers live here, so switching to the list and back
  // does not throw them away.
  const [queueMarks, setQueueMarks] = useState<ReadonlyMap<string, QueueMark>>(new Map());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // Selection is a mode, entered once from the header, rather than a checkbox
  // column standing on every row forever and a "Select" word repeated per band.
  const [selecting, setSelecting] = useState(false);
  /**
   * The answer staged against each item while a batch is being built.
   *
   * Without this a chip click would always draft one item immediately and
   * clear the selection on its way out, so "select two, pick an answer on
   * each" could not happen. The server takes a pick per id (`board_address`
   * matches each against that item's own offered labels); the surface holds
   * them here.
   */
  const [picks, setPicks] = useState<ReadonlyMap<string, string>>(new Map());
  /**
   * What closed on its own (a passed day, a dismissed Need) since the user last looked.
   *
   * This line is the whole safety of auto-dismissal. Nothing is destroyed by it
   * - a dismissed item stays in the database and comes back with `--all` - so
   * the only real risk is that a closure happens and the user never learns of it.
   */
  const [autoClosed, setAutoClosed] = useState<AutoClosedItem[]>([]);
  const [reviewing, setReviewing] = useState(false);
  // Bumped by OK. A fetch that started before it answers with the items just
  // marked seen, and putting those back on screen is the note coming back
  // after the user closed it.
  const autoClosedEpoch = useRef(0);
  useEffect(() => {
    // Not before the board itself has loaded: otherwise this would run once on
    // mount with the board still null and again the moment it arrives, two
    // requests on every open for one answer.
    if (board.data === null) return;
    let live = true;
    const epoch = autoClosedEpoch.current;
    rpc.call("board_auto_dismissed", null).then(
      (result) => {
        if (live && epoch === autoClosedEpoch.current) {
          setAutoClosed(result.items.map((i) => ({ id: i.id, headline: i.headline, note: i.note, state: i.state })));
        }
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [rpc, board.data]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [lastPicked, setLastPicked] = useState<string | null>(null);
  const [showAddressed, setShowAddressed] = useState(false);
  // Recovery is not conditional on anything: the closed list does not ride on
  // the addressed disclosure, so a dismissed item can be reached from this
  // panel even with nothing addressed.
  const [showClosed, setShowClosed] = useState(false);
  const [undo, setUndo] = useState<Undo | null>(null);
  // Not fetched while the disclosure is shut, and explicitly so: passing
  // `undefined` there would fetch the default states, which are the ones already on
  // screen (see useBoard).
  const closed = useBoard(["resolved", "dismissed"], { enabled: showClosed });

  const items = board.data ?? [];
  // Oldest first, flat. No area sections: they cost more height than they
  // save on a short list, and a count on a label adds nothing.
  // The area survives as the first slot of each row's facts line.
  const open = useMemo(
    () => boardOrder(items.filter((item) => item.state === "open")),
    [items],
  );
  // Bands by how soon it needs attention, and inside each band by the area of
  // work it belongs to. A flat list sorted by age is rows of identical
  // weight, which cannot be prioritised from.
  const bands = useMemo(() => boardBands(open), [open]);
  // One clock for the whole render, so two rows written a second apart cannot
  // disagree about whether it is still today.
  const now = Date.now();
  const addressed = useMemo(
    () => boardOrder(items.filter((item) => item.state === "addressed")),
    [items],
  );
  const closedItems = useMemo(() => boardOrder(closed.data ?? []), [closed.data]);

  // Every row the keyboard walks, in the order they are on screen.
  const rowKeys = [
    ...bands.flatMap((band) => band.items.map((item) => item.id)),
    ...(showAddressed ? addressed.map((item) => item.id) : []),
    ...(showClosed ? closedItems.map((item) => item.id) : []),
  ];
  const navigation = useRovingRows(rowKeys);

  const chosen = open.filter((item) => selected.has(item.id));
  const toggle = (id: string, next: boolean) => {
    setLastPicked(id);
    setSelected((current) => {
      const copy = new Set(current);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  };
  /** Shift-click: everything between the last box clicked and this one. */
  const pickRun = (id: string) => {
    const keys = open.map((item) => item.id);
    const from = lastPicked === null ? -1 : keys.indexOf(lastPicked);
    const to = keys.indexOf(id);
    setLastPicked(id);
    if (from === -1 || to === -1) {
      toggle(id, !selected.has(id));
      return;
    }
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    setSelected((current) => {
      const copy = new Set(current);
      for (const key of keys.slice(lo, hi + 1)) copy.add(key);
      return copy;
    });
  };
  /**
   * Drop selected ids and staged answers for items that have left the open
   * list.
   *
   * The board is two surfaces writing to one list, so an item can be resolved
   * from its own thread while it sits ticked here. Keeping the id would make
   * the selection count disagree with what any verb acts on; dropping it here
   * makes the keyboard and the bar read the same thing by construction.
   *
   * Returns the SAME reference when nothing changed, or this re-renders for
   * ever.
   */
  useEffect(() => {
    const live = new Set(open.map((item) => item.id));
    setSelected((current) => {
      const next = new Set([...current].filter((id) => live.has(id)));
      return next.size === current.size ? current : next;
    });
    setPicks((current) => {
      const next = new Map([...current].filter(([id]) => live.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [open]);

  const toggleExpanded = (id: string) =>
    setExpanded((current) => {
      const copy = new Set(current);
      if (copy.has(id)) copy.delete(id);
      else copy.add(id);
      return copy;
    });

  const refresh = () => {
    board.refetch();
    onRefresh();
    if (showClosed) closed.refetch();
  };

  /** Every item this surface currently knows about, whatever list it is in. */
  const known = useMemo(
    () => [...items, ...closedItems],
    [items, closedItems],
  );

  const actions = useBoardActions(refresh);

  /**
   * Drop exactly the ids being acted on, never the whole batch.
   *
   * A row-level verb taken mid-batch must not destroy every other selection
   * and every staged answer with it: "Write an answer" or "Dismiss" on one row
   * leaves the other rows' work alone. Acting on a batch still clears it,
   * because then `ids` IS the batch.
   */
  const forget = (ids: string[]) => {
    const gone = new Set(ids);
    setSelected((current) => new Set([...current].filter((id) => !gone.has(id))));
    setPicks((current) => new Map([...current].filter(([id]) => !gone.has(id))));
  };

  const address = async (
    ids: string[],
    picks?: { id: string; label: string }[],
    answers?: { id: string; text: string }[],
    opts?: { stay?: boolean },
  ): Promise<boolean> => {
    // AFTER, not before. Clearing first would mean a draft the server refused
    // takes the staged answers down with it, and the work to re-pick them is
    // gone with nothing drafted to show for it. The selection is cheap to keep
    // and expensive to rebuild.
    const ok = await actions.address(ids, picks, answers, opts);
    if (ok) forget(ids);
    return ok;
  };

  /**
   * Move items, and remember where they came from.
   *
   * `restore` is read off what is on screen, so an undo only ever puts an item
   * back into a state this surface actually observed. That matters for
   * "addressed", which the server otherwise sets only by watching a real send.
   *
   * `focusNext` is read before the move rather than after: the rows being moved
   * are about to leave the list, and `useRovingRows` would otherwise fall back
   * to the first row, which turns working a list into restarting it.
   */
  const setState = async (
    ids: string[],
    state: BoardStateDto,
    { undoable = true }: { undoable?: boolean } = {},
  ): Promise<boolean> => {
    if (ids.length === 0) return false;
    const before = known
      .filter((item) => ids.includes(item.id))
      .map((item) => ({ id: item.id, state: item.state }));
    const focusNext = nextRowKey(
      rowKeys.filter((key) => !ids.includes(key)),
      null,
    );
    const after = nextRowKey(rowKeys, ids[ids.length - 1] ?? null);
    const ok = await actions.move(ids, state);
    // Same rule as Address: a move the server refused must not take the
    // selection and the staged answers with it.
    if (!ok) return false;
    forget(ids);
    const target = after !== null && !ids.includes(after) ? after : focusNext;
    if (target !== null) navigation.focus(target);
    if (undoable && before.length > 0) {
      setUndo({ label: undoLabel(state, before.length), restore: before });
    }
    return true;
  };

  /** There is no chief thread. Start one, so Draft has somewhere to go. */
  const startChief = async () => {
    try {
      const result = await rpc.call("chief_restart", null);
      onRefresh();
      if (result.ok) toast.success(result.text);
      else toast.error(result.text);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  };

  /** Move one item to another band. Not undoable: it changes nothing but where it sits. */
  const setPriority = async (id: string, priority: BoardPriority) => {
    try {
      const result = await rpc.call("board_update", { id, priority, by: "panel" });
      refresh();
      if (!result.ok) toast.error(result.text);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  };

  /** Put every item back where it was, one call per distinct prior state. */
  const runUndo = async () => {
    if (undo === null) return;
    const moves = undoMoves(undo.restore);
    setUndo(null);
    for (const move of moves) {
      await setState(move.ids, move.state, { undoable: false });
    }
  };

  const openLink = useOpenOrCopyLink();

  /**
   * The letters. Composed over the roving hook rather than spread past it: the
   * hook handles only the arrows and returns early on any modifier, so Shift
   * combinations have to be answered before it sees them.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const node = event.target instanceof HTMLElement ? event.target : null;
    if (
      node !== null &&
      (node.isContentEditable ||
        node.tagName === "INPUT" ||
        node.tagName === "TEXTAREA")
    ) {
      return;
    }
    const key = node?.closest<HTMLElement>("[data-cos-row]")?.dataset.cosRow;
    const row = key === undefined ? null : known.find((item) => item.id === key) ?? null;

    if (event.key === "Escape") {
      if (selected.size > 0) {
        event.preventDefault();
        setSelected(new Set());
        setPicks(new Map());
      } else if (row !== null && expanded.has(row.id)) {
        event.preventDefault();
        toggleExpanded(row.id);
      }
      // Otherwise the host keeps its own Escape.
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Enter") {
      if (row === null) return;
      event.preventDefault();
      if (event.shiftKey) {
        if (row.sourceThreadId === null) toast.error("No thread for this one.");
        else navigate.toThread(row.sourceThreadId);
        return;
      }
      toggleExpanded(row.id);
      return;
    }
    if (event.shiftKey) return;
    // A verb acts on the selection when there is one, and on the focused row
    // otherwise. That is what makes a mixed batch one pass: mark the ones the
    // chief has to see with x, resolve and dismiss the rest as you go, and
    // press a once at the end.
    // `chosen`, not raw `selected`. The bar acts on open items intersected
    // with the selection; taking the selection as-is would let an id left
    // behind by an item since resolved or dismissed elsewhere make the
    // keyboard and the bar compose DIFFERENT batches.
    const targets =
      selected.size > 0
        ? chosen.map((item) => item.id)
        : row === null || row.state === "resolved" || row.state === "dismissed"
          ? []
          : [row.id];
    if (event.key === "x") {
      if (row === null || row.state === "resolved" || row.state === "dismissed") return;
      event.preventDefault();
      toggle(row.id, !selected.has(row.id));
      return;
    }
    if (event.key === "u") {
      if (undo === null) return;
      event.preventDefault();
      void runUndo();
      return;
    }
    if (event.key === "p") {
      if (row === null || (row.state !== "resolved" && row.state !== "dismissed")) return;
      event.preventDefault();
      void setState([row.id], "open");
      return;
    }
    if (targets.length === 0) return;
    if (event.key === "a") {
      event.preventDefault();
      // Same staged answers the bar's Draft uses: a keyboard batch and a
      // clicked one must not compose different drafts.
      void address(
        targets,
        targets.filter((id) => picks.has(id)).map((id) => ({ id, label: picks.get(id) as string })),
      );
    } else if (event.key === "r") {
      event.preventDefault();
      void setState(targets, "resolved");
    } else if (event.key === "d") {
      event.preventDefault();
      void setState(targets, "dismissed");
    }
  };

  const bar =
    undo !== null ? (
      /*
        Every state move offers a way back, in the place the move happened. It
        lives in the sticky header rather than above the list, because a
        dismissal made while scrolled down would otherwise put its own Undo off screen.
        The board is two people writing to one list from surfaces neither can
        see, and an Undo out of sight can cost a decision already made.
      */
      <div className={cn("mt-1 flex items-center gap-x-3", finger ? "gap-y-6" : "gap-y-1")}>
        <span
          aria-live="polite"
          className="min-w-0 flex-1 truncate text-[12px] leading-5 text-muted-foreground"
        >
          {undo.label}
        </span>
        <QuietButton
          tone="primary"
          onClick={() => void runUndo()}
          className={finger ? BAR_WORD_HIT_AREA : undefined}
          title="Undo (u)"
        >
          Undo
        </QuietButton>
        <QuietButton
          onClick={() => setUndo(null)}
          className={finger ? BAR_WORD_HIT_AREA : undefined}
        >
          Keep
        </QuietButton>
      </div>
    ) : !selecting && selected.size === 0 ? null : (
      // SHOWS FOR A SELECTION, not only for the mode. The checkbox is always
      // available, so gating this on the mode could strand the user with items
      // selected, an answer staged on each, and nothing on screen to send them
      // with. A selection with no way to act on it is worse than no selection.
      <div
        className={cn(
          "mt-1 flex flex-wrap items-center gap-x-3",
          finger ? "gap-y-6" : "gap-y-1",
        )}
      >
        {/*
          A count, plus a real way out beside it.

          A bare count is not enough: a selection can be built with the
          always-on checkboxes without ever entering the mode, and then the
          only ways out would be unticking every row or knowing about Escape.
        */}
        <span
          aria-live="polite"
          className={cn("shrink-0 text-[12px] leading-5", TEXT_TERTIARY)}
        >
          {chosen.length} selected
          {/*
            The answered count is the feedback that a chip click did something.
            Staging changes one box's edge, which is easy to miss at the bottom
            of a long list; this says it in words next to the verb that will act
            on it.
          */}
          {chosen.filter((item) => picks.has(item.id)).length > 0
            ? `, ${chosen.filter((item) => picks.has(item.id)).length} answered`
            : null}
        </span>
        <QuietButton
          onClick={() => setSelected(new Set(open.map((item) => item.id)))}
          className={finger ? BAR_WORD_HIT_AREA : undefined}
        >
          All
        </QuietButton>
        <QuietButton
          onClick={() => {
            setSelected(new Set());
            setPicks(new Map());
          }}
          className={finger ? BAR_WORD_HIT_AREA : undefined}
          title="Clear the selection and the answers staged on it (Esc)"
        >
          Clear
        </QuietButton>
        <QuietButton
          tone="primary"
          onClick={() =>
            void address(
              chosen.map((item) => item.id),
              // Only picks for items still in the selection: unchecking a row
              // after staging it must not smuggle its answer into the draft.
              chosen
                .filter((item) => picks.has(item.id))
                .map((item) => ({ id: item.id, label: picks.get(item.id) as string })),
            )
          }
          className={finger ? BAR_WORD_HIT_AREA : undefined}
          title="Put these in the chief's composer, with the answers you picked. Nothing is sent. (a)"
        >
          {/*
            Says where it goes, which answers the two questions being asked at
            this moment - where does this go, and does it send. The verb stays
            "Draft" because it does not send, and that is the half that must
            not be misleading.
          */}
          Draft to chief
        </QuietButton>
        {/* Resolve in bulk, so the only bulk verb here is not the destructive
            one. */}
        <QuietButton
          onClick={() => void setState(chosen.map((item) => item.id), "resolved")}
          className={finger ? BAR_WORD_HIT_AREA : undefined}
          title="Resolve (r)"
        >
          Resolve
        </QuietButton>
        <ActionGap />
        <QuietButton
          tone="destructive"
          onClick={() => void setState(chosen.map((item) => item.id), "dismissed")}
          className={cn(finger ? BAR_WORD_HIT_AREA : undefined, "pl-3")}
          title="Dismiss (d)"
        >
          Dismiss
        </QuietButton>
      </div>
    );

  /**
   * The list's contextual word on the view line: enter selection, or leave it.
   *
   * One word in one place, rather than a "Select" word per band floating at
   * the right edge with no visible relationship to anything. While the mode is
   * on, every row's lead box holds a checkbox instead of a chevron.
   * It sits before the Quick review / List pair, which is on in both views.
   */
  const selectWord =
    presentation === "queue" ? null : open.length === 0 ? null : (
      <QuietButton
        onClick={() => {
          // Entering KEEPS what is already selected; only leaving clears.
          // Clearing on entry would destroy a selection built with the
          // always-on checkboxes by pressing the control that looks like it
          // manages selection.
          setSelecting((on) => {
            if (on) {
              setSelected(new Set());
              setPicks(new Map());
            }
            return !on;
          });
        }}
        className={finger ? BAR_WORD_HIT_AREA : undefined}
        ariaLabel={selecting ? "Leave selection mode" : "Select several items"}
      >
        {selecting ? "Done" : "Select"}
      </QuietButton>
    );

  // The view switch is the same Segmented as For you / Board / Activity, on
  // the same line. On a finger each word is a 44px square at least: "List"
  // alone is 20px wide.
  const viewSwitch = (
    <div className="flex items-center gap-4">
      {selectWord}
      <Segmented
        options={PRESENTATION_OPTIONS}
        value={presentation}
        onSelect={(id) => setPresentation(id === "list" ? "list" : "queue")}
        optionClassName={finger ? BAR_WORD_HIT_AREA : undefined}
      />
    </div>
  );

  const frame = (body: ReactNode) => (
    <div className="@container/cos overflow-x-clip">
      <div className="sticky -top-3 z-20 -mx-4 -mt-3 border-b border-border bg-background px-4 pb-2 pt-3">
        {header(viewSwitch)}
        {bar}
      </div>
      {body}
    </div>
  );

  if (board.error !== null && board.data === null) {
    return frame(<p className="py-3 text-[13px] text-muted-foreground">{board.error}</p>);
  }
  if (board.data === null) {
    return frame(<p className="py-3 text-[13px] text-muted-foreground">Loading</p>);
  }

  const rowProps = (item: BoardItemDto, variant: "open" | "addressed" | "closed") => ({
    key: item.id,
    item,
    variant,
    selected: selected.has(item.id),
    selecting,
    anySelected: selected.size > 0,
    onSelect: (next: boolean) => toggle(item.id, next),
    onShiftSelect: () => pickRun(item.id),
    onOpenLink: openLink,
    expanded: expanded.has(item.id),
    onToggle: () => toggleExpanded(item.id),
    actions: {
      onAddress: () => void address([item.id]),
      onAnswer: (text: string) => address([item.id], undefined, [{ id: item.id, text }]),
      onSetState: (state: BoardStateDto) => void setState([item.id], state),
    },
    onPutBack: () => void setState([item.id], "open"),
    pick: picks.get(item.id) ?? null,
    /**
     * With no batch open, a chip drafts that one item and the view STAYS on the
     * board, the way the queue does, so a run of answers does not mean coming
     * back after every tap. The toast says where the answer went.
     *
     * With a batch open it STAGES instead, and pulls this row into the batch so
     * a chip click never silently acts on something that is not selected.
     * Clicking the staged answer again unstages it, so undoing one pick never
     * means clearing the whole selection and starting over.
     */
    onChoose: (label: string) => {
      if (selected.size === 0) {
        void address([item.id], [{ id: item.id, label }], undefined, { stay: true });
        return;
      }
      setSelected((current) => new Set(current).add(item.id));
      setPicks((current) => {
        const copy = new Map(current);
        if (copy.get(item.id) === label) copy.delete(item.id);
        else copy.set(item.id, label);
        return copy;
      });
    },
    onPriority: (level: BoardPriority) => void setPriority(item.id, level),
    now,
    tabIndex: navigation.tabIndexFor(item.id),
  });

  /** OK: every closure on screen is seen. A failure says so and leaves the note up. */
  const reviewAutoClosed = async () => {
    if (reviewing) return;
    setReviewing(true);
    try {
      await rpc.call("board_auto_reviewed", null);
      autoClosedEpoch.current += 1;
      setAutoClosed([]);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setReviewing(false);
    }
  };

  /**
   * Reopen one item that closed on its own wrongly. The prior state is on the
   * item (dismissed, or resolved from a click in another panel), so the move gets the same
   * Undo strip as any other, even though the closed list holding the item is
   * not loaded.
   */
  const putBackAutoClosed = async (id: string) => {
    const was = autoClosed.find((item) => item.id === id)?.state ?? "dismissed";
    const ok = await actions.move([id], "open");
    if (!ok) return;
    setAutoClosed((current) => current.filter((item) => item.id !== id));
    setUndo({ label: undoLabel("open", 1), restore: [{ id, state: was }] });
  };

  /**
   * What closed on its own, shown in BOTH presentations.
   * The queue is the default view, so a note shown only in the list would
   * leave an overnight auto-closure unseen and never marked reviewed.
   */
  const autoClosedNotice = (
    <AutoClosedNotice
      items={autoClosed}
      busy={reviewing}
      onOk={() => void reviewAutoClosed()}
      onPutBack={(id) => void putBackAutoClosed(id)}
    />
  );

  const empty = open.length === 0 && addressed.length === 0;

  if (presentation === "queue") {
    return frame(
      <>
        {board.stale ? <StaleNote error={board.error ?? ""} onRetry={refresh} /> : null}
        {chiefThreadId !== null ? null : (
          <p className={cn("flex items-center gap-3 pt-2 text-[12px] leading-5", TEXT_URGENT)}>
            <span>No chief thread yet, so answers have nowhere to go.</span>
            <QuietButton tone="primary" onClick={() => void startChief()}>
              Start the chief
            </QuietButton>
          </p>
        )}
        <div className="@[860px]/cos:max-w-[760px]">
          <div className="pt-2">{autoClosedNotice}</div>
          <QueueView
            items={items}
            onRefresh={refresh}
            onShowList={() => setPresentation("list")}
            hasAddressed={addressed.length > 0}
            marks={queueMarks}
            setMarks={setQueueMarks}
            // The list's own move: records the Undo strip in the header, and
            // reports whether the server accepted it.
            onDismiss={(ids) => setState(ids, "dismissed")}
          />
        </div>
      </>,
    );
  }

  return frame(
    <>
      {board.stale ? <StaleNote error={board.error ?? ""} onRetry={refresh} /> : null}

      {/*
        The chief's own state, but only when it stops this surface working:
        `Address` is the primary verb here and it drafts into the chief thread,
        so with no chief it silently stages nothing.
      */}
      {chiefThreadId !== null ? null : (
        <p className={cn("flex items-center gap-3 pt-2 text-[12px] leading-5", TEXT_URGENT)}>
          <span>No chief thread yet, so Draft has nowhere to go.</span>
          {/* A button, not a command to retype. The panel can start it. */}
          <QuietButton
            tone="primary"
            onClick={() => void startChief()}
            className={finger ? BAR_WORD_HIT_AREA : undefined}
          >
            Start the chief
          </QuietButton>
        </p>
      )}

      <div
        className="@[860px]/cos:max-w-[860px]"
        {...navigation.containerProps}
        onKeyDown={(event) => {
          onKeyDown(event);
          if (!event.defaultPrevented) navigation.containerProps.onKeyDown(event);
        }}
      >
        {autoClosedNotice}
        {empty ? (
          <EmptyState
            glyph="emptyBoard"
            title="Nothing waiting on you."
            detail={`The chief puts items here when it needs a decision, an approval, or your eyes on something. ${BOUNDARY_LINE}`}
          />
        ) : (
          bands.map((band) => (
            <section key={band.priority}>
              {/*
                One header level, not two. The band word is the only structure
                left: area sub-headers under these would cost more chrome than
                content on a short list,
                and the area rides on each row's own identity line where it
                belongs to the item rather than to a group.

                The word carries the level and the ink only agrees with it, so
                "Now" still reads Now in grayscale. There is no count: the rows
                are right there and countable.
              */}
              <SectionLabel label={band.label} className={PRIORITY_CLASS[band.priority]} />
              <RowList ariaLabel={band.label}>
                {band.items.map((item) => (
                  <BoardRow {...rowProps(item, "open")} />
                ))}
              </RowList>
            </section>
          ))
        )}

        {/*
          Addressed items: a message was sent about them, so they are out of the
          way, but they do not disappear. The chief resolves them once the work
          behind them is actually done, rather than dropping them silently.
        */}
        {addressed.length === 0 ? null : (
          <div className="mt-4 border-t border-border">
            <DisclosureRow
              open={showAddressed}
              label={
                showAddressed
                  ? `Sent to the chief, waiting to be resolved: ${addressed.length}`
                  : `${addressed.length} sent to the chief, waiting to be resolved`
              }
              onToggle={() => setShowAddressed((current) => !current)}
            />
            {showAddressed ? (
              <RowList ariaLabel="Items you sent to the chief">
                {addressed.map((item) => (
                  <BoardRow {...rowProps(item, "addressed")} />
                ))}
              </RowList>
            ) : null}
          </div>
        )}

        <div className="mt-2 border-t border-border">
          <DisclosureRow
            open={showClosed}
            label={
              showClosed
                ? `Resolved and dismissed: ${closedItems.length}`
                : "Resolved and dismissed"
            }
            onToggle={() => setShowClosed((current) => !current)}
          />
          {showClosed ? (
            closed.error !== null && closed.data === null ? (
              <p className="py-2 text-[12px] text-muted-foreground">{closed.error}</p>
            ) : closed.data === null ? (
              <p className="py-2 text-[12px] text-muted-foreground">Loading</p>
            ) : closedItems.length === 0 ? (
              <p className="py-2 text-[12px] text-muted-foreground">
                Nothing has been resolved or dismissed yet.
              </p>
            ) : (
              <RowList ariaLabel="Resolved and dismissed items">
                {closedItems.map((item) => (
                  <BoardRow {...rowProps(item, "closed")} />
                ))}
              </RowList>
            )
          ) : null}
        </div>
      </div>

      {/*
        What this list is, at the foot rather than above the list, stated once:
        a permanent line above every visit wraps to two lines at narrow widths.
        It is still here when the list is not empty.
      */}
      {empty ? null : (
        <p className={cn("mt-4 text-[11px] leading-5", TEXT_TERTIARY)}>{BOUNDARY_LINE}</p>
      )}
    </>,
  );
}
