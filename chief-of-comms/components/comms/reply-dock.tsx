// The reply dock under a conversation. Send is the
// approval step for
// both channels: WhatsApp goes out through the linked device, mail sends the
// Gmail draft, through Superhuman on work mail. Nothing is sent until the owner
// presses Send or Cmd/Ctrl+Enter.
//
// Cmd/Ctrl+Enter sends mail too, as in Superhuman. The key and the button
// are the same human action and call the same sendMail(), which saves an
// edited box first and then sends it. What goes out is always the text in the
// box, never a draft the user has not seen. The key is ignored while a send is in
// flight, while the key is held down (auto-repeat) and while an input method
// is composing, so one press cannot become two sends.
//
// Layout: a To line with who wrote the draft, the editor, then one action row:
// Send, Ask chief (opens the chief with a line naming this conversation; sends nothing), Save draft when there are edits, the status, and Discard
// alone at the far right, away from Send. One caption under it says where the
// mail goes out.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Conversation, Draft, WaState } from "../../contract";
import { Glyph } from "./glyph";
import { askLine, relativeTime, replySubject, replyTarget, viewDockPlaceholder, viewRecipient, viewRecipients, viewSendKeyHint } from "./format";
import { FINGER_WORD, TEXT_BUTTON } from "./signals";
import { DOCK_DESTRUCTIVE_MARGIN_CLASS } from "./touch-geometry.ts";
import { askChiefAbout } from "./chief-drawer";
import { REWRITE_SHARE, changedShare, groupedDiff, hasChange } from "./draft-diff.ts";
import { openWith, type Stash } from "./compose-stash.ts";
import { toastDiscardResult, useDiscardDraft } from "./use-discard-draft";
import { errorText, fetchSendIntent, useCommsRpc, useIsFingerSurface, useSummary } from "./use-comms";

const MAX_HEIGHT_PX = 288;

// Unsaved text per conversation key, so switching conversations (which
// remounts the dock) never loses what was typed. Each entry records the draft
// it was typed into; compose-stash.ts decides what the box opens with, and
// text from a draft that is gone never goes back in the box.
const unsavedText = new Map<string, Stash>();

/** The platform string the key hint is read from; "" outside a browser. */
function platformString(): string {
  if (typeof navigator === "undefined") return "";
  return navigator.platform || navigator.userAgent || "";
}

export interface ReplyDockProps {
  conversation: Conversation;
  draft: Draft | null;
  waState: WaState;
  narrow: boolean;
  onChanged: () => void;
}

