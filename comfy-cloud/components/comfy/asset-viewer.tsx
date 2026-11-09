// The Viewer: one asset large on a stage, prev and next over the current
// filtered list, a Media | Graph toggle, and a reading column where the prompt
// is the headline and every identifier is a footnote. Escape returns to the
// Library; ArrowLeft and ArrowRight move. The route owns the selection, so
// every move is a navigation the page turns into a new `id`.
//
// Two layouts from one component:
//
// - **Compact, a narrow touch screen.** A full bleed black stage at the top, the
//   picture's own aspect up to 70 percent of the body, under a slim overlay bar (back,
//   "5 of 40", and `...`). Tap the picture to hide or show the bar; swipe to
//   move; double tap or pinch to zoom. The prompt, the four actions (two by
//   two, 44 px) and the spec strip are one scroll under it, and everything else
//   is in the `...` sheet.
// - **Wider.** The stage beside or above the reading column, with
//   the header's glyph buttons and the hover prev and next strips. Swipe and
//   zoom work there too, with a mouse wheel plus ctrl or a trackpad pinch.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Asset, Workflow } from "../../contract";
import { ActionSheet } from "./action-sheet";
import type { SheetAction } from "./action-sheet";
import { billedAsText, costCell, costSentence } from "./cost";
import { DeleteAssetDialog } from "./delete-dialog";
import {
  absoluteTime,
  aspectOf,
  elapsedSeconds,
  estimateFor,
  estimateLabel,
  fileName,
  firstLine,
  formatBytes,
  formatSeconds,
  hasAudio,
  fitBox,
  hasStill,
  kindAndSize,
  mediaUrl,
  modelLabel,
  pixelSize,
  seedOf,
  viewPixels,
  shortAbsoluteTime,
  shortError,
  sizeChip,
} from "./format";
import { familyOf } from "./gallery-layout";
import { VIDEO_CONTROLS_PX } from "./gestures";
import { Glyph } from "./glyphs";
import { workflowClassTypes } from "./graph-layout";
import { BAR, CopyButton, Disclosure, EmptyNote, FieldLabel, GhostButton, LABEL_CLASS, PrimaryButton, Segmented, Shimmer, copyText, ghostButtonClass } from "./kit";
import { HEADER_DESTRUCTIVE_MARGIN, HEADER_DIVIDER, HEADER_GAP } from "./touch-geometry";
import { StatusPill } from "./signals";
import {
  errorText,
  requestReference,
  requestTweak,
  useAssetDetail,
  useComfyRpc,
  useCompact,
  useElementSize,
  useNodeCatalog,
  useNow,
  useOpenGenerateTab,
  useReducedMotion,
  useStatus,
} from "./use-comfy";
import type { PreviewBase } from "./use-comfy";
import { ProgressiveImage, StageNote, ViewerStage } from "./viewer-stage";
import { WorkflowGraph } from "./workflow-graph";

/**
 * Below this the reading column moves under the stage. Side by side only pays
 * off once the stage is clearly wider than the 320 px column, so the picture
 * stays the loudest thing on screen.
 */
const NARROW_PX = 820;
/**
 * Below this the header bar drops the word "Library" and keeps only the glyph,
 * so "Library", the position, the Media/Graph switch and the three ghost
 * buttons still fit on one line of the 40 px bar.
 */
const TIGHT_PX = 380;
/**
 * Stacked, the stage hugs the media: the picture's own height plus a little
 * air, floored at MEDIA_MIN_PX and capped at MEDIA_MAX_SHARE of the body.
 * A square or a portrait asset fills most of the body, and a wide image gets
 * a stage its own height, so the media is the whole stage at every aspect
 * rather than a band above empty grey.
 */
const MEDIA_MIN_PX = 200;
const MEDIA_PAD_PX = 12;
const MEDIA_MAX_SHARE = 0.72;
/**
 * The phone's stage: full bleed, no air, the picture's own aspect up to 70
 * percent of the body, so the prompt under it always peeks into view and says
 * there is more to scroll to.
 */
const PHONE_MEDIA_MAX_SHARE = 0.7;
const PHONE_MEDIA_MIN_PX = 240;
/** The graph needs room to be worth looking at. */
const GRAPH_MIN_PX = 560;
const GRAPH_SHARE = 0.55;

const VIEW_OPTIONS = [
  { id: "media", label: "Media" },
  { id: "graph", label: "Graph" },
] as const;

const NO_WORKFLOW: Workflow = {};

const SOURCE_TEXT: Record<string, string> = { panel: "the panel", cli: "the CLI", tool: "a thread", unknown: "somewhere else" };

export interface AssetViewerProps {
  id: string;
  /** The current filtered list; prev/next walk it. */
  assets: readonly Asset[];
  preview: PreviewBase | null;
  onClose: () => void;
  onSelect: (id: string) => void;
  /** Something changed on the server; the page refetches its lists. */
  onChanged: () => void;
}

