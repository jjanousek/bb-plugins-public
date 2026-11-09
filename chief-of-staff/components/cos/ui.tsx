// The small visual vocabulary every Chief of Staff surface is built from.
//
// The reference is bb itself: the sidebar thread list and the chat. Quiet and
// typographic. Nothing is boxed, nothing is filled, nothing is badged. A list
// is rows separated by hairlines; a group is an 11px label; an action is a
// word. The Mission tab, the Worker tab, and the homepage all draw from here
// so the three read as one surface rather than three widgets.
//
// Colour comes from tone.ts and nowhere else, so the whole plugin speaks the
// five attention levels: urgent, attention, active, neutral, and
// the tertiary tier for metadata.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import {
  useMediaQuery,
  usePrefersReducedMotion,
} from "@/components/ui/hooks/use-media-query";
import { Glyph, type GlyphName } from "./glyph";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { elapsed, stamp } from "./format.ts";
import { TEXT_ATTENTION, TEXT_TERTIARY, TEXT_URGENT } from "./tone";
import { plainLine, relativeTime } from "./use-cos";

// --- surface ----------------------------------------------------------------

const POINTER_COARSE_QUERY = "(pointer: coarse)";

/**
 * Is the thing pointing at this panel a finger?
 *
 * `useIsCompactViewport` is a width test (`max-width: 767px`), and an iPhone in
 * landscape is 852px wide. A width test therefore calls that phone a mouse and
 * hides every row action behind a hover that can never happen, which is worse
 * than inflating chrome for a pointer that did not need it. A coarse pointer is
 * a finger at any width, so both terms count.
 *
 * This is a deliberate divergence from the host, which confines its
 * coarse-pointer sizing to `max-md`. Compact stays in the test so the panel
 * keeps honouring `CompactViewportOverrideContext`: a narrow desktop panel is
 * still treated as compact.
 */
export function useIsFingerSurface(): boolean {
  // Both hooks are called on every render. `useIsCompactViewport() || useMediaQuery(...)`
  // would short-circuit the second one and change the hook count when the width flips.
  const compact = useIsCompactViewport();
  const coarse = useMediaQuery(POINTER_COARSE_QUERY);
  return compact || coarse;
}

/**
 * Right-aligned relative age. The only numeric column, so it is tabular, and
 * it sits in a fixed 44px rail so nothing in the reading line ever moves.
 * `tone="urgent"` is reserved for a row that is itself urgent.
 */
/**
 * The row's right rail: when this happened, on every row of every view.
 *
 * 44px wide, 36px on a narrow container. Not 28: a short month-and-day date takes about 36px at
 * 11px tabular, and the rail has to hold the widest thing the formatter can
 * return rather than the widest relative form. The full timestamp is on the
 * title, so the exact time is one hover away on every view instead of only on
 * the curated list.
 */
export function Age({
  at,
  tone = "tertiary",
  variant = "stamp",
}: {
  at: number | null;
  tone?: "tertiary" | "urgent";
  /**
   * `stamp` is a calendar date past 24 hours, for a log. `elapsed` is how long
   * it has been waiting, for a list being triaged, and it is narrow enough
   * ("4d") to sit beside a sentence rather than above one.
   */
  variant?: "stamp" | "elapsed";
}) {
  if (at === null) return null;
  const now = Date.now();
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap text-right text-[11px] tabular-nums",
        variant === "elapsed"
          ? "w-6"
          : "w-11 @max-[420px]/cos:w-9",
        tone === "urgent" ? TEXT_URGENT : TEXT_TERTIARY,
      )}
      title={new Date(at).toLocaleString("en-GB")}
    >
      {variant === "elapsed" ? elapsed(at, now) : stamp(at, now)}
    </span>
  );
}

/**
 * The stamp in a log's own left column.
 *
 * Deliberately not the row rail. A row is one thing with its age pinned to the
 * right edge; a history is a two-column table read down the left, and putting
 * its times on the right would leave a ragged gutter between each time and the
 * sentence it belongs to. One stated exception rather than an accidental
 * inconsistency.
 */
export function LogStamp({ at }: { at: number }) {
  return (
    <span
      className={cn(
        "w-11 shrink-0 whitespace-nowrap text-right text-[11px] tabular-nums @max-[420px]/cos:w-9",
        TEXT_TERTIARY,
      )}
      title={new Date(at).toLocaleString("en-GB")}
    >
      {stamp(at, Date.now())}
    </span>
  );
}

/**
 * How long the running turn has been going, in the same 44px rail as `Age` and
 * counting up on its own: the age of the last finished turn is the one number
 * that says nothing about the run being watched. The tick is once a second but
 * the state only changes when the
 * printed word does, so a row that says "4m" re-renders once a minute.
 */
export function Elapsed({ since }: { since: number }) {
  const [text, setText] = useState(() => relativeTime(since));
  useEffect(() => {
    setText(relativeTime(since));
    const timer = setInterval(() => {
      setText((current) => {
        const next = relativeTime(since);
        return next === current ? current : next;
      });
    }, 1_000);
    return () => clearInterval(timer);
  }, [since]);
  return (
    <span
      title={`Running for ${text}`}
      className={cn(
        "w-11 shrink-0 whitespace-nowrap text-right text-[11px] tabular-nums @max-[420px]/cos:w-9",
        TEXT_TERTIARY,
      )}
    >
      {text}
    </span>
  );
}

