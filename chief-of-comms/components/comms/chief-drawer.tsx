// The chief drawer: the one long-lived thread that runs the inbox, inside the
// Comms page beside the conversation, instead of in a separate host tab. The
// page holds a module-level open state so a button in the host header and a
// button in the page both reach it, and an <aside> the page narrows beside. Below 768px it
// covers the page, because a phone-width page cut in two is two columns nobody
// can read.
//
// Top to bottom: a header row, the About card for the conversation open on
// the left, then the chat. The card is pinned: it belongs to the conversation,
// not to the chat, so the chat scrolls under it and never pushes it away.
import { memo, useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ThreadChat, useBbNavigate, useComposer } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { cn } from "@/lib/utils";
import {
  ABOUT_STORAGE_KEY,
  DRAWER_STORAGE_KEY,
  aboutOpenFor,
  initialDrawerOpen,
  parseAboutMemory,
  rememberAbout,
  type AboutMemory,
} from "./chief-drawer-state";
import { avatarTone, initials, relativeTime, stepDay } from "./format";
import { Glyph } from "./glyph";
import { LocalFileLinks } from "./local-file-links";
import { FINGER_ICON, FINGER_WORD, ICON_BUTTON, SkeletonRows } from "./signals";
import { ThreadExecutionBar } from "./thread-execution-bar";
import {
  errorText,
  useCommsRpc,
  useConversationAbout,
  useIsFingerSurface,
  useSummary,
  useVoiceFile,
  type ConversationAbout,
} from "./use-comms";

// ---------------------------------------------------------------------------
// Open or closed, shared by the header toggle, the page and the dashboard.
// The header is a separate host-mounted root, so this cannot be React state.

function readStorage(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode or a full quota: the choice still holds for this session.
  }
}

let drawerOpen: boolean | null = null;
const drawerListeners = new Set<() => void>();

function drawerSnapshot(): boolean {
  if (drawerOpen === null) {
    const width = typeof window === "undefined" ? 0 : window.innerWidth;
    drawerOpen = initialDrawerOpen(readStorage(DRAWER_STORAGE_KEY), width);
  }
  return drawerOpen;
}

function setDrawerOpen(open: boolean): void {
  drawerOpen = open;
  writeStorage(DRAWER_STORAGE_KEY, open ? "open" : "closed");
  for (const listener of drawerListeners) listener();
}

export function openChief(): void {
  setDrawerOpen(true);
}

// ---------------------------------------------------------------------------
// "Ask chief…": open the drawer with a first line in the chief's composer that
// names the conversation, and send nothing. Sending a draft request at once
// would go out before the user could say what they wanted to ask.

interface ChiefAsk {
  threadId: string | null;
  text: string;
  nonce: number;
}

let pendingAsk: ChiefAsk = { threadId: null, text: "", nonce: 0 };
const askListeners = new Set<() => void>();

/** Open the chief with `text` waiting in its composer, cursor after it. */
export function askChiefAbout(threadId: string, text: string): void {
  pendingAsk = { threadId, text, nonce: pendingAsk.nonce + 1 };
  for (const listener of askListeners) listener();
  setDrawerOpen(true);
}

/** Each ask is written into the composer once, whichever composer mounts first. */
let seededNonce = 0;

/**
 * A composer banner registered for every thread composer. It renders nothing
 * and acts only in the chief's own composer when an ask is waiting: it puts
 * the line in the draft and focuses it. `useComposer` only works inside a
 * composer slot, which is why this is a registration and not a child here.
 */
export function ChiefComposerSeed() {
  const composer = useComposer();
  const ask = useSyncExternalStore(
    (listener) => {
      askListeners.add(listener);
      return () => {
        askListeners.delete(listener);
      };
    },
    () => pendingAsk,
    () => pendingAsk,
  );
  useEffect(() => {
    if (ask.nonce <= seededNonce || ask.threadId === null) return;
    if (composer.scope.kind !== "thread" || composer.scope.threadId !== ask.threadId) return;
    seededNonce = ask.nonce;
    composer.replace((current) => {
      if (current.text.includes(ask.text)) return current;
      if (current.text.trim() === "") {
        return { text: `${ask.text}\n\n`, mentions: [] };
      }
      const trimmed = current.text.trimEnd();
      const mentions = current.mentions.filter((mention) => mention.to <= trimmed.length);
      return { text: `${trimmed}\n\n${ask.text}\n\n`, mentions };
    });
    composer.focus();
  }, [ask, composer]);
  return null;
}

export function closeChief(): void {
  setDrawerOpen(false);
}

export function toggleChief(): void {
  setDrawerOpen(!drawerSnapshot());
}

