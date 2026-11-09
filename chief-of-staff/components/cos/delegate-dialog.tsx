import { useEffect, useId, useMemo, useRef, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { cn } from "@/lib/utils";
import { TEXT_URGENT } from "./tone";
import { errorText, useCosRpc, useProjects, useRoster } from "./use-cos";

const BRIEF_TEMPLATE = "Goal:\n\nConstraints:\n\nDone when:\n\nReport back:\n";

export interface DelegateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful delegate with the worker thread id, if any. */
  onDelegated?: (threadId: string | null) => void;
}

export function DelegateDialog({ open, onOpenChange, onDelegated }: DelegateDialogProps) {
  const rpc = useCosRpc();
  const projects = useProjects();
  const roster = useRoster();
  const workerListId = useId();
  // The compact drawer is the only surface this sheet overflows on, so every
  // size decision below is gated on it rather than on a CSS breakpoint.
  const compact = useIsCompactViewport();

  const [projectId, setProjectId] = useState("");
  const [worker, setWorker] = useState("");
  const [description, setDescription] = useState("");
  const [brief, setBrief] = useState(BRIEF_TEMPLATE);
  const [pending, setPending] = useState(false);
  const briefRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setWorker("");
    setDescription("");
    setBrief(BRIEF_TEMPLATE);
    setPending(false);
    // The caret lands after "Goal: " rather than in front of the label, so the
    // first keystroke writes the goal instead of breaking the template.
    const frame = requestAnimationFrame(() => briefRef.current?.setSelectionRange(6, 6));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const projectOptions = projects.data ?? [];
  useEffect(() => {
    if (projectId !== "" || projectOptions.length === 0) return;
    const personal = projectOptions.find((p) => p.kind === "personal");
    setProjectId((personal ?? projectOptions[0]).id);
  }, [projectId, projectOptions]);

  const suggestions = useMemo(() => {
    const workers = roster.data?.workers ?? [];
    return workers
      .filter((w) => !w.retired && (projectId === "" || w.projectId === projectId))
      .map((w) => w.name);
  }, [roster.data, projectId]);

  // Whether the roster has ANSWERED, which is not the same as whether it is
  // empty. `suggestions` falls back to [], so a roster that has not landed and
  // a roster that failed would both read as "this project has no workers": the
  // field would call an existing worker new, and the submit would carry the
  // implicit `spawn: true` consent on the strength of a read that never
  // happened.
  const rosterKnown = roster.data !== null && roster.data !== undefined;
  const existing = rosterKnown && suggestions.includes(worker.trim().toLowerCase());
  // The untouched template is not a brief: sending "Goal: Constraints: Done
  // when: Report back:" to a worker is a wasted turn.
  const briefWritten = brief.trim() !== "" && brief.trim() !== BRIEF_TEMPLATE.trim();
  const canSubmit = projectId !== "" && worker.trim() !== "" && briefWritten && !pending;

  const submit = async () => {
    if (!canSubmit) return;
    setPending(true);
    try {
      const result = await rpc.call("delegate", {
        project: projectId,
        worker: worker.trim(),
        message: brief.trim(),
        ...(description.trim() === "" ? {} : { description: description.trim() }),
        // The field says in so many words that this name is new, so the click
        // is the explicit consent the CLI asks for with --spawn. It is only
        // consent when the field actually said it: with the roster unread the
        // sentence says so instead, and this stays off, which makes the server
        // refuse an unknown name rather than create one on a guess.
        ...(rosterKnown && !existing ? { spawn: true } : {}),
      });
      // delegate() returns a refusal as an ordinary result with no thread. A
      // refusal must not close the dialog under a green toast: it stays open
      // and reads as an error.
      if (result.threadId === null) {
        toast.error(result.text);
        return;
      }
      const projectName = projectOptions.find((p) => p.id === projectId)?.name ?? "the project";
      toast.success(
        result.reused
          ? `Brief sent to ${worker.trim()} in ${projectName}.`
          : `New worker ${worker.trim()} started in ${projectName}.`,
      );
      onOpenChange(false);
      onDelegated?.(result.threadId);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Delegate a task</DialogTitle>
          {/* Kept rendered and unhidden on compact: the drawer wires
              `aria-describedby` to this exact element. The reuse rule lives
              on the Worker field, where the name is typed. */}
          <DialogDescription>The chief sends this brief to a worker thread.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Project</span>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger>
                <SelectValue placeholder={projects.data === null ? "Loading" : "Pick a project"} />
              </SelectTrigger>
              <SelectContent>
                {projectOptions.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {projects.error === null ? null : (
              <span className={cn("text-xs", TEXT_URGENT)}>{projects.error}</span>
            )}
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Worker</span>
            <Input
              value={worker}
              list={workerListId}
              placeholder="release-notes"
              onChange={(event) => setWorker(event.target.value)}
            />
            <datalist id={workerListId}>
              {suggestions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <span className="text-xs text-muted-foreground">
              {worker.trim() === ""
                ? "Lowercase name with dashes. Reused if it already exists in this project."
                : !rosterKnown
                  ? "Still reading the roster, so this name has not been checked yet."
                  : existing
                    ? "This worker exists. It will be reused and keeps its context."
                    : "Not in this project yet. Delegating creates this worker."}
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
            <span className="text-xs text-muted-foreground">
              The chief sees this as the worker's topic. On a reused worker it replaces the old one.
            </span>
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Brief</span>
            <Textarea
              ref={briefRef}
              value={brief}
              rows={compact ? 4 : 9}
              className="text-[13px] leading-5"
              onChange={(event) => setBrief(event.target.value)}
            />
          </label>
        </div>

        {/* Compact only: the desktop dialog is `p-6`, where `-mx-4 px-4` would
            hang the buttons 8px outside the field column. `flex-row` overrides
            the footer's own `flex-col-reverse` through `cn`'s tailwind-merge,
            so Delegate does not cost a second 36px line on a phone. */}
        <DialogFooter
          className={cn(
            compact &&
              "sticky bottom-0 -mx-4 flex-row justify-end gap-2 bg-background px-4 pb-[max(0.5rem,env(safe-area-inset-bottom))]",
          )}
        >
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {pending ? "Sending" : "Delegate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
