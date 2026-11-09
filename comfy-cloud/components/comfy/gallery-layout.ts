// Pure layout for the Library gallery: newest first, grouped by local
// day, each group laid out as justified rows (every tile keeps its aspect
// ratio, rows share a height, the last row is left aligned). No DOM, so it
// is unit-testable and the page is a plain projection of this output.
import type { Asset } from "../../contract";
import { dayKey, dayLabel } from "./format";

/** Row heights before the container has been measured; after that the width decides. */
export const TILE_HEIGHTS = { S: 120, M: 170, L: 240 } as const;
export type TileSize = keyof typeof TILE_HEIGHTS;
export const TILE_SIZES: readonly TileSize[] = ["S", "M", "L"];
export const TILE_GAP = 8;

/**
 * How wide one M tile wants to be. The count for M is the container divided
 * by this, S is one more per row and L is one less, so the three sizes always
 * differ: 3, 2 and 1 in a 560 px panel (536 px of gallery) and 5, 4 and 3 at
 * 1120 px of plugin width. The 0.1 nudges the two anchors onto whole numbers.
 */
const MID_TILE_WIDTH = 280;
/** A stand-in aspect for the mix in a typical library, used only to turn a tile count into a row height. */
const NOMINAL_ASPECT = 1.2;
const MIN_ROW_HEIGHT = 64;
const MAX_ROW_HEIGHT = 460;

/** Tiles per row this size aims for at this width; never fewer than one. */
export function tilesPerRow(size: TileSize, containerWidth: number): number {
  const mid = Math.max(2, Math.round(containerWidth / MID_TILE_WIDTH + 0.1));
  const shift = size === "S" ? 1 : size === "L" ? -1 : 0;
  return Math.max(1, mid + shift);
}

/**
 * Row height for a size at the container's current width, derived from the
 * tile count rather than a fixed pixel height. Falls back to the fixed
 * heights when the container has not been measured yet.
 */
export function rowHeightFor(size: TileSize, containerWidth: number): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return TILE_HEIGHTS[size];
  const count = tilesPerRow(size, containerWidth);
  const height = (containerWidth - TILE_GAP * (count - 1)) / (count * NOMINAL_ASPECT);
  return Math.round(Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, height)));
}

/**
 * The narrow touch screen's one density. S, M and L are a desktop control;
 * on a phone the grid is fixed at two square tiles a row. The height is
 * rounded **up**, never down: two squares close a row only when their fitted
 * height is at most the row height, and on an odd width that height ends in
 * .5, where rounding down would pack three smaller squares instead.
 */
export const PHONE_TILES_PER_ROW = 2;

export function phoneRowHeight(containerWidth: number): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return TILE_HEIGHTS.L;
  const width = Math.floor(containerWidth);
  const height = (width - TILE_GAP * (PHONE_TILES_PER_ROW - 1)) / PHONE_TILES_PER_ROW;
  return Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, Math.ceil(height)));
}

/**
 * How many rows at the top of the gallery load at once rather than lazily. The
 * first screen on a phone is about two rows, and those are what somebody
 * opened the panel to see, so they are asked for first and eagerly.
 */
export const EAGER_ROWS = 2;

export interface GalleryItem {
  id: string;
  /** Width divided by height, already clamped. */
  aspect: number;
}

export interface PlacedItem extends GalleryItem {
  width: number;
  height: number;
}

export interface GalleryRow {
  items: PlacedItem[];
  height: number;
  /** True when the row was stretched to the container width, false for a short last row. */
  justified: boolean;
}

/**
 * Pack items into rows of `rowHeight`; a row is closed once its tiles at
 * that height would overflow the container, then scaled to fill the width
 * exactly. The last row keeps `rowHeight` and stays left aligned unless it
 * would overflow.
 */
export function justifyRows(items: readonly GalleryItem[], containerWidth: number, rowHeight: number, gap = TILE_GAP): GalleryRow[] {
  const rows: GalleryRow[] = [];
  if (items.length === 0) return rows;
  const height = Math.max(1, rowHeight);
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return items.map((item) => placeRow([item], height, Number.POSITIVE_INFINITY, gap, false));
  }
  const width = Math.floor(containerWidth);
  let current: GalleryItem[] = [];
  let aspectSum = 0;
  for (const item of items) {
    current.push(item);
    aspectSum += item.aspect;
    const fitted = (width - gap * (current.length - 1)) / aspectSum;
    if (fitted <= height) {
      rows.push(placeRow(current, fitted, width, gap, true));
      current = [];
      aspectSum = 0;
    }
  }
  if (current.length > 0) rows.push(placeRow(current, height, width, gap, false));
  return rows;
}

