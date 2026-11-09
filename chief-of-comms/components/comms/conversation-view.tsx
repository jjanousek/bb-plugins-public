// Middle column of the inbox when a conversation is open.
//
// The header is a face, a name and one meta line, with Done and the overflow
// menu on the right. The thread sits on a faint grey under centred day labels:
// their messages on white, the owner's on warm grey and to the right, each with
// a small foot naming who and when. The reply dock closes the column.
//
// Every line in the header truncates rather than wraps, so a narrow window
// cannot squeeze the title to one word per line.
import { Fragment, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { channelKeyOf, type Conversation, type Message, type WaState } from "../../contract";
import { Glyph } from "./glyph";
import {
  LONG_MAIL_CHARS,
  absoluteTime,
  counterpartLabel,
  dayKey,
  splitQuoted,
  avatarTone,
  viewClock,
  viewDayLabel,
  viewFirstName,
  initials,
  viewOpenedLine,
} from "./format";
import { ActionsMenu, type MenuAction } from "./menu";
import { ReplyDock } from "./reply-dock";
import { EmptyState, FINGER_ICON, FINGER_WORD, ICON_BUTTON, RichText } from "./signals";
import { ACTION_GAP_CLASS } from "./touch-geometry.ts";
import { toastDiscardResult, useDiscardDraft } from "./use-discard-draft";
import {
  CHANNEL_LABELS,
  errorText,
  useCommsRpc,
  useIsFingerSurface,
  useMediaPreview,
  type ConversationDetail,
} from "./use-comms";

export interface ConversationViewProps {
  detail: ConversationDetail;
  waState: WaState;
  /** The plugin's own slot is narrow: one column, tighter gutters. */
  narrow: boolean;
  /** The next conversation is still loading; the current one is shown dimmed. */
  stale: boolean;
  onBack: () => void;
  onChanged: () => void;
}

/** The colour a read status is shown in. "Could not check" is amber and never looks like "not opened". */
function readTone(state: NonNullable<Conversation["readStatus"]>["state"]): string {
  if (state === "opened") return "text-emerald-600";
  if (state === "unknown") return "text-amber-600";
  return "text-muted-foreground";
}

/**
 * Who the header is about. A mail conversation's title is its subject, so the
 * person is the counterpart; a chat's title is the contact or group name, and
 * its counterpart is only a phone number.
 */
function headerName(conversation: Conversation): string {
  if (conversation.channel === "mail") return conversation.counterpart.trim() || conversation.title;
  return conversation.title.trim() || counterpartLabel(conversation);
}

export function ConversationView({ detail, waState, narrow, stale, onBack, onChanged }: ConversationViewProps) {
  const { conversation, messages, draft } = detail;
  const rpc = useCommsRpc();
  const whatsapp = conversation.channel === "whatsapp";
  // media_preview is a WhatsApp-only URL; mail threads must not ask for it.
  const media = useMediaPreview(whatsapp);
  const mediaBase = whatsapp ? (media.data?.baseUrl ?? null) : null;
  const [busy, setBusy] = useState(false);
  const finger = useIsFingerSurface();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Whether the reader is still sitting on the newest message. True until they
  // scroll away from the bottom, and true again for every new conversation.
  const pinned = useRef(true);

  useEffect(() => {
    pinned.current = true;
  }, [conversation.key]);

  // Photos and lazily laid out bodies gain their height after the first paint,
  // so a one-shot scrollTop lands short and the newest message stays below the
  // fold. Follow every size change for as long as the reader has not moved.
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const toBottom = () => {
      if (!pinned.current) return;
      element.scrollTop = element.scrollHeight;
    };
    toBottom();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(toBottom);
    // The container's own box never changes; its children are what grow.
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [conversation.key, messages.length]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (element === null) return;
    // Within a message's height of the end still counts as "at the bottom".
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  };

  const mail = conversation.channel === "mail";
  const links = conversation.links ?? draft?.links ?? null;
  const gutter = narrow ? "px-4" : "px-[22px]";

  const call = async (job: () => Promise<{ ok: boolean; text: string }>) => {
    setBusy(true);
    try {
      const result = await job();
      if (result.ok) toast.success(result.text);
      else toast.error(result.text);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const dismiss = () =>
    call(() => rpc.call("dismiss", { key: conversation.key, dismissed: !conversation.dismissed }));
  const requestDraft = () => call(() => rpc.call("request_draft", { key: conversation.key }));
  // Not through `call`: a discard is the one action here that offers an undo,
  // and the shared toast is what carries it.
  const runDiscard = async () => {
    setBusy(true);
    try {
      toastDiscardResult(await rpc.call("draft_discard", { key: conversation.key }), rpc, onChanged);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const toggleMute = () =>
    call(async () => {
      const result = await rpc.call("sender_mute", { key: conversation.key, muted: !conversation.muted });
      return { ok: result.ok, text: result.text };
    });

  // The overflow menu sits in the header of whichever conversation is open, so
  // picking this on the wrong one is the easy mistake. The question names the
  // recipient for that reason.
  const discardDraft = useDiscardDraft(conversation, () => void runDiscard());

  const name = headerName(conversation);
  const readStatus = conversation.readStatus ?? null;
  // Mail: the subject, then the mailbox. Chat: the number or "Group", then the channel.
  const metaParts = [
    mail ? conversation.title.trim() : counterpartLabel(conversation),
    CHANNEL_LABELS[channelKeyOf(conversation.channel, conversation.account)],
    conversation.muted ? "muted" : "",
  ].filter((part) => part !== "" && part !== name);

  // Dismiss is the Done button beside the menu, so the menu does not carry a
  // second copy of it.
  const actions: MenuAction[] = [];
  if (links !== null) actions.push({ key: "gmail", label: "Open in Gmail", href: links.gmailUrl });
  if (mail && links !== null) {
    actions.push({ key: "superhuman", label: "Open in Superhuman", href: links.superhumanUrl });
  }
  actions.push({ key: "ask", label: "Ask the chief to draft", disabled: busy, onSelect: () => void requestDraft() });
  if (conversation.senderId !== null) {
    actions.push({
      key: "mute",
      label: conversation.muted ? "Unmute this sender" : "Mute this sender",
      disabled: busy,
      onSelect: () => void toggleMute(),
    });
  }
  if (draft !== null) {
    actions.push({
      key: "discard",
      label: "Discard draft",
      danger: true,
      disabled: busy,
      onSelect: () => discardDraft.askDiscard(),
    });
  }

  const doneLabel = conversation.dismissed ? "Undo Done, show it in the list again" : "Done, hide until they write";
  const opens = readStatus?.opens ?? [];
  const openedOn = readStatus?.state === "opened" && mail ? openedMessageId(messages, opens) : null;
  const openedText = openedOn === null ? "" : openedLine(conversation, readStatus, opens);

  return (
    // While another conversation loads, the previous one stays for a moment
    // but cannot be acted on: its Send and Discard would reach the wrong person.
    <div
      className={cn("flex h-full min-h-0 min-w-0 flex-1 flex-col", stale && "pointer-events-none opacity-60 transition-opacity")}
      inert={stale || undefined}
      aria-busy={stale || undefined}
    >
      <header className={cn("shrink-0 border-b border-border pb-3 pt-3.5", gutter)}>
        <div className="flex min-w-0 items-center gap-3">
          {narrow ? (
            <button
              type="button"
              aria-label="Back to the conversation list"
              onClick={onBack}
              className={cn(ICON_BUTTON, finger ? FINGER_ICON : "-ml-1 size-6")}
            >
              <Glyph name="back" size={14} />
            </button>
          ) : null}
          <span
            aria-hidden
            className={cn(
              "inline-flex size-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold",
              avatarTone(name),
            )}
          >
            {initials(name)}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15.5px] font-semibold leading-snug tracking-[-0.01em] text-foreground" title={name}>
              {name}
            </h2>
            <p
              className="mt-px truncate text-[12px] text-muted-foreground"
              title={[...metaParts, readStatus?.text ?? ""].filter((part) => part !== "").join(" · ")}
            >
              {metaParts.map((part, index) => (
                <Fragment key={part}>
                  {index === 0 ? null : <MetaSep />}
                  {part}
                </Fragment>
              ))}
              {readStatus === null ? null : (
                <>
                  {metaParts.length === 0 ? null : <MetaSep />}
                  <span className={readTone(readStatus.state)}>{readStatus.text}</span>
                </>
              )}
            </p>
          </div>
          <div className={cn("flex shrink-0 items-center", finger ? ACTION_GAP_CLASS.finger : "gap-1")}>
            <button
              type="button"
              aria-label={doneLabel}
              aria-pressed={conversation.dismissed}
              title={doneLabel}
              disabled={busy}
              onClick={() => void dismiss()}
              className={cn(ICON_BUTTON, finger ? FINGER_ICON : "size-6", conversation.dismissed && "text-foreground")}
            >
              <Glyph name="done" size={14} />
            </button>
            <ActionsMenu label="Conversation actions" actions={actions} />
          </div>
          {discardDraft.confirm}
        </div>
        {opens.length > 1 ? (
          // Every open with its time, newest first. The meta line already
          // gives the count, first and last; this is the full list behind it.
          <details className={cn("mt-1 text-[11px] text-muted-foreground", narrow ? "pl-0" : "pl-12")}>
            <summary className="w-fit cursor-pointer select-none hover:text-foreground">Every open</summary>
            <ul className="mt-1 space-y-0.5 pl-3 tabular-nums">
              {[...opens].reverse().map((open) => (
                <li key={`${open.at}-${open.recipient ?? ""}`} className="truncate">
                  {absoluteTime(open.at)}
                  {open.recipient === null ? "" : ` · ${open.recipient}`}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </header>

      {conversation.dismissed && draft !== null ? (
        <div className={cn("shrink-0 pt-3", gutter)}>
          <div
            role="status"
            className="flex min-w-0 items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-600"
          >
            <Glyph name="done" size={12} />
            <span className="min-w-0 flex-1 truncate">Marked done earlier, a draft is ready</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void dismiss()}
              className={cn(
                "shrink-0 cursor-pointer whitespace-nowrap underline-offset-2 hover:underline disabled:cursor-default disabled:opacity-50",
                finger && FINGER_WORD,
              )}
            >
              Undo Done
            </button>
          </div>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden bg-muted/30 pb-2 pt-[18px]",
          gutter,
        )}
      >
        {messages.length === 0 ? (
          <EmptyState glyph="draft" title="No messages stored for this conversation" />
        ) : (
          messages.map((message, index) => {
            const previous = index === 0 ? null : messages[index - 1];
            const newDay = previous == null || dayKey(previous.at) !== dayKey(message.at);
            return (
              <Fragment key={message.id}>
                {newDay ? (
                  <span className="shrink-0 self-center whitespace-nowrap rounded-full border border-border/60 bg-card px-2.5 py-px text-[11px] text-muted-foreground">
                    {viewDayLabel(message.at)}
                  </span>
                ) : null}
                <MessageItem
                  message={message}
                  group={conversation.isGroup}
                  mail={mail}
                  mediaBase={mediaBase}
                  finger={finger}
                  opened={message.id === openedOn ? openedText : ""}
                />
              </Fragment>
            );
          })
        )}
      </div>

      <ReplyDock
        key={conversation.key}
        conversation={conversation}
        draft={draft}
        waState={waState}
        narrow={narrow}
        onChanged={onChanged}
      />
    </div>
  );
}

function MetaSep() {
  return (
    <span aria-hidden className="mx-[5px] text-muted-foreground/50">
      ·
    </span>
  );
}

/**
 * Which of the user's messages the "Opened" foot belongs under. The read
 * status is about the last mail comms sent through Superhuman, which is not
 * always the user's newest message: they may have written from Gmail since. So
 * it is the newest of their messages sent before the first open, since a mail
 * cannot be opened before it went out. With no open times on record it is the
 * newest.
 */
function openedMessageId(messages: readonly Message[], opens: readonly { at: number }[]): string | null {
  const firstOpen = opens.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...opens.map((open) => open.at));
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.fromMe && message.at <= firstOpen) return message.id;
  }
  return null;
}

/**
 * "Opened by Desma Mon 09:15 and Mon 21:45". The names are the addresses that
 * actually opened it, as the feed reports them; the thread's counterpart only
 * when the feed gave no address. Without open times, which is how older
 * recorded opens arrive, the server's own sentence is used as it is.
 */
function openedLine(
  conversation: Conversation,
  readStatus: Conversation["readStatus"],
  opens: readonly { at: number; recipient: string | null }[],
): string {
  if (opens.length === 0) return (readStatus?.text ?? "Opened").replace(/\.$/, "");
  const openers = [...new Set(opens.map((open) => open.recipient).filter((who): who is string => who !== null))];
  // The opener's own address wins. Naming the thread's counterpart instead
  // said "Opened by Desma" when only Lee, the other recipient, had opened it.
  // The counterpart is used only when the feed did not say who.
  const names = openers.length === 0 ? [viewFirstName(conversation.counterpart)] : openers.map(viewFirstName);
  const who = names.filter((part) => part !== "");
  const joined = who.length <= 1 ? (who[0] ?? "") : `${who.slice(0, -1).join(", ")} and ${who[who.length - 1]}`;
  return viewOpenedLine(joined, opens);
}

// Drawn for this plugin with the glyph pipeline (tools/asset-pipeline, Seedream
// asset). Kept here rather than in glyph-data.ts
// because only this foot uses it; the pupil is a hole, hence evenodd.
const EYE = {
  viewBox: "-10.0 -29.6 120.0 120.0",
  d: "M 49.7 0.8 C 49.7 0.8, 48.8 0.9, 47.8 1 C 44.3 1.2, 40.5 1.8, 37.1 2.9 C 35.6 3.3, 33.3 4.1, 32.7 4.4 C 32.6 4.5, 32 4.7, 31.5 4.9 C 25.8 7.2, 18.9 11.5, 13.5 16.1 C 11.8 17.5, 11.1 18.1, 9.5 19.6 C 7.4 21.4, 3 25.9, 2.1 27 C 1.9 27.3, 1.6 27.8, 1.4 28.2 L 1 29 1 30.3 C 1 32.7, 1.4 33.3, 5.3 37.3 C 9.2 41.2, 13 44.4, 17.9 48.1 C 20 49.7, 22.7 51.4, 26 53.3 C 27.8 54.3, 32 56.2, 33.4 56.7 C 33.7 56.8, 34.3 57, 34.8 57.2 C 37.6 58.1, 40.6 58.9, 43.7 59.4 C 48.4 60.1, 54.1 60, 59 58.9 C 59.5 58.8, 60.3 58.7, 60.6 58.6 C 61 58.5, 61.4 58.4, 61.6 58.4 C 61.7 58.3, 62.3 58.2, 62.8 58 C 67 56.9, 72.8 54.2, 77.5 51.3 C 80.3 49.6, 86 45.5, 86.5 44.8 C 86.6 44.8, 86.9 44.5, 87.3 44.2 C 90.9 41.3, 97.8 34.4, 98.6 32.9 C 99.4 31.1, 99.3 29.4, 98.4 27.6 C 97.9 26.6, 91.4 20.1, 88.5 17.6 C 88 17.2, 87.5 16.8, 87.4 16.7 C 82.8 12.7, 75.5 7.9, 70.1 5.5 C 69.8 5.4, 69.4 5.2, 69.2 5.1 C 68.5 4.8, 65.2 3.5, 64.5 3.3 C 64.1 3.2, 63.6 3, 63.4 2.9 C 62.9 2.8, 60.7 2.2, 60 2 C 58.1 1.6, 57.5 1.5, 56 1.3 C 55.1 1.2, 53.6 1, 52.6 1 C 51.6 0.9, 50.6 0.8, 50.3 0.8 C 50 0.8, 49.7 0.8, 49.7 0.8 M 46.8 10.3 C 46.1 10.4, 45.3 10.5, 45 10.6 C 44.8 10.6, 44.4 10.7, 44.1 10.7 C 43 10.9, 38.3 12.2, 37.3 12.7 C 37.2 12.7, 36.8 12.9, 36.4 13 C 36.1 13.2, 35.7 13.3, 35.5 13.4 C 35.3 13.5, 35 13.6, 34.8 13.7 C 33.6 14.2, 30.6 15.8, 29.3 16.5 C 25.8 18.5, 24.1 19.7, 19.6 23.2 C 19.2 23.5, 16.9 25.4, 16.3 25.9 C 16.1 26.1, 15.6 26.6, 15.2 26.9 C 14 28, 11.6 30.4, 11.6 30.5 C 11.6 30.6, 14.2 33.1, 16.7 35.3 C 19.5 37.7, 23.3 40.6, 26.4 42.6 C 29.4 44.5, 33.9 46.9, 36.1 47.7 C 36.5 47.8, 37.1 48.1, 37.4 48.2 C 46.1 51.5, 54.3 51.4, 63.8 47.9 C 65.9 47, 70.6 44.6, 72.9 43.1 C 76.5 40.8, 78.2 39.6, 80.3 37.8 C 80.8 37.4, 81.5 36.8, 82 36.4 C 84.1 34.7, 88.4 30.7, 88.4 30.5 C 88.4 30.2, 84.8 26.8, 82.1 24.5 C 76.8 20, 70.1 15.7, 65.4 13.7 C 65 13.6, 64.6 13.4, 64.5 13.3 C 59 10.9, 52.5 9.8, 46.8 10.3 M 48 20.8 C 47.1 21, 45.9 21.5, 45.4 21.8 C 39.8 25.2, 38.6 32.2, 42.9 36.9 C 48.3 43.1, 58.6 39.9, 59.7 31.7 C 60.6 25, 54.4 19.2, 48 20.8",
};

function EyeGlyph() {
  return (
    <svg viewBox={EYE.viewBox} width={12} height={12} className="shrink-0" aria-hidden focusable="false">
      <path d={EYE.d} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

interface MessageItemProps {
  message: Message;
  /** A WhatsApp group: the foot names the sender in full, since first names repeat. */
  group: boolean;
  mail: boolean;
  /** Base URL serving downloaded WhatsApp media, when known. */
  mediaBase: string | null;
  /** A finger surface: the Show more and quoted-text words get a 44px box. */
  finger: boolean;
  /** "Opened by ..." for the one sent mail the read status is about, else "". */
  opened: string;
}

function mediaUrl(base: string | null, file: string | null): string | null {
  if (base === null || file === null) return null;
  return `${base.replace(/\/$/, "")}/${encodeURIComponent(file)}`;
}

const PLACEHOLDER = /^\[(photo|sticker|document[^\]]*|voice message|audio)\]$/;
const MAIL_BODY = "whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[14px] leading-[1.6] text-foreground";
const CHAT_BODY = "whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[13.5px] leading-[1.55] text-foreground";

function MessageItem({ message, group, mail, mediaBase, finger, opened }: MessageItemProps) {
  const fileUrl = mediaUrl(mediaBase, message.mediaPath);
  const isImage = (message.mediaMime ?? "").startsWith("image/");
  const [expanded, setExpanded] = useState(false);
  const [showQuoted, setShowQuoted] = useState(false);
  const raw = mail ? splitQuoted(message.text) : { body: message.text, quoted: "" };
  // Bodies cached before preview padding was stripped can still carry it,
  // which renders as a tall blank card before "Show more". bodyToText strips
  // it on read; this covers what is already in the cache.
  const split = mail
    ? { ...raw, body: raw.body.replace(/[\u00AD\u034F\u200B-\u200F\u2060-\u2064\uFEFF]/g, "").replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim() }
    : raw;
  const long = mail && split.body.length > LONG_MAIL_CHARS;
  const shown = long && !expanded ? `${split.body.slice(0, LONG_MAIL_CHARS)}...` : split.body;
  const media = !mail && message.kind !== "text";
  const quotedLines = split.quoted === "" ? 0 : split.quoted.split("\n").length;
  const toggle = cn(
    "cursor-pointer text-[11.5px] text-muted-foreground hover:text-foreground hover:underline hover:underline-offset-2",
    finger && FINGER_WORD,
  );
  const mine = message.fromMe;
  const who = mine ? "You" : group ? message.sender.trim() : viewFirstName(message.sender) || message.sender.trim();

  return (
    <div
      className={cn(
        "flex min-w-0 shrink-0 flex-col",
        mail ? "max-w-[min(62ch,92%)]" : "max-w-[min(62ch,85%)]",
        mine ? "items-end self-end" : "items-start self-start",
      )}
    >
      <div
        className={cn(
          "min-w-0 max-w-full rounded-xl border px-3.5 py-2.5",
          // Warm grey for the user's own, as a tint so it holds in the dark
          // theme too. About #f2f1ed on white.
          mine ? "border-stone-500/20 bg-stone-500/10" : "border-border bg-card",
        )}
      >
        {mail && (message.to !== null || message.cc !== null) ? (
          <p className="mb-1.5 truncate text-[11px] text-muted-foreground">
            {message.to === null ? "" : `To: ${message.to}`}
            {message.cc === null ? "" : ` Cc: ${message.cc}`}
          </p>
        ) : null}

        {fileUrl !== null && isImage ? (
          <a href={fileUrl} target="_blank" rel="noopener noreferrer" className="block">
            <img
              src={fileUrl}
              alt={message.fileName ?? "Photo"}
              className="max-h-64 max-w-full rounded-md border border-border object-contain"
              loading="lazy"
            />
          </a>
        ) : fileUrl !== null ? (
          <a
            href={fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-w-0 max-w-full items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-[12px] text-foreground no-underline transition-colors hover:bg-accent"
          >
            <Glyph name="attach" size={14} className="text-muted-foreground" />
            <span className="min-w-0 break-all">
              {message.fileName ?? `Open attachment (${message.mediaMime ?? "file"})`}
            </span>
          </a>
        ) : null}

        {fileUrl !== null && PLACEHOLDER.test(shown.trim()) ? null : (
          <p
            className={cn(
              fileUrl !== null && "mt-2",
              mail ? MAIL_BODY : CHAT_BODY,
              media && fileUrl === null && "italic text-muted-foreground",
            )}
          >
            {media && shown.trim() === "" ? message.kind : <RichText text={shown} />}
          </p>
        )}

        {long ? (
          <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className={cn("mt-1.5 block", toggle)}>
            {expanded ? "Show less" : "Show more"}
          </button>
        ) : null}

        {split.quoted === "" ? null : (
          <div className="mt-1.5 min-w-0">
            <button type="button" aria-expanded={showQuoted} onClick={() => setShowQuoted(!showQuoted)} className={toggle}>
              {showQuoted ? "Hide quoted text" : `Show quoted text (${quotedLines} lines)`}
            </button>
            {showQuoted ? (
              <p className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] border-l border-border pl-3 text-[12px] leading-5 text-muted-foreground">
                <RichText text={split.quoted} />
              </p>
            ) : null}
          </div>
        )}
      </div>

      <p
        className={cn(
          "mx-1 mt-1 flex min-w-0 max-w-full items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground",
          mine && "justify-end",
        )}
        title={`${message.sender} · ${absoluteTime(message.at)}`}
      >
        {opened === "" ? null : (
          <span className="flex min-w-0 items-center gap-1.5 text-emerald-600">
            <EyeGlyph />
            <span className="truncate">{opened}</span>
            <span aria-hidden className="text-muted-foreground">
              ·
            </span>
          </span>
        )}
        <span className="min-w-0 truncate">{who}</span>
        <span aria-hidden>·</span>
        <span className="shrink-0">{viewClock(message.at)}</span>
      </p>
    </div>
  );
}