/**
 * `Docs QA · waiting on you · docs · 2 new`: the name carries the weight, the
 * note is the one place a level colour lands, and everything after it is
 * provenance. No chips, and the note is always a word, never colour alone.
 * `slug` is the worker's identifier, shown as the name's tooltip so the CLI
 * name is still findable from the board.
 *
 * The line is three boxes, not one truncating run, and the state word sits in
 * the middle one where nothing can push it off.
 *
 * A single `truncate` drops whatever is past the clip point, which on a row
 * with a long name is the note. A name survives being cut ("Site Build…" is
 * still that worker); "for the …" is not a state, so a single truncate keeps
 * the piece that could afford to go and cuts the one that could not.
 *
 * So: the tail takes the leftover width and nothing else (`flex-1`, which is a
 * flex base of zero plus grow), the note never shrinks at all, and the name
 * keeps its natural width until there is no leftover left to take. The note is
 * a state word by construction, so pinning it costs a bounded amount of room.
 * The project sits behind the note for the same reason: at 430 it would push
 * the state word off the line.
 *
 * The tail is not `shrink-[999]`. A huge shrink factor looks like priority but
 * is proportion: it only weights how a deficit is shared, so the browser still
 * takes a share off the name, even on a screen with room to spare. A base of
 * zero removes the tail from the deficit sum entirely, so there is no deficit
 * to share until the name alone overflows.
 *
 * `trailing` is pinned with the note, not put in the tail. Its only caller is
 * `unreadLabel`, there is no other surface on a phone that shows the unread
 * count, and "3 new" is bounded in the same way a state word is.
 *
 * Pinning two things puts the squeeze back on the name: a decision row at 430
 * has about 200px for this line, and "waiting on you · 1 new" is 120px of it.
 * On a narrow container the line therefore wraps
 * instead of competing. A phone is short of width and long on height, the row
 * already has a body line under it, and a wrapped line cuts nothing at all.
 * Above 420px it stays one line, because there the width is real.
 */
/**
 * One thing the user can decide, in someone else's words. Tapping it drafts that answer.
 *
 * The chief's words on a curated board item; the worker's own on a decision
 * row, since a worker can offer its answers in its Need
 * line (`Options: A | B`). Same word, same behaviour, wherever a question has
 * pre-crafted answers: it drafts, it never sends.
 *
 * Stacked and full width on a narrow container, inline words on a wide one. The
 * stack is not a style choice: two choices side by side are about 280px and the
 * phone's content column is about 274, so they wrap, and two wrapped rows of
 * `-my-3 py-3` words overlap their own 44px boxes by 20px. A
 * block that owns its full height cannot overlap anything.
 */
export function ChoiceWord({
  label,
  tabIndex,
  onChoose,
  chosen = false,
}: {
  label: string;
  tabIndex: number;
  onChoose: () => void;
  /**
   * Staged as this item's answer in a batch. The box has to SAY so: while a
   * selection is open a click stages instead of drafting, and an answer that
   * looked identical before and after the click is indistinguishable from a
   * click that did nothing.
   */
  chosen?: boolean;
}) {
  const finger = useIsFingerSurface();
  return (
    <button
      type="button"
      onClick={onChoose}
      tabIndex={tabIndex}
      title="Draft this answer to the chief"
      className={cn(
        // A BOX WITH AN EDGE, because the reader has to be able to tell what
        // is clickable here.
        //
        // A bare word works elsewhere in the plugin but not on THIS surface:
        // the row is a full-bleed button that navigates, so the answer sits
        // inside a container where everything is tappable and nothing shows
        // where one target stops. Colour alone does not fix that. An edge
        // does, because it is the one signal that says where the hit area ENDS.
        //
        // A thumb missing the box does not navigate away: `extra` is
        // `pointer-events-auto` and sits over the full-bleed open button, so a
        // miss beside a chip lands on an inert div and does nothing. A dead tap
        // is recoverable, a navigation away from the list being worked down is
        // not. `w-full` fills the grid cell: the box is the CELL's width, not
        // the text's, which is what makes every answer on the surface the same
        // shape. `justify-start` keeps the label left so the first word of each
        // answer lines up down the column and can be scanned without reading.
        "inline-flex w-full max-w-full cursor-pointer items-center justify-start rounded-md border px-2.5 py-1.5 text-left text-[13px] leading-5",
        // The EDGE is neutral and the label keeps the accent it already had, so
        // this adds no colour to the row at all and the colour budget is untouched -
        // which matters because a four-answer row would otherwise be four
        // coloured boxes, and `--primary` is a light near-grey in the dark
        // theme but a saturated tone in the light one.
        // The border is the affordance; colour is not what is missing.
        chosen ? "border-primary bg-accent text-primary" : "border-border text-primary",
        "transition-colors hover:border-primary/60 hover:bg-accent",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        // 44px is a finger rule; a pointer gets the tight box.
        finger ? "min-h-11 py-2" : "min-h-7 py-1",
      )}
    >
      {label}
    </button>
  );
}

/**
 * The row of answers, and the state of the row that qualifies them.
 *
 * One wrapping line instead of a stack. At a 652px panel most answer sets
 * fit on one line and the rest wrap to two, where a stack would take three or
 * four full-width rows.
 */
/**
 * What has already happened to this row, at the head of its answers.
 *
 * Not in the right rail beside the `...`: a state word there would move the
 * `...` left and shrink the sentence on just the rows carrying it. A rail
 * whose contents move is not a rail: the whole value of one is that the eye
 * parks at a fixed x and finds the same control on every row. So the rail is
 * always the `...` and a two-character age, and this goes at the head of the
 * answers it qualifies. It costs no height: it sits on the answers line, and
 * on a closed row it is that line.
 */
export function StateMark({ text }: { text: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[12px] leading-5", TEXT_TERTIARY)}>
      <Glyph name="check" aria-hidden className="size-3 shrink-0" />
      {text}
    </span>
  );
}