function isEditable(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/** The overlay bar's glyph buttons: 44 px, white on the black stage whatever the theme. */
const OVERLAY_BUTTON = "inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-md text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70";

export function AssetViewer({ id, assets, preview, onClose, onSelect, onChanged }: AssetViewerProps) {
  const rpc = useComfyRpc();
  const detail = useAssetDetail(id);
  const openGenerate = useOpenGenerateTab();
  const compact = useCompact();
  const reducedMotion = useReducedMotion();
  const [rootRef, size] = useElementSize<HTMLDivElement>();
  const [stageRef, stage] = useElementSize<HTMLDivElement>();
  const narrow = compact || (size.width > 0 && size.width < NARROW_PX);
  const tight = size.width > 0 && size.width < TIGHT_PX;

  const [view, setView] = useState<"media" | "graph">("media");
  const [busy, setBusy] = useState(false);
  const [jsonRequest, setJsonRequest] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<Asset | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [fullRes, setFullRes] = useState(false);
  /** Where the graph's node form goes on the wide layout: the reading column. */
  const [graphPanel, setGraphPanel] = useState<HTMLDivElement | null>(null);

  const fromList = useMemo(() => assets.find((asset) => asset.id === id) ?? null, [assets, id]);
  const asset: Asset | null = detail.data?.asset ?? fromList;
  // The detail poll returns an equal but brand new workflow object every 15 s.
  // Hold a stable reference keyed on the content so the graph's draft survives.
  const fetched = detail.data?.workflow ?? null;
  const workflowKey = useMemo(() => (fetched === null ? null : JSON.stringify(fetched)), [fetched]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const workflow = useMemo(() => fetched, [workflowKey]);
  const catalog = useNodeCatalog(useMemo(() => workflowClassTypes(workflow ?? NO_WORKFLOW), [workflow]));
  const family = useMemo(() => familyOf(assets, id), [assets, id]);

  const index = assets.findIndex((row) => row.id === id);
  const prev = index > 0 ? (assets[index - 1] ?? null) : null;
  const next = index >= 0 && index < assets.length - 1 ? (assets[index + 1] ?? null) : null;
  const prevId = prev?.id ?? null;
  const nextId = next?.id ?? null;

  const active = asset !== null && (asset.status === "running" || asset.status === "queued");
  const now = useNow(active);

  // A new asset starts on the media view, with the chrome up, on its view copy.
  useEffect(() => {
    setView("media");
    setDeleteTarget(null);
    setSheetOpen(false);
    setChrome(true);
    setFullRes(false);
  }, [id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditable(event.target)) return;
      if (event.key === "Escape") {
        // The delete dialog and the sheet own Escape while they are open.
        if (deleteTarget !== null || sheetOpen) return;
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowLeft" && prevId !== null) {
        event.preventDefault();
        onSelect(prevId);
      } else if (event.key === "ArrowRight" && nextId !== null) {
        event.preventDefault();
        onSelect(nextId);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [deleteTarget, sheetOpen, nextId, onClose, onSelect, prevId]);

  // Warm the neighbours so flipping feels instant: the same view copy the stage
  // will settle on, never the original, so opening one image does not cost
  // three originals.
  useEffect(() => {
    if (typeof Image === "undefined") return;
    for (const neighbour of [prev, next]) {
      if (neighbour === null || neighbour.kind !== "image" || neighbour.file === null || neighbour.status !== "completed") continue;
      const warmed = mediaUrl(preview, neighbour, "view");
      if (warmed === null) continue;
      const image = new Image();
      image.src = warmed;
    }
  }, [prev, next, preview]);

  // The stage settles on the 2048 px view copy; the thumbnail, which the grid
  // has usually just loaded, fills the frame while it is in flight. The
  // original is fetched only by Download, or by Full resolution on request.
  const isImage = asset !== null && asset.kind === "image";
  const viewUrl = asset !== null && asset.file !== null ? mediaUrl(preview, asset, "view") : null;
  const originalUrl = asset !== null && asset.file !== null ? mediaUrl(preview, asset, "file") : null;
  const url = fullRes && isImage && originalUrl !== null ? originalUrl : viewUrl;
  const placeholder = asset !== null && asset.file !== null && isImage ? mediaUrl(preview, asset, "thumb") : null;
  const poster = asset !== null && asset.kind === "video" && hasStill(asset) ? mediaUrl(preview, asset, "thumb") : null;
  const downloadUrl = asset !== null && asset.file !== null ? mediaUrl(preview, asset, "file", { download: true }) : null;
  const pixels = asset === null ? null : pixelSize(asset);
  // The drawn box is the same for every copy, so nothing moves when the view
  // copy or the original replaces the thumbnail. It is fitted from the view
  // copy's pixels on the light stage (never an upscale), and from the aspect
  // alone on the phone's full bleed stage, where the picture fills the width.
  const drawnBox =
    asset === null || asset.kind !== "image"
      ? null
      : compact
        ? fitBox(pixels, stage, { enlarge: true })
        : fitBox(viewPixels(asset), stage);
  // The original is only worth offering when it is a different file from the
  // one on screen; the sheet row says its pixels and bytes so the cost is plain.
  const canFullRes = isImage && asset?.status === "completed" && originalUrl !== null && originalUrl !== viewUrl;

  // Stacked: the stage is the media's own height plus a little air, so there
  // is never a band of empty grey under a wide picture. The graph gets a band
  // worth panning in instead. On the phone the stage is full bleed and has no air.
  const bodyHeight = size.height > 0 ? size.height : 0;
  const stackedGraphHeight = Math.max(GRAPH_MIN_PX, Math.round(bodyHeight * GRAPH_SHARE));
  const stackedMediaHeight =
    !narrow || asset === null
      ? undefined
      : compact
        ? Math.round(Math.min(Math.max(size.width / aspectOf(asset), PHONE_MEDIA_MIN_PX), Math.max(PHONE_MEDIA_MIN_PX, bodyHeight * PHONE_MEDIA_MAX_SHARE)))
        : Math.round(Math.min(Math.max(size.width / aspectOf(asset) + MEDIA_PAD_PX * 2, MEDIA_MIN_PX), Math.max(MEDIA_MIN_PX, bodyHeight * MEDIA_MAX_SHARE)));

  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    try {
      await job();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const regenerate = () =>
    run(async () => {
      const result = await rpc.call("asset_retry", { id, newSeed: true });
      toast.success(`Queued ${result.asset.id} with a new seed`);
      onChanged();
      onSelect(result.asset.id);
    });

  const tweak = () => {
    if (asset === null) return;
    requestTweak({ kind: asset.kind, prompt: asset.prompt, model: asset.model, params: asset.params, parentId: asset.id });
    if (openGenerate()) toast.success("Generate tab prefilled");
    else toast("Generate tab prefilled", { description: "Open the Generate tab in the side panel to continue." });
  };

  const useAsReference = () => {
    if (asset === null) return;
    requestReference(asset);
    if (openGenerate()) toast.success("Added as a reference");
    else toast("Added as a reference", { description: "Open the Generate tab in the side panel to continue." });
  };

  const editWorkflow = () => {
    if (workflow === null) {
      toast.error("The workflow has not loaded yet");
      return;
    }
    setView("graph");
    setJsonRequest((count) => count + 1);
  };

  const runTweaked = (graph: Workflow) =>
    run(async () => {
      const result = await rpc.call("run_workflow", { workflow: graph, kind: asset?.kind ?? "auto", parentId: id, source: "panel" });
      toast.success(`Queued ${result.asset.id} from the tweaked workflow`);
      onChanged();
      onSelect(result.asset.id);
    });

  const star = () =>
    run(async () => {
      if (asset === null) return;
      await rpc.call("asset_star", { id, starred: !asset.starred });
      toast.success(asset.starred ? "Star removed" : "Starred");
      detail.refetch();
      onChanged();
    });

  const remove = (target: Asset) =>
    run(async () => {
      const result = await rpc.call("asset_delete", { id: target.id });
      if (result.ok) toast.success(result.text);
      else toast.error(result.text);
      onChanged();
      onClose();
    });

  const estimate = asset === null ? null : estimateLabel(estimateFor(asset));
  const toggleChrome = useCallback(() => {
    if (compact) setChrome((shown) => !shown);
  }, [compact]);

  // A video is centred on the stage and its native controls live along its own
  // bottom edge, so the step strips have to stop above that line rather than at
  // a fixed offset from the stage. The rendered box follows from the aspect.
  const stepBottom =
    asset === null || asset.kind !== "video" || stage.height === 0 || stage.width === 0
      ? 0
      : Math.round((stage.height - Math.min(stage.height, stage.width / aspectOf(asset))) / 2) + VIDEO_CONTROLS_PX;

  // What the phone's `...` sheet holds, in order. Delete is apart.
  const sheetActions: SheetAction[] =
    asset === null
      ? []
      : [
          { id: "star", label: asset.starred ? "Remove the star" : "Star", glyph: asset.starred ? "starFilled" : "star", pressed: asset.starred, disabled: busy, onSelect: () => void star() },
          ...(asset.prompt === "" ? [] : [{ id: "copy", label: "Copy prompt", glyph: "copy" as const, onSelect: () => void copyText(asset.prompt, "Prompt copied") }]),
          ...(canFullRes
            ? [
                {
                  id: "full",
                  label: fullRes ? "Back to the view copy" : "Full resolution",
                  glyph: "zoom" as const,
                  hint: fullRes ? undefined : [pixels === null ? null : `${pixels.width}x${pixels.height}`, asset.sizeBytes === null ? null : formatBytes(asset.sizeBytes)].filter((part) => part !== null).join(", "),
                  onSelect: () => setFullRes((value) => !value),
                },
              ]
            : []),
          { id: "graph", label: view === "graph" ? "Show the picture" : "Show the graph", glyph: view === "graph" ? "image" : "nodes", onSelect: () => setView(view === "graph" ? "media" : "graph") },
          { id: "workflow", label: "Edit workflow", glyph: "braces", disabled: busy || workflow === null, onSelect: editWorkflow },
        ];
  const sheetDelete: SheetAction | undefined =
    asset === null ? undefined : { id: "delete", label: "Delete", glyph: "trash", disabled: busy, onSelect: () => setDeleteTarget(asset) };

  const phoneStage = compact && view === "media";
  const overlay = compact && view === "media";

  return (
    <div ref={rootRef} className="flex h-full min-h-0 w-full min-w-0 flex-col bg-background">
      {overlay ? null : (
        <div className={cn(BAR, "gap-1 max-md:pointer-coarse:h-auto max-md:pointer-coarse:min-h-10 max-md:pointer-coarse:py-1")}>
          <GhostButton className="-ml-2" iconOnly={tight || compact} onClick={onClose} ariaLabel="Back to the Library (Escape)" title="Back to the Library (Escape)">
            <Glyph.back className="size-3.5 max-md:pointer-coarse:size-5" />
            {tight || compact ? null : "Library"}
          </GhostButton>
          <span aria-live="polite" className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">
            {index === -1 ? "" : `${index + 1} of ${assets.length}`}
          </span>
          {/* The switch belongs to the stage, so it sits with the position rather
              than centring itself in whatever space the two button groups leave;
              centred in the leftover space it lands off both the stage centre and
              the panel centre. */}
          <Segmented className="ml-1" ariaLabel="View" options={VIEW_OPTIONS} value={view} onSelect={(chosen) => setView(chosen === "graph" ? "graph" : "media")} />
          <div className="min-w-0 flex-1" />
          {asset === null ? null : compact ? (
            <GhostButton iconOnly className="-mr-2" ariaLabel="More actions" title="More actions" onClick={() => setSheetOpen(true)}>
              <Glyph.more className="size-5" />
            </GhostButton>
          ) : (
            <div className={cn("flex shrink-0 items-center", HEADER_GAP.class)}>
              <GhostButton
                iconOnly
                ariaLabel={asset.starred ? "Remove star" : "Star"}
                ariaPressed={asset.starred}
                title={asset.starred ? "Remove the star" : "Star this one"}
                disabled={busy}
                className={cn(asset.starred && "text-foreground")}
                onClick={() => void star()}
              >
                {asset.starred ? <Glyph.starFilled className="size-3.5 max-md:pointer-coarse:size-5" /> : <Glyph.star className="size-3.5 max-md:pointer-coarse:size-5" />}
              </GhostButton>
              {downloadUrl === null ? (
                <GhostButton iconOnly ariaLabel="Download" disabled>
                  <Glyph.download className="size-3.5 max-md:pointer-coarse:size-5" />
                </GhostButton>
              ) : (
                <a href={downloadUrl} download={fileName(asset.file ?? asset.id)} aria-label="Download" title="Download the original at full resolution" className={cn(ghostButtonClass({ iconOnly: true }), "max-md:pointer-coarse:flex max-md:pointer-coarse:h-11 max-md:pointer-coarse:w-11 max-md:pointer-coarse:items-center max-md:pointer-coarse:justify-center")}>
                  <Glyph.download className="size-3.5 max-md:pointer-coarse:size-5" />
                </a>
              )}
              {/* The hairline and Delete's own margin are what put 21px of clear
                  air between Download and Delete on a finger. touch-geometry.ts
                  holds that arithmetic and the test fails if it ever falls to
                  the 12px floor. */}
              <span aria-hidden className={cn("hidden h-6 w-px bg-border/60 max-md:pointer-coarse:block", HEADER_DIVIDER.class)} />
              <GhostButton iconOnly danger className={cn("-mr-2", HEADER_DESTRUCTIVE_MARGIN.class)} ariaLabel="Delete" title="Delete this one" disabled={busy} onClick={() => setDeleteTarget(asset)}>
                <Glyph.trash className="size-3.5 max-md:pointer-coarse:size-5" />
              </GhostButton>
            </div>
          )}
        </div>
      )}

      <div className={cn("flex min-h-0 flex-1", narrow ? "flex-col overflow-auto overscroll-y-contain" : "flex-row")}>
        <div
          ref={stageRef}
          data-stage
          style={!narrow ? undefined : view === "graph" ? { minHeight: stackedGraphHeight } : { height: stackedMediaHeight }}
          className={cn(
            "relative flex min-w-0 overflow-hidden",
            view === "graph" ? "items-stretch bg-background" : phoneStage ? "bg-black" : "items-center justify-center bg-muted/40",
            narrow && view === "media" && !phoneStage && "border-b border-border/60",
            // Stacked, the graph grows with its form; everything else keeps the height it was given.
            narrow ? (view === "graph" ? "shrink-0" : "min-h-0 shrink-0") : "min-h-0 flex-1",
          )}
        >
          {asset === null ? (
            detail.loading ? (
              <Shimmer className="m-auto size-2/3" />
            ) : (
              <div className={cn("m-auto", phoneStage && "rounded-md bg-background")}>
                <EmptyNote icon="alert" title="This asset is not in the Library any more" hint={detail.error ?? undefined}>
                  <GhostButton onClick={onClose}>Back to the Library</GhostButton>
                </EmptyNote>
              </div>
            )
          ) : view === "graph" ? (
            workflow === null ? (
              <p className="m-auto text-[12px] text-muted-foreground">{detail.error ?? "Loading the workflow"}</p>
            ) : (
              <WorkflowGraph
                workflow={workflow}
                catalog={catalog.data}
                onRun={runTweaked}
                busy={busy}
                jsonRequest={jsonRequest}
                panelContainer={narrow ? null : graphPanel}
                stacked={narrow}
                className={narrow ? "w-full" : "absolute inset-0 bg-background"}
              />
            )
          ) : (
            <ViewerStage
              asset={asset}
              prev={prev}
              next={next}
              preview={preview}
              content={drawnBox}
              zoomable={isImage && asset.status === "completed" && url !== null}
              dark={phoneStage}
              reducedMotion={reducedMotion}
              onSelect={onSelect}
              onTap={toggleChrome}
            >
              <Media
                key={asset.id}
                asset={asset}
                url={url}
                fullLabel={fullRes ? "the original" : "the larger copy"}
                placeholder={placeholder}
                poster={poster}
                box={drawnBox}
                now={now}
                dark={phoneStage}
                reducedMotion={reducedMotion}
              />
            </ViewerStage>
          )}
          {view === "media" && asset !== null && !compact ? (
            <>
              <StepEdge side="left" targetId={prevId} insetBottom={stepBottom} onSelect={onSelect} />
              <StepEdge side="right" targetId={nextId} insetBottom={stepBottom} onSelect={onSelect} />
            </>
          ) : null}
          {overlay ? (
            <OverlayBar
              shown={chrome}
              position={index === -1 ? "" : `${index + 1} of ${assets.length}`}
              hasAsset={asset !== null}
              onBack={onClose}
              onMore={() => setSheetOpen(true)}
            />
          ) : null}
          {fullRes && view === "media" ? <StageNote>Full resolution</StageNote> : null}
        </div>

        {asset === null ? null : (
          <aside className={cn("@container min-w-0 p-3", narrow ? "shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]" : "w-80 shrink-0 overflow-auto border-l border-border/60")}>
            <PromptBlock asset={asset} width={size.width} />

            <ActionRow
              asset={asset}
              compact={compact}
              busy={busy}
              estimate={estimate}
              downloadUrl={downloadUrl}
              workflowReady={workflow !== null}
              fullRes={canFullRes ? fullRes : null}
              onRegenerate={() => void regenerate()}
              onTweak={tweak}
              onReference={useAsReference}
              onEditWorkflow={editWorkflow}
              onFullRes={() => setFullRes((value) => !value)}
            />

            {/* The graph's node form and Run bar land here on the wide layout. */}
            <div ref={setGraphPanel} className={cn("mt-4", (narrow || view !== "graph") && "hidden")} />

            {asset.error === null ? null : (
              <div className="mt-4 rounded-md border border-destructive/40 p-2.5">
                <p className={cn(LABEL_CLASS, "text-destructive")}>Generation failed</p>
                <p className="mt-1 select-text break-words text-[11px] leading-4 text-foreground [overflow-wrap:anywhere]">{asset.error}</p>
              </div>
            )}

            <SpecStrip asset={asset} />

            <div className="mt-4 border-t border-border/60 pt-1">
              <Disclosure className="-mx-1" label="Details" meta={asset.id}>
                <DetailList asset={asset} now={now} />
              </Disclosure>
            </div>

            {family.length > 1 ? (
              <div className="mt-4">
                <FieldLabel>Variants</FieldLabel>
                <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1" role="list" aria-label="Variants">
                  {family.map((member) => (
                    <VariantThumb key={member.id} asset={member} preview={preview} current={member.id === id} onSelect={onSelect} />
                  ))}
                </div>
              </div>
            ) : null}
          </aside>
        )}
      </div>

      <ActionSheet
        open={sheetOpen && asset !== null}
        onOpenChange={setSheetOpen}
        title={asset === null ? "Actions" : asset.kind === "video" ? "This video" : "This image"}
        description={asset === null ? undefined : firstLine(asset.prompt, 60) || asset.id}
        actions={sheetActions}
        destructive={sheetDelete}
      />

      <DeleteAssetDialog
        asset={deleteTarget}
        preview={preview}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onConfirm={(target) => void remove(target)}
      />
    </div>
  );
}

/**
 * The phone's header, laid over the top of the black stage: back, the position
 * and `...`, over a soft scrim so white glyphs read on a white picture. A tap
 * on the picture hides it and another brings it back; hidden, it takes no
 * taps, so the picture is the whole screen.
 */
function OverlayBar({ shown, position, hasAsset, onBack, onMore }: { shown: boolean; position: string; hasAsset: boolean; onBack: () => void; onMore: () => void }) {
  return (
    <div
      data-overlay-bar
      aria-hidden={!shown}
      className={cn(
        "absolute inset-x-0 top-0 z-20 flex h-14 items-start gap-1 bg-gradient-to-b from-black/60 to-transparent px-1 pt-1",
        "transition-opacity duration-150 motion-reduce:transition-none",
        shown ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <button type="button" tabIndex={shown ? 0 : -1} aria-label="Back to the Library (Escape)" onClick={onBack} className={OVERLAY_BUTTON}>
        <Glyph.back className="size-5" />
      </button>
      <span aria-live="polite" className="flex h-11 min-w-0 flex-1 items-center justify-center whitespace-nowrap text-[12px] font-medium tabular-nums text-white">
        {position}
      </span>
      {hasAsset ? (
        <button type="button" tabIndex={shown ? 0 : -1} aria-label="More actions" onClick={onMore} className={OVERLAY_BUTTON}>
          <Glyph.more className="size-5" />
        </button>
      ) : (
        <span className="size-11 shrink-0" aria-hidden />
      )}
    </div>
  );
}

/**
 * The four things a result is for: Regenerate (the one filled button, with the
 * estimate inside), Tweak, Use as reference and Download. Two by two at 44 px
 * on a phone. A wider screen keeps Download, Star and Delete in the header, so
 * its row carries Edit workflow and Full resolution instead, which the phone
 * keeps in its sheet.
 */
function ActionRow({
  asset,
  compact,
  busy,
  estimate,
  downloadUrl,
  workflowReady,
  fullRes,
  onRegenerate,
  onTweak,
  onReference,
  onEditWorkflow,
  onFullRes,
}: {
  asset: Asset;
  compact: boolean;
  busy: boolean;
  estimate: string | null;
  downloadUrl: string | null;
  workflowReady: boolean;
  /** Null when the original is not a different file; otherwise whether it is on screen. */
  fullRes: boolean | null;
  onRegenerate: () => void;
  onTweak: () => void;
  onReference: () => void;
  onEditWorkflow: () => void;
  onFullRes: () => void;
}) {
  // A reference has to be a picture that exists; the server says the same.
  const canReference = asset.kind === "image" && asset.status === "completed" && asset.file !== null;
  // On a phone every cell is 44 px whatever the pointer, and the secondary
  // actions carry a hairline so the grid reads as four buttons, not two words.
  const cell = compact ? "h-11 w-full justify-start border border-border/60 px-3" : undefined;
  const glyph = "size-3.5 shrink-0 max-md:pointer-coarse:size-5";
  const reference = (
    <GhostButton
      disabled={busy || !canReference}
      onClick={onReference}
      title={canReference ? "Open the Generate tab with this image attached as a reference" : "Only a finished image can be a reference"}
      className={cell}
    >
      <Glyph.reference className={glyph} />
      Use as reference
    </GhostButton>
  );
  const regenerate = (
    <PrimaryButton
      glyph="refresh"
      busy={busy}
      disabled={busy}
      meta={estimate ?? undefined}
      metaBelow={compact}
      title={`Run the same settings again with a new seed (${estimate ?? ""})`}
      className={compact ? "h-11 w-full" : undefined}
      onClick={onRegenerate}
    >
      Regenerate
    </PrimaryButton>
  );
  const tweak = (
    <GhostButton disabled={busy} onClick={onTweak} title="Open the Generate tab with these settings" className={cell}>
      <Glyph.sliders className={glyph} />
      Tweak
    </GhostButton>
  );
  if (compact) {
    return (
      <div className="mt-4 grid grid-cols-2 gap-2">
        {regenerate}
        {tweak}
        {reference}
        {downloadUrl === null ? (
          <GhostButton disabled className={cell}>
            <Glyph.download className={glyph} />
            Download
          </GhostButton>
        ) : (
          <a href={downloadUrl} download={fileName(asset.file ?? asset.id)} title="Download the original at full resolution" className={cn(ghostButtonClass(), cell)}>
            <Glyph.download className={glyph} />
            Download
          </a>
        )}
      </div>
    );
  }
  return (
    <div className="mt-4 flex flex-wrap items-center gap-1.5">
      {regenerate}
      {tweak}
      {reference}
      <GhostButton disabled={busy || !workflowReady} onClick={onEditWorkflow} title="Open the workflow JSON for hand edits">
        <Glyph.braces className={glyph} />
        Edit workflow
      </GhostButton>
      {fullRes === null ? null : (
        <GhostButton ariaPressed={fullRes} onClick={onFullRes} title={fullRes ? "Back to the 2048 px view copy" : "Load the original at full resolution"}>
          <Glyph.zoom className={glyph} />
          {fullRes ? "View copy" : "Full resolution"}
        </GhostButton>
      )}
    </div>
  );
}

/**
 * A full height strip over one sixth of the stage. Nothing shows at rest; the
 * glyph fades in on a solid backdrop under the pointer or keyboard focus, so
 * no chrome ever floats over the picture. `insetBottom` keeps a video's own
 * controls clickable. Not drawn on a phone, which swipes instead.
 */
function StepEdge({ side, targetId, insetBottom, onSelect }: { side: "left" | "right"; targetId: string | null; insetBottom: number; onSelect: (id: string) => void }) {
  if (targetId === null) return null;
  const left = side === "left";
  return (
    <button
      type="button"
      aria-label={left ? "Previous (left arrow)" : "Next (right arrow)"}
      title={left ? "Previous (left arrow)" : "Next (right arrow)"}
      onClick={() => onSelect(targetId)}
      // Matching top padding keeps the glyph on the stage's middle even though
      // the strip stops short of the bottom.
      style={insetBottom > 0 ? { bottom: insetBottom, paddingTop: insetBottom } : undefined}
      className={cn(
        "group absolute top-0 z-10 flex w-1/6 min-w-11 cursor-pointer items-center focus-visible:outline-none",
        insetBottom > 0 ? undefined : "bottom-0",
        left ? "left-0 justify-start pl-2" : "right-0 justify-end pr-2",
      )}
    >
      <span
        className={cn(
          // The pad has to separate from whatever picture is under it, so the
          // hairline is a fraction of the foreground rather than the border
          // token: it composites over the image, not over the pad, so it darkens
          // a white asset and lightens a black one. Without it a white pad sits
          // at 255 on a 251 line drawing and only the chevron says it is there.
          "flex size-8 items-center justify-center rounded-md bg-background text-foreground opacity-0 ring-1 ring-foreground/40",
          "transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none",
          "group-focus-visible:ring-2 group-focus-visible:ring-ring",
        )}
      >
        {left ? <Glyph.back className="size-4" /> : <Glyph.forward className="size-4" />}
      </span>
    </button>
  );
}

function Media({
  asset,
  url,
  fullLabel,
  placeholder,
  poster,
  box,
  now,
  dark,
  reducedMotion,
}: {
  asset: Asset;
  url: string | null;
  fullLabel: string;
  placeholder: string | null;
  poster: string | null;
  box: { width: number; height: number } | null;
  now: number;
  dark: boolean;
  reducedMotion: boolean;
}) {
  const muted = dark ? "text-white/70" : "text-muted-foreground";
  if (asset.status === "completed") {
    if (url === null) {
      return <p className={cn("m-auto text-[12px]", muted)}>{asset.file === null ? "No file was stored for this asset." : "Preparing the preview"}</p>;
    }
    if (asset.kind === "video") {
      // Poster first, native controls; `preload="metadata"` means the clip is
      // only fetched once somebody presses play.
      return (
        <div className="flex max-h-full max-w-full flex-col items-center gap-1.5">
          <video
            src={url}
            poster={poster ?? undefined}
            controls
            muted
            loop
            playsInline
            preload="metadata"
            className={cn("max-h-full max-w-full", dark ? undefined : "rounded-sm ring-1 ring-border")}
            aria-label={asset.prompt}
          />
          {hasAudio(asset) ? <p className={cn("text-[11px]", muted)}>Sound is off; use the player's volume control to hear it.</p> : null}
        </div>
      );
    }
    return <ProgressiveImage asset={asset} full={url} fullLabel={fullLabel} placeholder={placeholder} box={box} dark={dark} reducedMotion={reducedMotion} />;
  }
  const card = dark ? "rounded-md bg-background" : undefined;
  if (asset.status === "failed") {
    return (
      <div className={card}>
        <EmptyNote icon="alert" title="Generation failed" hint={shortError(asset.error) || "Comfy Cloud reported an error."} />
      </div>
    );
  }
  if (asset.status === "cancelled") {
    return (
      <div className={card}>
        <EmptyNote icon="close" title="Cancelled" hint="This job was stopped before it finished." />
      </div>
    );
  }
  if (asset.status === "unknown") {
    return (
      <div className={card}>
        <EmptyNote icon="clock" title="Not known yet" hint={asset.error ?? "Waiting to hear back from Comfy Cloud."} />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2">
      <Shimmer className={cn("size-40", dark && "bg-white/10")} />
      <StatusPill status={asset.status} detail={asset.status === "running" ? formatSeconds(elapsedSeconds(asset, now)) : undefined} className={dark ? "bg-background" : undefined} />
      <p className={cn("text-[11px]", muted)}>{asset.status === "queued" ? "Waiting to be submitted" : "Comfy Cloud is working on it"}</p>
    </div>
  );
}

/** The kind and size chip, the prompt as the headline, and a more toggle past three lines. */
function PromptBlock({ asset, width }: { asset: Asset; width: number }) {
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const promptRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    setExpanded(false);
  }, [asset.id]);

  // Measure only while clamped: expanded, the box is exactly as tall as its
  // text, so measuring then would hide the way back.
  useLayoutEffect(() => {
    const element = promptRef.current;
    if (element === null || expanded) return;
    setClipped(element.scrollHeight - element.clientHeight > 1);
  }, [asset.prompt, expanded, width]);

  const empty = asset.prompt === "";
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-[22px] min-w-0 shrink items-center truncate rounded-md border border-border/60 px-1.5 text-[10px] font-medium text-muted-foreground">
          {kindAndSize(asset)}
        </span>
        <span className="ml-auto shrink-0">{empty ? null : <CopyButton text={asset.prompt} label="Copy the prompt" done="Prompt copied" />}</span>
      </div>
      <p
        ref={promptRef}
        className={cn(
          "mt-2 min-w-0 select-text whitespace-pre-wrap break-words text-[15px] leading-6 [overflow-wrap:anywhere]",
          empty ? "text-muted-foreground" : "text-foreground",
          expanded ? undefined : "line-clamp-3",
        )}
      >
        {empty ? "No prompt recorded" : asset.prompt}
      </p>
      {clipped ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 cursor-pointer rounded-md text-[11px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:-m-1 max-md:pointer-coarse:min-h-11 max-md:pointer-coarse:p-1 max-md:pointer-coarse:py-2.5 max-md:pointer-coarse:text-[12px]"
        >
          {expanded ? "Show less" : "More"}
        </button>
      ) : null}
    </div>
  );
}

function Spec({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className={LABEL_CLASS}>{label}</p>
      <div className="mt-0.5 min-w-0 break-words text-[11px] leading-4 text-foreground [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}

/** What the picture is: model, size, cost, seed, created. Everything else is a footnote in Details. */
function SpecStrip({ asset }: { asset: Asset }) {
  const status = useStatus();
  const seed = seedOf(asset);
  const pixels = pixelSize(asset);
  // The chip beside the prompt already says "Video, 480p 16:9, 3 s", so this
  // cell is only the exact pixels, which keeps it on one line and the columns
  // in their row.
  const sizeText = pixels === null ? sizeChip(asset) : `${pixels.width}x${pixels.height}`;
  // What it cost: the billed figure once Comfy reports it, the estimate until
  // then. The "est" half only appears when the two are far enough apart to be
  // worth a second look; the whole sentence lives in Details.
  const cost = costCell(asset, status.data?.creditRate ?? null);
  return (
    <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border/60 pt-4 @[30rem]:grid-cols-4 @[46rem]:grid-cols-5">
      <Spec label="Model">
        <span title={asset.model}>{modelLabel(asset.model)}</span>
      </Spec>
      <Spec label="Size">{sizeText === "" ? <span className="text-muted-foreground">unknown</span> : sizeText}</Spec>
      <Spec label="Cost">
        {cost.unknown ? (
          <span className="text-muted-foreground">unknown</span>
        ) : (
          <>
            <span className="tabular-nums">{cost.main}</span>
            {cost.note === null ? null : <span className="text-muted-foreground">{cost.note}</span>}
          </>
        )}
      </Spec>
      <Spec label="Seed">
        {seed === null ? (
          <span className="text-muted-foreground">unknown</span>
        ) : (
          <span className="flex items-center gap-0.5">
            <span className="tabular-nums">{seed}</span>
            <CopyButton text={String(seed)} label="Copy the seed" done="Seed copied" size="sm" />
          </span>
        )}
      </Spec>
      <Spec label="Created">
        <span title={absoluteTime(asset.createdAt)}>{shortAbsoluteTime(asset.createdAt)}</span>
      </Spec>
    </div>
  );
}

/**
 * A path that keeps its file name whatever the column is worth: the folders
 * truncate with an ellipsis, the last segment never does.
 */
function PathText({ path }: { path: string }) {
  const name = fileName(path);
  const head = path.slice(0, path.length - name.length);
  const separator = head.endsWith("/") ? "/" : "";
  const folders = separator === "" ? head : head.slice(0, -1);
  // The ellipsis and the separator both ride with the file name. Left to CSS,
  // the folders span would end its ellipsis a fraction of a character short of
  // its box and open a gap in the middle of the path, so the folders are cut at
  // the exact pixel the column runs out and the mark is drawn here instead.
  const [foldersRef, cut] = useClipped(folders);
  return (
    <span className="flex min-w-0 overflow-hidden font-mono" title={path}>
      <span ref={foldersRef} className="min-w-0 overflow-hidden whitespace-nowrap">
        {folders}
      </span>
      <span className="shrink-0">
        {cut ? "\u2026" : ""}
        {separator}
        {name}
      </span>
    </span>
  );
}

/** True once an element is narrower than the text in it, so the caller can draw its own ellipsis. */
function useClipped(text: string): [(element: HTMLSpanElement | null) => void, boolean] {
  const [cut, setCut] = useState(false);
  const element = useRef<HTMLSpanElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback(() => {
    const current = element.current;
    if (current !== null) setCut(current.scrollWidth > current.clientWidth + 1);
  }, []);
  const ref = useCallback(
    (next: HTMLSpanElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      element.current = next;
      if (next === null) return;
      measure();
      if (typeof ResizeObserver === "undefined") return;
      const watcher = new ResizeObserver(measure);
      watcher.observe(next);
      observer.current = watcher;
    },
    [measure],
  );
  useEffect(() => {
    measure();
  }, [text, measure]);
  useEffect(
    () => () => {
      observer.current?.disconnect();
      observer.current = null;
    },
    [],
  );
  return [ref, cut];
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground [overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}

/** The footnotes: identifiers, paths, where it came from. Closed until asked for. */
function DetailList({ asset, now }: { asset: Asset; now: number }) {
  const took = asset.startedAt !== null && asset.completedAt !== null ? formatSeconds(Math.max(0, Math.round((asset.completedAt - asset.startedAt) / 1000))) : null;
  // The spec strip carries the number; this is the whole sentence, including
  // the model id Comfy actually billed under.
  const cost = costSentence(asset);
  const billedAs = billedAsText(asset);
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-[11px] leading-4">
      <Row label="Status">
        <StatusPill status={asset.status} detail={asset.status === "running" ? formatSeconds(elapsedSeconds(asset, now)) : undefined} />
      </Row>
      <Row label="Asset id">
        <span className="flex items-center gap-0.5">
          <code className="font-mono">{asset.id}</code>
          <CopyButton text={asset.id} label="Copy the asset id" done="Asset id copied" size="sm" />
        </span>
      </Row>
      {took === null ? null : <Row label="Took">{took}</Row>}
      <Row label="Model id">
        <code className="font-mono">{asset.model}</code>
      </Row>
      {cost === null ? null : <Row label="Cost">{cost}</Row>}
      {billedAs === null ? null : (
        <Row label="Billed as">
          {/* The id is code, the tier is a word: in one mono run they read as one string. */}
          {asset.billedModel === null || asset.billedModel === undefined || asset.billedModel === "" ? (
            <span>{billedAs}</span>
          ) : (
            <span>
              <code className="font-mono">{asset.billedModel}</code>
              {asset.outputTier === null || asset.outputTier === undefined || asset.outputTier === "" ? null : `, ${asset.outputTier} tier`}
            </span>
          )}
        </Row>
      )}
      <Row label="Started from">{SOURCE_TEXT[asset.source] ?? asset.source}</Row>
      {asset.threadId === null ? null : (
        <Row label="Thread">
          <code className="font-mono">{asset.threadId}</code>
        </Row>
      )}
      {asset.parentId === null ? null : (
        <Row label="Made from">
          <code className="font-mono">{asset.parentId}</code>
        </Row>
      )}
      <Row label="File size">{asset.sizeBytes === null ? <span className="text-muted-foreground">unknown</span> : formatBytes(asset.sizeBytes)}</Row>
      <Row label="Path">
        {asset.path === null ? (
          <span className="text-muted-foreground">not downloaded yet</span>
        ) : (
          <span className="flex min-w-0 items-center gap-1">
            <PathText path={asset.path} />
            <CopyButton text={asset.path} label="Copy the file path" done="Path copied" size="sm" />
          </span>
        )}
      </Row>
      <Row label="Workflow">
        <span className="flex min-w-0 items-center gap-1">
          <PathText path={asset.workflowPath} />
          <CopyButton text={asset.workflowPath} label="Copy the workflow path" done="Workflow path copied" size="sm" />
        </span>
      </Row>
    </dl>
  );
}

function VariantThumb({ asset, preview, current, onSelect }: { asset: Asset; preview: PreviewBase | null; current: boolean; onSelect: (id: string) => void }) {
  // A 56 px square: the thumbnail, never the original.
  const url = asset.file !== null && asset.status === "completed" ? mediaUrl(preview, asset, "thumb") : null;
  return (
    <button
      type="button"
      role="listitem"
      aria-current={current ? "true" : undefined}
      aria-label={`${current ? "Current: " : ""}${firstLine(asset.prompt, 60) || asset.id}`}
      title={`${asset.id}: ${firstLine(asset.prompt, 80)}`}
      onClick={() => onSelect(asset.id)}
      className={cn(
        "flex size-14 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-md bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        current ? "ring-2 ring-ring" : "opacity-80 ring-1 ring-border/60 hover:opacity-100",
      )}
    >
      {url === null ? (
        <StatusPill status={asset.status} className="scale-90" />
      ) : asset.kind === "video" && !hasStill(asset) ? (
        <video src={url} muted playsInline preload="metadata" className="size-full object-cover" aria-hidden />
      ) : (
        <img src={url} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
      )}
    </button>
  );
}