/**
 * Turn one row of aspects into integer pixel widths.
 *
 * Every edge is the rounded running total, so each tile is within a pixel of
 * `aspect * height` and the widths still add up exactly: a justified row ends
 * on the container edge, a free row ends at its natural width. Spreading the
 * rounding this way keeps the last tile from absorbing all of the drift and
 * cropping its picture; `test/app.test.tsx` holds the property test for it.
 */
function placeRow(items: readonly GalleryItem[], height: number, containerWidth: number, gap: number, justified: boolean): GalleryRow {
  const count = items.length;
  const rowHeight = Math.max(1, Math.round(height));
  const gaps = gap * Math.max(0, count - 1);
  // Never less than one pixel per tile, so a target can always be shared out.
  const available = Number.isFinite(containerWidth) ? Math.max(count, Math.floor(containerWidth) - gaps) : Number.POSITIVE_INFINITY;
  const exact = items.map((item) => Math.max(1, item.aspect * height));
  const natural = exact.reduce((sum, value) => sum + value, 0);
  const target = justified ? available : Math.min(available, Math.round(natural));
  const scale = target / natural;

  let cursor = 0;
  let used = 0;
  const placed = items.map((item, index) => {
    cursor += exact[index]! * scale;
    const remaining = count - 1 - index;
    const ideal = Math.round(cursor) - used;
    const width = Math.min(Math.max(1, ideal), Math.max(1, target - used - remaining));
    used += width;
    return { ...item, width, height: rowHeight };
  });
  return { items: placed, height: rowHeight, justified };
}

export interface DayGroup<T> {
  key: string;
  label: string;
  items: T[];
}

/** Group newest-first rows by local day, keeping their order. */
export function groupByDay<T extends { createdAt: number }>(rows: readonly T[], nowMs = Date.now()): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const row of rows) {
    const key = dayKey(row.createdAt);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.key === key) {
      last.items.push(row);
      continue;
    }
    groups.push({ key, label: dayLabel(row.createdAt, nowMs), items: [row] });
  }
  return groups;
}

/** Horizontal centre of every tile, for arrow-key moves between rows. */
export interface TilePosition {
  id: string;
  row: number;
  centerX: number;
}

export function tilePositions(rows: readonly GalleryRow[], rowOffset: number, gap = TILE_GAP): TilePosition[] {
  const positions: TilePosition[] = [];
  rows.forEach((row, rowIndex) => {
    let x = 0;
    for (const item of row.items) {
      positions.push({ id: item.id, row: rowOffset + rowIndex, centerX: x + item.width / 2 });
      x += item.width + gap;
    }
  });
  return positions;
}

/** The tile an arrow key lands on; null when there is nowhere to go. */
export function moveFocus(positions: readonly TilePosition[], fromId: string, key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End"): string | null {
  const index = positions.findIndex((position) => position.id === fromId);
  if (index === -1) return positions[0]?.id ?? null;
  if (key === "Home") return positions[0]?.id ?? null;
  if (key === "End") return positions[positions.length - 1]?.id ?? null;
  if (key === "ArrowLeft") return positions[index - 1]?.id ?? null;
  if (key === "ArrowRight") return positions[index + 1]?.id ?? null;
  const from = positions[index]!;
  const targetRow = key === "ArrowUp" ? from.row - 1 : from.row + 1;
  let best: TilePosition | null = null;
  for (const position of positions) {
    if (position.row !== targetRow) continue;
    if (best === null || Math.abs(position.centerX - from.centerX) < Math.abs(best.centerX - from.centerX)) best = position;
  }
  return best?.id ?? null;
}

/** Parent, siblings and children linked through parentId, oldest first (the Viewer's variant strip). */
export function familyOf(assets: readonly Asset[], id: string): Asset[] {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const rootOf = (asset: Asset): string => {
    let current = asset;
    const seen = new Set<string>();
    while (current.parentId !== null && !seen.has(current.id)) {
      const parent = byId.get(current.parentId);
      if (parent === undefined) break;
      seen.add(current.id);
      current = parent;
    }
    return current.id;
  };
  const me = byId.get(id);
  if (me === undefined) return [];
  const root = rootOf(me);
  return assets.filter((asset) => rootOf(asset) === root).sort((a, b) => a.createdAt - b.createdAt);
}
