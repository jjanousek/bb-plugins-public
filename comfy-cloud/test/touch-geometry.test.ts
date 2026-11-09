// The arithmetic behind every destructive control's clear air. It lives in a
// test rather than a comment because a margin is one edit away from being
// removed by somebody tidying a class list.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FINGER_TARGET,
  HEADER_DESTRUCTIVE_MARGIN,
  HEADER_DIVIDER,
  HEADER_GAP,
  DESTRUCTIVE_MIN_GAP,
  TILE_ACTION_GAP,
  TILE_DESTRUCTIVE_HIDDEN_ON_FINGER,
  TILE_GAP_BELOW_FLOOR,
  SHEET_DELETE_SEPARATOR,
  SHEET_ROW,
  headerClearAir,
  scaleToPx,
  sheetDeleteClearAir,
} from "../components/comfy/touch-geometry";

const read = (file: string): string => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");

describe("the Viewer header's Delete", () => {
  it("keeps more than the floor between Download and Delete on a finger", () => {
    // Held with headroom on purpose. A pair that clears the floor by one pixel
    // is a pair that fails on the next class edit.
    expect(headerClearAir()).toBe(21);
    expect(headerClearAir()).toBeGreaterThan(DESTRUCTIVE_MIN_GAP);
  });

  it("pays the row gap twice, because the hairline is a flex item", () => {
    expect(headerClearAir()).toBe(HEADER_GAP.px * 2 + HEADER_DIVIDER.marginPx * 2 + HEADER_DIVIDER.widthPx + HEADER_DESTRUCTIVE_MARGIN.px);
  });

  it("is drawn from these constants rather than from a literal class list", () => {
    // A number without its class is a guess and a class without its number is
    // unmeasured, so the header renders the classes this file measures instead
    // of spelling them out. If somebody swaps one back to a literal, the gap
    // can move without this test noticing, so the reference itself is asserted.
    const viewer = read("components/comfy/asset-viewer.tsx");
    for (const name of ["HEADER_GAP", "HEADER_DIVIDER", "HEADER_DESTRUCTIVE_MARGIN"]) {
      expect(viewer.split(`from "./touch-geometry"`)[1] ?? viewer, name).toContain(`${name}.class`);
    }
    for (const cls of [HEADER_GAP.class, HEADER_DIVIDER.class, HEADER_DESTRUCTIVE_MARGIN.class]) {
      // Tailwind only emits a class it can see as a literal, and these are
      // literals in touch-geometry.ts, which the build scans.
      expect(read("components/comfy/touch-geometry.ts"), cls).toContain(`"${cls}"`);
    }
  });
});

describe("the failed tile's actions", () => {
  it("has a gap below the floor, so Delete cannot share the strip on a finger", () => {
    expect(TILE_GAP_BELOW_FLOOR).toBe(true);
    expect(TILE_ACTION_GAP.px).toBeLessThan(DESTRUCTIVE_MIN_GAP);
  });

  it("keeps Delete off the tile wherever that gap would apply", () => {
    // The gap itself is allowed to stay small: on a mouse, precision is not the
    // problem. What must never happen is a destructive control sitting in it
    // on a finger.
    const tile = read("components/comfy/asset-tile.tsx");
    const deleteButton = /<GhostButton danger[^>]*>/.exec(tile);
    expect(deleteButton, "the tile should still have a Delete for the mouse").not.toBe(null);
    expect(deleteButton![0]).toContain("TILE_DESTRUCTIVE_HIDDEN_ON_FINGER");
    expect(TILE_DESTRUCTIVE_HIDDEN_ON_FINGER).toBe("max-md:pointer-coarse:hidden");
  });
});

describe("the Viewer sheet's Delete", () => {
  it("is a full finger tall and more than the floor away from the row above it", () => {
    // The rows sit flush, so the separator is the whole of the air: 8px of
    // margin, a 1px hairline, 8px of padding.
    expect(SHEET_ROW.px).toBe(FINGER_TARGET);
    expect(sheetDeleteClearAir()).toBe(17);
    expect(sheetDeleteClearAir()).toBeGreaterThan(DESTRUCTIVE_MIN_GAP);
  });

  it("is drawn from these constants, and the classes say what the numbers say", () => {
    const sheet = read("components/comfy/action-sheet.tsx");
    expect(sheet).toContain("SHEET_DELETE_SEPARATOR.class");
    expect(sheet).toContain("SHEET_ROW.class");
    expect(SHEET_DELETE_SEPARATOR.class).toContain(`mt-${SHEET_DELETE_SEPARATOR.marginPx / 4}`);
    expect(SHEET_DELETE_SEPARATOR.class).toContain(`pt-${SHEET_DELETE_SEPARATOR.paddingPx / 4}`);
    expect(SHEET_DELETE_SEPARATOR.class).toContain("border-t");
    expect(SHEET_ROW.class).toBe("min-h-11");
  });
});

describe("the assumption underneath every number here", () => {
  it("keeps the hit box equal to the layout box", () => {
    // Every figure in touch-geometry.ts is a sum of gaps, which is only the
    // clear air if the buttons do not bleed past their slots. A negative margin
    // in ghostButtonClass would make all of them wrong without touching that
    // file, and the visible gap would still look right.
    const kit = read("components/comfy/kit.tsx");
    const body = kit.slice(kit.indexOf("export function ghostButtonClass"), kit.indexOf("export interface GhostButtonProps"));
    expect(body).not.toMatch(/"-m|\s-m[xytrbl]?-\d|:-m[xytrbl]?-\d/);
    expect(body).toContain("max-md:pointer-coarse:h-11");
  });

  it("reads Tailwind's spacing scale the way Tailwind does", () => {
    expect(scaleToPx(1)).toBe(4);
    expect(scaleToPx(3)).toBe(12);
    expect(FINGER_TARGET).toBe(scaleToPx(11));
  });
});