export function ChoiceRow({ children }: { children: ReactNode }) {
  return (
    // A UNIFORM GRID, NOT A RAGGED WRAP. Answers sized to their own text under
    // `flex-wrap` give every item a different silhouette: one chip then two,
    // two then one, three on a line. That makes the surface look untidy -
    // there is no rhythm to lock onto, so every block has to be re-parsed from
    // scratch.
    //
    // Equal columns fix the raggedness without hiding anything, which is the
    // reason this is not a single non-wrapping line with a "+2" overflow: an
    // answer that cannot be seen is an answer that cannot be weighed, and the whole point of
    // the row is choosing between them.
    //
    // Two columns rather than one full-width stack. A stack costs height, and
    // moving through these QUICKLY is the goal, so height matters. One column
    // under 480px, where two would put four words on three lines.
    <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2">{children}</div>
  );
}

export function DraftWord({
  label,
  tabIndex,
  onDraft,
}: {
  label: string;
  tabIndex: number;
  onDraft: () => void;
}) {
  const finger = useIsFingerSurface();
  return (
    <button
      type="button"
      onClick={onDraft}
      tabIndex={tabIndex}
      title="Put this in the chief's composer so you can type an answer. Nothing is sent."
      className={cn(
        // The same box as a ChoiceWord so the answer line is in the same place
        // and the same shape on every row, including `w-full` so it fills its
        // grid cell like the rest, and a dashed edge because this one
        // opens a composer rather than drafting words the chief already wrote.
        // The shape of the line still says "one tap" or "you will have to
        // type" before the sentence above it has been read.
        "inline-flex w-full max-w-full cursor-pointer items-center justify-start rounded-md border border-dashed px-2.5 text-left text-[13px] leading-5",
        "border-border transition-colors hover:border-foreground/40 hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        finger ? "min-h-11 py-2" : "min-h-7 py-1",
        TEXT_TERTIARY,
      )}
    >
      {label}
    </button>
  );
}

/**
 * A 44px tap target around a 16px box. The bleed keeps the
 * row's text where it was, so the line does not move when the surface is a
 * finger rather than a mouse.
 */
export function SelectBox({
  checked,
  label,
  tabIndex,
  onChange,
  onShiftChange,
}: {
  checked: boolean;
  label: string;
  tabIndex: number;
  onChange: (next: boolean) => void;
  onShiftChange: () => void;
}) {
  const finger = useIsFingerSurface();
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center",
        finger ? "-my-3 -ml-3 size-11" : "-my-1 -ml-1 size-7",
      )}
      // Shift-click selects the run between the last box clicked and this one.
      // It is on the wrapper because Radix's Checkbox does not forward the
      // event, and it is mouse-only on purpose: there is no shift on a finger,
      // and the roving hook refuses every modifier including Shift.
      onClickCapture={(event) => {
        if (!event.shiftKey) return;
        event.preventDefault();
        event.stopPropagation();
        onShiftChange();
      }}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
        aria-label={label}
        tabIndex={tabIndex}
        className="size-4"
      />
    </span>
  );
}

