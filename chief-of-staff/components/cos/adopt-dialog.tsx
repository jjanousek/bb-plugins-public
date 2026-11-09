import { useEffect, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { errorText, useCosRpc } from "./use-cos";

/** Worker names are slugs: lowercase, dashes, no punctuation. */
export function slugifyName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export interface AdoptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The thread to register as a worker. Nothing renders while it is null. */
  threadId: string | null;
  /** Seeds the name field, usually the thread title. */
  suggestedName?: string;
  onAdopted?: () => void;
}

export function AdoptDialog({
  open,
  onOpenChange,
  threadId,
  suggestedName,
  onAdopted,
}: AdoptDialogProps) {
  const rpc = useCosRpc();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    // A thread title is a sentence; its first three words are a name someone
    // can type, the whole thing is not.
    setName(slugifyName((suggestedName ?? "").split(/\s+/).slice(0, 3).join(" ")));
    setDescription("");
    setPending(false);
  }, [open, suggestedName]);

  const canSubmit = threadId !== null && name.trim() !== "" && !pending;

  const submit = async () => {
    if (threadId === null || !canSubmit) return;
    setPending(true);
    try {
      const result = await rpc.call("adopt", {
        threadId,
        name: slugifyName(name) || name.trim(),
        ...(description.trim() === "" ? {} : { description: description.trim() }),
      });
      if (!result.ok) {
        // The typed name survives a rejection; only a success closes the dialog.
        toast.error(result.text);
        return;
      }
      toast.success(result.text);
      onOpenChange(false);
      onAdopted?.();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open && threadId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Adopt as worker</DialogTitle>
          <DialogDescription>
            Register this thread so the chief can reuse it by name and read its reports.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Worker name</span>
            <Input
              // First field takes focus on open, so Escape and the keyboard
              // reach this sheet instead of the page behind it.
              autoFocus
              value={name}
              placeholder="release-notes"
              onChange={(event) => setName(event.target.value)}
            />
            <span className="text-xs text-muted-foreground">
              Lowercase name with dashes, unique inside the project.
            </span>
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Description (optional)
            </span>
            <Input
              value={description}
              placeholder="What this worker owns"
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {pending ? "Adopting" : "Adopt"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
