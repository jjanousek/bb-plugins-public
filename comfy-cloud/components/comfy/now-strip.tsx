// The Library's "Now" strip: what is waiting or running, and what failed in the
// last hour, as a row of small cards above the first day. Progress has to be
// visible without switching to the Jobs tab, because generations started from
// the tool or the CLI never pass through the panel. A card
// opens Jobs; a failed card carries Retry. Nothing here when nothing is
// happening: the strip is news, not furniture.
import { cn } from "@/lib/utils";
import type { Asset } from "../../contract";
import { TileSweep } from "./asset-tile";
import { elapsedOfEstimate, firstLine, modelLabel, shortError } from "./format";
import { unknownHeadline } from "./now";
import { Glyph } from "./glyphs";
import { GhostButton, LABEL_CLASS, Spinner } from "./kit";

export interface NowStripProps {
  rows: readonly Asset[];
  now: number;
  onOpen: (asset: Asset) => void;
  onRetry: (asset: Asset) => void;
}

/** A card's box: 96 px tall, wide enough for "41 s of about 20 to 40 s" at 11 px. */
export const NOW_CARD = { width: 208, height: 96 } as const;

export function NowStrip({ rows, now, onOpen, onRetry }: NowStripProps) {
  if (rows.length === 0) return null;
  const working = rows.filter((row) => row.status !== "failed").length;
  const failed = rows.length - working;
  const summary = [working > 0 ? `${working} in progress` : null, failed > 0 ? `${failed} failed` : null].filter((part) => part !== null).join(", ");
  return (
    <section aria-label="Now" className="pt-3">
      <div className="flex items-center gap-3 pb-2">
        <h3 className={cn(LABEL_CLASS, "shrink-0")}>Now</h3>
        <div aria-hidden className="h-px min-w-0 flex-1 bg-border/60" />
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{summary}</span>
      </div>
      {/* Bleeds to the panel edge so a long strip scrolls under the gutter
          rather than stopping 12 px short of it. */}
      <ul className="-mx-3 flex snap-x gap-2 overflow-x-auto px-3 pb-1 [scrollbar-width:none]" role="list">
        {rows.map((asset) => (
          <NowCard key={asset.id} asset={asset} now={now} onOpen={onOpen} onRetry={onRetry} />
        ))}
      </ul>
    </section>
  );
}

function NowCard({ asset, now, onOpen, onRetry }: { asset: Asset; now: number; onOpen: (asset: Asset) => void; onRetry: (asset: Asset) => void }) {
  const failed = asset.status === "failed";
  const unknown = asset.status === "unknown";
  const state = failed ? "Failed" : asset.status === "queued" ? "Waiting" : unknown ? "Not known yet" : elapsedOfEstimate(asset, now);
  const prompt = firstLine(asset.prompt, 80) || asset.id;
  return (
    <li
      data-now-id={asset.id}
      className={cn(
        "relative shrink-0 snap-start overflow-hidden rounded-md ring-1",
        failed ? "bg-destructive/5 ring-destructive/40" : "bg-muted ring-border/60",
      )}
      style={{ width: NOW_CARD.width, height: NOW_CARD.height }}
    >
      {failed ? null : <TileSweep />}
      {/* The whole card is the way to Jobs; Retry sits above it as a sibling,
          so nothing interactive nests inside a button. */}
      <button
        type="button"
        aria-label={`${failed ? "Failed" : state}: ${prompt}. Open Jobs`}
        onClick={() => onOpen(asset)}
        className="absolute inset-0 cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="pointer-events-none relative flex h-full flex-col justify-between p-2.5">
        <p className={cn("flex min-w-0 items-center gap-1.5 text-[11px] font-medium leading-4", failed ? "pr-20 text-destructive" : "text-foreground")}>
          {failed ? <Glyph.alert className="size-3.5 shrink-0" /> : <Spinner className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 truncate tabular-nums">{state}</span>
        </p>
        <p className="line-clamp-2 text-[11px] leading-4 text-foreground">{failed ? shortError(asset.error) || "Comfy Cloud reported an error" : unknown ? unknownHeadline(asset) : prompt}</p>
        <p className="min-w-0 truncate text-[10px] leading-4 text-muted-foreground">{modelLabel(asset.model)}</p>
      </div>
      {/* Top right, beside the short "Failed" line: at the bottom a 44 px
          target covered the second line of the error. */}
      {failed ? (
        <GhostButton className="absolute right-1 top-1 z-10 bg-background/90 text-foreground hover:bg-background max-md:pointer-coarse:right-0 max-md:pointer-coarse:top-0" onClick={() => onRetry(asset)}>
          <Glyph.refresh className="size-3.5" />
          Retry
        </GhostButton>
      ) : null}
    </li>
  );
}
