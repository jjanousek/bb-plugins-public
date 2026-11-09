// Discarded tab: the Gmail drafts thrown away in the last 24 hours, newest
// first, each with the control that puts it back. This is the recovery path
// that still works the next day. The Undo in the toast only reaches whoever
// is looking at the screen while it is on it, so the toast is the fast path
// and this list is the one that does not depend on anyone watching.
import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { DiscardedDraft } from "../../contract";
import { accountLabel, relativeTime } from "./format";
import { EmptyState, FINGER_WORD, SectionLabel, SkeletonRows, TEXT_BUTTON } from "./signals";
import { COMMS_PANEL_PATH, conversationSubPath } from "./tabs";
import { errorText, useCommsRpc, useDiscardedDrafts, useIsFingerSurface, useSummary } from "./use-comms";

/** How long the copy has left, in the same shape as the ages elsewhere. */
function expiresIn(at: number): string {
  const minutes = Math.round((at - Date.now()) / 60_000);
  if (minutes <= 1) return "gone in a minute";
  if (minutes < 60) return `gone in ${minutes}m`;
  return `gone in ${Math.round(minutes / 60)}h`;
}

export function DiscardedTab() {
  const rpc = useCommsRpc();
  const trash = useDiscardedDrafts();
  const summary = useSummary();
  const navigate = useBbNavigate();
  const finger = useIsFingerSurface();
  const [busy, setBusy] = useState<string | null>(null);

  if (trash.data === null) {
    return trash.error === null ? (
      <SkeletonRows className="p-0" />
    ) : (
      <p role="alert" className="text-[12px] text-rose-600">
        {trash.error}
      </p>
    );
  }

  const restore = async (draft: DiscardedDraft) => {
    setBusy(draft.draftId);
    try {
      const result = await rpc.call("draft_restore", { account: draft.account, draftId: draft.draftId });
      if (!result.ok) {
        toast.error(result.text);
        return;
      }
      toast.success(result.text);
      // The draft is back under its conversation, so open it: the point of the
      // restore is to finish writing it, not to admire the list.
      if (draft.key !== null) {
        navigate.toPluginPanel(COMMS_PANEL_PATH, { subPath: conversationSubPath(draft.key), replace: true });
      }
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(null);
      trash.refetch();
      summary.refetch();
    }
  };

  return (
    <div className="min-w-0">
      <SectionLabel glyph="dismiss" label="Discarded" count={trash.data.length} />
      {trash.data.length === 0 ? (
        <EmptyState glyph="done" title="Nothing has been thrown away in the last 24 hours." />
      ) : (
        <>
          <p className="mt-2 text-[12px] leading-5 text-muted-foreground">
            A discarded Gmail draft is kept here for 24 hours. Putting it back writes a new draft with the same
            recipient, subject, text and place in the thread; the draft id changes.
          </p>
          <ul className="mt-1">
            {trash.data.map((draft) => (
              <li key={`${draft.account}:${draft.draftId}`} className="min-w-0 border-b border-border/60 py-3">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                    {draft.subject === "" ? "(no subject)" : draft.subject}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {relativeTime(draft.discardedAt)}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                  {accountLabel(draft.account)} to {draft.to === "" ? "(no recipient)" : draft.to}
                </p>
                {draft.preview === "" ? null : (
                  <p className="mt-1 line-clamp-2 break-words [overflow-wrap:anywhere] text-[12px] leading-5 text-foreground">
                    {draft.preview}
                  </p>
                )}
                <div className="mt-2 flex min-w-0 items-center gap-4">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void restore(draft)}
                    className={cn(TEXT_BUTTON, finger && FINGER_WORD, "disabled:opacity-50")}
                  >
                    {busy === draft.draftId ? "Putting it back" : "Put it back"}
                  </button>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {expiresIn(draft.expiresAt)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
