// One path to "Discard draft", shared by the three controls that offer it: the
// row icon in conversation-list.tsx, the overflow item in conversation-view.tsx
// and the word in reply-dock.tsx. Deleting a Gmail draft cannot be undone
// losslessly, so every control asks the same question before it acts.
//
// The dialog is a copy of chief-of-staff's ConfirmDialog, so bb has one shape
// for "this cannot be undone" instead of one per plugin. It is the host's own
// dialog, which already presents as a bottom sheet under a finger.
import { useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { MailAccount } from "../../contract";
import { discardConfirmFor, type DiscardPrompt, type DiscardSubject } from "./discard-confirm";
import type { CommsRpc } from "./use-comms";
import { errorText } from "./use-comms";

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
  // Cancel takes focus explicitly rather than by being first in the DOM, so a
  // return key pressed out of habit cancels. Radix focuses the content box on
  // open unless it is told otherwise; the compact path strips this prop and
  // the drawer shell honours autoFocus instead.
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancel.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {/* gap-3 because the footer stacks on a phone and the destructive
            button would otherwise touch Cancel: a destructive button keeps
            12px clear of its neighbour, in the dialog too. */}
        <DialogFooter className="gap-3">
          <Button ref={cancel} autoFocus variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {/* A real hairline, not spacing. Horizontal while the footer is
              stacked, vertical once it is a row. */}
          <span
            aria-hidden
            className="self-stretch border-t border-border sm:self-auto sm:border-l sm:border-t-0"
          />
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

export interface DiscardDraft {
  /** Call this from the control. It asks first when the discard cannot be undone. */
  askDiscard: () => void;
  /** Render this next to the control; it is nothing until a question is pending. */
  confirm: ReactNode;
}

/**
 * `discard` runs when there is nothing to ask, or once the user has said yes. The
 * decision of whether to ask is in discard-confirm.ts, which is tested.
 */
export function useDiscardDraft(conversation: DiscardSubject, discard: () => void): DiscardDraft {
  const [pending, setPending] = useState<DiscardPrompt | null>(null);
  const askDiscard = () => {
    const prompt = discardConfirmFor(conversation);
    if (prompt === null) {
      discard();
      return;
    }
    setPending(prompt);
  };
  return {
    askDiscard,
    confirm:
      pending === null ? null : (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setPending(null);
          }}
          title={pending.title}
          description={pending.description}
          confirmLabel={pending.confirmLabel}
          onConfirm={discard}
        />
      ),
  };
}

export interface DiscardResult {
  ok: boolean;
  text: string;
  restore?: { account: MailAccount; draftId: string } | null;
}

/**
 * Report a discard and offer the undo, the same way from all three controls.
 * A Gmail draft is hard-deleted at Google, so the undo writes a new draft from
 * the copy bb took first: same recipient, subject, body and place in the
 * thread, new draft id. The window is a day; the toast stays up longer than a
 * normal toast so the undo is easier to reach.
 */
export function toastDiscardResult(result: DiscardResult, rpc: CommsRpc, onDone?: () => void): void {
  if (!result.ok) {
    toast.error(result.text);
    return;
  }
  const target = result.restore ?? null;
  if (target === null) {
    toast.success(result.text);
    return;
  }
  toast.success("Draft deleted.", {
    duration: 12_000,
    description: "You can put it back for the next 24 hours.",
    action: {
      label: "Undo",
      onClick: () => {
        void (async () => {
          try {
            const restored = await rpc.call("draft_restore", target);
            if (restored.ok) toast.success(restored.text);
            else toast.error(restored.text);
          } catch (cause) {
            toast.error(errorText(cause));
          } finally {
            onDone?.();
          }
        })();
      },
    },
  });
}
