// Jobs tab: what is running and waiting, then failures from the last day as
// one line each with Retry, then what finished, in time order, with older
// failures among it under a muted marker. One row is a 44 px thumbnail, the
// prompt on one line and a meta line; a running row carries a 2 px sweep along
// its bottom edge, which is the only motion on the surface. Idle shows the
// plugin's own hourglass drawing rather than a bare sentence.
//
// The age rule is now.ts's: an old failure drops into time order, so it never
// sits above work that has finished since.
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Asset } from "../../contract";
import { Art } from "./art";
import { jobCostText } from "./cost";
import { absoluteTime, elapsedLabel, estimateTail, firstLine, formatSeconds, kindAndSize, hasStill, mediaUrl, modelLabel, shortError, shortTime } from "./format";
import { Glyph } from "./glyphs";
import { EmptyState, FieldLabel, GhostButton, Hairline, PrimaryButton, Shimmer, Spinner, SweepStyle } from "./kit";
import { splitJobs } from "./now";
import { COMFY_PANEL_PATH, GENERATE_SUBPATH, assetSubPath } from "./tabs";
import { errorText, useComfyRpc, useJobs, useModelLabels, useNow, useOpenGenerateTab, usePreviewBase, useStatus } from "./use-comfy";
import type { PreviewBase } from "./use-comfy";

/** How many finished rows are worth keeping on this tab; the rest belong to the Library. */
const RECENT_SHOWN = 8;

/** A section title: the 10 px line, a hairline filling the row, then anything trailing. */
function SectionHead({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="flex h-7 items-center gap-3">
      <FieldLabel className="shrink-0">{label}</FieldLabel>
      <Hairline className="min-w-0 flex-1" />
      {children}
    </div>
  );
}