export function NameLine({
  name,
  slug,
  project,
  note,
  noteTone = "muted",
  noteId,
  trailing = [],
  execution,
  hideProjectWhenNarrow = false,
  strong = true,
  nameSize = 13,
}: {
  name: string;
  /** The worker's slug, for the name's `title` attribute. */
  slug?: string;
  project?: string;
  note?: string | null;
  noteTone?: "muted" | "urgent" | "attention";
  /** Lets the row point `aria-describedby` at the state word. */
  noteId?: string;
  /** Tertiary words after the note: "2 new". Empty strings are skipped. */
  trailing?: readonly (string | undefined)[];
  /**
   * Where the thread runs ("acp-omp claude-fable-5-1"). Last on the line and
   * dropped on a narrow container: on a phone the line has room for the name or
   * for the provenance, and provenance loses.
   */
  execution?: string;
  /** On a narrow container the project moves to the body line. */
  hideProjectWhenNarrow?: boolean;
  strong?: boolean;
  /**
   * 13px when the first cell is a proper name, 12px when it is a
   * classification.
   *
   * A worker has a name and has to be findable in a long roster, so it
   * is the loudest thing on its line. A curated item has no name, only an area,
   * and an area must never outrank the sentence the user actually has to act on,
   * which lives on the line below. Same component, same slots, one number
   * different.
   */
  nameSize?: 13 | 12;
}) {
  const extra = trailing.filter(
    (word): word is string => word !== undefined && word !== "",
  );
  const hasNote = note !== undefined && note !== null && note !== "";
  const hasTail = project !== undefined || (execution !== undefined && execution !== "");
  // A flex item is blockified, so the leading space of a `" · "` string would be
  // dropped at the start of one. The gap supplies that space instead and each
  // box carries its own separator.
  return (
    <span className="flex min-w-0 items-baseline gap-1 overflow-hidden leading-5 @max-[420px]/cos:flex-wrap">
      <span
        title={slug !== undefined && slug !== name ? slug : undefined}
        className={cn(
          "min-w-0 truncate",
          nameSize === 13 ? "text-[13px] text-foreground" : "text-[12px] text-muted-foreground",
          strong && "font-semibold",
        )}
      >
        {name}
      </span>
      {!hasNote ? null : (
        <span
          id={noteId}
          className={cn(
            "shrink-0 whitespace-nowrap text-[12px]",
            noteTone === "urgent"
              ? TEXT_URGENT
              : noteTone === "attention"
                ? TEXT_ATTENTION
                : "text-muted-foreground",
          )}
        >
          {"· "}
          {note}
        </span>
      )}
      {extra.map((word) => (
        <span
          key={word}
          className={cn(
            "shrink-0 whitespace-nowrap text-[11px] tabular-nums",
            TEXT_TERTIARY,
          )}
        >
          {"· "}
          {word}
        </span>
      ))}
      {!hasTail ? null : (
        <span className="min-w-0 flex-1 truncate">
          {project === undefined ? null : (
            <span
              className={cn(
                "text-[12px] text-muted-foreground",
                hideProjectWhenNarrow && "@max-[420px]/cos:hidden",
              )}
            >
              {"· "}
              {project}
            </span>
          )}
          {execution === undefined || execution === "" ? null : (
            <span
              className={cn(
                "text-[11px] tabular-nums @max-[420px]/cos:hidden",
                TEXT_TERTIARY,
              )}
            >
              {project === undefined ? "· " : " · "}
              {execution}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

/**
 * The line under a name. 13px carries meaning the eye should stop on (a need,
 * an excerpt worth reading); 12px muted is a footnote. Markdown that came out
 * of a chat message is flattened, so no row ever prints ** or a backtick. The
 * measure is capped at 68 characters so a 940px panel still reads as prose.
 */
export function RowDetail({
  text,
  clamp = 2,
  size = "xs",
  tone = "muted",
  label,
  narrowPrefix,
  measure = "reading",
}: {
  text: string;
  /** `none` for text that must be readable in full, whatever the width. */
  clamp?: 1 | 2 | 3 | "none";
  /**
   * `lead` is 15px with a taller line, for a line that IS the row rather than a
   * detail under one. Without it the For you sentence and the answers to it
   * would both be 13px, so a rank of choices would read as more prose and the
   * surface would have no hierarchy at all. The sentence has to out-rank its
   * own answers.
   */
  size?: "xs" | "sm" | "lead";
  tone?: "muted" | "foreground";
  /** A muted word before the text that says what the line is: "Needs:". */
  label?: string;
  /** The project name, shown here only while the container is narrow. */
  narrowPrefix?: string;
  /**
   * `reading` caps the line at 54ch, which is the comfortable measure for
   * prose. `full` lets it run the whole column, and is for a line that is one
   * SENTENCE rather than a paragraph. At a 652px panel the cap stops a
   * headline at about 511px and leaves the rest of the row empty beside it, so
   * a long one-sentence headline would take a second line purely to respect a
   * measure that only matters when there is a second sentence to keep track
   * of. A one-sentence label is not prose.
   */
  measure?: "reading" | "full";
}) {
  return (
    <p
      className={cn(
        measure === "full" ? null : "max-w-[54ch]",
        size === "lead" ? "text-[15px] leading-[1.4]" : "leading-5",
        size === "lead" ? null : size === "sm" ? "text-[13px]" : "text-[12px]",
        tone === "foreground" ? "text-foreground" : "text-muted-foreground",
        clamp === "none"
          ? null
          : clamp === 1
            ? "line-clamp-1"
            : clamp === 2
              ? "line-clamp-2"
              : "line-clamp-3",
      )}
    >
      {narrowPrefix === undefined ? null : (
        <span className="hidden text-muted-foreground @max-[420px]/cos:inline">
          {narrowPrefix}
          {" · "}
        </span>
      )}
      {label === undefined ? null : (
        <span className="text-muted-foreground">{label} </span>
      )}
      {plainLine(text)}
    </p>
  );
}

/**
 * The row's left dot: how much of the user's attention this row wants.
 *
 * One meaning across the whole panel, so the dot column reads as a rail and the
 * few coloured ones are findable by scanning it. The Board passes a worker's
 * urgency through `StatusDot`, which also carries thread state; this is the
 * plain version for rows that have a level but no running thread behind them.
 */
export function LevelDot({ level }: { level: "urgent" | "attention" | "neutral" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-[7px] size-1.5 shrink-0 rounded-full",
        level === "urgent"
          ? "bg-[color:var(--destructive-text,var(--destructive))]"
          : level === "attention"
            ? "bg-[color:var(--cos-attention,var(--primary))]"
            : "bg-muted-foreground/40",
      )}
    />
  );
}

/** A flat list: hairlines between rows, no border of its own. */
export function RowList({
  children,
  ariaLabel,
}: {
  children: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <div role="list" aria-label={ariaLabel} className="divide-y divide-border">
      {children}
    </div>
  );
}

// --- keyboard ---------------------------------------------------------------

/** Single-letter shortcuts never fire while text is being typed or a control has focus. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** A button or a link handles its own Enter, so the row must not act as well. */
function isControlTarget(target: EventTarget | null): boolean {
  if (isTypingTarget(target)) return true;
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "BUTTON" || tag === "A";
}

/** What a row can do from the keyboard. */
export interface RowShortcuts {
  /** Enter. Defaults to the row's own `onOpen`. */
  open?: () => void;
  /** Shift+Enter: the full thread. */
  thread?: () => void;
  /** a */
  answer?: () => void;
  /** c */
  askChief?: () => void;
  /** r */
  retire?: () => void;
  /** i */
  importSession?: () => void;
  /** d: dismiss a need that was answered elsewhere. */
  dismiss?: () => void;
}

const SHORTCUT_KEYS: readonly { key: string; field: keyof RowShortcuts }[] = [
  { key: "a", field: "answer" },
  { key: "c", field: "askChief" },
  { key: "r", field: "retire" },
  { key: "i", field: "importSession" },
  { key: "d", field: "dismiss" },
];

/** `aria-keyshortcuts`, so the row announces what it answers to. */
function keyShortcutsOf(
  shortcuts: RowShortcuts | undefined,
  canOpen: boolean,
): string | undefined {
  const parts: string[] = [];
  if (canOpen) parts.push("Enter");
  if (shortcuts?.thread !== undefined) parts.push("Shift+Enter");
  for (const entry of SHORTCUT_KEYS) {
    if (shortcuts?.[entry.field] !== undefined) parts.push(entry.key);
  }
  return parts.length === 0 ? undefined : parts.join(" ");
}

export interface RowNavigation {
  /** 0 for the one row that is in the tab order, -1 for every other. */
  tabIndexFor: (key: string) => number;
  /**
   * Put the keyboard on this row.
   *
   * A list whose rows are removed by their own actions needs this: the caller
   * reads the next key before it issues the move and calls `focus` once the
   * server accepts, so the fallback below never decides for it.
   */
  focus: (key: string) => void;
  containerProps: {
    ref: RefObject<HTMLDivElement | null>;
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
    onFocusCapture: (event: FocusEvent<HTMLDivElement>) => void;
    onBlurCapture: (event: FocusEvent<HTMLDivElement>) => void;
  };
}

/** The key of the row `node` sits in, or undefined when it sits in no row. */
function rowKeyOf(node: EventTarget | null): string | undefined {
  if (!(node instanceof HTMLElement)) return undefined;
  const key = node.closest<HTMLElement>("[data-cos-row]")?.dataset.cosRow;
  return key === undefined || key === "" ? undefined : key;
}

/**
 * One roving tabindex for a whole board. `keys` is every row in reading order,
 * across sections, because Arrow keys have to cross a section boundary without
 * the reader thinking about it. Tab enters and leaves the board in one press.
 */
export function useRovingRows(keys: readonly string[]): RowNavigation {
  const container = useRef<HTMLDivElement | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const focusedRow = useRef<string | null>(null);
  // The fallback to the first row is for a list whose rows only ever arrive:
  // on the Mission board nothing is removed by its own action, so it never
  // fires. On the curated list Resolve and Dismiss remove the focused row on
  // purpose, and falling back would send the keyboard to the top after every
  // single move. That list names its own next row through `focus` before the
  // move, so `activeKey` is already a key that survives.
  const current =
    activeKey !== null && keys.includes(activeKey)
      ? activeKey
      : (keys[0] ?? null);
  // The joined keys stand in for the array's identity, which changes every render.
  const signature = keys.join(" ");

  const focusRow = useCallback((key: string) => {
    setActiveKey(key);
    const root = container.current;
    if (root === null) return;
    for (const row of Array.from(
      root.querySelectorAll<HTMLElement>("[data-cos-row]"),
    )) {
      if (row.dataset.cosRow !== key) continue;
      row.focus();
      row.scrollIntoView({ block: "nearest" });
      return;
    }
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    if (isTypingTarget(event.target)) return;
    // The container is spread on a wrapper that also holds both archive
    // disclosures, their rows, the Import buttons and the empty state. Only a
    // key pressed inside a row this hook actually owns may move focus;
    // anywhere else Arrow keys must stay with the scroller. Rows outside the
    // board render no `data-cos-row`, so `closest` finds nothing for them.
    const owner = rowKeyOf(event.target);
    if (owner === undefined || !keys.includes(owner)) return;
    const index = current === null ? -1 : keys.indexOf(current);
    let next: string | undefined;
    if (event.key === "ArrowDown")
      next = keys[Math.min(index + 1, keys.length - 1)];
    else if (event.key === "ArrowUp") next = keys[Math.max(index - 1, 0)];
    else if (event.key === "Home") next = keys[0];
    else if (event.key === "End") next = keys[keys.length - 1];
    else return;
    if (next === undefined) return;
    event.preventDefault();
    focusRow(next);
  };

  const onFocusCapture = (event: FocusEvent<HTMLDivElement>) => {
    const key = rowKeyOf(event.target);
    if (key === undefined) return;
    focusedRow.current = key;
    setActiveKey(key);
  };

  const onBlurCapture = (event: FocusEvent<HTMLDivElement>) => {
    // Focus went somewhere that is not a row, so there is nothing to restore.
    if (rowKeyOf(event.relatedTarget) === undefined) focusedRow.current = null;
  };

  // Chrome fires no blur when a focused node is removed, so a ref that is
  // still set while nothing on the page holds row focus is exactly the signal
  // that the row under the keyboard went away (the board keeps
  // one tab stop). Containment in the container is deliberately not the test:
  // the container also wraps the disclosures, the Import buttons and the
  // empty-state Delegate, so a containment guard would yank focus onto a row
  // twice a minute on the 20s poll.
  useLayoutEffect(() => {
    if (focusedRow.current === null || current === null) return;
    if (rowKeyOf(document.activeElement) !== undefined) return;
    focusRow(current);
  }, [signature]);

  return {
    tabIndexFor: (key: string) => (key === current ? 0 : -1),
    focus: focusRow,
    containerProps: {
      ref: container,
      onKeyDown,
      onFocusCapture,
      onBlurCapture,
    },
  };
}

/**
 * The keys that appeared since the previous render of this list. New rows fade
 * in once; the set is seeded on first mount, and again on the first render
 * that has any rows at all, so arriving data does not flash the whole list.
 */
export function useNewRowKeys(keys: readonly string[]): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const latest = useRef<readonly string[]>(keys);
  latest.current = keys;
  const [fresh, setFresh] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  // The joined keys stand in for the array's identity, which changes every render.
  const signature = keys.join(" ");
  useEffect(() => {
    const previous = seen.current;
    const next = new Set(latest.current);
    seen.current = next;
    // The list is empty until the roster lands, and that first fill is not news.
    if (previous === null || previous.size === 0) return;
    const added = new Set([...next].filter((key) => !previous.has(key)));
    setFresh((current) =>
      added.size === 0 && current.size === 0 ? current : added,
    );
  }, [signature]);
  return fresh;
}

// --- rows -------------------------------------------------------------------

/**
 * One row of a flat list. The whole row is a click target; the trailing text
 * actions sit above it and appear on hover or focus. The hover and focus
 * affordance is a bleed box two pixels wider than the text column, so the
 * highlight traces the row rather than a rectangle inside it.
 */
export function Row({
  dot,
  lead,
  title,
  body,
  extra,
  age,
  actions,
  restingAction,
  compactActions,
  onOpen,
  openLabel,
  rowKey,
  tabIndex,
  shortcuts,
  titleLeads = false,
  describedBy,
  isNew = false,
}: {
  /** The 6px status dot, in its own gutter on the canvas, so its colour is judged against the canvas it was tuned for. */
  dot?: ReactNode;
  /** A 20px mark (a worker avatar) after the dot, aligned to the first line. */
  lead?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  /**
   * Interactive content belonging to this row: choices, links, an expanded
   * block. It is a separate slot because it is the only part of the text column
   * that can take a tap (see the comment where it renders).
   */
  extra?: ReactNode;
  age?: ReactNode;
  actions?: ReactNode;
  /**
   * One action word that stays visible at rest, outside the hover fade. The
   * only user of this is Answer on a decision row: the one action the user
   * must never have to hunt for. Everything else is
   * hover-only.
   */
  restingAction?: ReactNode;
  /** Rendered instead of `actions` on a finger surface, where hover does not exist. */
  compactActions?: ReactNode;
  onOpen?: () => void;
  openLabel?: string;
  /** Identity for the board's roving tabindex. */
  rowKey?: string;
  /** 0 for the single row in the tab order, -1 for the rest. Omit to opt out. */
  tabIndex?: number;
  shortcuts?: RowShortcuts;
  /**
   * The title holds the row's PAYLOAD SENTENCE rather than a label, so it
   * leads the row. Two things change: the right rail aligns to the sentence's
   * first line instead of centring on the whole block, and under a pointer the
   * sentence takes its own pointer events back so a drag selects it, which is
   * the same rule `body` already has and the reason a headline with a path in
   * it can still be copied.
   *
   * Made for the For you list, so no line above every sentence carries
   * nothing but a `...` and a date, first on the row, on every item. Nothing
   * here truncates.
   */
  titleLeads?: boolean;
  /** Id of the state word, so a reader hears "site-builder, personal, due today". */
  describedBy?: string;
  isNew?: boolean;
}) {
  const finger = useIsFingerSurface();
  const reducedMotion = usePrefersReducedMotion();
  const shownActions = finger ? compactActions : actions;
  const open = shortcuts?.open ?? onOpen;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (isControlTarget(event.target)) return;
    if (event.key === "Enter") {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const run = event.shiftKey ? shortcuts?.thread : open;
      if (run === undefined) return;
      event.preventDefault();
      run();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    const entry = SHORTCUT_KEYS.find(
      (candidate) => candidate.key === event.key,
    );
    const run = entry === undefined ? undefined : shortcuts?.[entry.field];
    if (run === undefined) return;
    event.preventDefault();
    run();
  };

  return (
    <div
      role="listitem"
      data-cos-row={rowKey}
      tabIndex={tabIndex}
      aria-describedby={describedBy}
      aria-keyshortcuts={
        tabIndex === undefined
          ? undefined
          : keyShortcutsOf(shortcuts, open !== undefined)
      }
      onKeyDown={handleKeyDown}
      className={cn(
        // py-3.5, not py-2.5. A row's own internals are tall once answers are a
        // grid, so the gap BETWEEN rows has to stay clearly bigger than the
        // gaps inside one, or blocks read as a single wall rather
        // than as separate decisions. Separation between items has to beat
        // separation within an item or the grouping inverts.
        "group relative flex min-w-0 items-start gap-2 py-3.5 focus:outline-none focus-visible:outline-none",
        // A finger needs 44px; a mouse does not.
        finger && "min-h-11 py-3",
        isNew && !reducedMotion && "animate-in fade-in-0 duration-150 ease-out",
      )}
    >
      {onOpen === undefined ? null : (
        <button
          type="button"
          aria-label={openLabel}
          onClick={onOpen}
          tabIndex={tabIndex === undefined ? undefined : -1}
          className="peer absolute -inset-x-1 inset-y-0 cursor-pointer focus-visible:outline-none"
        />
      )}
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-x-2 inset-y-0 rounded-sm group-hover:bg-accent/60 group-focus-visible:ring-1 group-focus-visible:ring-ring peer-focus-visible:ring-1 peer-focus-visible:ring-ring"
      />
      {dot === undefined ? null : (
        <span className="relative mt-[7px] flex shrink-0">{dot}</span>
      )}
      {lead === undefined ? null : (
        <span className="relative flex shrink-0">{lead}</span>
      )}
      <div className="pointer-events-none relative min-w-0 flex-1">
        <div
          className={cn(
            "flex min-w-0 gap-3",
            // The rail centres on a one-line label and would drift to the
            // middle of a three-line sentence, so a leading title pins it to
            // the top and nudges it onto the sentence's own first line.
            titleLeads ? "items-start" : "items-center",
          )}
        >
          <div
            className={cn(
              "min-w-0 flex-1",
              // Same rule as `body` below, and for the same reason: the column
              // is inert so the full-bleed open button keeps working, and only
              // the payload takes its events back, and only under a pointer.
              titleLeads && !finger && "pointer-events-auto select-text",
              titleLeads && !finger && open !== undefined && "cursor-pointer",
            )}
            onClick={
              !titleLeads || finger || open === undefined
                ? undefined
                : () => {
                    if ((window.getSelection()?.toString() ?? "") === "")
                      open();
                  }
            }
          >
            {title}
          </div>
          {restingAction === undefined ? null : (
            <div
              className={cn(
                "pointer-events-auto flex shrink-0 items-center",
                titleLeads && "mt-px",
              )}
            >
              {restingAction}
            </div>
          )}
          {shownActions === undefined ? null : (
            <div
              className={cn(
                "pointer-events-auto flex shrink-0 items-center gap-3",
                titleLeads && "mt-px",
                // Always visible, on every device. A word that fades in on
                // hover would leave the answer to "what can I do with this
                // row" invisible on a desktop until the pointer is already on
                // it. Buttons must be easy to find; a control you have to
                // hover to discover is not findable, it is remembered. The row
                // carries at most one word and one `...` at rest, which is
                // little enough to leave on screen.
                null,
              )}
            >
              {shownActions}
            </div>
          )}
          {age === undefined ? null : titleLeads ? (
            <span className="mt-1 flex shrink-0">{age}</span>
          ) : (
            age
          )}
        </div>
        {body === undefined ? null : (
          <div
            className={cn(
              "mt-0.5",
              // The text column above is inert so the full-bleed open button
              // under it keeps the whole row clickable. Under a pointer the
              // payload alone takes its pointer events back, so a drag across a
              // `Need:` line selects the words instead of pressing the
              // invisible button at both ends of the gesture; the click that
              // ends such a drag bubbles to the row div, which has no handler,
              // so nothing navigates. The title, the age rail and the rest of
              // the row stay inert and keep opening the worker.
              //
              // A finger keeps the inert body: selection there is a long press,
              // which pointer events would not grant anyway, and the body is
              // half of the row's 44px tap target.
              !finger && "pointer-events-auto select-text",
              !finger && open !== undefined && "cursor-pointer",
            )}
            // A plain click on the body opens the row like everywhere else on
            // it; only a click that ends a text selection is left alone, so a
            // drag across the question still copies it. Without this the
            // largest, darkest target on a decision row would do nothing while
            // the hover highlight covers it.
            onClick={
              finger || open === undefined
                ? undefined
                : () => {
                    if ((window.getSelection()?.toString() ?? "") === "")
                      open();
                  }
            }
          >
            {body}
          </div>
        )}
        {extra === undefined ? null : (
          /*
            Anything interactive that belongs to a row goes here, not in `title`
            or `body`. The whole text column above is `pointer-events-none` so
            the full-bleed open button underneath keeps the row clickable, and
            only `body` takes its events back, and only under a pointer. A
            control placed anywhere else in the column is therefore dead to a
            finger, silently: it renders, it highlights, and nothing happens.
          */
          <div className="relative mt-1 pointer-events-auto">{extra}</div>
        )}
      </div>
    </div>
  );
}

/**
 * 11px uppercase group label with the count as plain text after it. The label
 * is hidden from assistive tech: its name is carried by the sibling list's
 * `aria-label`, so a reader is not stopped by a heading between rows.
 */
export function SectionLabel({
  label,
  count,
  action,
  className,
}: {
  label: string;
  count?: number;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-1.5 mt-4 flex items-center gap-2", className)}>
      <h3
        aria-hidden
        className={cn(
          "shrink-0 text-[11px] font-medium uppercase tracking-wide",
          TEXT_TERTIARY,
        )}
      >
        {label}
      </h3>
      {count === undefined ? null : (
        <span
          aria-hidden
          className={cn("text-[11px] tabular-nums", TEXT_TERTIARY)}
        >
          {count}
        </span>
      )}
      {action === undefined ? null : (
        <div className="ml-auto shrink-0">{action}</div>
      )}
    </div>
  );
}

/**
 * `-my-3 py-3` grows a 20px word into a 44px hit area without moving the line
 * it sits on and without painting anything new. Shared so the
 * strip, the home card, the Worker tab header and the panel header cannot
 * drift apart on the one number that has to be identical.
 */
export const COMPACT_WORD_HIT_AREA = "-my-3 py-3";

/**
 * The same 44px hit area with a width floor.
 *
 * `COMPACT_WORD_HIT_AREA` only grows the height, which leaves a short word like
 * "Clear" 31px wide. A word in a bar needs 44 in both directions
 * (a 44px floor for a finger), and a button centres its own text, so the floor needs
 * no alignment class. Shared so both board surfaces use the same number, which
 * has to be identical.
 */
export const BAR_WORD_HIT_AREA = `${COMPACT_WORD_HIT_AREA} min-w-11`;

/** A row action, a disclosure action, an empty-state action: always a word. */
export function QuietButton({
  onClick,
  tone = "muted",
  ariaLabel,
  "aria-label": ariaLabelAttr,
  title,
  tabIndex,
  disabled = false,
  className,
  children,
}: {
  onClick: () => void;
  tone?: "muted" | "primary" | "destructive";
  ariaLabel?: string;
  /** The attribute spelling, so a caller can write it the way the DOM does. */
  "aria-label"?: string;
  title?: string;
  /**
   * Set on a word inside a roving list, so the whole list is one tab stop.
   * Without it a row with an open disclosure is five to seven Tab presses.
   */
  tabIndex?: number;
  /**
   * Refuse further presses. A word whose label changes to "Restarting" still
   * takes clicks, and the calls behind these words are seconds long and not
   * idempotent: two Restarts would run two outbox drains at once.
   */
  disabled?: boolean;
  /** Extra classes, for the one thing a word ever needs: a bigger hit area. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel ?? ariaLabelAttr}
      title={title}
      tabIndex={tabIndex}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "shrink-0 whitespace-nowrap rounded-sm text-[12px] leading-5 transition-colors focus-visible:outline-none focus-visible:underline focus-visible:underline-offset-2",
        disabled ? "cursor-default opacity-60" : "cursor-pointer",
        tone === "primary"
          ? "text-primary hover:opacity-70"
          : tone === "destructive"
            ? // The hover of TEXT_URGENT, written out: a class must be a literal.
              "text-muted-foreground hover:text-[color:var(--destructive-text,var(--destructive))]"
            : "text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

export interface SegmentOption {
  id: string;
  label: string;
  /**
   * Show the count only on a narrow container. The Board word carries one:
   * above 420px the strip one line up shows those buckets separately, so a
   * total here would repeat them; below it the strip has collapsed to its
   * single loudest number and this is the only thing saying the rest exist.
   */
  narrowOnly?: boolean;
  /** Tabular, and by default it LEADS the label. Omit for a plain view switch. */
  count?: number;
  /**
   * Put the count after the label instead of before it.
   *
   * Which side is right is a property of the LABEL, not of this component, and
   * getting that wrong is visible: the strip's labels are verb phrases, so "3
   * need you" and "1 working" are sentences and "need you 3" is not. A tab's
   * label is a noun, so "3 Board" reads as three boards. Leading is the default
   * because most labels here are the strip's; the Board tab sets this.
   */
  countTrails?: boolean;
  /** Colours the count when it is worth noticing. Never the label. */
  tone?: "urgent" | "attention";
}

/**
 * A segmented control made of words, not buttons: the active one is
 * underlined. Used for the mission counts and for Board / Activity.
 */
export function Segmented({
  options,
  value,
  onSelect,
  className,
  optionClassName,
}: {
  options: readonly SegmentOption[];
  value: string | null;
  onSelect: (id: string) => void;
  className?: string;
  /** Padding a compact caller adds to reach 44px without moving the line. */
  optionClassName?: string;
}) {
  if (options.length === 0) return null;
  return (
    <div className={cn("flex shrink-0 items-center gap-3", className)}>
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(option.id)}
            className={cn(
              // The active option is already `text-foreground`, so the colour
              // change is no indicator on the one option that is always on
              // screen. The ring is (WCAG 2.4.7); `rounded-sm` keeps it on the
              // word rather than around a square.
              "cursor-pointer whitespace-nowrap rounded-sm text-[12px] leading-5 transition-colors focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              active
                ? "text-foreground underline underline-offset-4"
                : "text-muted-foreground hover:text-foreground",
              optionClassName,
            )}
          >
            {option.count === undefined || option.countTrails === true ? null : (
              <SegmentCount option={option} trailing={false} />
            )}
            {option.label}
            {option.count === undefined || option.countTrails !== true ? null : (
              <SegmentCount option={option} trailing />
            )}
          </button>
        );
      })}
    </div>
  );
}

