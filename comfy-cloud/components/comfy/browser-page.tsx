// The Comfy page body, the Library: one toolbar over a gallery of justified
// rows grouped by day, replaced by the Viewer while an asset is selected.
// Selection lives in the route (`a/<id>`), so a deep link and browser back
// both land on the right asset. Running and failed rows are always shown,
// whatever the filters say: they are what is happening now, so they sit in the
// Now strip above the first day rather than in the grid.
//
// On a narrow touch screen: one toolbar row, the count in the day headers,
// refresh by pulling the grid down, and a fixed two-a-row density where the
// desktop has S, M and L.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, TouchEvent as ReactTouchEvent } from "react";
import { UrlLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Asset } from "../../contract";
import { Art } from "./art";
import { AssetTile, TileSweep } from "./asset-tile";
import { AssetViewer } from "./asset-viewer";
import { DeleteAssetDialog } from "./delete-dialog";
import { aspectOf } from "./format";
import { Glyph } from "./glyphs";
import { EAGER_ROWS, TILE_GAP, TILE_SIZES, groupByDay, justifyRows, moveFocus, phoneRowHeight, rowHeightFor, tilePositions, tilesPerRow } from "./gallery-layout";
import type { GalleryRow, TilePosition, TileSize } from "./gallery-layout";
import { pullDistance, pullTriggers } from "./gestures";
import { BAR, Banner, EmptyCard, GhostButton, Hairline, LABEL_CLASS, PrimaryButton, Segmented, Spinner, SweepStyle, primaryButtonClass } from "./kit";
import { splitLibrary } from "./now";
import { NowStrip } from "./now-strip";
import { mayHaveOlder, nextLimit } from "./library-paging";
import { COMFY_PANEL_PATH, GENERATE_SUBPATH, SETTINGS_HREF, assetIdFromSubPath, assetSubPath } from "./tabs";
import {
  LIBRARY_LIMIT,
  errorText,
  requestTweak,
  useAssets,
  useComfyBridge,
  useComfyRpc,
  useCompact,
  useDebounced,
  useElementSize,
  useFinger,
  useModelLabels,
  useNow,
  useOpenGenerateTab,
  useOpenJobsTab,
  usePreviewBase,
  useStatus,
} from "./use-comfy";
import type { KindFilter } from "./use-comfy";

const SIZE_OPTIONS = TILE_SIZES.map((size) => ({ id: size, label: size }));
const KIND_OPTIONS = [
  { id: "all", label: "All" },
  { id: "image", label: "Images" },
  { id: "video", label: "Videos" },
];
const FOCUS_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);
/**
 * Below this plugin width the search box folds into a glyph that opens a full
 * width field over the toolbar, and Starred drops its word. That is every phone.
 */
const NARROW_PX = 420;
/**
 * The S, M and L control needs this much room beside the filters and the
 * search box. It is a desktop control: a phone gets one fixed density instead.
 */
const SIZE_CONTROL_MIN_PX = 540;
/** The gallery's own horizontal padding, so the toolbar and the rows line up. */
const GUTTER = "px-3";

/** What the "Generate an image" button prefills. */
export const EXAMPLE_PROMPT = "A brass compass on a folded map, overhead photo";

interface LaidGroup {
  key: string;
  label: string;
  count: number;
  rows: GalleryRow[];
  /** Index of this group's first row across the whole gallery, for the eager rows. */
  firstRow: number;
}


/** One empty list for a page with no data yet, so a memo keyed on the rows does not rerun every render. */
const NO_ASSETS: Asset[] = [];

