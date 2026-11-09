// Connections tab: the WhatsApp link and the two Gmail accounts. One dot per
// connection carries the state; nothing here is a card with a heading.
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { accountLabel, relativeTime, waStateShort } from "./format";
import {
  FINGER_WORD,
  SectionLabel,
  SkeletonRows,
  StateDot,
  TEXT_BUTTON,
  mailDotClass,
  waDotClass,
  waTextClass,
} from "./signals";
import { errorText, useCommsRpc, useIsFingerSurface, useMutedSenders, useSummary } from "./use-comms";

export function ConnectionsTab() {
  const rpc = useCommsRpc();
  const summary = useSummary();
  const muted = useMutedSenders();
  const [busy, setBusy] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const finger = useIsFingerSurface();
  const word = cn(TEXT_BUTTON, finger && FINGER_WORD);

  if (summary.data === null) {
    return summary.error === null ? (
      <SkeletonRows className="p-0" />
    ) : (
      <p role="alert" className="text-[12px] text-rose-600">
        {summary.error}
      </p>
    );
  }
  const { wa, mail, autoDraft } = summary.data;

  const call = async (job: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await job();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
      summary.refetch();
    }
  };

  const loginLabel = wa.state === "connected" ? "Reconnect" : wa.state === "qr" ? "Refresh QR code" : "Show QR code";

  return (
    <div className="min-w-0 space-y-6">
      <section className="min-w-0">
        <SectionLabel glyph="signal" label="WhatsApp" />

        <div className="mt-3 flex min-w-0 items-center gap-2">
          <StateDot className={waDotClass(wa.state)} />
          <span className={cn("min-w-0 truncate text-[13px] font-medium", waTextClass(wa.state))}>
            {waStateShort(wa.state)}
          </span>
        </div>

        {wa.me === null ? null : (
          <p className="mt-2 truncate text-[12px] text-muted-foreground">
            Linked as {wa.me.name ?? wa.me.phone ?? wa.me.jid}
            {wa.sinceMs === null ? "" : ` since ${relativeTime(wa.sinceMs)}`}
          </p>
        )}
        {wa.lastError === null ? null : (
          <p className="mt-2 break-words [overflow-wrap:anywhere] text-[12px] leading-5 text-rose-600">
            {wa.lastError}
          </p>
        )}

        {wa.state === "qr" && wa.qrDataUrl !== null ? (
          <div className="mt-3 space-y-2">
            <img
              src={wa.qrDataUrl}
              alt="WhatsApp pairing QR code"
              className="size-48 rounded-md border border-border bg-background"
            />
            <p className="max-w-[46ch] text-[12px] leading-5 text-muted-foreground">
              On your phone: WhatsApp, then Settings, then Linked devices, then Link a device. Point the camera at this
              code.
            </p>
          </div>
        ) : null}

        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-4">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void call(() => rpc.call("wa_login"))}>
            {loginLabel}
          </Button>
          {confirmUnlink ? (
            <span className="inline-flex items-center gap-2 text-[12px] text-muted-foreground">
              Unlink this phone?
              <button
                type="button"
                className={cn(word, "text-rose-600 hover:text-rose-600")}
                disabled={busy}
                onClick={() => {
                  setConfirmUnlink(false);
                  void call(() => rpc.call("wa_logout"));
                }}
              >
                Yes
              </button>
              <button type="button" className={word} onClick={() => setConfirmUnlink(false)}>
                No
              </button>
            </span>
          ) : (
            <button type="button" className={word} disabled={busy} onClick={() => setConfirmUnlink(true)}>
              Unlink
            </button>
          )}
        </div>
      </section>

      <section className="min-w-0">
        <SectionLabel glyph="mail" label="Mail" count={mail.length} />
        <div className="mt-1">
          {mail.map((account) => (
            <div key={account.account} className="min-w-0 border-b border-border/60 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <StateDot className={mailDotClass(account)} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                  {account.email}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{accountLabel(account.account)}</span>
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-4 pl-4">
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-[12px]",
                    account.ok ? "text-muted-foreground" : "text-rose-600",
                  )}
                >
                  {account.syncing
                    ? "Syncing now"
                    : account.lastSyncAt === null
                      ? "Never synced"
                      : `Last synced ${relativeTime(account.lastSyncAt)}`}
                </span>
                <button
                  type="button"
                  className={word}
                  disabled={busy || account.syncing}
                  onClick={() => void call(() => rpc.call("mail_sync"))}
                >
                  Sync now
                </button>
              </div>
              <p className="mt-0.5 truncate pl-4 text-[12px] text-muted-foreground">
                {account.sendPath === "superhuman"
                  ? "Sends through Superhuman, with read status"
                  : account.account === "work" && summary.data?.superhuman?.connected === false
                    ? "Sends through Gmail. Connect Superhuman for read status"
                    : "Sends through Gmail, no read status"}
              </p>
              {account.error === null ? null : (
                <p className="mt-1 break-words [overflow-wrap:anywhere] pl-4 text-[12px] leading-5 text-rose-600">
                  {account.error}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      {muted.data === null || muted.data.length === 0 ? null : (
        <section className="min-w-0">
          <SectionLabel glyph="dismiss" label="Muted senders" count={muted.data.length} />
          <div className="mt-1">
            {muted.data.map((sender) => (
              <div key={sender.id} className="flex min-w-0 items-center gap-4 border-b border-border/60 py-2.5">
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                  {sender.label}
                  <span className="ml-2 text-[11px] text-muted-foreground">{sender.handle}</span>
                </span>
                <button
                  type="button"
                  className={word}
                  disabled={busy}
                  onClick={() =>
                    void call(async () => {
                      await rpc.call("muted_set", { id: sender.id, muted: false });
                      muted.refetch();
                    })
                  }
                >
                  Unmute
                </button>
              </div>
            ))}
          </div>
          <p className="mt-2 max-w-[60ch] text-[12px] leading-5 text-muted-foreground">
            A muted sender never counts as needing a reply and the chief never drafts for it on its own. Their messages
            still arrive and the conversation stays under All.
          </p>
        </section>
      )}

      <p className="max-w-[60ch] text-[12px] leading-5 text-muted-foreground">
        Drafts are kept in Gmail, so they show up in Gmail and in Superhuman too. Nothing is sent until you press Send.
        {summary.data?.superhuman ? ` ${summary.data.superhuman.line}` : ""}
        {autoDraft === "" ? "" : ` Auto-draft: ${autoDraft}.`}
      </p>
    </div>
  );
}