export function ReplyDock({ conversation, draft, waState, narrow, onChanged }: ReplyDockProps) {
  const rpc = useCommsRpc();
  // Under a finger the words beside Send get 44px boxes
  // and the box is 16px so iOS does not zoom on focus.
  const finger = useIsFingerSurface();
  const word = cn(TEXT_BUTTON, finger && FINGER_WORD);
  const serverText = draft?.text ?? "";
  const draftId = draft?.id ?? null;
  const [opened] = useState(() => openWith(unsavedText.get(conversation.key), draftId, serverText));
  const [text, setText] = useState(opened.text);
  const [dirty, setDirty] = useState(opened.dirty);
  // Text typed into a draft that has since been sent, discarded or replaced.
  // Shown to copy from, never in the box, so Send cannot carry it.
  const [orphan, setOrphan] = useState<string | null>(opened.orphan);
  // The draft the box's text belongs to. Send refuses when the stored draft is
  // a different one, whatever the text says.
  const boxDraftId = useRef<string | null>(opened.dirty ? (unsavedText.get(conversation.key)?.draftId ?? draftId) : draftId);
  const [busy, setBusy] = useState(false);
  // Set synchronously when a job starts, so a second key press that lands
  // before React has re-rendered with busy=true is still refused.
  const inFlight = useRef(false);
  // A draft the chief wrote while the box was dirty, waiting to be adopted.
  const [incoming, setIncoming] = useState<string | null>(null);
  // The quoted history is not in the box; it is appended again on save.
  const [showQuoted, setShowQuoted] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastServerText = useRef(serverText);

  // Adopt a draft the chief wrote while the box sat untouched; offer it when
  // the box is dirty rather than dropping it.
  useEffect(() => {
    if (lastServerText.current === serverText && boxDraftId.current === draftId) return;
    lastServerText.current = serverText;
    if (!dirty) {
      setText(serverText);
      boxDraftId.current = draftId;
      setIncoming(null);
      return;
    }
    setIncoming(serverText === "" ? null : serverText);
  }, [serverText, draftId, dirty]);

  useEffect(() => {
    if (dirty) unsavedText.set(conversation.key, { text, draftId: boxDraftId.current });
    else unsavedText.delete(conversation.key);
  }, [conversation.key, text, dirty]);

  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  const mail = conversation.channel === "mail";
  const trimmed = text.trim();
  const connected = waState === "connected";
  const pendingClean = draft !== null && !dirty && trimmed !== "";
  const sendError = draft?.error ?? null;

  const run = async (job: () => Promise<void>) => {
    inFlight.current = true;
    setBusy(true);
    try {
      await job();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
      onChanged();
    }
  };

  // After a send or a discard the draft prop still holds the old text until the
  // refetch lands; pin lastServerText to it so the box is not refilled.
  const clearBox = () => {
    setText("");
    setDirty(false);
    setIncoming(null);
    setOrphan(null);
    lastServerText.current = serverText;
    unsavedText.delete(conversation.key);
  };

  const save = () =>
    run(async () => {
      if (trimmed === "") return;
      const saved = await rpc.call("draft_save", { key: conversation.key, text });
      lastServerText.current = text.trim();
      boxDraftId.current = saved.id;
      setDirty(false);
      setIncoming(null);
      unsavedText.delete(conversation.key);
      toast.success("Draft saved");
    });

  // The box's text belongs to a draft that is no longer the stored one. Saving
  // it would write the old draft's words into the new draft, so Send stops.
  const boxIsForAnotherDraft = () => dirty && boxDraftId.current !== null && boxDraftId.current !== draftId;
  const refuseOtherDraft = () => {
    toast.error("Not sent: the text in the box was typed into an earlier draft. Read the stored draft, then press Send again.");
    setOrphan(text);
    setText(serverText);
    setDirty(false);
    boxDraftId.current = draftId;
    unsavedText.delete(conversation.key);
  };

  const sendMail = () =>
    run(async () => {
      if (trimmed === "") return;
      if (boxIsForAnotherDraft()) return refuseOtherDraft();
      let sendingId = boxDraftId.current ?? draftId;
      if (draft === null || dirty) sendingId = (await rpc.call("draft_save", { key: conversation.key, text })).id;
      // The text on screen goes with the send, and the server refuses if the
      // pending draft now says something else: a draft the chief rewrote after
      // this screen last refreshed must never go out unseen. The draft id goes
      // too, so a different draft on the same thread is refused as well.
      const result = await rpc.call("draft_send", {
        key: conversation.key,
        expectText: text,
        ...(sendingId === null ? {} : { expectDraftId: sendingId }),
        intent: await fetchSendIntent(conversation.key),
      });
      if (result.ok) {
        toast.success(result.text);
        clearBox();
        return;
      }
      // The draft stays pending with its error; keep the text so Send can retry.
      toast.error(result.text);
      lastServerText.current = text.trim();
      setDirty(false);
    });

  const send = () =>
    run(async () => {
      if (trimmed === "" || !connected) return;
      if (draft === null) {
        const result = await rpc.call("send_now", { key: conversation.key, text, intent: await fetchSendIntent(conversation.key) });
        if (result.ok) {
          toast.success(result.text);
          clearBox();
        } else {
          toast.error(result.text);
        }
        return;
      }
      if (boxIsForAnotherDraft()) return refuseOtherDraft();
      let sendingId = boxDraftId.current ?? draftId;
      if (dirty) sendingId = (await rpc.call("draft_save", { key: conversation.key, text })).id;
      const result = await rpc.call("draft_send", {
        key: conversation.key,
        expectText: text,
        ...(sendingId === null ? {} : { expectDraftId: sendingId }),
        intent: await fetchSendIntent(conversation.key),
      });
      if (result.ok) {
        toast.success(result.text);
        clearBox();
        return;
      }
      toast.error(result.text);
      lastServerText.current = text.trim();
      setDirty(false);
    });

  const discard = () =>
    run(async () => {
      const result = await rpc.call("draft_discard", { key: conversation.key });
      if (result.ok) {
        toastDiscardResult(result, rpc);
        clearBox();
        return;
      }
      // The draft is still there, so the box must keep what is in it. Clearing
      // here would also drop the unsaved stash and throw away typed text. Send
      // and sendMail also clear only on success.
      toast.error(result.text);
    });

  const discardDraft = useDiscardDraft(conversation, () => void discard());

  // The chief's last rewrite, shown as a highlight until the owner accepts or
  // undoes it. Only while the box still holds exactly that text:
  // once the user types, their text is what matters and the highlight goes.
  // Clicking into the highlighted text switches to the editor; typing then
  // makes the box dirty, and saving the edit clears the change on the server.
  const [editingReview, setEditingReview] = useState<string | null>(null);
  const reviewKey = draft?.previousText ?? null;
  const review =
    !dirty && incoming === null && draft !== null && hasChange(draft.previousText, text) && editingReview !== reviewKey
      ? (draft.previousText as string)
      : null;
  // Most of the words changed: a diff of that is noise, so show the new text
  // plainly and the old one on request.
  const rewrite = review !== null && changedShare(review, text) > REWRITE_SHARE;
  const [showPrevious, setShowPrevious] = useState(false);
  const editInstead = () => {
    setEditingReview(reviewKey);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const reviewChange = (action: "accept" | "undo") =>
    run(async () => {
      const result = await rpc.call("draft_review", { key: conversation.key, action });
      if (!result.ok) {
        toast.error(result.text);
        return;
      }
      if (action === "undo" && review !== null) {
        setText(review);
        lastServerText.current = review.trim();
      }
      toast.success(result.text);
    });

  // Opens the chief with a line naming this conversation and sends nothing:
  // the user adds the question and presses Enter themselves.
  const summary = useSummary();
  const askChief = () => {
    const chief = summary.data?.chiefThreadId ?? null;
    if (chief === null) {
      toast.error("The chief is not running yet. Open it from the Chief button to start it.");
      return;
    }
    askChiefAbout(chief, askLine(conversation, draft !== null));
  };

  const sendDisabled = busy || trimmed === "" || (!mail && !connected);
  const pressSend = () => void (mail ? sendMail() : send());

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    // The same press as the Send button, under the same conditions it is
    // enabled on. See the note at the top of this file.
    if (event.repeat || event.nativeEvent.isComposing || inFlight.current || sendDisabled) return;
    pressSend();
  };

  const provenance =
    draft === null
      ? ""
      : draft.origin === "chief"
        ? "Draft by the chief"
        : draft.origin === "worker"
          ? `Draft by ${draft.authorTitle ?? "another thread"}`
          : draft.origin === "you"
            ? "Your draft"
            : "Pending draft";
  const sendLabel = sendError === null ? "Send" : "Retry send";

  // The banner over the box names whoever wrote the draft that landed, taken
  // from the record on the draft itself. A draft written from the CLI or in a
  // second window is not the chief, so the banner must not say it was.
  const incomingByChief = draft?.origin === "chief";
  const incomingLabel = incomingByChief
    ? "Chief updated this draft"
    : draft?.origin === "worker"
      ? `${draft.authorTitle ?? "Another thread"} updated this draft`
      : "This draft changed elsewhere";

  // Adopting the new draft throws away what is in the box, so keep a copy and
  // offer it back for as long as the toast is up.
  const adoptIncoming = (next: string) => {
    const mine = text;
    const mineDraftId = boxDraftId.current;
    boxDraftId.current = draftId;
    setText(next);
    setDirty(false);
    setIncoming(null);
    unsavedText.delete(conversation.key);
    if (mine.trim() === "") return;
    toast.success("Using the new draft", {
      // Four seconds is the default and it is not enough to read a line, decide
      // that the old text was the better one, and reach the button.
      duration: 10000,
      action: {
        label: "Undo",
        onClick: () => {
          boxDraftId.current = mineDraftId;
          setText(mine);
          setDirty(true);
          unsavedText.set(conversation.key, { text: mine, draftId: mineDraftId });
        },
      },
    });
  };

  // Built from the parts that exist. A leftover Gmail draft can carry neither a
  // recipient nor a subject. Mail names the first recipient and their address;
  // a chat names the chat and, for a person, the number.
  const target = replyTarget(conversation, draft?.to ?? null);
  const recipient = mail
    ? viewRecipient(target)
    : {
        name: target,
        address: conversation.isGroup || conversation.counterpart === target ? "" : conversation.counterpart.trim(),
        more: 0,
      };
  const allTo = mail ? viewRecipients(draft?.to ?? target) : [];
  const cc = mail ? viewRecipients(draft?.cc ?? null) : [];
  const subject = mail ? ((draft?.subject ?? "").trim() || replySubject(conversation.title)) : "";
  const toTitle = [target === "" ? "No recipient yet" : `To ${target}`, subject].filter((part) => part !== "").join(" · ");
  const keyHint = viewSendKeyHint(platformString());

  return (
    <div className={cn("min-w-0 shrink-0 border-t border-border bg-card pb-3.5 pt-3", narrow ? "px-4" : "px-[22px]")}>
      <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground" title={toTitle}>
        {target === "" ? (
          <span className="min-w-0 truncate">No recipient yet</span>
        ) : (
          <span className="min-w-0 truncate">
            To{" "}
            <span className="font-medium text-foreground">{recipient.name || recipient.address}</span>
            {recipient.name === "" || recipient.address === ""
              ? ""
              : mail
                ? ` <${recipient.address}>`
                : ` ${recipient.address}`}
            {recipient.more > 0 ? ` and ${recipient.more} more` : ""}
          </span>
        )}
        {draft === null ? null : (
          <span className="ml-auto shrink-0 whitespace-nowrap rounded-[5px] bg-emerald-500/10 px-1.5 text-[10.5px] leading-[17px] text-emerald-600">
            {provenance}
            {` · ${relativeTime(draft.updatedAt)}`}
          </span>
        )}
      </div>

      {mail && (allTo.length > 1 || cc.length > 0) ? (
        // Everyone the mail goes to, before Send. The line above names only the
        // first To; a Cc is amber because it is the one the user did not type.
        <div className="mt-1 min-w-0 space-y-0.5 text-[11.5px] leading-[1.45]">
          {allTo.length > 1 ? (
            <p className="break-words text-muted-foreground">
              <span className="text-muted-foreground/80">To </span>
              <span className="text-foreground">{allTo.join(", ")}</span>
            </p>
          ) : null}
          {cc.length > 0 ? (
            <p className="break-words text-amber-700">
              <span>Cc </span>
              {cc.join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}

      {orphan === null ? null : (
        <div className="mt-2 min-w-0 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1">
              Unsaved text from an earlier draft on this thread. It is not in the box below and will not be sent.
            </span>
            <button
              type="button"
              className={word}
              onClick={() => {
                void navigator.clipboard?.writeText(orphan).then(
                  () => toast.success("Copied"),
                  () => toast.error("Could not copy"),
                );
              }}
            >
              Copy
            </button>
            <button type="button" className={word} onClick={() => setOrphan(null)}>
              Dismiss
            </button>
          </div>
          <pre className="mt-1.5 max-h-28 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[12px] text-muted-foreground">{orphan}</pre>
        </div>
      )}

      {incoming === null ? null : (
        <div className="mt-2 flex min-w-0 items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-600">
          <Glyph name={incomingByChief ? "chief" : "draft"} size={12} />
          <span className="min-w-0 flex-1 truncate">{incomingLabel}</span>
          <button
            type="button"
            onClick={() => adoptIncoming(incoming)}
            className={cn("shrink-0 cursor-pointer whitespace-nowrap underline-offset-2 hover:underline", finger && FINGER_WORD)}
          >
            Use it
          </button>
          <button type="button" onClick={() => setIncoming(null)} className={word}>
            Keep mine
          </button>
        </div>
      )}

      <div
        className={cn(
          "mt-2 min-w-0 rounded-[10px] border bg-background transition-shadow",
          // A clean draft waiting to go: emerald edge and a soft glow. Tints
          // rather than fixed shades, because the panel has no dark variant.
          pendingClean
            ? "border-emerald-500/30 shadow-[0_0_0_3px_rgba(16,185,129,0.08)]"
            : "border-border focus-within:border-foreground/25",
        )}
      >
        {review === null ? null : (
          <div className="min-w-0 border-b border-border/60">
            <p
              aria-label="What the chief changed. Click to edit the text."
              title="Click to edit"
              onClick={editInstead}
              className="max-h-72 cursor-text overflow-y-auto whitespace-pre-wrap break-words px-[13px] py-[11px] text-[14px] leading-[1.6] text-foreground max-md:pointer-coarse:text-base"
            >
              {rewrite
                ? text
                : groupedDiff(review, text).map((part, index) =>
                    part.kind === "same" ? (
                      <span key={index}>{part.text}</span>
                    ) : part.kind === "added" ? (
                      <ins key={index} className="rounded-[3px] bg-emerald-500/15 px-0.5 text-emerald-700 no-underline">
                        {part.text}
                      </ins>
                    ) : (
                      <del
                        key={index}
                        className="rounded-[3px] px-0.5 text-muted-foreground/80 decoration-rose-500/70 decoration-1"
                      >
                        {part.text}
                      </del>
                    ),
                  )}
            </p>
            {rewrite && showPrevious ? (
              <div className="border-t border-border/60 px-[13px] py-2">
                <div className="text-[11px] text-muted-foreground">Previous version</div>
                <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-[1.55] text-muted-foreground line-through decoration-rose-500/50 decoration-1">
                  {review}
                </p>
              </div>
            ) : null}
            <div className={cn("flex min-w-0 items-center gap-2 border-t border-border/60 py-1.5 pl-[13px] pr-2 text-[11.5px] text-muted-foreground", finger && "flex-wrap gap-x-4 gap-y-2")}>
              <Glyph name="chief" size={12} />
              <span className="min-w-0 flex-1 truncate">{draft?.origin === "worker"
                  ? `${draft.authorTitle ?? "Another thread"} ${rewrite ? "rewrote this draft" : "changed this draft; the change is highlighted"}`
                  : rewrite
                    ? "The chief rewrote this draft"
                    : "Chief's change is highlighted"}</span>
              {rewrite ? (
                <button type="button" className={cn(word, "text-[11.5px]")} onClick={() => setShowPrevious(!showPrevious)}>
                  {showPrevious ? "Hide previous" : "Show previous"}
                </button>
              ) : null}
              <button type="button" className={cn(word, "text-[11.5px]")} disabled={busy} onClick={() => void reviewChange("accept")}>
                Accept
              </button>
              <button type="button" className={cn(word, "text-[11.5px]")} disabled={busy} onClick={() => void reviewChange("undo")}>
                Undo change
              </button>
            </div>
          </div>
        )}
        <textarea
          ref={textareaRef}
          hidden={review !== null}
          rows={3}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setDirty(true);
          }}
          onKeyDown={onKeyDown}
          aria-label="Reply text"
          aria-keyshortcuts="Meta+Enter Control+Enter"
          placeholder={viewDockPlaceholder(mail ? "mail" : "whatsapp", recipient.name || recipient.address)}
          className={cn(
            "block max-h-72 min-h-[92px] w-full resize-none overflow-y-auto rounded-[10px] border-0 bg-transparent px-[13px] py-[11px]",
            // 16px text on coarse pointers below md, so mobile browsers do not zoom the field on focus.
            "text-[14px] leading-[1.6] max-md:pointer-coarse:text-base text-foreground placeholder:text-muted-foreground",
            "focus-visible:outline-none",
          )}
        />
        {draft?.quoted ? (
          <div className="min-w-0 border-t border-border/60 px-[13px] py-1.5 text-[11.5px] text-muted-foreground">
            <button type="button" className={cn(word, "text-[11.5px]")} onClick={() => setShowQuoted(!showQuoted)}>
              {showQuoted ? "Hide quoted history" : "Show quoted history (sent below your reply)"}
            </button>
            {showQuoted ? (
              <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-sans">{draft.quoted}</pre>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className={cn("mt-2.5 flex min-w-0 items-center", finger ? "flex-wrap gap-x-4 gap-y-3" : "gap-2")}>
        <span
          className={cn("inline-flex", finger && "basis-full")}
          title={mail || connected ? undefined : "WhatsApp is not connected"}
        >
          <button
            type="button"
            disabled={sendDisabled}
            onClick={pressSend}
            className={cn(
              "inline-flex shrink-0 cursor-pointer items-center justify-center gap-[7px] whitespace-nowrap rounded-[7px] bg-foreground px-4 text-[12.5px] font-medium text-background transition-colors hover:bg-foreground/90",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-default disabled:opacity-50",
              finger ? "h-11 w-full text-[15px]" : "h-[34px]",
            )}
          >
            <Glyph name="send" size={14} />
            {sendLabel}
            {finger ? null : (
              <kbd className="rounded-[4px] border border-b-2 border-background/25 bg-background/15 px-1 font-mono text-[10.5px] font-normal leading-[15px] text-background/75">
                {keyHint}
              </kbd>
            )}
          </button>
        </span>

        <button
          type="button"
          disabled={busy}
          onClick={askChief}
          className={cn(
            "inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap rounded-[7px] border border-border bg-card px-[11px] text-[12.5px] text-foreground transition-colors hover:bg-muted/60",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50",
            finger ? "min-h-11 px-4 text-[14px]" : "h-[30px]",
          )}
        >
          Ask chief…
        </button>

        {dirty ? (
          <button type="button" className={word} disabled={busy || trimmed === ""} onClick={() => void save()}>
            Save draft
          </button>
        ) : null}

        <Status
          sendError={sendError}
          offline={!mail && !connected}
          dirty={dirty}
          ready={draft !== null && conversation.readyToSend}
          provenance={provenance}
          savedAt={draft?.updatedAt ?? null}
        />

        {draft === null ? null : (
          <>
            <button
              type="button"
              // Far right, away from Send. Held off its neighbours on a finger:
              // the row is gap-x-4 there and word boxes bleed 4px each side,
              // so the extra margin is what keeps 12px of clear air. See
              // touch-geometry.ts.
              className={cn(
                word,
                "text-rose-600/80 hover:text-rose-600",
                finger ? DOCK_DESTRUCTIVE_MARGIN_CLASS : "h-[30px] rounded-[7px] px-2.5 text-[12.5px] hover:bg-rose-500/10",
              )}
              disabled={busy}
              onClick={() => discardDraft.askDiscard()}
            >
              Discard
            </button>
            {discardDraft.confirm}
          </>
        )}
      </div>

      {mail ? <SendPathNote account={conversation.account} /> : null}
    </div>
  );
}

// Drawn for this plugin with the glyph pipeline (tools/asset-pipeline, Seedream
// asset). Kept here rather than in glyph-data.ts
// because only the send note uses it.
const UNDO = {
  viewBox: "-11.1 -10.0 120.0 120.0",
  d: "M 27.3 1.1 C 27.2 1.1, 27.1 1.2, 27 1.2 C 26.7 1.2, 25.6 1.7, 24.9 2.2 C 24.4 2.6, 20.5 5.8, 20.3 6 C 20.2 6, 19.5 6.7, 17.6 8.1 C 13.6 11.5, 10.6 13.6, 6.3 16.4 C 5.8 16.7, 5.3 17, 5.2 17.1 C 5.1 17.2, 4.5 17.6, 4 17.9 C 2.2 19.1, 1.5 19.9, 1.1 21.2 C 0.6 22.9, 1.4 24.5, 3.6 26 C 4.1 26.3, 5.5 27.2, 6.7 28 C 10.1 30.3, 11.8 31.5, 14.8 33.8 C 16.6 35.3, 21.3 39.2, 22.6 40.4 C 25.2 42.7, 26.8 43.6, 28.6 43.6 C 29.4 43.5, 30.6 43.2, 31.2 42.9 C 31.3 42.8, 31.5 42.7, 31.7 42.6 C 32.4 42.2, 33.4 40.9, 33.8 39.8 C 34.6 37.4, 33.6 35.2, 30.5 32.7 C 30.3 32.6, 29.7 32, 29.1 31.5 C 28.6 31, 28 30.5, 27.7 30.3 C 27.1 29.7, 26.3 29, 25.6 28.3 L 25 27.7 41.6 27.7 C 54.6 27.7, 58.5 27.8, 59 27.9 C 63 28.6, 63.3 28.7, 65.8 29.6 C 79.9 35, 88 50.4, 84.3 64.8 C 83.6 67.3, 83 68.8, 81.9 71.1 C 78.9 77.1, 73.5 82.2, 67.2 84.9 C 66 85.5, 64.5 86, 63.9 86.2 C 63.8 86.2, 63.4 86.3, 63.1 86.4 C 62.4 86.6, 61.2 86.8, 60.4 86.9 C 60.1 87, 59.6 87, 59.4 87.1 C 59.2 87.1, 47.1 87.2, 32.6 87.2 C 8.5 87.3, 6.3 87.3, 5.8 87.4 C 3.6 88.1, 2 89.6, 1.4 91.6 C 0.7 94.4, 2.5 97.4, 5.5 98.4 L 6.3 98.7 32.7 98.7 C 50.6 98.7, 59.3 98.6, 59.9 98.6 C 61.5 98.3, 62.8 98.2, 63.3 98.1 C 63.5 98, 64.1 97.9, 64.7 97.8 C 66 97.5, 66.1 97.5, 67.3 97.1 C 69.1 96.6, 71 95.9, 72.4 95.2 C 72.9 95.1, 73.2 94.9, 73.2 94.9 C 73.2 94.9, 73.6 94.7, 74.1 94.5 C 82.7 90.3, 90 82.4, 93.6 73.7 C 93.9 73.1, 94.1 72.5, 94.2 72.4 C 96.4 67.4, 97.4 58, 96.4 52.1 C 96.1 49.7, 95.7 48.2, 95.3 46.7 C 94.9 45.1, 94.7 44.5, 93.9 42.4 C 93.5 41.3, 92.1 38.6, 91.4 37.4 C 91.2 36.9, 91 36.5, 91 36.5 C 91 36.4, 88.8 33.2, 88.3 32.5 C 85.2 28.5, 80.7 24.4, 76.5 22 C 74.5 20.8, 73.7 20.3, 71.4 19.3 C 68.6 18.1, 64.3 16.9, 60.9 16.5 C 58.2 16.2, 56.5 16.1, 40.7 16.2 C 32.1 16.2, 25.1 16.2, 25.1 16.1 C 25.1 16.1, 26.4 15, 30 12.1 C 32.4 10, 33 9.4, 33.5 8.1 C 34.8 5.4, 33.1 1.9, 30 1.1 C 29.4 0.9, 27.5 0.9, 27.3 1.1",
};

/**
 * What pressing Send does on this account, read from the server rather than
 * assumed: work mail goes through Superhuman once it is connected, and the two
 * paths differ in the one thing worth knowing before the click, which is
 * whether it can be taken back. The undo is Superhuman's, not this panel's,
 * so the line says where to go for it.
 */
function SendPathNote({ account }: { account: Conversation["account"] }) {
  const summary = useSummary();
  const path = summary.data?.mail.find((m) => m.account === account)?.sendPath ?? null;
  if (path === null) return null;
  return (
    <p className="mt-2 flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
      {path === "superhuman" ? (
        <svg viewBox={UNDO.viewBox} width={12} height={12} className="shrink-0" aria-hidden focusable="false">
          <path d={UNDO.d} fill="currentColor" />
        </svg>
      ) : null}
      <span className="min-w-0 truncate">
        {path === "superhuman"
          ? "Goes out through Superhuman with a read receipt. You have one minute to undo it in Superhuman."
          : "Goes out from Gmail as you, with no read receipt. It cannot be undone."}
      </span>
    </p>
  );
}

interface StatusProps {
  sendError: string | null;
  offline: boolean;
  dirty: boolean;
  ready: boolean;
  provenance: string;
  savedAt: number | null;
}

/**
 * One 11px line in the action row, taking the space between the buttons and
 * Discard. Never more than one state, and never more than one line: it
 * truncates, with the full text on hover.
 */
function Status({ sendError, offline, dirty, ready, provenance, savedAt }: StatusProps) {
  const base = "min-w-0 flex-1 truncate whitespace-nowrap text-right text-[11px]";
  if (sendError !== null) {
    return (
      <span className={cn(base, "text-rose-600")} title={sendError}>
        {sendError}
      </span>
    );
  }
  if (offline) return <span className={cn(base, "text-rose-600")}>WhatsApp is not connected</span>;
  if (dirty) return <span className={cn(base, "text-muted-foreground")}>Unsaved changes</span>;
  if (provenance === "") return <span className={base} aria-hidden />;
  if (ready) {
    return (
      <span className={base} title={`Ready to send · ${provenance}`}>
        <span className="text-emerald-600">Ready to send</span>
        <span className="text-muted-foreground"> · {provenance}</span>
      </span>
    );
  }
  const saved = savedAt === null ? "" : `, saved ${relativeTime(savedAt)}`;
  return (
    <span className={cn(base, "text-muted-foreground")} title={`${provenance}${saved}`}>
      {provenance}
      {saved}
    </span>
  );
}