function SegmentCount({
  option,
  trailing,
}: {
  option: SegmentOption;
  trailing: boolean;
}) {
  return (
    <span
      className={cn(
        "tabular-nums",
        option.narrowOnly === true && "hidden @max-[420px]/cos:inline",
        option.tone === "urgent"
          ? TEXT_URGENT
          : option.tone === "attention"
            ? TEXT_ATTENTION
            : null,
      )}
    >
      {trailing ? " " : null}
      {option.count}
      {trailing ? null : " "}
    </span>
  );
}

/** The single line a collapsed group presents. */
export function DisclosureRow({
  open,
  label,
  onToggle,
  action,
}: {
  open: boolean;
  label: string;
  onToggle: () => void;
  action?: ReactNode;
}) {
  const compact = useIsCompactViewport();
  return (
    <div className={cn("flex items-center gap-3 py-2", compact && "min-h-11")}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={cn(
          "flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-[12px] leading-5 text-muted-foreground transition-colors hover:text-foreground",
          compact && "min-h-11",
        )}
      >
        <Glyph
          name="chevron"
          rotate={open ? 90 : 0}
          aria-hidden
          className="size-2.5 shrink-0"
        />
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {action === undefined ? null : <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * Two lines of muted text and a word to act on. Never a dashed box.
 *
 * An empty surface is the one place a drawn shape is allowed:
 * nothing else is competing for the eye, and the picture is not repeating a
 * label sitting beside it. It is optional and quiet, at the tertiary tone, and
 * the words still carry the whole meaning if it is left out.
 */
export function EmptyState({
  glyph,
  title,
  detail,
  action,
}: {
  glyph?: GlyphName;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="space-y-1.5 py-4">
      {glyph === undefined ? null : (
        <Glyph
          name={glyph}
          aria-hidden
          className={cn("mb-2.5 size-10 opacity-40", TEXT_TERTIARY)}
        />
      )}
      <p className="text-[13px] text-foreground">{title}</p>
      {detail === undefined ? null : (
        <p className="max-w-md text-[13px] leading-5 text-muted-foreground">
          {detail}
        </p>
      )}
      {action === undefined ? null : <div className="pt-0.5">{action}</div>}
    </div>
  );
}

/**
 * The line a surface prints while it is showing data it can no longer refresh.
 *
 * Every surface here guards with `error !== null && data === null`, which only
 * catches a failure on the first fetch. After that a throwing refetch leaves
 * the last good payload on screen unmarked, so a panel that stopped updating
 * is indistinguishable from a panel with nothing new on it. For a plugin whose
 * whole job is saying what is waiting, that is the one silence worth breaking.
 *
 * Attention rather than urgent: what is on screen is still real, it is just
 * old. A word, not a banner, per the vocabulary at the top of this file.
 */
export function StaleNote({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}) {
  return (
    <p
      role="status"
      className={cn(
        "flex flex-wrap items-baseline gap-x-2 py-1.5 text-[12px] leading-5",
        TEXT_ATTENTION,
      )}
    >
      <span className="min-w-0">Not updating. {error}</span>
      <QuietButton onClick={onRetry} className={COMPACT_WORD_HIT_AREA}>
        Retry
      </QuietButton>
    </p>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
}

/** A yes/no in the host's dialog, so nothing ever reaches for window.confirm. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
