// The Chief of Staff mark in a thread's header.
//
// On a wide viewport it is a word: `Worker: site-builder`. On a compact one the
// header has no room for a word that already truncates at 8rem, so it becomes
// the same 28px control every other header icon uses, carrying only the dot
// instead. The name does not disappear: it moves into `aria-label` and
// `title`, which is where a truncated word was really living anyway.
import { useState } from "react";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Urgency, WorkerStatus } from "@/contract";
import { Button } from "@/components/ui/button";
import { COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { Glyph } from "./glyph";
import { cn } from "@/lib/utils";
import { AdoptDialog } from "./adopt-dialog";
import { useCosBridge } from "./bridge";
import { CHIEF_PANEL_PATH } from "./tabs";
import { WorkerMark } from "./avatar";
import { StatusDot } from "./status-dot";
import { DOT_NEUTRAL } from "./tone";
import { displayName, useWorkerForThread, workerStatus } from "./use-cos";

const CHIEF_LABEL = "Chief of Staff thread";

/**
 * A 28px glyph is what the host header is built from, and a finger needs 44px.
 * Growing the button and pulling the same amount back out with
 * a negative margin buys the tap target without moving the header: the painted
 * box keeps its own size, the hit area does not.
 */
const COARSE_POINTER_44_HIT_AREA =
  "max-md:pointer-coarse:size-11 max-md:pointer-coarse:-m-2";
/** Same trick over the host's 36px coarse icon button, so it lands on 44px too. */
const COARSE_POINTER_44_OVER_36 =
  "max-md:pointer-coarse:size-11 max-md:pointer-coarse:-m-1";

/**
 * The dot level for a worker's header mark. Only urgent and attention override
 * the run-state colour, and `StatusDot` already holds both of them still: a red
 * pulsing dot is an alarm, and the header is ambient.
 */
function headerUrgency(worker: WorkerStatus): Urgency | undefined {
  if (worker.urgency !== "urgent" && worker.urgency !== "attention") return undefined;
  return worker.urgency;
}

export function ThreadHeaderAction({ threadId }: PluginThreadHeaderActionProps) {
  useCosBridge();
  const navigate = useBbNavigate();
  const role = useWorkerForThread(threadId);
  const compact = useIsCompactViewport();
  const [adoptOpen, setAdoptOpen] = useState(false);

  if (role.data === null) return null;

  if (role.data.isChief) {
    if (compact) {
      return (
        <span
          role="img"
          aria-label={CHIEF_LABEL}
          title={CHIEF_LABEL}
          className={cn("mx-1.5 inline-block size-2 shrink-0 rounded-full", DOT_NEUTRAL)}
        />
      );
    }
    return <span className="px-1 text-xs text-muted-foreground">Chief</span>;
  }

  const worker = role.data.worker;
  if (worker !== null) {
    const urgency = headerUrgency(worker);
    if (compact) {
      const label = `Worker ${displayName(worker)} in ${worker.projectName}. Open Chief of Staff.`;
      return (
        // Button drops `title`, so the tooltip lives on the wrapper. Same
        // string as the accessible name, so the two never drift.
        <span title={label} className="inline-flex">
          <Button
            variant="ghost"
            size="sm"
            className={cn(COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS, COARSE_POINTER_44_OVER_36)}
            aria-label={label}
            onClick={() => navigate.toPluginPanel(CHIEF_PANEL_PATH)}
          >
            <span className="inline-flex items-center gap-1">
              <StatusDot status={workerStatus(worker)} urgency={urgency} />
              <WorkerMark avatar={worker.avatar} size={18} />
            </span>
          </Button>
        </span>
      );
    }
    // bb fixes this slot at the left end of the header's action row and caps it
    // at 28px tall: the status dot, a 22px avatar, then the worker's title as
    // plain text. The dot sits on the canvas, not on the face.
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-2 rounded-full pl-2 pr-2.5 text-xs font-normal"
        aria-label={`Worker ${displayName(worker)} in ${worker.projectName}. Open the Chief of Staff page.`}
        onClick={() => navigate.toPluginPanel(CHIEF_PANEL_PATH)}
      >
        <StatusDot status={workerStatus(worker)} urgency={urgency} />
        <WorkerMark avatar={worker.avatar} size={22} />
        <span className="max-w-[10rem] truncate">{displayName(worker)}</span>
      </Button>
    );
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        // Already icon-only at the host's own header size, so the glyph stays
        // as it is; only the touch hit area grows to 44px.
        className={cn(
          "h-7 w-7 p-0 text-muted-foreground hover:text-foreground",
          COARSE_POINTER_44_HIT_AREA,
        )}
        aria-label="Adopt as worker"
        onClick={() => setAdoptOpen(true)}
      >
        <Glyph name="adopt" aria-hidden className="size-4" />
      </Button>
      <AdoptDialog
        open={adoptOpen}
        onOpenChange={setAdoptOpen}
        threadId={threadId}
        onAdopted={role.refetch}
      />
    </>
  );
}