export function useChiefDrawerOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      drawerListeners.add(listener);
      return () => {
        drawerListeners.delete(listener);
      };
    },
    drawerSnapshot,
    drawerSnapshot,
  );
}

// ---------------------------------------------------------------------------
// The header toggle. Lives in the host's panel header next to the pills.

export function ChiefToggle() {
  const open = useChiefDrawerOpen();
  const finger = useIsFingerSurface();
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={toggleChief}
      // A toggle keeps one name; aria-pressed says whether it is on.
      aria-pressed={open}
      aria-label="Show the chief"
      className={cn("shrink-0 gap-1.5 px-2 text-xs", finger ? "-my-2.5 h-11 min-w-11" : "h-7")}
    >
      <Glyph name="chief" size={14} className={open ? "text-amber-600" : "text-muted-foreground"} />
      <span className="hidden sm:inline">Chief</span>
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Chat and header.

// The summary re-renders the drawer on every realtime signal and poll, and the
// About card re-renders it on every fetch. The chat must not re-render with
// either, or open popovers (the model picker) close.
//
// Known host behaviour, not ours: in a narrow panel the composer only shows its
// action row (attach, model, microphone) while it has focus, in either variant.
// Clicking the model button moves focus into the popover, so the row can unmount
// under the pointer and the picker closes on the way open. Ctrl+Shift+M always
// works, and "Open thread" in the header shows the thread at full width, where
// the row is permanent.
//
// LocalFileLinks: a link to a file on bb's machine in the chat opened a
// browser tab on bb's home page, because ThreadChat takes no local-file handler
// on a plugin surface. The wrapper sends it to bb's file panel instead; web
// links are untouched. See local-file-links.tsx.
const StableThreadChat = memo(function StableThreadChat({ threadId }: { threadId: string }) {
  return (
    <LocalFileLinks threadId={threadId} className="h-full">
      <ThreadChat threadId={threadId} variant="compact" layout="contained" className="h-full" />
    </LocalFileLinks>
  );
});

/**
 * An X drawn from two hairlines. The glyph set has no close mark, and this
 * panel takes no stock icons, so the two strokes are plain boxes.
 */
function CloseMark() {
  return (
    <span className="relative block size-3" aria-hidden>
      <span className="absolute left-1/2 top-1/2 h-[1.5px] w-3.5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-full bg-current" />
      <span className="absolute left-1/2 top-1/2 h-[1.5px] w-3.5 -translate-x-1/2 -translate-y-1/2 -rotate-45 rounded-full bg-current" />
    </span>
  );
}

// The header re-renders with the status string only, never with the chat.
const DrawerHeader = memo(function DrawerHeader({
  status,
  onOpenThread,
}: {
  /** null while the summary loads or before the chief is started. */
  status: string | null;
  onOpenThread: (() => void) | null;
}) {
  const finger = useIsFingerSurface();
  const working = status !== null && /run|work|think|tool|draft/i.test(status);
  const failed = status !== null && /error|fail/i.test(status);
  return (
    <div className="flex min-h-[46px] min-w-0 shrink-0 items-center gap-2 border-b border-border py-1.5 pl-4 pr-3">
      <Glyph name="chief" size={14} className="text-amber-600" />
      <span className="shrink-0 text-[13px] font-semibold text-foreground">Chief</span>
      {status === null ? null : (
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              failed ? "bg-rose-500" : working ? "animate-pulse bg-emerald-500" : "bg-muted-foreground/40",
            )}
            aria-hidden
          />
          <span
            className={cn(
              "min-w-0 truncate text-[11px]",
              failed ? "text-rose-600" : working ? "text-emerald-600" : "text-muted-foreground",
            )}
          >
            {status}
          </span>
        </span>
      )}
      <span className="min-w-2 flex-1" aria-hidden />
      {onOpenThread === null ? null : (
        <button
          type="button"
          onClick={onOpenThread}
          title="Open the chief thread at full width, where the composer keeps its model picker"
          className={cn(
            "shrink-0 cursor-pointer whitespace-nowrap rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            finger && FINGER_WORD,
          )}
        >
          Open thread
        </button>
      )}
      <button
        type="button"
        onClick={closeChief}
        aria-label="Close the chief"
        title="Close the chief"
        className={cn(ICON_BUTTON, finger ? FINGER_ICON : "size-7 rounded-md hover:bg-muted")}
      >
        <CloseMark />
      </button>
    </div>
  );
});

// ---------------------------------------------------------------------------
// The About card.

function readAboutMemory(): AboutMemory {
  return parseAboutMemory(readStorage(ABOUT_STORAGE_KEY));
}

function CardFrame({ children }: { children: ReactNode }) {
  return (
    <section
      aria-label="About this conversation"
      className="mx-3 mb-1 mt-3 shrink-0 overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      {children}
    </section>
  );
}

