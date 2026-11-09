// Left column of the inbox:
// a search box, a To do / Waiting / All switch, one chip per inbox, then the
// grouped rows. A row is a face (initials with a corner mark for the inbox),
// the name, what it is about, and the start of the draft when one is ready.
// State is carried by the group a row sits in and by its badge, not by colour
// on the row itself.
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PANEL_VIEWS, VIEW_TITLES, type PanelView } from "./tabs";
import type { ChannelKey, Conversation, InboxFilter, Summary } from "../../contract";
import { Glyph, type GlyphName } from "./glyph";
import { avatarTone, initials, previewLine, shortTime, todoCount } from "./format";
import {
  EmptyState,
  FINGER_ICON,
  FINGER_WORD,
  ICON_BUTTON,
  SkeletonRows,
  TEXT_BUTTON,
} from "./signals";
import { channelKeyOf } from "../../contract";
import { ACTION_GAP_CLASS } from "./touch-geometry.ts";
import { toastDiscardResult, useDiscardDraft } from "./use-discard-draft";
import {
  CHANNEL_KEYS,
  CHANNEL_LABELS,
  channelCounts,
  errorText,
  selectedCounts,
  useCommsRpc,
  useIsFingerSurface,
} from "./use-comms";

/**
 * The three places the list can show. "To do" is the needs-reply filter: the
 * ready drafts are pinned above it already, so a separate Ready view only
 * repeated them.
 */
const SEGMENTS: readonly { id: InboxFilter; label: string }[] = [
  { id: "needs-reply", label: "To do" },
  { id: "waiting", label: "Waiting" },
  { id: "all", label: "All" },
];

/** Short labels: the chip row already says these are inboxes. */
const CHANNEL_SHORT: Record<ChannelKey, string> = {
  "mail:work": "Work",
  "mail:personal": "Personal",
  whatsapp: "WhatsApp",
};

/** The corner mark on an avatar: which inbox the row came from. */
const SOURCE_MARK: Record<ChannelKey, { letter: string; className: string }> = {
  "mail:work": { letter: "W", className: "bg-[#2f5bd3]" },
  "mail:personal": { letter: "P", className: "bg-[#7042c9]" },
  whatsapp: { letter: "WA", className: "bg-[#1f8a4c]" },
};

/**
 * Row backgrounds. The action strip floats over the row, so its colour has to
 * be opaque and equal to the row's, or the text underneath shows through and
 * the seam shows. Hover is therefore a solid mix of accent into the page
 * rather than a translucent tint, and it keys off the wrapper (group-hover) so
 * the row stays lit while the pointer is over the strip. Literal strings so
 * Tailwind emits them.
 */
const ROW_BG = {
  selected: { row: "bg-accent", fadeTo: "to-accent", strip: "bg-accent" },
  idle: {
    row: "bg-background group-hover:bg-[color:color-mix(in_oklch,var(--accent)_45%,var(--background))]",
    fadeTo: "to-background group-hover:to-[color:color-mix(in_oklch,var(--accent)_45%,var(--background))]",
    strip: "bg-background group-hover:bg-[color:color-mix(in_oklch,var(--accent)_45%,var(--background))]",
  },
} as const;

type Badge = "dismissed" | "no reply yet" | "opened" | "waiting";

const BADGE_CLASS: Record<Badge, string> = {
  "no reply yet": "bg-amber-50 text-amber-700",
  opened: "bg-emerald-50 text-emerald-700",
  waiting: "border border-border/60 bg-muted/60 text-muted-foreground",
  dismissed: "border border-border/60 bg-muted/60 text-muted-foreground/70",
};

export interface ConversationListProps {
  conversations: Conversation[] | null;
  /** Matches before the server's limit cut the list; null while loading. */
  total: number | null;
  /** Conversations with a pending draft, pinned above the filter's own rows. */
  ready: Conversation[] | null;
  error: string | null;
  summary: Summary | null;
  filter: InboxFilter;
  onFilterChange: (filter: InboxFilter) => void;
  channels: readonly ChannelKey[];
  onChannelsChange: (channels: readonly ChannelKey[]) => void;
  query: string;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** Refetch after a row action changes server state. */
  onChanged: () => void;
  /** The secondary panel view that is open, when one is. */
  view: PanelView | null;
  onOpenView: (view: PanelView) => void;
}