export function JobsTab() {
  const rpc = useComfyRpc();
  const navigate = useBbNavigate();
  const jobs = useJobs();
  const status = useStatus();
  const preview = usePreviewBase();
  const openGenerate = useOpenGenerateTab();
  // Names every model in the registry, not just the ten in the contract tables.
  useModelLabels();
  const active = jobs.data?.active ?? [];
  const recent = jobs.data?.recent ?? [];
  const anyActive = active.some((row) => row.status === "running" || row.status === "queued");
  // Every second while something runs; every half minute otherwise, which is
  // what moves a day old failure down into Finished without a reload.
  const now = useNow(true, anyActive ? 1000 : 30_000);
  const minute = Math.floor(now / 60_000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const split = useMemo(() => splitJobs(active, recent, now, RECENT_SHOWN), [active, recent, minute]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const failed = split.allFailed;
  const nowRows = [...split.working, ...split.failed];
  // Clear failed takes every failure, old and new, so it sits once: with the
  // fresh ones in Now when there are any, else with the old ones in Finished.
  const clearInNow = split.failed.length > 0;
  const clearButton =
    failed.length === 0 ? null : (
      <GhostButton className="shrink-0" disabled={clearing} onClick={() => void clearFailed()} title="Delete every failed row">
        {clearing ? <Spinner /> : <Glyph.trash className="size-3.5" />}
        Clear failed
      </GhostButton>
    );

  const refresh = () => {
    jobs.refetch();
    status.refetch();
  };

  const act = async (asset: Asset, job: () => Promise<unknown>, done: string) => {
    setBusyId(asset.id);
    try {
      await job();
      toast.success(done);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusyId(null);
      refresh();
    }
  };

  const clearFailed = async () => {
    setClearing(true);
    let removed = 0;
    try {
      for (const row of failed) {
        await rpc.call("asset_delete", { id: row.id });
        removed += 1;
      }
      toast.success(removed === 1 ? "Removed 1 failed job" : `Removed ${removed} failed jobs`);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setClearing(false);
      refresh();
    }
  };

  const open = (asset: Asset) => {
    navigate.toPluginPanel(COMFY_PANEL_PATH, { subPath: assetSubPath(asset.id), replace: true });
  };

  const generate = () => {
    if (!openGenerate()) navigate.toPluginPanel(COMFY_PANEL_PATH, { subPath: GENERATE_SUBPATH, replace: true });
  };

  if (jobs.data === null) {
    if (jobs.error !== null) {
      return (
        <EmptyState
          glyph="alert"
          title="Could not load the jobs"
          action={
            <GhostButton onClick={jobs.refetch}>
              <Glyph.refresh className="size-3.5" />
              Try again
            </GhostButton>
          }
        >
          <p className="break-words [overflow-wrap:anywhere]">{jobs.error}</p>
        </EmptyState>
      );
    }
    return (
      <div className="space-y-2" aria-hidden>
        {[0, 1, 2].map((row) => (
          <Shimmer key={row} className="h-14" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SweepStyle />

      {nowRows.length === 0 ? (
        // Still a section, with the same head as Finished: the two halves of
        // this tab keep the same shape whether or not anything is running.
        // This is the one empty state with nothing else to carry it, so the
        // drawing gets a real box (144 px) and enough ink to stay above 3:1
        // against a near white surface.
        <section>
          <SectionHead label="Now" />
          <EmptyState
            art={<Art name="idle-jobs" className="h-36 w-24 text-muted-foreground/70" />}
            title="Nothing waiting"
            className="px-4 py-5"
            action={
              <PrimaryButton glyph="spark" onClick={generate}>
                Generate something
              </PrimaryButton>
            }
          >
            <p>Waiting and running generations show up here while they are happening, and failures for a day after.</p>
          </EmptyState>
        </section>
      ) : (
        <section>
          <SectionHead label="Now">{clearInNow ? clearButton : null}</SectionHead>
          <ul className="divide-y divide-border/60">
            {split.working.map((asset) => (
              <JobRow key={asset.id} asset={asset} preview={preview.data} now={now} busy={busyId === asset.id} onOpen={open}>
                <GhostButton disabled={busyId === asset.id} onClick={() => void act(asset, () => rpc.call("asset_cancel", { id: asset.id }), "Cancelled")}>
                  Cancel
                </GhostButton>
              </JobRow>
            ))}
            {split.failed.map((asset) => (
              <FailedRow
                key={asset.id}
                asset={asset}
                now={now}
                busy={busyId === asset.id}
                onOpen={open}
                onRetry={() => void act(asset, () => rpc.call("asset_retry", { id: asset.id }), "Queued again")}
              />
            ))}
          </ul>
        </section>
      )}

      {split.finished.length === 0 ? null : (
        <section>
          <SectionHead label="Finished">{clearInNow ? null : clearButton}</SectionHead>
          <ul className="divide-y divide-border/60">
            {split.finished.map((asset) => (
              <JobRow key={asset.id} asset={asset} preview={preview.data} now={now} busy={busyId === asset.id} onOpen={open} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * A failure from the last day: one line, the friendly sentence the server
 * stored (comfy.ts `friendlyError`), and Retry. The whole error is one tap away
 * in the Viewer, and on the row's title for a pointer.
 */
function FailedRow({ asset, now, busy, onOpen, onRetry }: { asset: Asset; now: number; busy: boolean; onOpen: (asset: Asset) => void; onRetry: () => void }) {
  const reason = shortError(asset.error) || "Comfy Cloud reported an error";
  return (
    <li className={cn("@container relative", busy && "opacity-60")} data-failed-row>
      <div className="flex min-w-0 items-center gap-2.5 py-2">
        <button
          type="button"
          onClick={() => onOpen(asset)}
          title={`${firstLine(asset.prompt, 120)}\n${asset.error ?? ""}`}
          aria-label={`Failed: ${firstLine(asset.prompt, 80) || asset.id}. ${reason}`}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:min-h-11"
        >
          <span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-destructive/5 ring-1 ring-destructive/30">
            <Glyph.alert className="size-4 text-destructive" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] leading-5 text-foreground">{reason}</span>
            <span className="block truncate text-[11px] leading-4 text-muted-foreground">
              {modelLabel(asset.model)} · {firstLine(asset.prompt, 80) || asset.id}
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <GhostButton disabled={busy} onClick={onRetry}>
            <Glyph.refresh className="size-3.5" />
            Retry
          </GhostButton>
          <span className="hidden w-12 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground @[22rem]:inline" title={absoluteTime(asset.completedAt ?? asset.createdAt)}>
            {shortTime(asset.completedAt ?? asset.createdAt, now)}
          </span>
        </div>
      </div>
    </li>
  );
}

/** The picture on a row: the file once it exists, otherwise what the row is doing. */
function Thumb({ asset, preview, className }: { asset: Asset; preview: PreviewBase | null; className?: string }) {
  const url = asset.status === "completed" ? mediaUrl(preview, asset, "thumb") : null;
  return (
    <span className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/40 ring-1 ring-border/60", className)}>
      {url !== null ? (
        // A video row with a poster frame draws the still: the thumb is a webp,
        // which a <video> element cannot show.
        asset.kind === "video" && !hasStill(asset) ? (
          <video src={url} muted playsInline preload="metadata" className="size-full object-cover" aria-hidden />
        ) : (
          <img src={url} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
        )
      ) : asset.status === "failed" ? (
        <Glyph.alert className="size-4 text-muted-foreground" />
      ) : asset.status === "running" || asset.status === "unknown" ? (
        <Spinner className="text-muted-foreground" />
      ) : asset.status === "queued" ? (
        <Art name="idle-jobs" className="h-5 w-3.5 text-muted-foreground/70" />
      ) : asset.kind === "video" ? (
        <Glyph.video className="size-3.5 text-muted-foreground" />
      ) : (
        <Glyph.image className="size-3.5 text-muted-foreground" />
      )}
    </span>
  );
}

/**
 * The separator in front of a meta part. Its class says at which row widths it
 * shows, which is wherever something visible stands before its part.
 */
function Dot({ className }: { className: string }) {
  return (
    <span aria-hidden className={cn("mx-1.5 text-muted-foreground/50", className)}>
      &middot;
    </span>
  );
}

interface JobRowProps {
  asset: Asset;
  preview: PreviewBase | null;
  now: number;
  busy: boolean;
  onOpen: (asset: Asset) => void;
  children?: ReactNode;
}

function JobRow({ asset, preview, now, busy, onOpen, children }: JobRowProps) {
  const running = asset.status === "running";
  // A failure old enough to sit in Finished says so quietly: it is history now.
  const state =
    asset.status === "queued"
      ? "Waiting"
      : asset.status === "failed"
        ? "Failed"
        : asset.status === "cancelled"
          ? "Cancelled"
          : asset.status === "unknown"
            ? "Not known yet"
            : null;
  // A queued row has nothing to count yet, and its estimate would push the meta
  // line onto a second row, so it waits until the row is actually running.
  const time = running
    ? elapsedLabel(asset, now)
    : asset.status === "completed" && asset.startedAt !== null && asset.completedAt !== null
      ? `took ${formatSeconds(Math.max(0, Math.round((asset.completedAt - asset.startedAt) / 1000)))}`
      : "";
  // "of about 20 to 40 s" doubles the width of the time part, so it waits for a
  // row wide enough to hold it next to a Cancel button.
  const tail = running ? estimateTail(asset) : "";
  // The estimate while it runs, the billed figure once it is finished. Same
  // words as the Generate button and the viewer's COST cell.
  const cost = jobCostText(asset);
  return (
    <li className={cn("@container relative", busy && "opacity-60")}>
      <div className="flex min-w-0 items-start gap-2.5 py-2.5">
        <button
          type="button"
          onClick={() => onOpen(asset)}
          aria-label={`Open ${asset.id}`}
          className="cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Thumb asset={asset} preview={preview} className="size-11" />
        </button>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => onOpen(asset)}
            // 20 px of text; on a finger 12 px of padding bleeds above and
            // below it, so the target is 44 px without moving the meta line.
            className="relative block w-full min-w-0 cursor-pointer truncate text-left text-[12px] leading-5 text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:-my-3 max-md:pointer-coarse:py-3"
            title={asset.prompt}
          >
            {firstLine(asset.prompt, 120) || asset.id}
          </button>
          {/* One line, always, and never cut mid word: every part but the kind
              and size is shrink-0, and parts step out whole as the row
              narrows. The kind and size go first below 26rem (the 44 px
              picture already says image or video), then the model, then the
              cost below 20rem. Each part carries its own leading dot, shown at
              exactly the widths where something visible stands before it, so
              a part stepping out never leaves a stray separator. */}
          <p className="flex min-w-0 items-center overflow-hidden text-[11px] leading-4 text-muted-foreground">
            {state === null ? null : (
              <span
                className={cn("shrink-0 font-medium", asset.status === "queued" || asset.status === "unknown" ? "text-foreground" : "text-muted-foreground")}
                title={asset.status === "unknown" ? (asset.error ?? undefined) : undefined}
              >
                {state}
              </span>
            )}
            <span className="hidden min-w-0 truncate @[26rem]:inline">
              <Dot className={state === null ? "hidden" : "inline"} />
              {kindAndSize(asset)}
            </span>
            {cost === null ? null : (
              <span className="hidden shrink-0 tabular-nums @[20rem]:inline">
                <Dot className={state === null ? "hidden @[26rem]:inline" : "inline"} />
                {cost}
              </span>
            )}
            <span className={cn("hidden shrink-0", children === undefined ? "@[32rem]:inline" : "@[40rem]:inline")}>
              <Dot className="inline" />
              {modelLabel(asset.model)}
            </span>
            {time === "" ? null : (
              <span className="shrink-0 tabular-nums">
                <Dot className={state !== null ? "inline" : cost === null ? "hidden @[26rem]:inline" : "hidden @[20rem]:inline"} />
                {time}
                {tail === "" ? null : <span className="hidden @[26rem]:inline">{tail}</span>}
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {children}
          <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground" title={absoluteTime(asset.createdAt)}>
            {shortTime(asset.createdAt, now)}
          </span>
        </div>
      </div>
      {running ? (
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden rounded-full bg-border/50">
          <span className="comfy-sweep block h-full w-1/3 rounded-full bg-foreground/50" />
        </span>
      ) : null}
    </li>
  );
}
