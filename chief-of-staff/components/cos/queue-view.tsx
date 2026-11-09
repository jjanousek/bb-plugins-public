// For you as a queue.
//
// One decision at a time instead of every item at once, so the items can be
// moved through quickly rather than read as a form with many forms in it.
// Here a number picks an answer and the next item comes up; picks collect in
// a tray and go to the chief in one draft, which is the batch, made the
// default rather than a mode.
//
// A very short context paragraph, more details under More: the item shows its
// headline and a lead of one or two sentences. The
// full context, the source worker, the links and the item's history are one
// press away under More, and the source thread one more.
//
// Nothing here sends. The tray drafts into the chief's composer through the
// same `board_address` the list uses, and dismissals through the same state
// move, so the rules those carry (only an offered label reaches the draft, an
// item is "addressed" only when a real send is observed) are unchanged.
import { useEffect, useMemo, useRef, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { BoardItemDto } from "@/contract";
import { cn } from "@/lib/utils";
import { TEXT_TERTIARY, TEXT_URGENT } from "./tone";
import { AnswerBox } from "./answer-box";
import { useOpenOrCopyLink } from "./local-file-links";
import { Age, BAR_WORD_HIT_AREA, EmptyState, QuietButton, StateMark, isTypingTarget, useIsFingerSurface } from "./ui";
import { Glyph } from "./glyph";
import { BOARD_AREA_LABEL, boardHistory, boardOrder, boardBands } from "./board-rows";
import { nextUnmarked, splitLead, trackStates, trayPlan, type QueueMark } from "./queue";
import { useBoardActions } from "./use-board-actions";

/**
 * A key cap: the number or letter that does the thing, drawn as a label, not an
 * icon. Hidden on a finger surface, where there is no key to press and a row of
 * caps would only be clutter; the word beside it carries the meaning there.
 */
function Key({ children }: { children: string }) {
  const finger = useIsFingerSurface();
  if (finger) return null;
  return (
    <kbd
      aria-hidden
      className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded border border-border border-b-2 px-1 font-mono text-[11px] leading-none text-muted-foreground"
    >
      {children}
    </kbd>
  );
}

/** Newest-priority first, oldest first inside a band: the order the list already uses. */
function queueOrder(items: readonly BoardItemDto[]): BoardItemDto[] {
  return boardBands(boardOrder(items.filter((item) => item.state === "open"))).flatMap((band) => band.items);
}

export function QueueView({
  items,
  onRefresh,
  onShowList,
  hasAddressed = false,
  marks,
  setMarks,
  onDismiss,
}: {
  items: readonly BoardItemDto[];
  onRefresh: () => void;
  /** Back to the full list, for anything the queue does not do (priorities, the closed list). */
  onShowList: () => void;
  /** Items sent to the chief and waiting to be resolved, which only the list shows. */
  hasAddressed?: boolean;
  /**
   * What has been staged, owned by the PARENT, so that "Show as list" to
   * check one item's priority and back again does not unmount the queue and
   * throw staged answers away.
   */
  marks: ReadonlyMap<string, QueueMark>;
  setMarks: React.Dispatch<React.SetStateAction<ReadonlyMap<string, QueueMark>>>;
  /**
   * Dismiss through the parent's own move, which records an Undo in the
   * sticky header, so a D pressed by mistake and sent has a way back other
   * than the closed list.
   */
  onDismiss: (ids: string[]) => Promise<boolean>;
}) {
  const navigate = useBbNavigate();
  const openLink = useOpenOrCopyLink();
  const finger = useIsFingerSurface();
  const actions = useBoardActions(onRefresh);
  const queue = useMemo(() => queueOrder(items), [items]);
  const ids = useMemo(() => queue.map((item) => item.id), [queue]);
  // Initialised to the first item, not null: null is the end state, and
  // starting there would flash the end message for one frame on every open
  // while the sync effect catches up.
  const [currentId, setCurrentId] = useState<string | null>(() => ids[0] ?? null);
  const [more, setMore] = useState(false);
  const [sending, setSending] = useState(false);
  /**
   * The answer being typed on the current item, or null when the box is shut.
   * The box opens on the item, and nothing is staged until there are words in
   * it: staging an empty item to answer later in the composer leaves no way to
   * tell, after a mixed pass, which item an empty slot belongs to.
   */
  const [writing, setWriting] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Set when the queue moves; the effect below focuses the new heading.
  const focusNext = useRef(false);
  // Read by the sync effect below, which runs on `ids` alone and so would
  // otherwise see the `marks` and position of its first render.
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const lastIndexRef = useRef(0);
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;

  // The board is two surfaces writing one list: an item can be resolved from
  // its own thread while it sits here. Drop marks for items that left, and
  // keep the current item if it is still open, else take the first unmarked.
  useEffect(() => {
    const live = new Set(ids);
    setMarks((current) => {
      const next = new Map([...current].filter(([id]) => live.has(id)));
      return next.size === current.size ? current : next;
    });
    setCurrentId((current) => {
      if (current !== null && live.has(current)) return current;
      // The first unmarked item AT OR AFTER the current position, not the first in the
      // list: when the item on screen is resolved elsewhere (the board is two
      // surfaces writing one list) the queue should land on the next one, not go
      // back to the start. `marksRef` rather than `marks`, because this effect
      // runs on `ids` alone and the closure's `marks` would be the stale first one.
      const from = current === null ? -1 : lastIndexRef.current - 1;
      const next = nextUnmarked(ids, marksRef.current, from);
      return next === null ? null : ids[next]!;
    });
  }, [ids]);

  const index = currentId === null ? -1 : ids.indexOf(currentId);
  const item = index === -1 ? null : queue[index]!;
  if (index !== -1) lastIndexRef.current = index;

  // After the queue moves, focus the new heading (or the surface at the end),
  // so the keys keep working and a screen reader reads the next question.
  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    (headingRef.current ?? rootRef.current)?.focus({ preventScroll: true });
  }, [currentId]);

  const advance = (from: number, nextMarks: ReadonlyMap<string, QueueMark>) => {
    const next = nextUnmarked(ids, nextMarks, from);
    setCurrentId(next === null ? null : ids[next]!);
    setMore(false);
    setWriting(null);
  };

  /**
   * An answer already put into the chief's composer is final here: a pick or a
   * second write would put the item in the composer twice. It is edited there.
   */
  const inComposer = (id: string): boolean => {
    const current = marks.get(id);
    return current?.kind === "write" && current.drafted === true;
  };
  /** The marks with only the answers already in the composer, for Clear and after a send. */
  const onlyDrafted = (current: ReadonlyMap<string, QueueMark>) =>
    new Map([...current].filter(([, value]) => value.kind === "write" && value.drafted === true));

  const mark = (value: QueueMark) => {
    if (item === null || inComposer(item.id)) return;
    const next = new Map(marks).set(item.id, value);
    setMarks(next);
    advance(index, next);
    // A click leaves focus on the button that was clicked, which then
    // unmounts with its item, and focus falls to the page body, where the
    // number keys stop working. Focus
    // moves to the next item's heading once it renders, which keeps the keys
    // working and lets a screen reader announce the new question.
    focusNext.current = true;
  };

  const back = () => {
    // From the end state (index -1) Back returns to the last item, so a pass
    // that skipped everything is not a dead end.
    if (index === 0 || ids.length === 0) return;
    // From the end, back to where the user left off: `nextUnmarked` wraps, so the
    // last item seen can be anywhere in the list, not only at its end.
    setCurrentId(ids[index === -1 ? Math.min(lastIndexRef.current, ids.length - 1) : index - 1]!);
    setMore(false);
    setWriting(null);
    focusNext.current = true;
  };

  /** Open the answer box on this item, holding what was written before on a return to it. */
  const startWriting = () => {
    if (item === null || inComposer(item.id)) return;
    const before = marks.get(item.id);
    setWriting(before?.kind === "write" ? before.text : "");
  };

  /**
   * Put the typed answer into the chief's composer NOW, and move on.
   *
   * The answer is given while the card is fresh, rather than after working
   * through the rest and then finding the item in the composer. The composer step
   * stays (nothing is sent from here), but the answer goes in the moment it
   * is saved, on its own "My answer:" line under its own question, and the
   * queue stays open. Empty words do nothing.
   */
  const [saving, setSaving] = useState(false);
  const saveWriting = async (text: string) => {
    if (item === null || saving) return;
    // Captured now: the user can move on while the draft is in flight.
    const id = item.id;
    setSaving(true);
    try {
      const ok = await actions.address([id], undefined, [{ id, text }], { stay: true });
      // A refused draft keeps the words in the box rather than losing them.
      if (!ok) return;
      const next = new Map(marksRef.current).set(id, { kind: "write", text, drafted: true });
      setMarks(next);
      // Move on only if the user is still on the item just answered.
      if (currentIdRef.current === id) {
        advance(ids.indexOf(id), next);
        focusNext.current = true;
      }
    } finally {
      setSaving(false);
    }
  };

  const plan = trayPlan(ids, marks);
  const staged = plan.draft.length + plan.dismiss.length;

  const send = async () => {
    if (staged === 0 || sending) return;
    setSending(true);
    try {
      // Dismissals first, and not undone by a failed draft: they are the
      // user's decision on those items whether or not the draft lands.
      if (plan.dismiss.length > 0) {
        const ok = await onDismiss(plan.dismiss);
        if (!ok) return;
      }
      if (plan.draft.length > 0) {
        const ok = await actions.address(plan.draft, plan.picks, plan.answers);
        if (!ok) {
          // Keep the picks: a refused draft must not take the answers with it.
          setMarks((current) => new Map([...current].filter(([id]) => !plan.dismiss.includes(id))));
          return;
        }
      }
      // Answers already in the composer stay marked: the item is open until
      // the chief's send is seen, and must not come back as unanswered.
      setMarks((current) => onlyDrafted(current));
      rootRef.current?.focus({ preventScroll: true });
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const node = event.target instanceof HTMLElement ? event.target : null;
    if (node !== null && (node.isContentEditable || node.tagName === "INPUT" || node.tagName === "TEXTAREA")) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key;
    if (item !== null && /^[1-9]$/.test(key)) {
      const n = Number(key);
      if (n <= item.choices.length) {
        event.preventDefault();
        mark({ kind: "pick", label: item.choices[n - 1]!.label });
      } else if (n === item.choices.length + 1) {
        event.preventDefault();
        startWriting();
      }
      return;
    }
    const lower = key.toLowerCase();
    if (lower === "s" && item !== null) {
      event.preventDefault();
      mark({ kind: "skip" });
    } else if (lower === "d" && item !== null) {
      event.preventDefault();
      mark({ kind: "dismiss" });
    } else if (lower === "m" && item !== null) {
      event.preventDefault();
      setMore((open) => !open);
    } else if (key === "ArrowLeft") {
      event.preventDefault();
      back();
    } else if (key === "Enter" && event.shiftKey && item?.sourceThreadId) {
      event.preventDefault();
      navigate.toThread(item.sourceThreadId);
    } else if (key === "Enter" && staged > 0) {
      // Not when a button has focus: Enter on a focused answer or on "More"
      // is that button's own click; if the root's handler ran as well,
      // pressing Enter on an answer would pick it AND send the whole tray.
      if (node !== null && node !== rootRef.current && node.closest("button,a") !== null) return;
      event.preventDefault();
      void send();
    }
  };

  // Focus the surface so the keys work without a click first, but never out of
  // a field being typed in. The host remounts this panel on navigation and on
  // a realtime reconnect (remembered.ts), and a remount that took focus from
  // the chief's composer would turn the next letters typed into queue keys: "s"
  // skips, "d" stages a dismissal and Enter sends the tray.
  useEffect(() => {
    if (isTypingTarget(document.activeElement)) return;
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  if (queue.length === 0) {
    return (
      <EmptyState
        glyph="emptyBoard"
        title="Nothing waiting on you."
        detail={
          hasAddressed
            ? "Some items are with the chief, waiting to be resolved. They are on the list."
            : "The chief puts items here when it needs a decision, an approval, or your eyes on something."
        }
        // The list holds the addressed and closed items; the queue does not,
        // so an empty queue must not be a dead end.
        action={<QuietButton onClick={onShowList}>Show as list</QuietButton>}
      />
    );
  }

  const track = trackStates(ids, marks, index === -1 ? null : index);
  const lead = item === null ? null : splitLead(item.context);
  const current = item === null ? undefined : marks.get(item.id);
  const history = item === null ? [] : boardHistory(item);
  const due = item?.priority === "now";

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-col outline-none"
      role="region"
      aria-label="For you, one item at a time"
    >
      {/*
        Where you are. The strongest segment is current, amber is answered, the
        mid grey is skipped or dismissed, the faint one is not seen yet. Chosen
        for white as well as dark: a /60 tint for `cleared` is 2.91:1 on white
        and barely distinct from `todo`, so progress would vanish in light mode.
      */}
      <div className="flex h-[5px] items-end gap-[3px] mt-3" aria-hidden>
        {track.map((state, i) => (
          // A picture, not a control. Segments 1 to 5px tall are too thin to
          // aim at with a pointer and a mis-tap trap on a phone, where a tap
          // meant for the first answer could jump to a different item.
          // Back and the numbers move through the queue; the track only shows.
          <span
            key={ids[i]}
            // A HEIGHT per state as well as a hue, so the track reads in
            // grayscale: current is the tallest, answered full, cleared a
            // hairline, not-seen a faint full bar. By hue alone the current
            // and an answered segment look the same in dark mode.
            className={cn(
              "flex-1 self-end rounded-full",
              state === "current" && "h-[5px] bg-foreground",
              state === "picked" && "h-[3px] bg-[color:var(--warning-text,var(--destructive))]",
              state === "cleared" && "h-px bg-muted-foreground/75",
              state === "todo" && "h-[3px] bg-border",
            )}
          />
        ))}
      </div>

      {item === null ? (
        <div className="py-16 text-center">
          <p className="text-[15px] text-foreground">That is all {queue.length}.</p>
          <p className={cn("mt-1 text-[13px]", TEXT_TERTIARY)}>
            {staged > 0 ? "Send the tray, or leave it staged." : "Skipped items come back next time."}
          </p>
          {/* Not a dead end: back into the queue, or out to the list. */}
          <div className="mt-4 flex items-center justify-center gap-5 text-[12px]">
            <QuietButton onClick={back} className={finger ? BAR_WORD_HIT_AREA : undefined}>
              Back
            </QuietButton>
            <QuietButton onClick={onShowList} className={finger ? BAR_WORD_HIT_AREA : undefined}>
              Show as list
            </QuietButton>
          </div>
        </div>
      ) : (
        // Keyed on the item: otherwise React reuses one DOM node across items
        // and a screen reader does not treat the new heading as new content.
        <article key={item.id} className="pt-5 pb-2">
          {/*
            One line at every width. At a narrow phone width a long source label (such as
            "site-builder, after the smoke run") would squeeze the age and the
            counter onto several lines, so only the source gives way: it
            truncates, and the rest never wraps.
          */}
          <div className={cn("mb-2 flex min-w-0 items-center gap-2 whitespace-nowrap text-[12px] leading-5", TEXT_TERTIARY)}>
            <span className="shrink-0">{BOARD_AREA_LABEL[item.area]}</span>
            {item.sourceLabel === null ? null : (
              <>
                <span aria-hidden className="shrink-0">·</span>
                <span className="min-w-0 truncate">{item.sourceLabel}</span>
              </>
            )}
            <span aria-hidden className="shrink-0">·</span>
            <span className={cn("shrink-0", due ? TEXT_URGENT : undefined)}>
              <Age at={item.createdAt} tone={due ? "urgent" : "tertiary"} />
              {due ? " · now" : null}
            </span>
            <span className="ml-auto shrink-0 pl-2 tabular-nums">
              {index + 1} of {queue.length}
            </span>
          </div>

          {/* 16px: a larger headline reads as too large here. */}
          {/*
            h2, focusable, and focused when the queue moves: a screen reader
            then reads the new question. Focus on an unlabelled container would
            leave nothing saying what came next after a pick. Keys still
            work, because the heading sits inside the surface that owns them.
          */}
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="max-w-[60ch] text-[16px] font-semibold leading-snug text-foreground outline-none"
          >
            {item.headline}
          </h2>

          {lead === null || lead.lead === "" ? null : (
            <p className="mt-1.5 max-w-[62ch] text-[13px] leading-5 text-muted-foreground">{lead.lead}</p>
          )}

          {/*
            The gap lives on a wrapper: BAR_WORD_HIT_AREA carries its own
            negative margin, and tailwind-merge would drop this button's mt-2
            in favour of it on a finger, leaving More flush under the lead.
          */}
          <div className={finger ? "mt-5" : "mt-2"}>
            <button
              type="button"
              onClick={() => setMore((open) => !open)}
              className={cn(
                "inline-flex items-center gap-2 text-[12px] leading-5 text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground",
                finger && BAR_WORD_HIT_AREA,
              )}
              aria-expanded={more}
            >
              <Key>M</Key>
              {more ? "Less" : "More"}
            </button>
          </div>

          {more ? (
            <div className="mt-3 max-w-[62ch] space-y-3 border-l-2 border-border pl-4 text-[13px] leading-5">
              {lead !== null && lead.rest !== "" ? (
                <p className="text-muted-foreground">{lead.rest}</p>
              ) : null}
              {item.links.length === 0 && item.sourceThreadId === null ? null : (
                <div className={cn("flex flex-wrap gap-x-4", finger ? "flex-col gap-y-0 [&>button]:min-h-11 [&>button]:text-left" : "gap-y-1")}>
                  {item.sourceThreadId === null ? null : (
                    <button
                      type="button"
                      className="text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
                      onClick={() => navigate.toThread(item.sourceThreadId!)}
                    >
                      Open {item.sourceLabel ?? "the source"}'s thread
                    </button>
                  )}
                  {item.links.map((link) => (
                    <button
                      key={`${link.label}${link.href}`}
                      type="button"
                      className="text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
                      onClick={() => openLink(link.href, item.sourceThreadId)}
                    >
                      {link.label}
                    </button>
                  ))}
                </div>
              )}
              <ul className={cn("space-y-0.5 text-[12px]", TEXT_TERTIARY)}>
                {history.map((entry) => (
                  <li key={`${entry.at}${entry.text}`}>
                    <Age at={entry.at} tone="tertiary" /> · {entry.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/*
            On a pointer the number cap is what says "this is an answer you can
            pick". On a finger there is no cap, and bare accent words do not
            read as clickable, so on a finger each answer gets a 1px outline
            with no fill, and a gap between.
          */}
          {/*
            A skip, a dismiss or an "own words" leaves no box to fill, so after
            Back nothing would say it was staged. It says so in words above the
            answers, the same StateMark the list uses.
          */}
          {current !== undefined && current.kind !== "pick" && current.kind !== "write" ? (
            <div className="mt-4">
              <StateMark text={current.kind === "dismiss" ? "Staged to dismiss" : "Skipped for now"} />
            </div>
          ) : null}
          <div className={cn("mt-4 flex max-w-[560px] flex-col", finger && "gap-2")}>
            {item.choices.map((choice, i) => {
              // Staged is said three ways, never by hue alone: a tick, a
              // filled edge, and aria-pressed. Amber text by itself fails the
              // grayscale check and is invisible to a screen reader, so after
              // Back the staged answer would look like the other two.
              const picked = current?.kind === "pick" && current.label === choice.label;
              return (
                <button
                  key={choice.label}
                  type="button"
                  aria-pressed={picked}
                  onClick={() => mark({ kind: "pick", label: choice.label })}
                  className={cn(
                    "flex items-center gap-3 rounded-md border border-transparent px-2 py-2 text-left text-[14px] leading-5 hover:bg-accent/60",
                    finger && "min-h-11 border-border px-3",
                    picked && "border-primary bg-accent",
                  )}
                >
                  <Key>{String(i + 1)}</Key>
                  <span className="min-w-0 flex-1">{choice.label}</span>
                  {picked ? <Glyph name="check" aria-hidden className="size-3.5 shrink-0" /> : null}
                </button>
              );
            })}
            {writing !== null ? (
              /* The answer is typed HERE, on the item it answers. */
              <AnswerBox
                key={item.id}
                className="mt-2"
                headline={item.headline}
                value={writing}
                onChange={setWriting}
                onSave={(text) => void saveWriting(text)}
                onCancel={() => {
                  setWriting(null);
                  headingRef.current?.focus({ preventScroll: true });
                }}
                saveLabel="Add to the chief's composer"
                busy={saving}
              />
            ) : current?.kind === "write" ? (
              /* The saved answer, shown as the user's, with the way to change it. */
              <div className="mt-2 rounded-md border border-primary bg-accent px-3 py-2">
                <p className={cn("text-[11px] leading-5", TEXT_TERTIARY)}>
                  {current.drafted === true ? "Your answer, in the chief's composer. Not sent." : "Your answer"}
                </p>
                <p className="whitespace-pre-wrap text-[14px] leading-5 text-foreground">{current.text}</p>
                {/* Once it is in the composer, that is where it is edited: a second
                    copy from here would put the item in the composer twice. */}
                {current.drafted === true ? null : (
                  <QuietButton onClick={startWriting} className={cn("mt-1", finger && BAR_WORD_HIT_AREA)}>
                    Edit
                  </QuietButton>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={startWriting}
                // A verb, not a fourth offered answer, so no box on a finger
                // (the list view follows the same rule): 44px tall,
                // and set apart from the answers above it by its muted ink.
                className={cn(
                  "flex items-center gap-3 rounded-md px-2 py-2 text-left text-[14px] leading-5 text-muted-foreground hover:bg-accent/60",
                  finger && "min-h-11 px-3",
                )}
              >
                <Key>{String(item.choices.length + 1)}</Key>
                <span>{item.choices.length > 0 ? "Write an answer" : "Answer"}</span>
              </button>
            )}
          </div>

          <div className={cn("mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px] leading-5", TEXT_TERTIARY)}>
            <button type="button" className={cn("inline-flex items-center gap-1.5 hover:text-foreground", finger && BAR_WORD_HIT_AREA)} onClick={() => mark({ kind: "skip" })}>
              <Key>S</Key>Skip
            </button>
            <button type="button" className={cn("inline-flex items-center gap-1.5 hover:text-foreground", finger && BAR_WORD_HIT_AREA)} onClick={() => mark({ kind: "dismiss" })}>
              <Key>D</Key>Dismiss
            </button>
            <button type="button" className={cn("inline-flex items-center gap-1.5 hover:text-foreground disabled:opacity-40", finger && BAR_WORD_HIT_AREA)} onClick={back} disabled={index <= 0}>
              <Key>←</Key>Back
            </button>
            {/* No "Show as list" here: the Quick review / List pair on the view
                line is the one switch, and it is on screen in both views. */}
          </div>
        </article>
      )}

      {/*
        The tray. Nothing staged, nothing said: it only appears once there is
        something to send, and says in words what the send will do.
      */}
      {staged === 0 ? null : (
        /*
          Bottom-pinned, and it covers the scroller's own bottom padding
          (-bottom-4 -mb-4) so rows do not scroll visibly through a 16px
          strip under it, with the phone's safe area honoured. The counts never
          truncate: at a narrow phone width a cut sentence would hide that the button dismisses
          too. The sentence wraps instead, and the reassurance moves into the
          button's own words on a finger, where a title never shows.
        */
        <div className="sticky -bottom-4 -mx-4 -mb-4 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border bg-background px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <p className="min-w-0 flex-1 text-[12px] leading-5 text-muted-foreground" aria-live="polite">
            <span className="whitespace-nowrap">
              {[
                plan.draft.length > 0 ? `${plan.draft.length} to draft` : null,
                plan.dismiss.length > 0 ? `${plan.dismiss.length} to dismiss` : null,
              ]
                .filter(Boolean)
                .join(", ")}
            </span>
            {finger ? null : <span>. Nothing is sent from here.</span>}
          </p>
          <QuietButton
            onClick={() => {
              setMarks((current) => onlyDrafted(current));
              rootRef.current?.focus({ preventScroll: true });
            }}
            className={finger ? BAR_WORD_HIT_AREA : undefined}
          >
            Clear
          </QuietButton>
          <button
            type="button"
            disabled={sending}
            onClick={() => void send()}
            className={cn(
              "shrink-0 rounded-md bg-foreground px-3 py-1.5 text-[13px] font-medium text-background disabled:opacity-50",
              finger && "min-h-11 px-4",
            )}
            title="Put the answers in the chief's composer and dismiss the rest. Nothing is sent. (Enter)"
          >
            {sending ? "Working" : plan.draft.length > 0 ? "Draft to the chief" : "Dismiss them"}
          </button>
        </div>
      )}
    </div>
  );
}