export function BrowserPage({ subPath }: PluginNavPanelProps) {
  useComfyBridge();
  // The tiles and the Viewer name a model, so the label map is fetched here.
  useModelLabels();
  const rpc = useComfyRpc();
  const navigate = useBbNavigate();
  const openGenerate = useOpenGenerateTab();
  const openJobs = useOpenJobsTab();
  const compact = useCompact();
  const finger = useFinger();
  const [kind, setKind] = useState<KindFilter>("all");
  const [starred, setStarred] = useState(false);
  // How many rows the grid asks for; "Show older" raises it a page at a time.
  const [limit, setLimit] = useState(LIBRARY_LIMIT);
  const [queryInput, setQueryInput] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [tileSize, setTileSize] = useState<TileSize>("M");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Asset | null>(null);
  const query = useDebounced(queryInput, 250);

  const status = useStatus();
  const list = useAssets({ kind, starred, query, limit });
  const preview = usePreviewBase();
  const selectedId = assetIdFromSubPath(subPath);

  // Deep link "generate": bring the tab forward, then clear the sub path so
  // a refresh does not open it again.
  const openGenerateRef = useRef(openGenerate);
  useEffect(() => {
    openGenerateRef.current = openGenerate;
  });
  useEffect(() => {
    if (subPath.replace(/^\/+|\/+$/g, "") !== GENERATE_SUBPATH) return;
    openGenerateRef.current();
    navigate.toPluginPanel(COMFY_PANEL_PATH, { subPath: "", replace: true });
  }, [subPath, navigate]);

  const select = useCallback(
    (id: string) => {
      setOpenedId(id);
      navigate.toPluginPanel(COMFY_PANEL_PATH, { subPath: assetSubPath(id), replace: true });
    },
    [navigate],
  );
  // Leaving the viewer puts focus back on the tile that was open, and scrolls
  // it into view, so Escape does not drop the keyboard user at the top.
  const restoreId = useRef<string | null>(null);
  const deselect = useCallback(() => {
    restoreId.current = assetIdFromSubPath(subPath);
    navigate.toPluginPanel(COMFY_PANEL_PATH, { subPath: "", replace: true });
  }, [navigate, subPath]);

  const statusRefetch = status.refetch;
  const listRefetch = list.refetch;
  const previewRefetch = preview.refetch;
  const previewBroken = preview.data === null || preview.error !== null;
  const refreshAll = useCallback(() => {
    statusRefetch();
    listRefetch();
    if (previewBroken) previewRefetch();
  }, [statusRefetch, listRefetch, previewRefetch, previewBroken]);

  const assets = list.data?.assets ?? NO_ASSETS;
  const anyActive = assets.some((asset) => asset.status === "running" || asset.status === "queued");
  // Every second while something runs, for the elapsed counts; otherwise every
  // half minute, which is what lets an hour old failure leave the Now strip.
  const now = useNow(selectedId === null, anyActive ? 1000 : 30_000);
  const minute = Math.floor(now / 60_000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const split = useMemo(() => splitLibrary(assets, now), [assets, minute]);

  const [rootRef, rootSize] = useElementSize<HTMLDivElement>();
  const [measureRef, gallerySize] = useElementSize<HTMLDivElement>();
  const galleryEl = useRef<HTMLDivElement | null>(null);
  const setGalleryRef = useCallback(
    (element: HTMLDivElement | null) => {
      galleryEl.current = element;
      measureRef(element);
    },
    [measureRef],
  );
  const panelWidth = rootSize.width;
  const narrow = panelWidth > 0 && panelWidth < NARROW_PX;
  const showSizeControl = !compact && panelWidth >= SIZE_CONTROL_MIN_PX;
  const searchExpanded = !narrow || searchOpen;

  const gallery = split.gallery;
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const { groups, positions } = useMemo(() => {
    const width = Math.max(0, Math.floor(gallerySize.width));
    // A phone has one density, two squares a row. S, M and L are a desktop choice.
    const rowHeight = compact ? phoneRowHeight(width) : rowHeightFor(showSizeControl ? tileSize : "M", width);
    const laid: LaidGroup[] = [];
    const tiles: TilePosition[] = [];
    let rowOffset = 0;
    for (const group of groupByDay(gallery, Date.now())) {
      const items = group.items.map((asset) => ({ id: asset.id, aspect: aspectOf(asset) }));
      const rows = justifyRows(items, width, rowHeight);
      tiles.push(...tilePositions(rows, rowOffset));
      laid.push({ key: group.key, label: group.label, count: group.items.length, rows, firstRow: rowOffset });
      rowOffset += rows.length;
    }
    return { groups: laid, positions: tiles };
  }, [gallery, gallerySize.width, tileSize, compact, showSizeControl]);

  useEffect(() => {
    const id = restoreId.current;
    if (id === null || selectedId !== null || groups.length === 0) return;
    const tile = galleryEl.current?.querySelector<HTMLElement>(`[data-tile-id="${CSS.escape(id)}"]`);
    const button = tile?.querySelector<HTMLButtonElement>("button");
    if (button === undefined || button === null) return;
    restoreId.current = null;
    setFocusedId(id);
    button.focus();
    tile?.scrollIntoView({ block: "nearest" });
  }, [selectedId, groups]);

  const firstId = gallery[0]?.id ?? null;
  const tabStop = focusedId !== null && assetById.has(focusedId) ? focusedId : firstId;

  const onTileKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, id: string) => {
    if (!FOCUS_KEYS.has(event.key)) return;
    const target = moveFocus(positions, id, event.key as "ArrowLeft");
    if (target === null) return;
    event.preventDefault();
    setFocusedId(target);
    galleryEl.current?.querySelector<HTMLButtonElement>(`[data-tile-id="${target}"] button`)?.focus();
  };

  const act = async (job: () => Promise<string>) => {
    try {
      toast.success(await job());
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      listRefetch();
      statusRefetch();
    }
  };
  const star = (asset: Asset) =>
    act(async () => {
      await rpc.call("asset_star", { id: asset.id, starred: !asset.starred });
      return asset.starred ? "Star removed" : "Starred";
    });
  // One retry per row at a time. A retry is a new paid generation, and a
  // double tap on the tile or the Now card must not queue two of them; the
  // Jobs tab guards its own Retry the same way.
  const retrying = useRef(new Set<string>());
  const retry = async (asset: Asset) => {
    if (retrying.current.has(asset.id)) return;
    retrying.current.add(asset.id);
    try {
      await act(async () => {
        const result = await rpc.call("asset_retry", { id: asset.id });
        return `Queued again as ${result.asset.id}`;
      });
    } finally {
      retrying.current.delete(asset.id);
    }
  };
  const remove = (asset: Asset) =>
    act(async () => {
      const result = await rpc.call("asset_delete", { id: asset.id });
      if (!result.ok) throw new Error(result.text);
      return result.text;
    });

  // The strip is what is happening now; its full story is the Jobs tab. A host
  // that cannot bring a fixed tab forward still gets somewhere useful.
  const openFromStrip = (asset: Asset) => {
    if (!openJobs()) select(asset.id);
  };

  // Pull to refresh, on a finger only: a drag down from the very top of the
  // grid. Realtime and the poll already keep the list fresh; this is for the
  // moment somebody wants to be sure.
  const scrollEl = useRef<HTMLDivElement | null>(null);
  const pullStart = useRef<number | null>(null);
  const [pull, setPull] = useState(0);
  const [pulling, setPulling] = useState(false);
  const onTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    pullStart.current = event.touches.length === 1 && touch !== undefined && (scrollEl.current?.scrollTop ?? 0) <= 0 ? touch.clientY : null;
  };
  const onTouchMove = (event: ReactTouchEvent<HTMLDivElement>) => {
    const start = pullStart.current;
    const touch = event.touches[0];
    if (start === null || touch === undefined) return;
    if ((scrollEl.current?.scrollTop ?? 0) > 0) {
      pullStart.current = null;
      setPull(0);
      return;
    }
    setPull(pullDistance(touch.clientY - start));
  };
  const onTouchEnd = () => {
    const start = pullStart.current;
    pullStart.current = null;
    // `pull` is already the damped distance, so the trigger reads it back as a finger distance.
    if (start !== null && pullTriggers(pull * 2)) {
      setPulling(true);
      refreshAll();
    }
    setPull(0);
  };
  useEffect(() => {
    if (pulling && !list.loading) setPulling(false);
  }, [pulling, list.loading]);

  const startExample = () => {
    requestTweak({ kind: "image", prompt: EXAMPLE_PROMPT, model: status.data?.imageModel ?? "", params: {}, parentId: null });
    if (!openGenerate()) navigate.toPluginPanel(COMFY_PANEL_PATH, { subPath: GENERATE_SUBPATH, replace: true });
  };

  if (selectedId !== null) {
    return <AssetViewer id={selectedId} assets={assets} preview={preview.data} onClose={deselect} onSelect={select} onChanged={refreshAll} />;
  }

  const filtered = kind !== "all" || starred || query !== "";
  const unconfigured = status.data !== null && !status.data.configured;
  const assetDirError = status.data?.assetDirError ?? null;
  // The list stops at `limit` rows, so the oldest day shown may be cut short,
  // and "Show older" under the last day asks for the next page.
  const truncated = mayHaveOlder(list.data?.pageCount ?? 0, limit);
  const clearFilters = () => {
    setKind("all");
    setStarred(false);
    setQueryInput("");
  };

  // 16rem when there is room, shrinking before anything else does; in the
  // narrow toolbar it takes the whole row instead. 16 px text on a finger, or
  // iOS zooms the page when it takes the focus.
  const searchBox = (grow: boolean) => (
    <div className={cn("relative min-w-0", grow ? "flex-1" : "max-w-64 shrink basis-64")}>
      <Glyph.search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground max-md:pointer-coarse:size-5 max-md:pointer-coarse:left-2.5" />
      <Input
        type="search"
        value={queryInput}
        onChange={(event) => setQueryInput(event.target.value)}
        placeholder="Search prompts"
        aria-label="Search prompts"
        autoFocus={searchOpen}
        // Chrome draws its own blue clear cross on a search input; this plugin
        // paints its own in a host token colour instead.
        className="h-7 rounded-md border-border/60 pl-7 pr-7 text-[12px] max-md:pointer-coarse:h-11 max-md:pointer-coarse:pl-9 max-md:pointer-coarse:pr-11 max-md:pointer-coarse:text-base [&::-webkit-search-cancel-button]:appearance-none"
      />
      {queryInput === "" ? null : (
        <GhostButton iconOnly ariaLabel="Clear search" className="absolute right-0.5 top-1/2 size-6 -translate-y-1/2 max-md:pointer-coarse:right-0 max-md:pointer-coarse:size-11" onClick={() => setQueryInput("")}>
          <Glyph.close className="size-3 max-md:pointer-coarse:size-4" />
        </GhostButton>
      )}
    </div>
  );

  return (
    <div ref={rootRef} className="flex h-full min-h-0 w-full min-w-0 flex-col bg-background">
      <SweepStyle />
      {/* One row at every width. On a phone: the kind switch on the left, the
          starred and search glyphs on the right, and search opens as a full
          width field over the whole bar. The count lives in the day headers and
          refresh is a pull on the grid, so neither needs a place up here. */}
      <div className={cn(BAR, "flex-nowrap overflow-hidden max-md:pointer-coarse:h-auto max-md:pointer-coarse:min-h-10 max-md:pointer-coarse:py-1")}>
        {narrow && searchOpen ? (
          <>
            {searchBox(true)}
            <GhostButton
              iconOnly
              ariaLabel="Close search"
              onClick={() => {
                setSearchOpen(false);
                setQueryInput("");
              }}
            >
              <Glyph.close className="size-3.5 max-md:pointer-coarse:size-5" />
            </GhostButton>
          </>
        ) : (
          <>
            <Segmented ariaLabel="Kind" options={KIND_OPTIONS} value={kind} onSelect={(id) => setKind(id as KindFilter)} />
            <div aria-hidden className="min-w-0 flex-1" />
            <GhostButton
              iconOnly={narrow}
              ariaPressed={starred}
              ariaLabel={starred ? "Showing starred only" : "Show starred only"}
              title="Starred only"
              className={cn(starred && "text-foreground")}
              onClick={() => setStarred((value) => !value)}
            >
              {starred ? <Glyph.starFilled className="size-3.5 shrink-0 max-md:pointer-coarse:size-5" /> : <Glyph.star className="size-3.5 shrink-0 max-md:pointer-coarse:size-5" />}
              {narrow ? null : "Starred"}
            </GhostButton>
            {searchExpanded ? (
              searchBox(false)
            ) : (
              <GhostButton iconOnly ariaLabel="Search prompts" title="Search prompts" className={cn(query !== "" && "text-foreground")} onClick={() => setSearchOpen(true)}>
                <Glyph.search className="size-3.5 max-md:pointer-coarse:size-5" />
              </GhostButton>
            )}
            {showSizeControl ? (
              <Segmented ariaLabel="Tile size" options={SIZE_OPTIONS} value={tileSize} onSelect={(id) => setTileSize(id === "S" || id === "L" ? id : "M")} />
            ) : null}
            {/* A mouse cannot pull the grid down, so the desktop keeps a refresh. */}
            {finger ? null : (
              <GhostButton iconOnly ariaLabel="Refresh" title="Refresh" disabled={list.loading && list.data === null} onClick={refreshAll}>
                {list.loading ? <Spinner /> : <Glyph.refresh className="size-3.5" />}
              </GhostButton>
            )}
          </>
        )}
      </div>

      {list.error !== null && list.data !== null ? (
        <Banner tone="error" action={<GhostButton onClick={listRefetch}>Retry</GhostButton>}>
          Could not refresh the Library: {list.error}
        </Banner>
      ) : null}
      {unconfigured && assets.length > 0 ? (
        <Banner
          tone="error"
          action={
            <UrlLink href={SETTINGS_HREF} className="shrink-0 text-[12px] font-medium text-foreground underline underline-offset-2">
              Open settings
            </UrlLink>
          }
        >
          No Comfy Cloud API key is configured, so nothing new can be generated.
        </Banner>
      ) : null}
      {assetDirError === null ? null : <Banner tone="error">The asset folder could not be prepared: {assetDirError}</Banner>}
      {preview.error !== null && preview.data === null ? (
        <Banner tone="error" action={<GhostButton onClick={previewRefetch}>Retry</GhostButton>}>
          Previews are unavailable: {preview.error}
        </Banner>
      ) : null}

      <div
        ref={scrollEl}
        className="min-h-0 flex-1 overflow-auto overscroll-y-contain"
        onTouchStart={finger ? onTouchStart : undefined}
        onTouchMove={finger ? onTouchMove : undefined}
        onTouchEnd={finger ? onTouchEnd : undefined}
        onTouchCancel={finger ? onTouchEnd : undefined}
      >
        {finger ? <PullIndicator distance={pull} busy={pulling} /> : null}
        <div ref={setGalleryRef} data-gallery className={cn("flex min-h-full flex-col pb-6", GUTTER)}>
          <NowStrip rows={split.strip} now={now} onOpen={openFromStrip} onRetry={(target) => void retry(target)} />
          {list.data === null ? (
            list.error !== null ? (
              <EmptyCard icon="alert" title="Could not load the Library" actions={<PrimaryButton onClick={listRefetch}>Try again</PrimaryButton>}>
                <p>{list.error}</p>
              </EmptyCard>
            ) : (
              <Skeleton size={tileSize} phone={compact} width={gallerySize.width} />
            )
          ) : gallery.length === 0 && split.strip.length > 0 ? null : assets.length === 0 ? (
            filtered ? (
              <EmptyCard
                icon="search"
                art={<Art name="empty-search" className="h-24 w-52 text-muted-foreground/70" />}
                title="No matches"
                actions={<PrimaryButton onClick={clearFilters}>Clear filters</PrimaryButton>}
              >
                <p>Nothing here matches this filter or search.</p>
              </EmptyCard>
            ) : unconfigured ? (
              <EmptyCard
                icon="alert"
                art={<Art name="no-key" className="h-28 w-44 text-muted-foreground/70" />}
                title="Add your Comfy Cloud key"
                actions={
                  <UrlLink href={SETTINGS_HREF} className={primaryButtonClass()}>
                    Open settings
                  </UrlLink>
                }
              >
                <p>Comfy Cloud needs your API key before anything can be generated. Any one of these works; the key never leaves the server.</p>
                <pre className="whitespace-pre-wrap rounded-md border border-border/60 p-2 text-left font-mono text-[11px] leading-4 text-foreground [overflow-wrap:anywhere]">
                  {[
                    "# 1. the secret plugin setting (also in Settings)",
                    "bb plugin config comfy-cloud set apiKey <key>",
                    "# 2. a git-ignored .env in the plugin folder",
                    "bb secret request COMFY_API_KEY --write-env <plugin folder>/.env",
                    "# 3. a dotenv file you already have",
                    "bb plugin config comfy-cloud set keyFile /path/to/.env",
                    "bb plugin reload comfy-cloud",
                  ].join("\n")}
                </pre>
              </EmptyCard>
            ) : (
              <EmptyCard
                icon="image"
                art={<Art name="empty-library" className="h-24 w-52 text-muted-foreground/70" />}
                title="Nothing generated yet"
                actions={
                  <PrimaryButton glyph="spark" onClick={startExample}>
                    Generate an image
                  </PrimaryButton>
                }
              >
                <p>Your images and videos will appear here, newest first, and agents can add to them from any thread.</p>
              </EmptyCard>
            )
          ) : (
            groups.map((group, groupIndex) => (
              // 12 px of air inside the header plus 12 px here makes the 24 px
              // section break the type scale asks for, without moving the first
              // group away from the toolbar.
              <section key={group.key} aria-label={group.label} className={cn((groupIndex > 0 || split.strip.length > 0) && "mt-3")}>
                <div className={cn("sticky top-0 z-10 -mx-3 flex items-center gap-3 bg-background pb-2 pt-3", GUTTER)}>
                  <h3 className={cn(LABEL_CLASS, "shrink-0")}>{group.label}</h3>
                  <Hairline className="min-w-0 flex-1" />
                  {/* How many that day, where the eye already is. The oldest day
                      of a list that hit its limit may be cut short, so it says so. */}
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" data-day-count>
                    {group.count}
                    {truncated && groupIndex === groups.length - 1 ? "+" : ""}
                  </span>
                </div>
                <div className="flex flex-col" style={{ gap: TILE_GAP }}>
                  {group.rows.map((row, rowIndex) => (
                    <div key={rowIndex} data-row className="flex items-start" style={{ gap: TILE_GAP }}>
                      {row.items.map((item) => {
                        const asset = assetById.get(item.id);
                        if (asset === undefined) return null;
                        return (
                          <AssetTile
                            key={asset.id}
                            asset={asset}
                            preview={preview.data}
                            now={now}
                            width={item.width}
                            height={item.height}
                            tabIndex={asset.id === tabStop ? 0 : -1}
                            selected={asset.id === openedId}
                            eager={group.firstRow + rowIndex < EAGER_ROWS}
                            finger={finger}
                            onSelect={select}
                            onFocus={setFocusedId}
                            onKeyDown={onTileKeyDown}
                            onStar={(target) => void star(target)}
                            onRetry={(target) => void retry(target)}
                            onDelete={setDeleteTarget}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
              </section>
            ))
          )}
          {truncated && groups.length > 0 ? (
            <div className="flex justify-center pb-3 pt-4">
              <GhostButton disabled={list.loading} onClick={() => setLimit(nextLimit)}>
                {list.loading ? <Spinner className="size-3.5" /> : null}
                Show older
              </GhostButton>
            </div>
          ) : null}
        </div>
      </div>

      <DeleteAssetDialog
        asset={deleteTarget}
        preview={preview.data}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onConfirm={(target) => void remove(target)}
      />
    </div>
  );
}

/**
 * The pull to refresh indicator: it grows with the finger, turns its glyph as
 * the pull nears the trigger and spins while the list reloads. It has no size
 * at rest, so it never pushes the gallery down on its own.
 */
function PullIndicator({ distance, busy }: { distance: number; busy: boolean }) {
  const height = busy ? 40 : distance;
  if (height <= 0) return null;
  const ready = pullTriggers(distance * 2);
  return (
    <div aria-live="polite" className="flex items-end justify-center overflow-hidden text-muted-foreground" style={{ height }}>
      <span className="flex h-10 items-center gap-1.5 text-[11px]">
        {busy ? <Spinner /> : <span style={{ transform: `rotate(${Math.round(distance * 3)}deg)` }}><Glyph.refresh className="size-4" /></span>}
        {busy ? "Refreshing" : ready ? "Release to refresh" : "Pull to refresh"}
      </span>
    </div>
  );
}

/** First load: rows of the size the gallery is about to draw, sweeping quietly. */
function Skeleton({ size, phone, width }: { size: TileSize; phone: boolean; width: number }) {
  const height = phone ? phoneRowHeight(width) : rowHeightFor(size, width);
  const count = phone ? 2 : tilesPerRow(size, width);
  return (
    <div className="pt-3" aria-hidden>
      <div className="mb-2 h-2.5 w-28 rounded-sm bg-muted" />
      <div className="flex flex-col" style={{ gap: TILE_GAP }}>
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex" style={{ gap: TILE_GAP }}>
            {Array.from({ length: count }, (_, tile) => (
              <div key={tile} className="relative flex-1 rounded-md" style={{ height }}>
                <TileSweep />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
