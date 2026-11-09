// Clear air around this plugin's destructive controls, as arithmetic rather
// than as a comment. Plain .ts with no JSX so the unit test can import it.
//
// The pairing that matters most is a failed tile's Retry and Delete. Retry is
// what a finger reaches for straight after a failed generation, which is the
// moment attention is lowest, so Delete must never be the next thing along.
//
// Two facts to hold on to before editing any of this.
//
// **Measure hit boxes, not glyphs.** A control whose 44px box bleeds past its
// slot with a negative margin has more visible air than tappable air, and the
// visible number is the flattering one.
//
// **These buttons do not bleed.** `ghostButtonClass` in kit.tsx grows to 44px
// on a coarse pointer with `h-11 min-h-11` and `px-3`, no negative margin, so
// the hit box is the layout box and clear air is the sum of the gaps between
// them. `test/touch-geometry.test.ts` reads kit.tsx and fails if a negative
// margin ever appears there, because that would make every number below wrong
// without touching this file.

/** A touch target's side, from `h-11` / `w-11`. */
export const FINGER_TARGET = 44;

/** A destructive control is 44px and 12px clear of its neighbour. */
export const DESTRUCTIVE_MIN_GAP = 12;

/** Tailwind's spacing scale: `gap-1` is 4px. */
export function scaleToPx(scale: number): number {
  return scale * 4;
}

// ---------- the failed tile's action strip ----------
//
// A tile on a phone-width viewport is narrower than two 44px-tall buttons with
// readable labels at `px-3`, the strip's own padding and 12px between them, so
// there is no room to give Delete its clear air. One action belongs on a tile
// that small, and the useful one after a failure is Retry. So Delete is hidden
// on a coarse pointer and the pairing does not exist there at all, which is
// safer than spacing it. Deleting from a phone goes through the Viewer,
// one tap away, where Delete has more than the floor of clear air and its own
// confirm.

/** The strip's flex gap. Mouse only: precision is not the problem there. */
export const TILE_ACTION_GAP = { class: "gap-1", px: scaleToPx(1) } as const;

/** Hides the tile's Delete where two 44px targets cannot both fit. */
export const TILE_DESTRUCTIVE_HIDDEN_ON_FINGER = "max-md:pointer-coarse:hidden";

/** The strip's gap is below the destructive floor, which is why Delete is hidden on a finger. */
export const TILE_GAP_BELOW_FLOOR = TILE_ACTION_GAP.px < DESTRUCTIVE_MIN_GAP;

// ---------- the Viewer header ----------
//
// Star, Download, a hairline, then Delete. This one passes, and it is pinned
// here so it cannot quietly drop to the floor: a passing number with nothing
// holding it is one class edit from failing.

/** The header row's gap on a coarse pointer, `max-md:pointer-coarse:gap-1`. */
export const HEADER_GAP = { class: "max-md:pointer-coarse:gap-1", px: scaleToPx(1) } as const;

/** The hairline between Download and Delete: a flex item with `mx-1` either side. */
export const HEADER_DIVIDER = { class: "mx-1", marginPx: scaleToPx(1), widthPx: 1 } as const;

/** Delete's own left margin on a coarse pointer, `max-md:pointer-coarse:ml-1`. */
export const HEADER_DESTRUCTIVE_MARGIN = { class: "max-md:pointer-coarse:ml-1", px: scaleToPx(1) } as const;

/**
 * Clear air between Download's right edge and Delete's left edge on a finger.
 *
 * The divider is a flex item, so the row's gap is paid twice, once on each side
 * of it.
 */
export function headerClearAir(): number {
  return HEADER_GAP.px * 2 + HEADER_DIVIDER.marginPx * 2 + HEADER_DIVIDER.widthPx + HEADER_DESTRUCTIVE_MARGIN.px;
}

// ---------- the Viewer's action sheet ----------
//
// On a phone the Viewer's header holds back, the position and a `...` button,
// and Star, Copy prompt, Full resolution, Edit workflow, Graph and Delete live
// in a bottom sheet. Every row there is 44px (`min-h-11`), and Delete is the
// last row, set apart by a hairline with air on both sides. A destructive
// control needs 12px between it and its neighbour; the rows
// themselves sit flush, so the separator is the whole of that air.

/** The wrapper around Delete: a margin, a hairline and a padding, in that order. */
export const SHEET_DELETE_SEPARATOR = { class: "mt-2 border-t border-border/60 pt-2", marginPx: scaleToPx(2), borderPx: 1, paddingPx: scaleToPx(2) } as const;

/** The height of every row in the sheet, from `min-h-11`. */
export const SHEET_ROW = { class: "min-h-11", px: FINGER_TARGET } as const;

/** Clear air between the last ordinary row's bottom edge and Delete's top edge. */
export function sheetDeleteClearAir(): number {
  return SHEET_DELETE_SEPARATOR.marginPx + SHEET_DELETE_SEPARATOR.borderPx + SHEET_DELETE_SEPARATOR.paddingPx;
}