function AboutBody({ about }: { about: ConversationAbout }) {
  if (about.steps.length === 0) return null;
  return (
    <div className="max-h-[230px] overflow-y-auto">
      <div className="border-t border-border px-3 pb-0.5 pt-2 text-[11px] text-muted-foreground">This thread</div>
      <ol className="px-3 pb-2 pt-1">
        {about.steps.map((step, index) => (
          <li
            key={`${step.at}-${index}`}
            className="relative grid grid-cols-[12px_minmax(0,1fr)_auto] items-baseline gap-2 py-[3px] text-[12px] leading-4"
          >
            {index < about.steps.length - 1 ? (
              // The line down to the next dot.
              <span className="absolute bottom-[-6px] left-[3.5px] top-[14px] w-px bg-border" aria-hidden />
            ) : null}
            <span
              className={cn(
                "size-2 self-center rounded-full border-[1.5px]",
                step.tone === "now"
                  ? "border-foreground bg-foreground"
                  : step.tone === "open"
                    ? "border-emerald-600 bg-emerald-500/10"
                    : "border-muted-foreground/50 bg-card",
              )}
              aria-hidden
            />
            <span
              className={cn(
                "min-w-0",
                step.tone === "now" ? "font-medium text-foreground" : step.tone === "open" ? "text-emerald-600" : "text-foreground",
              )}
            >
              {step.text}
            </span>
            <span className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">{stepDay(step.at)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * How the owner writes to this person: the editable part of the contact's voice
 * file (voice.ts). The chief is given the same file in every draft request for
 * them, so what is written here is what it follows. Lines the chief added end
 * in "(added by the chief, date)"; delete one by deleting its line.
 */
function VoiceSection({ conversationKey }: { conversationKey: string }) {
  const rpc = useCommsRpc();
  const live = useVoiceFile(conversationKey);
  const finger = useIsFingerSurface();
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const voice = live.data !== null && live.data.key === conversationKey ? live.data.voice : null;
  if (voice === null || voice.contactId === null) return null;
  const word = cn("shrink-0 cursor-pointer whitespace-nowrap text-[11px] text-muted-foreground hover:text-foreground", finger && FINGER_WORD);
  const save = async () => {
    if (editing === null) return;
    setSaving(true);
    try {
      const result = await rpc.call("voice_save", { key: conversationKey, editable: editing });
      if (result.ok) {
        toast.success(result.text);
        setEditing(null);
        live.refetch();
      } else toast.error(result.text);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setSaving(false);
    }
  };
  const summary = [
    voice.samples === 0 ? "no sample messages yet" : `${voice.samples} sample message${voice.samples === 1 ? "" : "s"}`,
    voice.chiefLines > 0 ? `${voice.chiefLines} line${voice.chiefLines === 1 ? "" : "s"} added by the chief` : null,
    voice.reviewedAt === null ? null : `reviewed ${relativeTime(voice.reviewedAt)}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  return (
    <div className="border-t border-border px-3 pb-2 pt-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-[11px] text-muted-foreground">Voice</span>
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground">{summary}</span>
        {editing === null ? (
          <button type="button" className={word} onClick={() => setEditing(voice.editable)}>
            Edit
          </button>
        ) : (
          <>
            <button type="button" className={word} disabled={saving} onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="button" className={cn(word, "font-medium text-foreground")} disabled={saving} onClick={() => void save()}>
              Save
            </button>
          </>
        )}
      </div>
      {editing === null ? (
        <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[11.5px] leading-[1.45] text-foreground">
          {voice.editable.replace(/\n## /g, "\n\n## ").replace(/^## /gm, "").trim() || "Nothing written yet."}
        </pre>
      ) : (
        <textarea
          value={editing}
          onChange={(event) => setEditing(event.target.value)}
          aria-label={`How the user writes to ${voice.name}`}
          rows={9}
          className="mt-1 block w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-sans text-[12px] leading-[1.45] text-foreground focus-visible:outline-none max-md:pointer-coarse:text-base"
        />
      )}
    </div>
  );
}

function AboutCard({ conversationKey }: { conversationKey: string }) {
  const live = useConversationAbout(conversationKey);
  const [memory, setMemory] = useState<AboutMemory>(readAboutMemory);
  const finger = useIsFingerSurface();

  // Data read for another key is never shown against this one.
  const about = live.data !== null && live.data.key === conversationKey ? live.data.about : null;

  if (about === null) {
    return (
      <CardFrame>
        {live.error !== null ? (
          <p role="alert" className="px-3 py-2.5 text-[12px] leading-5 text-rose-600">
            Could not read who this is: {live.error}
          </p>
        ) : (
          <SkeletonRows className="space-y-3 px-3 py-2.5" />
        )}
      </CardFrame>
    );
  }

  const open = aboutOpenFor(memory, conversationKey);
  const toggle = () => {
    // Read the stored map again: another Comms window may have written to it.
    const next = rememberAbout(readAboutMemory(), conversationKey, !open);
    writeStorage(ABOUT_STORAGE_KEY, JSON.stringify(next));
    setMemory(next);
  };

  return (
    <CardFrame>
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        title={open ? "Fold the card" : "Show the thread and the voice file"}
        className={cn(
          "flex w-full min-w-0 cursor-pointer items-center gap-2.5 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          finger && "min-h-11",
        )}
      >
        <span
          className={cn("flex size-[26px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold", avatarTone(about.name))}
          aria-hidden
        >
          {initials(about.name)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-[1.3] text-foreground">{about.name}</span>
        <Glyph
          name="back"
          size={10}
          className={cn(
            "text-muted-foreground transition-transform",
            // The back mark is a left chevron: up when open, down when folded.
            open ? "rotate-90" : "-rotate-90",
          )}
        />
      </button>
      {open ? <AboutBody about={about} /> : null}
      {open ? <VoiceSection conversationKey={conversationKey} /> : null}
      {live.error !== null ? (
        // A refetch failed after an earlier read worked: keep the card, say so.
        <p role="alert" className="border-t border-border px-3 py-1.5 text-[11px] text-rose-600">
          Could not refresh: {live.error}
        </p>
      ) : null}
    </CardFrame>
  );
}

// ---------------------------------------------------------------------------
// The drawer.

function NoChief() {
  const rpc = useCommsRpc();
  const summary = useSummary();
  const [starting, setStarting] = useState(false);
  const start = async () => {
    setStarting(true);
    try {
      await rpc.call("chief_ensure");
      summary.refetch();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setStarting(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-2 text-center">
        <Glyph name="chief" size={28} className="text-muted-foreground" />
        <p className="text-[15px] font-medium leading-[1.4] text-foreground">No chief yet</p>
        <p className="text-[12px] leading-5 text-muted-foreground">
          One thread that reads your work and personal Gmail and your WhatsApp and drafts the replies. Nothing goes
          out until you send it.
        </p>
        <Button className="mt-4" onClick={() => void start()} disabled={starting}>
          {starting ? "Starting" : "Start the chief"}
        </Button>
      </div>
    </div>
  );
}

function DrawerBody({ selectedKey }: { selectedKey: string | null }) {
  const summary = useSummary();
  const navigate = useBbNavigate();
  const threadId = summary.data?.chiefThreadId ?? null;
  const openThread = useCallback(() => {
    if (threadId !== null) navigate.toThread(threadId);
  }, [navigate, threadId]);

  const rawStatus = summary.data === null ? null : threadId === null ? "not started" : summary.data.chiefStatus ?? "";
  const status = rawStatus === "" ? "idle" : rawStatus;

  return (
    <>
      <DrawerHeader status={status} onOpenThread={threadId === null ? null : openThread} />
      {selectedKey === null ? null : <AboutCard key={selectedKey} conversationKey={selectedKey} />}
      {summary.data === null ? (
        summary.error === null ? (
          <SkeletonRows className="p-4" />
        ) : (
          <p role="alert" className="p-4 text-[12px] text-rose-600">
            {summary.error}
          </p>
        )
      ) : threadId === null ? (
        <NoChief />
      ) : (
        <>
          <ThreadExecutionBar threadId={threadId} />
          <div className="min-h-0 flex-1">
            <StableThreadChat threadId={threadId} />
          </div>
        </>
      )}
    </>
  );
}

/**
 * The drawer itself, rendered by the inbox page to the right of the list and
 * the conversation. `selectedKey` is the conversation open on the left; the
 * About card follows it and the chat does not.
 */
export const ChiefDrawer = memo(function ChiefDrawer({ selectedKey }: { selectedKey: string | null }) {
  const open = useChiefDrawerOpen();
  const compact = useIsCompactViewport();
  if (!open) return null;
  if (compact) {
    return (
      <div
        role="dialog"
        aria-label="Chief of Communications"
        className="absolute inset-0 z-30 flex min-h-0 flex-col bg-background"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <DrawerBody selectedKey={selectedKey} />
      </div>
    );
  }
  return (
    <aside
      aria-label="Chief of Communications"
      className="flex h-full min-h-0 w-[340px] shrink-0 flex-col border-l border-border bg-background xl:w-[380px]"
    >
      <DrawerBody selectedKey={selectedKey} />
    </aside>
  );
});
