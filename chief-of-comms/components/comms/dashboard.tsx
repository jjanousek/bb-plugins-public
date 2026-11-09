// Right column of the inbox when nothing is selected. Not a dashboard any
// more: one centred column that says what the situation is, one line of
// connection state, and the two ways to reach the chief. The numbers live in
// the list column and the panel header; repeating them here as tiles only
// added chrome.
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Summary } from "../../contract";
import { openChief } from "./chief-drawer";
import { Glyph } from "./glyph";
import { accountLabel, relativeTime, waStateLabel } from "./format";
import { FINGER_WORD, TEXT_BUTTON } from "./signals";
import { TRIAGE_PROMPT } from "./tabs";
import { errorText, useCommsRpc, useIsFingerSurface } from "./use-comms";

export interface DashboardProps {
  summary: Summary | null;
  /** Rows the list beside this is showing, so the headline matches the screen. */
  listed: number;
}

/** What is actually true right now, in one line. */
function headline(summary: Summary | null, listed: number): string {
  if (summary === null) return "Reading your inbox";
  const { needsReply, ready } = summary.counts;
  if (ready > 0) return `${ready} ready to send`;
  if (needsReply > 0) return `${needsReply} ${needsReply === 1 ? "needs" : "need"} a reply`;
  // Nothing is waiting on the owner. Saying so next to forty listed rows reads
  // like a bug, so only claim it when the list really is empty.
  return listed > 0 ? "Pick a conversation" : "Nothing needs a reply";
}

/** "Work synced 2m ago · WhatsApp connected". */
function stateLine(summary: Summary | null): string {
  if (summary === null) return "";
  // Short parts: this line sits under a headline and must not wrap mid phrase.
  const parts = summary.mail.map((account) => {
    const label = accountLabel(account.account);
    if (!account.ok) return `${label} sync failed`;
    if (account.syncing) return `${label} syncing`;
    if (account.lastSyncAt === null) return `${label} never synced`;
    return `${label} ${relativeTime(account.lastSyncAt)}`;
  });
  parts.push(waStateLabel(summary.wa.state));
  return parts.join(" · ");
}

export function Dashboard({ summary, listed }: DashboardProps) {
  const rpc = useCommsRpc();
  const [busy, setBusy] = useState(false);
  const finger = useIsFingerSurface();

  const triage = async () => {
    setBusy(true);
    try {
      const result = await rpc.call("ask_chief", { text: TRIAGE_PROMPT });
      if (result.ok) toast.success(result.text);
      else toast.error(result.text);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const line = stateLine(summary);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-2 text-center">
        <Glyph name="brand" size={28} className="text-muted-foreground" />
        <p className="text-[15px] font-medium leading-[1.4] text-foreground">{headline(summary, listed)}</p>
        {line === "" ? null : <p className="text-[12px] leading-5 text-muted-foreground">{line}</p>}
        <div className="mt-4 flex flex-col items-center gap-3">
          <Button disabled={busy} onClick={() => void triage()}>
            Triage with the chief
          </Button>
          <button
            type="button"
            className={cn(TEXT_BUTTON, finger && FINGER_WORD)}
            onClick={openChief}
          >
            Open the chief
          </button>
        </div>
      </div>
    </div>
  );
}
