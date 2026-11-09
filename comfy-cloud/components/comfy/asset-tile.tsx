// One tile in the Library gallery. The picture is the only colour: the frame
// is a hairline, the prompt and the size chip only appear on hover or focus,
// and the star stays visible once it is set. Running rows show a slow neutral
// sweep with the elapsed seconds, failed rows a red tint with the first line
// of the error and Retry and Delete on hover. The tile itself is a button; the
// small controls are siblings so nothing interactive nests inside it.
//
// The box is sized by the gallery from the row's stored width and height, so
// the grid is laid out before a single byte of any picture arrives and nothing
// moves when one does. The picture fades in over the muted box once decoded,
// 180 ms and no scale, and simply appears under reduced motion.
//
// On a finger the star is not a tile control: a 44 px star on a 180 px tile is
// a quarter of the picture, and starring belongs in the viewer's action sheet.
// A starred tile still shows the star, as a mark rather than a button.
import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import type { Asset } from "../../contract";
import { durationChip, elapsedOfEstimate, firstLine, mediaUrl, shortError, sizeChip, truncate } from "./format";
import { Glyph } from "./glyphs";
import { FADE, GhostButton, Spinner } from "./kit";
import { TILE_ACTION_GAP, TILE_DESTRUCTIVE_HIDDEN_ON_FINGER } from "./touch-geometry";
import type { PreviewBase } from "./use-comfy";

export interface AssetTileProps {
  asset: Asset;
  preview: PreviewBase | null;
  /** Clock for the elapsed label; only ticks while something runs. */
  now: number;
  width: number;
  height: number;
  /** 0 for the one tile in the tab order, -1 for the rest (roving focus). */
  tabIndex: number;
  /** The tile the Viewer was last opened on, so coming back is obvious. */
  selected?: boolean;
  /** In the first rows: fetched at once and first, rather than when scrolled to. */
  eager?: boolean;
  /** Touch behaviour: no hover controls, the star is a mark rather than a button. */
  finger?: boolean;
  onSelect: (id: string) => void;
  onFocus: (id: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, id: string) => void;
  onStar: (asset: Asset) => void;
  onRetry: (asset: Asset) => void;
  onDelete: (asset: Asset) => void;
}

const HOVER_SHOW = `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 ${FADE}`;
/** A chip that sits on the picture: solid, small, tabular, the house radius. */
const PILL = "rounded-md bg-background/95 px-1.5 py-px text-[10px] font-medium tabular-nums leading-4 text-foreground";

/**
 * A slow neutral sweep for a tile that is waiting or running: one soft band
 * crossing the box about every two and a half seconds. Not a pulse, and it
 * stops under reduced motion.
 */
export function TileSweep({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden rounded-md bg-muted", className)}>
      {/* `comfy-sweep-slow` is the plugin's one indeterminate keyframe, defined
          once in the kit and mounted by the surface through <SweepStyle />. */}
      <span className="comfy-sweep-slow absolute inset-y-0 -left-3/5 w-3/5 bg-gradient-to-r from-transparent via-foreground/10 to-transparent" />
    </span>
  );
}

