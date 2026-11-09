// Undo Send: work emails that went out through Superhuman moments ago and can
// still be taken back, each with "Undo (0:58)" counting down to the deadline
// Superhuman gave. A floating strip over the inbox, because after Send the
// user is still looking at the conversation, not at a list.
//
// Undo only ever cancels. The server confirms with Superhuman before it says
// "Cancelled, back in drafts", and says "Too late, it was sent" when the window
// had closed. A row whose countdown reaches zero stops offering Undo: by then
// the email has gone, and a button that promised otherwise would lie.
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Glyph } from "./glyph";
import { FINGER_WORD, SIGNAL_TEXT, TEXT_BUTTON } from "./signals";
import { errorText, useCommsRpc, useIsFingerSurface, useUndoableSends } from "./use-comms";

type Outcome = { sendId: number; outcome: "cancelled" | "too_late" | "failed"; text: string; to: string };

/** "0:58" from milliseconds left. */
function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Ticks once a second while any window is open, and stops when none is. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const TONE: Record<Outcome["outcome"], string> = {
  cancelled: SIGNAL_TEXT.ready,
  too_late: SIGNAL_TEXT.attention,
  failed: SIGNAL_TEXT.error,
};

export function UndoSendStrip({ onChanged }: { onChanged?: () => void }) {
  const rpc = useCommsRpc();
  const sends = useUndoableSends();
  const finger = useIsFingerSurface();
  const [busy, setBusy] = useState<Set<number>>(() => new Set());
  // Each answer keeps who it was about: a cancelled email leaves the list on
  // the next read, and "That email" would not say which one.
  const [results, setResults] = useState<Outcome[]>([]);
  const items = sends.data ?? [];
  const now = useNow(items.length > 0);
  const open = items.filter((item) => item.undoUntil > now);

  // A window that closes on screen: re-read, so the row leaves with the
  // server's say-so rather than on this clock alone.
  const nextClose = open.length === 0 ? null : Math.min(...open.map((item) => item.undoUntil));
  const { refetch } = sends;
  useEffect(() => {
    if (nextClose === null) return;
    const timer = setTimeout(refetch, Math.max(0, nextClose - Date.now()) + 1500);
    return () => clearTimeout(timer);
  }, [nextClose, refetch]);

  const undo = async (sendId: number, to: string) => {
    if (busy.has(sendId)) return;
    setBusy((was) => new Set([...was, sendId]));
    try {
      const reply = await rpc.call("send_undo", { sendId });
      setResults((was) => [{ ...reply, to }, ...was.filter((entry) => entry.sendId !== sendId)]);
    } catch (cause) {
      setResults((was) => [
        { sendId, outcome: "failed", text: `${errorText(cause)} Nothing is known to have been cancelled; check before sending again.`, to },
        ...was.filter((entry) => entry.sendId !== sendId),
      ]);
    } finally {
      setBusy((was) => new Set([...was].filter((id) => id !== sendId)));
      refetch();
      onChanged?.();
    }
  };

  // An answer came back: Undo is not offered on that row again, except after
  // a failure while the window is still open, where trying again is the point.
  const settled = new Set(results.filter((entry) => entry.outcome !== "failed").map((entry) => entry.sendId));
  const shown = open.filter((item) => !settled.has(item.sendId));
  if (shown.length === 0 && results.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-auto absolute bottom-4 left-4 z-30 flex w-[min(360px,calc(100%-2rem))] flex-col gap-2 rounded-md border border-border bg-background p-3 shadow-lg"
    >
      {results.map((entry) => (
        <div key={entry.sendId} className="flex items-start gap-2 text-[12px]">
          <span className={cn("min-w-0 flex-1", TONE[entry.outcome])}>
            <span className="font-medium">To {entry.to || "the recipient"}:</span> {entry.text}
          </span>
          <button
            type="button"
            aria-label="Close this message"
            className={cn(TEXT_BUTTON, finger && FINGER_WORD)}
            onClick={() => setResults((was) => was.filter((other) => other.sendId !== entry.sendId))}
          >
            <Glyph name="dismiss" size={12} />
          </button>
        </div>
      ))}
      {shown.length === 0 ? null : (
        <>
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Just sent</span>
          <ul className="flex flex-col gap-1.5">
            {shown.map((item) => {
              const left = item.undoUntil - now;
              return (
                <li key={item.sendId} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
                    <span className="font-medium">{item.to || "Email"}</span>
                    {item.subject ? <span className="text-muted-foreground">, {item.subject}</span> : null}
                  </span>
                  <button
                    type="button"
                    disabled={busy.has(item.sendId)}
                    onClick={() => void undo(item.sendId, item.to)}
                    aria-label={`Undo the email to ${item.to || "this recipient"}, ${clock(left)} left`}
                    className={cn(
                      "shrink-0 rounded-md border border-border px-2.5 text-[12px] tabular-nums text-foreground hover:bg-muted disabled:opacity-60",
                      finger ? "min-h-11" : "min-h-7",
                    )}
                  >
                    {busy.has(item.sendId) ? "Cancelling" : `Undo (${clock(left)})`}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="text-[11px] text-muted-foreground">Undo cancels the email in Superhuman and puts it back in drafts. It never sends anything.</p>
        </>
      )}
    </div>
  );
}
