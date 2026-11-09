// Import one or more external Claude Code sessions into a bb worker.
//
// The server reads each session's transcript, seeds a worker with the digests,
// and asks it to write a detailed handover; this dialog only picks the
// sessions, the worker name, and where the worker should live.
import { useEffect, useMemo, useState } from "react";
import { experimental_useAppPanel } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { ExternalSession, ProjectRefDto } from "@/contract";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
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
import { slugifyName } from "./adopt-dialog";
import { WORKER_TAB } from "./tabs";
import {
  errorText,
  formatMb,
  groupSessionsByCwd,
  relativeTime,
  sessionLabel,
  useCosRpc,
} from "./use-cos";
import { useIsFingerSurface } from "./ui";

const DIGEST_PREVIEW_CHARS = 6000;

/**
 * The two text buttons in this sheet are 24px lines. On a finger surface the
 * box grows to 44px and the negative margin keeps the line where it was.
 * `h-auto` beats the `h-6` it joins under
 * tailwind-merge.
 */
const FINGER_TEXT_BUTTON = "h-auto min-h-11 -my-2.5";

/**
 * Drops the short numeric hash Claude appends to a generated session name:
 * "quiet-river-77" -> "quiet-river", "blue-harbor-98" -> "blue-harbor", while a
 * name that does not end in digits, such as "amber-field-continued", is left alone.
 */
export function stripSessionHash(name: string): string {
  const stripped = name.replace(/-\d{1,3}$/, "");
  return stripped === "" ? name : stripped;
}

function suggestedWorkerName(session: ExternalSession | undefined): string {
  if (session === undefined) return "";
  if (session.name !== null && session.name !== "") {
    return slugifyName(stripSessionHash(session.name));
  }
  const leaf = session.cwd.split("/").filter((part) => part !== "").pop() ?? "";
  return slugifyName(leaf) || session.sessionId.slice(0, 8);
}

export interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Sessions preselected when the dialog opens. */
  sessions: ExternalSession[];
  /** Everything found on the machine, so more sessions can be added here. */
  allSessions: ExternalSession[];
  projects: ProjectRefDto[];
  onImported?: () => void;
}