interface Groups {
  ready: Conversation[];
  main: Conversation[];
  /** Answered elsewhere or never; listed under Needs reply, outside the count. */
  quiet: Conversation[];
  stale: Conversation[];
}

function groupRows(props: ConversationListProps): Groups {
  const rows = props.conversations ?? [];
  const readySource = props.filter === "ready" ? rows : (props.ready ?? []);
  const ready = readySource
    .filter((row) => row.readyToSend)
    .slice()
    .sort((a, b) => (b.draft?.updatedAt ?? b.lastAt ?? 0) - (a.draft?.updatedAt ?? a.lastAt ?? 0));
  const pinned = new Set(ready.map((row) => row.key));
  const rest = rows.filter((row) => !pinned.has(row.key));
  if (props.filter === "needs-reply") return { ready, main: rest.filter((row) => !row.quiet), quiet: rest.filter((row) => row.quiet), stale: [] };
  if (props.filter !== "all") return { ready, main: rest, quiet: [], stale: [] };
  return {
    ready,
    main: rest.filter((row) => !row.stale),
    quiet: [],
    stale: rest.filter((row) => row.stale),
  };
}

/** True when a key press is going into a field and must not be taken over. */
function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function ConversationList(props: ConversationListProps) {
  const { conversations, filter, selectedKey, onSelect } = props;
  // Under a finger every word and glyph here is a 44px tap box
  // and the search field is 16px so iOS does not zoom on focus.
  const finger = useIsFingerSurface();
  const [cursor, setCursor] = useState(0);
  const [staleOpen, setStaleOpen] = useState(false);
  // Discarded is a state, not a permanent place: the entry appears in the
  // footer only while something is in the 24 hour trash, and the count is the
  // part that makes it findable without knowing a draft id.
  const discarded = props.summary?.counts.discarded ?? 0;
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // "/" anywhere on the page, outside a field, goes to the search box.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.defaultPrevented || typingInto(event.target)) return;
      const input = searchRef.current;
      if (input === null || input.offsetParent === null) return;
      // On a small screen the chief drawer covers the list without hiding it
      // from layout; a keypress inside the drawer must not focus a search box
      // the drawer is sitting on top of.
      if (event.target instanceof Element && event.target.closest('[aria-label="Chief of Communications"]') !== null) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const groups = useMemo(
    () => groupRows(props),
    // Recompute when the data or the filter moves; the callbacks do not matter.
    [props.conversations, props.ready, props.filter],
  );
  const visible = useMemo(
    () => [...groups.ready, ...groups.main, ...groups.quiet, ...(staleOpen ? groups.stale : [])],
    [groups, staleOpen],
  );

  // A filter or a search can shorten the list under the cursor. Left past the
  // end, no row is tabbable and the list can no longer be reached by keyboard.
  useEffect(() => {
    setCursor((current) => (current < visible.length ? current : Math.max(visible.length - 1, 0)));
  }, [visible.length]);

  // Keep the cursor on the open conversation when the list or the route moves.
  useEffect(() => {
    if (selectedKey === null) return;
    const index = visible.findIndex((item) => item.key === selectedKey);
    if (index >= 0) setCursor(index);
  }, [visible, selectedKey]);

  const move = (delta: number) => {
    if (visible.length === 0) return;
    const next = Math.min(Math.max(cursor + delta, 0), visible.length - 1);
    setCursor(next);
    rowRefs.current[next]?.focus();
    rowRefs.current[next]?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // React bubbles events through portals, so arrows pressed inside the
    // discard confirm (portaled out, but a child here in the tree) reached
    // this handler and moved the list behind the dialog. Only keys that
    // happen inside the listbox's own DOM move the cursor.
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    }
  };

  // The server caps the list at its limit; total counts the matches before the cut.
  const truncated =
    conversations !== null && props.total !== null && conversations.length < props.total;
  // The summary counts every stale draft; the list may hold only the first page.
  // A search narrows the rows to the query, so there the local length is the honest number.
  const staleCount =
    props.query === "" ? (props.summary?.counts.staleDrafts ?? groups.stale.length) : groups.stale.length;

  const counts = selectedCounts(props.summary, props.channels);
  const allChannels = props.channels.length === CHANNEL_KEYS.length;
  // The summary's Waiting count covers every inbox and ignores the search, so
  // it is shown only when it describes what the list would show.
  const waitingCount = allChannels && props.query === "" ? (props.summary?.counts.waiting ?? null) : null;
  const segmentCount = (id: InboxFilter): number | null => {
    if (props.summary === null) return null;
    if (id === "needs-reply") {
      // The ready rows are fetched for the same inboxes and search as the
      // list, so they are only a fair correction when no search narrows them.
      return props.query === "" ? todoCount(counts.needsReply, counts.ready, props.ready) : null;
    }
    if (id === "waiting") return waitingCount;
    return null;
  };

  // One channel in play means the chips have nothing to choose between.
  const populated = CHANNEL_KEYS.filter((key) => channelCounts(props.summary, key).total > 0);
  const showChannels = populated.length > 1;

  let index = -1;
  const nextIndex = () => {
    index += 1;
    return index;
  };

  const row = (conversation: Conversation, muted: boolean) => {
    const position = nextIndex();
    return (
      <ConversationRow
        key={conversation.key}
        ref={(element) => {
          rowRefs.current[position] = element;
        }}
        conversation={conversation}
        selected={conversation.key === selectedKey}
        muted={muted}
        tabbable={position === cursor}
        onSelect={() => {
          setCursor(position);
          onSelect(conversation.key);
        }}
        onChanged={props.onChanged}
      />
    );
  };

  const chip = (on: boolean) =>
    cn(
      "inline-flex shrink-0 cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-full border px-[9px] py-0.5 text-[11.5px] transition-colors",
      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      // Under a finger the chip keeps its look and grows an invisible 44px
      // tall tap box around it. The chips then sit on one line that scrolls
      // sideways, so no box reaches into a second line of chips, and the
      // gap-2 between them equals the two 4px bleeds, so neighbours touch
      // without overlapping.
      finger && "relative shrink-0 before:absolute before:-inset-x-1 before:-inset-y-3 before:content-['']",
      on
        ? "border-foreground/20 bg-muted/60 text-foreground"
        : "border-border bg-background text-muted-foreground hover:text-foreground",
    );

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <div className={cn("shrink-0 border-b border-border", showChannels ? "pb-2.5" : "pb-3")}>
        <div className={cn("flex min-w-0 items-center gap-2 px-3.5", finger ? "pt-1" : "pt-3")}>
          <label
            className={cn(
              "flex min-w-0 flex-1 cursor-text items-center gap-2 rounded-lg border border-border bg-muted/30 px-2.5 text-muted-foreground",
              "focus-within:border-foreground/25 focus-within:bg-background",
              finger ? "min-h-11" : "h-[34px]",
            )}
          >
            <Glyph name="search" size={14} className="shrink-0" />
            <input
              ref={searchRef}
              type="text"
              autoComplete="off"
              value={props.query}
              onChange={(event) => props.onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && props.query !== "") {
                  event.preventDefault();
                  props.onQueryChange("");
                }
              }}
              placeholder="Search people and messages"
              aria-label="Search conversations"
              aria-keyshortcuts="/"
              className={cn(
                "min-w-0 flex-1 border-0 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/70",
                finger ? "text-base" : "text-[13px]",
              )}
            />
            {finger || props.query !== "" ? null : (
              <kbd
                aria-hidden
                className="shrink-0 rounded border border-b-2 border-border bg-background px-1 font-mono text-[10.5px] leading-[15px] text-muted-foreground"
              >
                /
              </kbd>
            )}
          </label>
          <button
            type="button"
            aria-label="Refresh"
            title="Sync mail and refresh"
            disabled={props.refreshing}
            onClick={props.onRefresh}
            className={cn(ICON_BUTTON, finger ? FINGER_ICON : "-mr-1 size-6")}
          >
            <Glyph name="sync" size={14} className={cn(props.refreshing && "animate-spin")} />
          </button>
        </div>

        <div
          role="group"
          aria-label="Show"
          className={cn("mx-3.5 mt-2.5 flex gap-0.5 rounded-lg bg-muted/50 p-[3px]", finger && "mt-2")}
        >
          {SEGMENTS.map((option) => {
            // "To do" also covers a stale Ready filter left from before the
            // switch had no Ready button, so the control never shows nothing on.
            const active = option.id === filter || (option.id === "needs-reply" && filter === "ready");
            const count = segmentCount(option.id);
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={active}
                onClick={() => props.onFilterChange(option.id)}
                className={cn(
                  "inline-flex flex-1 cursor-pointer items-center justify-center whitespace-nowrap rounded-md py-1 text-[12px] transition-colors",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  finger && "min-h-11",
                  active
                    ? "bg-background font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.07)]"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
                {count !== null && count > 0 ? (
                  <span className="ml-1 font-normal tabular-nums text-muted-foreground/70">{count}</span>
                ) : null}
              </button>
            );
          })}
        </div>

        {showChannels ? (
          <div
            className={cn(
              "flex min-w-0 items-center px-3.5",
              // One line, never wrapped: a second line of chips pushed the
              // list down and read as clutter at the 300px column width.
              finger
                ? "gap-2 overflow-x-auto py-3 [scrollbar-width:none]"
                : "gap-1.5 overflow-x-auto pt-2.5 [scrollbar-width:none]",
            )}
          >
            <button
              type="button"
              aria-pressed={allChannels}
              onClick={() => props.onChannelsChange(CHANNEL_KEYS)}
              className={chip(allChannels)}
            >
              All inboxes
            </button>
            {CHANNEL_KEYS.map((key) => {
              // Each chip is a switch for its inbox, as before: lit while that
              // inbox is in the list, and a click turns it on or off. A chip
              // drawn dim while its inbox is on would hide that inbox when
              // clicked, which reads backwards.
              const on = props.channels.includes(key);
              const perChannel = channelCounts(props.summary, key);
              const open = perChannel.needsReply + perChannel.ready;
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={on}
                  title={CHANNEL_LABELS[key]}
                  onClick={() => {
                    const next = on ? props.channels.filter((item) => item !== key) : [...props.channels, key];
                    props.onChannelsChange(next);
                  }}
                  className={chip(on)}
                >
                  {CHANNEL_SHORT[key]}
                  {open > 0 ? <span className="tabular-nums">{open}</span> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <div
        role="listbox"
        aria-label="Conversations"
        onKeyDown={onKeyDown}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto pb-6 focus-visible:outline-none"
      >
        {conversations === null && props.error !== null ? (
          <p role="alert" className="px-3 py-6 text-center text-[12px] text-rose-600">
            {props.error}
          </p>
        ) : conversations === null ? (
          <SkeletonRows />
        ) : (
          <>
            {groups.ready.length === 0 ? null : (
              <>
                <GroupHeader label="Ready to send" count={groups.ready.length} />
                <RowGroup>{groups.ready.map((conversation) => row(conversation, false))}</RowGroup>
              </>
            )}

            {groups.ready.length > 0 && groups.main.length > 0 ? (
              <GroupHeader
                label={
                  filter === "needs-reply" ? "Needs a reply" : filter === "waiting" ? "Waiting on them" : "Everything else"
                }
                count={groups.main.length}
              />
            ) : null}
            {groups.main.length === 0 ? null : (
              <RowGroup>{groups.main.map((conversation) => row(conversation, false))}</RowGroup>
            )}

            {groups.quiet.length === 0 ? null : (
              <>
                <GroupHeader label="Not counted: answered elsewhere or no reply needed" count={groups.quiet.length} />
                <RowGroup>{groups.quiet.map((conversation) => row(conversation, false))}</RowGroup>
              </>
            )}

            {visible.length === 0 && groups.stale.length === 0 ? <ListEmpty {...props} /> : null}

            {filter === "all" && groups.stale.length > 0 ? (
              <>
                <button
                  type="button"
                  aria-expanded={staleOpen}
                  onClick={() => setStaleOpen(!staleOpen)}
                  className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-4 pb-1.5 pt-3.5 text-left text-[11px] font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <Glyph
                    name="back"
                    size={10}
                    className={cn(
                      "text-muted-foreground transition-transform",
                      // The back mark is a left chevron: down when open, right when shut.
                      staleOpen ? "-rotate-90" : "rotate-180",
                    )}
                  />
                  <span className="shrink-0">Older Gmail drafts</span>
                  <span className="shrink-0 font-normal tabular-nums text-muted-foreground/70">{staleCount}</span>
                  <span className="h-px min-w-4 flex-1 bg-border/70" aria-hidden />
                </button>
                {staleOpen ? <RowGroup>{groups.stale.map((conversation) => row(conversation, true))}</RowGroup> : null}
              </>
            ) : null}
            {truncated && props.total !== null && conversations !== null ? (
              <p className="px-3 pb-1.5 pt-5 text-[11px] tabular-nums leading-5 text-muted-foreground">
                Showing {conversations.length} of {props.total}. Search to narrow the list.
              </p>
            ) : null}
          </>
        )}
      </div>

      <div
        className={cn(
          "flex shrink-0 items-center border-t border-border px-3",
          finger ? "gap-0 py-0" : "gap-3 py-2",
        )}
      >
        {PANEL_VIEWS.filter((name) => name !== "discarded" || discarded > 0 || props.view === "discarded").map(
          (name) => (
            <button
              key={name}
              type="button"
              onClick={() => props.onOpenView(name)}
              aria-current={props.view === name ? "page" : undefined}
              className={cn(
                "inline-flex cursor-pointer items-center gap-1.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                finger && "min-h-11 px-2 first:-ml-2",
                props.view === name ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Glyph name={VIEW_GLYPHS[name]} size={11} />
              {VIEW_TITLES[name]}
              {name === "discarded" && discarded > 0 ? (
                <span className="tabular-nums text-muted-foreground">{discarded}</span>
              ) : null}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

/** One glyph per secondary view; bb draws no icon for these itself. */
const VIEW_GLYPHS: Record<PanelView, GlyphName> = {
  activity: "activity",
  connections: "signal",
  discarded: "dismiss",
};

/** The rows of one group, with a hairline between neighbours and none at the ends. */
function RowGroup({ children }: { children: ReactNode }) {
  return (
    <div role="presentation" className="divide-y divide-border/50">
      {children}
    </div>
  );
}

/** A quiet group label, its count, and a hairline running to the edge. */
function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex min-w-0 items-center gap-2 px-4 pb-1.5 pt-3.5 text-[11px] font-medium text-muted-foreground">
      <span className="shrink-0">{label}</span>
      <span className="shrink-0 font-normal tabular-nums text-muted-foreground/70">{count}</span>
      <span className="h-px min-w-4 flex-1 bg-border/70" aria-hidden />
    </div>
  );
}

function ListEmpty(props: ConversationListProps) {
  const finger = useIsFingerSurface();
  const word = cn(TEXT_BUTTON, finger && FINGER_WORD);
  if (props.error !== null) {
    return (
      <p role="alert" className="px-3 py-6 text-center text-[12px] text-rose-600">
        {props.error}
      </p>
    );
  }
  if (props.channels.length === 0) {
    return (
      <EmptyState glyph="signal" title="No inboxes selected">
        <button type="button" className={word} onClick={() => props.onChannelsChange(CHANNEL_KEYS)}>
          Show all inboxes
        </button>
      </EmptyState>
    );
  }
  if (props.query !== "") {
    return (
      <EmptyState glyph="search" title={`No matches for "${props.query}"`}>
        <button type="button" className={word} onClick={() => props.onQueryChange("")}>
          Clear search
        </button>
      </EmptyState>
    );
  }
  if (props.filter === "needs-reply") {
    return (
      <EmptyState glyph="done" tone="ok" title="Nothing needs a reply">
        <button type="button" className={word} onClick={() => props.onFilterChange("all")}>
          Show all
        </button>
      </EmptyState>
    );
  }
  if (props.filter === "waiting") {
    return (
      <EmptyState glyph="waiting" title="Nobody owes you a reply">
        <button type="button" className={word} onClick={() => props.onFilterChange("all")}>
          Show all
        </button>
      </EmptyState>
    );
  }
  if (props.filter === "ready") {
    return (
      <EmptyState glyph="send" title="No drafts waiting">
        <button type="button" className={word} onClick={() => props.onFilterChange("all")}>
          Show all
        </button>
      </EmptyState>
    );
  }
  return <EmptyState glyph="draft" title="Nothing here" />;
}

/**
 * The person's initials on a soft colour, with a small square in the corner
 * for the inbox. It replaces the channel glyph, so it carries the same name
 * for a screen reader.
 */
function RowAvatar({ name, source, muted }: { name: string; source: ChannelKey; muted: boolean }) {
  const mark = SOURCE_MARK[source];
  return (
    <span
      role="img"
      aria-label={CHANNEL_LABELS[source]}
      className={cn(
        "relative mt-px inline-flex size-7 shrink-0 select-none items-center justify-center rounded-full text-[11px] font-semibold leading-none",
        avatarTone(name),
        muted && "opacity-60",
      )}
    >
      <span aria-hidden>{initials(name)}</span>
      <span
        aria-hidden
        className={cn(
          "absolute -bottom-[3px] -right-[3px] flex h-[13px] min-w-[13px] items-center justify-center rounded-[4px] px-px text-[7px] font-bold leading-none text-white ring-2 ring-background",
          mark.className,
        )}
      >
        {mark.letter}
      </span>
    </span>
  );
}

interface ConversationRowProps {
  conversation: Conversation;
  selected: boolean;
  /** Leftover Gmail drafts render quiet. */
  muted: boolean;
  tabbable: boolean;
  onSelect: () => void;
  onChanged: () => void;
  ref: (element: HTMLButtonElement | null) => void;
}

function ConversationRow({ conversation, selected, muted, tabbable, onSelect, onChanged, ref }: ConversationRowProps) {
  const rpc = useCommsRpc();
  const finger = useIsFingerSurface();
  const [busy, setBusy] = useState(false);
  const mail = conversation.channel === "mail";
  const draft = conversation.draft;
  const ready = conversation.readyToSend && draft !== null;
  // A row with a draft is sorted by when the draft was last touched, so it has
  // to be stamped with that too. Stamping it with the last message instead made
  // the pinned group answer one question in its order and another in its dates.
  const at = ready ? (draft.updatedAt ?? conversation.lastAt) : (conversation.lastAt ?? draft?.updatedAt ?? null);

  // Line 1 names the other side, line 2 says what the conversation is about.
  // For mail that is the sender and the subject. For WhatsApp the chat already
  // carries the person's or group's name, and its counterpart is only a phone
  // number or the word "group", which is not what anyone scans for.
  const primary = mail
    ? conversation.counterpart === ""
      ? conversation.title
      : conversation.counterpart
    : conversation.title;
  const preview = previewLine(conversation.preview);
  const secondary = mail
    ? // A mail row with no sender already shows the subject on line 1; the
      // preview is the only thing left that line 2 can add.
      primary === conversation.title
      ? preview
      : conversation.title
    : preview === ""
      ? ""
      : `${conversation.lastFromMe ? "You: " : ""}${preview}`;
  // Line 3: the start of the draft, so a ready draft can be judged from the list.
  const draftLine = ready ? previewLine(draft.text) : "";

  // One word at most, most useful first. "opened" is Superhuman's read status
  // on the last reply comms sent here; "reminder" is Superhuman's own
  // "no reply yet" mail landing in the thread, which reads as the other side
  // writing unless it is named.
  const badge: Badge | null =
    conversation.dismissed && !muted
      ? "dismissed"
      : conversation.reminder
        ? "no reply yet"
        : conversation.opened && conversation.lastFromMe
          ? "opened"
          : conversation.waiting
            ? "waiting"
            : null;

  // "Done" is the dismiss action under a clearer name: the row goes away until
  // the other side writes again, which is exactly what isDismissed in store.ts does.
  const dismissLabel = conversation.dismissed ? "Undo done" : "Done";
  const dismissTitle = conversation.dismissed ? "Undo done, show it again" : "Done, hide until they write";
  // On a finger surface the row keeps one action. Two icons would take a third
  // of a phone-width row, cut every draft preview to a few words and hide the time.
  // Discarding a draft is one tap away in the conversation, behind the same
  // confirm, and it is the destructive one, so it is the one to move.
  const hasDraft = draft !== null && !finger;
  const bg = selected ? ROW_BG.selected : ROW_BG.idle;

  const runDismiss = async (dismissed: boolean, offerUndo: boolean) => {
    setBusy(true);
    try {
      const result = await rpc.call("dismiss", { key: conversation.key, dismissed });
      if (result.ok) {
        if (offerUndo) {
          toast.success(result.text, {
            action: { label: "Undo", onClick: () => void runDismiss(false, false) },
          });
        } else {
          toast.success(result.text);
        }
      } else {
        toast.error(result.text);
      }
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const runDiscard = async () => {
    setBusy(true);
    try {
      const result = await rpc.call("draft_discard", { key: conversation.key });
      toastDiscardResult(result, rpc, onChanged);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  // This icon sits beside Done, so their hit boxes must not overlap on a
  // finger: see touch-geometry.ts for the arithmetic. Asking first, and
  // keeping a copy for a day, are the other two guards.
  const discardDraft = useDiscardDraft(conversation, () => void runDiscard());

  return (
    // The row button does not span the whole row. It carries role=option
    // and the roving tabindex, but nested buttons are invalid HTML, so the
    // quick actions live beside it in this wrapper, floating over the right
    // edge. The hairline between rows comes from RowGroup.
    <div role="presentation" className="group relative">
      <button
        ref={ref}
        type="button"
        role="option"
        aria-selected={selected}
        tabIndex={tabbable ? 0 : -1}
        onClick={onSelect}
        className={cn(
          "relative flex w-full min-w-0 cursor-pointer gap-[11px] py-[11px] pl-4 text-left transition-colors",
          // An inset ring: the row is flush with the scroll container, so an
          // outline drawn outside it is clipped on the left and right edges.
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          // Under a finger the actions never hide, so the row keeps its own
          // room and the timestamp is not buried under them. With a mouse they
          // only appear while the row is hovered or focused, and the fade at
          // their left edge covers the seam.
          finger ? "pr-11" : "pr-3.5",
          bg.row,
        )}
      >
        {selected ? (
          <span className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r-[3px] bg-foreground" aria-hidden />
        ) : null}
        <RowAvatar name={primary} source={channelKeyOf(conversation.channel, conversation.account)} muted={muted} />

        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className={cn(
                "min-w-0 truncate text-[13px]",
                muted
                  ? "font-medium text-muted-foreground"
                  : conversation.unread
                    ? "font-semibold text-foreground"
                    : "font-medium text-foreground",
              )}
            >
              {primary}
            </span>
            {badge === null ? null : (
              <span
                className={cn(
                  "shrink-0 whitespace-nowrap rounded-[5px] px-1.5 text-[10.5px] leading-[17px]",
                  BADGE_CLASS[badge],
                )}
              >
                {badge}
              </span>
            )}
            <span className="ml-auto shrink-0 whitespace-nowrap pl-1 text-[11px] tabular-nums text-muted-foreground/70">
              {shortTime(at)}
            </span>
          </span>

          {secondary === "" ? null : (
            <span className="mt-px block min-w-0 truncate text-[12px] text-muted-foreground">{secondary}</span>
          )}

          {draftLine === "" ? null : (
            <span className="mt-[5px] block min-w-0 truncate border-l-2 border-emerald-200 pl-2 text-[12px] text-foreground/80">
              <span className="mr-[5px] text-[11px] font-semibold text-emerald-700">Draft</span>
              {draftLine}
            </span>
          )}
        </span>
      </button>
      <span
        // Over the row background so the text underneath does not show through;
        // the fade keeps the timestamp readable at the seam. Quiet until the
        // row is hovered or holds focus, always out on a finger surface.
        className={cn(
          "pointer-events-none absolute right-0 top-0 flex h-11 min-w-0 items-stretch transition-opacity",
          finger ? "opacity-100" : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
        )}
      >
        <span aria-hidden className={cn("h-full w-8 bg-gradient-to-r from-transparent", bg.fadeTo)} />
        <span
          className={cn(
            "pointer-events-auto flex items-center transition-colors",
            // The finger boxes are grown 10px on each side and bled back out,
            // so the last one would stick 10px past the row and give the list
            // a horizontal scrollbar. Pad it back in.
            //
            // The finger gap is wide because the boxes are wider than their
            // slots: see touch-geometry.ts, where the arithmetic is pinned by
            // a test. Below 12px of clear air Done and Discard draft overlap
            // and the destructive one wins the tap.
            finger ? ACTION_GAP_CLASS.finger : ACTION_GAP_CLASS.pointer,
            finger ? "pr-3" : "pr-2.5",
            bg.strip,
          )}
        >
          <button
            type="button"
            aria-label={dismissLabel}
            title={dismissTitle}
            disabled={busy}
            tabIndex={tabbable ? 0 : -1}
            onClick={(event) => {
              event.stopPropagation();
              void runDismiss(!conversation.dismissed, !conversation.dismissed);
            }}
            className={cn(ICON_BUTTON, finger ? FINGER_ICON : "-mr-1 size-6")}
          >
            <Glyph name={conversation.dismissed ? "back" : "done"} size={14} />
          </button>
          {hasDraft ? (
            <button
              type="button"
              aria-label="Discard draft"
              title="Discard draft"
              disabled={busy}
              tabIndex={tabbable ? 0 : -1}
              onClick={(event) => {
                event.stopPropagation();
                discardDraft.askDiscard();
              }}
              className={cn(ICON_BUTTON, "hover:text-rose-600", finger ? FINGER_ICON : "-mr-1 size-6")}
            >
              <Glyph name="draft" size={14} />
            </button>
          ) : null}
          {discardDraft.confirm}
        </span>
      </span>
    </div>
  );
}