export function AssetTile({ asset, preview, now, width, height, tabIndex, selected = false, eager = false, finger = false, onSelect, onFocus, onKeyDown, onStar, onRetry, onDelete }: AssetTileProps) {
  // The tile draws small on a phone, so it asks for the 512 px copy rather than
  // the original, which can run to several megabytes, and through the media
  // route, so the browser keeps it across openings of the panel.
  const url = mediaUrl(preview, asset, "thumb");
  // A video tile still plays on hover, so it keeps the file as its source; the
  // poster frame above is what it shows until then. See TileMedia.
  const videoSrc = mediaUrl(preview, asset, "file");
  const label = truncate(asset.prompt, 90) || asset.id;
  const kindWord = asset.kind === "video" ? "Video" : "Image";
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const size = sizeChip(asset);
  const duration = durationChip(asset);
  // The ring lives on the wrapper, not the button: an offset ring on a child
  // would be clipped by the wrapper's overflow-hidden and vanish over an image.
  const [ringed, setRinged] = useState(false);
  const done = asset.status === "completed";

  const playPreview = () => {
    void videoRef.current?.play().catch(() => undefined);
  };
  const stopPreview = () => {
    const video = videoRef.current;
    if (video === null) return;
    video.pause();
    try {
      video.currentTime = 0;
    } catch {
      // A metadata-only video may refuse a seek; nothing to do.
    }
  };

  return (
    <div
      data-tile-id={asset.id}
      className={cn(
        "group relative shrink-0 overflow-hidden rounded-md bg-muted ring-1 ring-border/60",
        asset.status === "failed" && "bg-destructive/5 ring-destructive/40",
        selected && "ring-2 ring-ring",
        ringed && "ring-2 ring-ring ring-offset-2 ring-offset-background",
      )}
      style={{ width, height }}
      onMouseEnter={playPreview}
      onMouseLeave={stopPreview}
    >
      <button
        type="button"
        tabIndex={tabIndex}
        aria-label={`${kindWord}: ${label}`}
        onClick={() => onSelect(asset.id)}
        onFocus={(event) => {
          onFocus(asset.id);
          setRinged(event.currentTarget.matches(":focus-visible"));
        }}
        onBlur={() => setRinged(false)}
        onKeyDown={(event) => onKeyDown(event, asset.id)}
        className="absolute inset-0 block size-full cursor-pointer text-left focus-visible:outline-none"
      >
        <TileMedia asset={asset} url={url} videoSrc={videoSrc} now={now} videoRef={videoRef} eager={eager} />
      </button>

      {done ? (
        <>
          {/* Top left: a video says it is one and how long it runs, always;
              how big anything is, on hover. The play mark and the length are
              one pill, so a video tile carries one small thing at rest. */}
          <div className="pointer-events-none absolute left-1.5 top-1.5 flex max-w-[calc(100%-3rem)] items-center gap-1" aria-hidden>
            {asset.kind === "video" ? (
              <span className={cn(PILL, "inline-flex items-center gap-0.5 pl-1")}>
                <Glyph.play className="size-3" />
                {duration}
              </span>
            ) : null}
            {size === "" || finger ? null : <span className={cn(PILL, "truncate", HOVER_SHOW)}>{size}</span>}
          </div>
          {/* Bottom: the prompt on one line over a scrim. */}
          <div
            className={cn("pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background/95 via-background/70 to-transparent px-2 pb-1.5 pt-8", HOVER_SHOW)}
            aria-hidden
          >
            <p className="truncate text-[11px] leading-4 text-foreground">{truncate(asset.prompt, 80)}</p>
          </div>
        </>
      ) : null}

      {finger && asset.starred && (done || asset.status === "failed") ? (
        <span aria-label="Starred" role="img" className="pointer-events-none absolute right-1.5 top-1.5 z-10 flex size-6 items-center justify-center rounded-md bg-background/85 text-foreground">
          <Glyph.starFilled className="size-3.5" />
        </span>
      ) : null}

      {!finger && (done || asset.status === "failed") ? (
        <GhostButton
          iconOnly
          ariaLabel={asset.starred ? "Remove star" : "Star"}
          ariaPressed={asset.starred}
          onClick={() => onStar(asset)}
          // Radius md, like the size chip on the other corner; only the play
          // badge over a video stays round, because that is what a play button is.
          className={cn("absolute right-1 top-1 z-10 size-6 rounded-md bg-background/85 text-foreground hover:bg-background", asset.starred ? "opacity-100" : HOVER_SHOW)}
        >
          {asset.starred ? <Glyph.starFilled className="size-3.5" /> : <Glyph.star className="size-3.5" />}
        </GhostButton>
      ) : null}

      {asset.status === "failed" ? (
        <div
          className={cn(
            "absolute inset-x-0 bottom-0 z-10 flex items-center justify-end border-t border-border/60 bg-background px-1.5 py-1 max-md:pointer-coarse:py-2",
            TILE_ACTION_GAP.class,
            HOVER_SHOW,
            "max-md:pointer-coarse:opacity-100",
          )}
        >
          <GhostButton onClick={() => onRetry(asset)}>Retry</GhostButton>
          {/* Delete is off the tile on a finger. Retry is exactly what a
              finger reaches for after a failure, and two 44px targets with
              12px between them do not fit a small tile, so a touch screen
              deletes from the Viewer instead. See touch-geometry.ts for the
              arithmetic. */}
          <GhostButton danger className={TILE_DESTRUCTIVE_HIDDEN_ON_FINGER} onClick={() => onDelete(asset)}>
            Delete
          </GhostButton>
        </div>
      ) : null}
    </div>
  );
}