export function ImportDialog({
  open,
  onOpenChange,
  sessions,
  allSessions,
  projects,
  onImported,
}: ImportDialogProps) {
  const rpc = useCosRpc();
  const panel = experimental_useAppPanel();
  const finger = useIsFingerSurface();

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [createProject, setCreateProject] = useState(false);
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [showDigest, setShowDigest] = useState(false);
  // KEYED TO THE SESSION it came from, because `primary` changes whenever the
  // selection does. A bare string with an "already fetched?" short-circuit
  // would show A's digest as the preview for B's import after previewing A,
  // hiding it, unticking A and ticking B. The preview is the text read before
  // deciding, which is the entire purpose of the control.
  const [digest, setDigest] = useState<{ sessionId: string; text: string } | null>(null);
  const [digestPending, setDigestPending] = useState(false);

  // Every session this dialog can talk about, preselected ones first so a row
  // that has scrolled out of the list is still resolvable.
  const pool = useMemo(() => {
    const byId = new Map<string, ExternalSession>();
    for (const session of sessions) byId.set(session.sessionId, session);
    for (const session of allSessions) {
      if (!byId.has(session.sessionId)) byId.set(session.sessionId, session);
    }
    return [...byId.values()];
  }, [sessions, allSessions]);

  const personalProjectId = useMemo(() => {
    const personal = projects.find((project) => project.kind === "personal");
    return (personal ?? projects[0])?.id ?? "";
  }, [projects]);

  const first = sessions[0];

  useEffect(() => {
    if (!open) return;
    setSelectedIds(sessions.map((session) => session.sessionId));
    setName(suggestedWorkerName(first));
    setDescription(first?.title ?? "");
    setCreateProject(false);
    setPending(false);
    setShowPicker(false);
    setShowDigest(false);
    setDigest(null);
    setDigestPending(false);
  }, [open, sessions, first]);

  useEffect(() => {
    if (!open) return;
    setProjectId(first?.matchedProjectId ?? personalProjectId);
  }, [open, first, personalProjectId]);

  const selected = useMemo(
    () => pool.filter((session) => selectedIds.includes(session.sessionId)),
    [pool, selectedIds],
  );
  const groups = useMemo(() => groupSessionsByCwd(pool), [pool]);
  const unmatched = first !== undefined && first.matchedProjectId === null;
  const primary = selected[0] ?? first;

  const toggle = (sessionId: string) => {
    setSelectedIds((previous) =>
      previous.includes(sessionId)
        ? previous.filter((id) => id !== sessionId)
        : [...previous, sessionId],
    );
  };

  const previewDigest = async () => {
    if (primary === undefined) return;
    setShowDigest(true);
    if (digest?.sessionId === primary.sessionId || digestPending) return;
    setDigestPending(true);
    try {
      const result = await rpc.call("session_digest", {
        sessionId: primary.sessionId,
        maxChars: DIGEST_PREVIEW_CHARS,
      });
      setDigest({ sessionId: primary.sessionId, text: result.digest });
    } catch (cause) {
      setDigest(null);
      toast.error(errorText(cause));
    } finally {
      setDigestPending(false);
    }
  };

  const canSubmit = selected.length > 0 && name.trim() !== "" && !pending;

  const submit = async () => {
    if (!canSubmit) return;
    setPending(true);
    try {
      const result = await rpc.call("session_import", {
        sessionIds: selected.map((session) => session.sessionId),
        worker: slugifyName(name) || name.trim(),
        ...(createProject
          ? { createProject: true }
          : projectId === ""
            ? {}
            : { project: projectId }),
        ...(description.trim() === "" ? {} : { description: description.trim() }),
      });
      if (!result.ok) {
        toast.error(result.text);
        return;
      }
      toast.success(result.text);
      onOpenChange(false);
      onImported?.();
      if (result.threadId !== null) {
        panel.openFixedTab({
          surface: { kind: "current" },
          tab: WORKER_TAB,
          target: { threadId: result.threadId },
        });
      }
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import Claude session</DialogTitle>
          <DialogDescription>
            The worker reads each transcript and writes a detailed handover before it does
            anything else, so you can pick the work back up inside bb.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-3 overflow-y-auto">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                Sessions ({selected.length})
              </span>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-6 px-2 text-xs text-muted-foreground hover:text-foreground",
                  finger && FINGER_TEXT_BUTTON,
                )}
                onClick={() => setShowPicker((value) => !value)}
              >
                {showPicker ? "Done" : "Add more"}
              </Button>
            </div>
            {selected.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Pick at least one session.
              </p>
            ) : (
              <ul className="divide-y divide-border border-y border-border">
                {selected.map((session) => (
                  <li
                    key={session.sessionId}
                    className="flex items-center gap-2 py-1.5 text-xs"
                  >
                    <span className="shrink-0 font-medium text-foreground">
                      {sessionLabel(session)}
                    </span>
                    <span
                      className="min-w-0 shrink truncate text-muted-foreground"
                      title={session.cwd}
                    >
                      {session.cwd}
                    </span>
                    {session.title === null ? null : (
                      <span className="min-w-0 flex-1 truncate text-muted-foreground/80">
                        {session.title}
                      </span>
                    )}
                    <span className="ml-auto shrink-0 text-muted-foreground">
                      {formatMb(session.transcriptBytes)}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {session.lastActivityAt === null
                        ? "no activity"
                        : `${relativeTime(session.lastActivityAt)} ago`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {showPicker ? (
            <div className="space-y-2 border-b border-border pb-2">
              {groups.map((group) => (
                <div key={group.cwd} className="space-y-1">
                  <p className="truncate text-xs text-muted-foreground" title={group.cwd}>
                    {group.cwd}
                  </p>
                  {group.sessions.map((session) => (
                    <label
                      key={session.sessionId}
                      // 44px of label on a finger, not 20px of box. The whole
                      // label is the target, so the bleed goes here rather than
                      // on the checkbox: growing the box alone would push the
                      // text off a 358px line.
                      className={cn(
                        "flex cursor-pointer items-center gap-2 pl-2 text-xs",
                        finger && "min-h-11",
                      )}
                    >
                      <Checkbox
                        checked={selectedIds.includes(session.sessionId)}
                        onCheckedChange={() => toggle(session.sessionId)}
                      />
                      <span className="shrink-0 text-foreground">{sessionLabel(session)}</span>
                      <span className="min-w-0 truncate text-muted-foreground">
                        {session.title ?? "no title"}
                      </span>
                      {session.importedWorkerName === null ? null : (
                        <span className="ml-auto shrink-0 text-muted-foreground">
                          imported as {session.importedWorkerName}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          ) : null}

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Worker name</span>
            <Input
              // First field takes focus on open, so Escape and the keyboard
              // reach this sheet instead of the page behind it.
              autoFocus
              value={name}
              placeholder="quiet-river"
              onChange={(event) => setName(event.target.value)}
            />
            <span className="text-xs text-muted-foreground">
              Lowercase name with dashes. An existing worker with this name is reused.
            </span>
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Project</span>
            <Select value={projectId} onValueChange={setProjectId} disabled={createProject}>
              <SelectTrigger>
                <SelectValue
                  placeholder={projects.length === 0 ? "Loading" : "Pick a project"}
                />
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          {unmatched && first !== undefined ? (
            <label className={cn("flex cursor-pointer items-center gap-2", finger && "min-h-11")}>
              <Checkbox
                checked={createProject}
                onCheckedChange={(value) => setCreateProject(value === true)}
              />
              <span className="min-w-0 truncate text-xs text-muted-foreground" title={first.cwd}>
                Create a bb project from {first.cwd}
              </span>
            </label>
          ) : null}

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

          <div className="space-y-1.5">
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-6 px-2 text-xs text-muted-foreground hover:text-foreground",
                finger && FINGER_TEXT_BUTTON,
              )}
              disabled={primary === undefined}
              onClick={() => {
                if (showDigest) setShowDigest(false);
                else void previewDigest();
              }}
            >
              {showDigest ? "Hide digest" : "Preview digest"}
            </Button>
            {showDigest ? (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-border pt-2 text-xs text-muted-foreground">
                {digestPending ? "Loading" : (digest?.text ?? "No digest available")}
              </pre>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {pending ? "Importing" : `Import ${selected.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