interface TileMediaProps {
  asset: Asset;
  url: string | null;
  videoSrc: string | null;
  now: number;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  eager: boolean;
}

/** The picture fades in over the tile's muted box once it has decoded. */
export const TILE_FADE = "transition-opacity duration-[180ms] ease-out motion-reduce:transition-none";

function TileMedia({ asset, url, videoSrc, now, videoRef, eager }: TileMediaProps) {
  const [shown, setShown] = useState(false);
  // A picture already in the cache can finish before React attaches onLoad,
  // so the element is asked once as it mounts.
  const imageRef = useCallback((element: HTMLImageElement | null) => {
    if (element !== null && element.complete && element.naturalWidth > 0) setShown(true);
  }, []);
  if (asset.status === "completed") {
    if (url === null) {
      return <span className="flex size-full items-center justify-center text-[11px] text-muted-foreground">{asset.file === null ? "No file" : "Preparing preview"}</span>;
    }
    if (asset.kind === "video") {
      // `poster` is the small still frame and `preload="none"` means the clip
      // is not fetched until a pointer asks for it, so a phone never downloads
      // a whole video just to show a still.
      return (
        <video
          ref={videoRef}
          src={videoSrc ?? url}
          poster={videoSrc === null || url === videoSrc ? undefined : url}
          muted
          playsInline
          loop
          preload="none"
          className="size-full object-cover"
          aria-hidden
        />
      );
    }
    return (
      <img
        ref={imageRef}
        src={url}
        alt={asset.prompt}
        loading={eager ? "eager" : "lazy"}
        fetchPriority={eager ? "high" : "auto"}
        decoding="async"
        onLoad={() => setShown(true)}
        // A picture that cannot load shows the muted box, not a broken frame.
        onError={() => setShown(false)}
        className={cn("size-full object-cover", TILE_FADE, shown ? "opacity-100" : "opacity-0")}
      />
    );
  }
  if (asset.status === "failed") {
    return (
      <span className="flex size-full flex-col justify-between p-2 text-left">
        <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.14em] text-destructive">
          <Glyph.alert className="size-3.5" />
          Failed
        </span>
        <span className="line-clamp-2 text-[11px] leading-4 text-foreground">{firstLine(asset.prompt, 60)}</span>
        {/* Retry and Delete take this line's place on hover, so it steps out
            rather than being covered by a translucent bar. */}
        <span className={cn("line-clamp-2 text-[10px] leading-4 text-destructive group-hover:opacity-0 group-focus-within:opacity-0", FADE)}>
          {shortError(asset.error) || "Comfy Cloud reported an error"}
        </span>
      </span>
    );
  }
  if (asset.status === "cancelled") {
    return (
      <span className="flex size-full flex-col justify-between p-2 text-left">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Cancelled</span>
        <span className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">{firstLine(asset.prompt, 60)}</span>
      </span>
    );
  }
  return (
    <span className="relative flex size-full flex-col justify-between p-2 text-left">
      <TileSweep />
      <span className="relative flex min-w-0 items-center gap-1 text-[10px] font-medium text-muted-foreground">
        <Spinner className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{asset.status === "queued" ? "Waiting" : asset.status === "unknown" ? "Not known yet" : elapsedOfEstimate(asset, now)}</span>
      </span>
      <span className="relative line-clamp-2 text-[11px] leading-4 text-foreground">{firstLine(asset.prompt, 60)}</span>
    </span>
  );
}
