// Hit-box arithmetic for the row action icons. Plain .ts on purpose: the unit
// tests import it, and node --test strips types but cannot compile JSX.
//
// FINGER_ICON in signals.tsx is "-m-2.5 size-11": a 44px hit box bled 10px
// past each side of the 24px slot it sits in. Two such boxes in a gap-0.5 row
// would overlap by 18px, and because Discard draft is the later flex item it
// paints on top, so a tap on the right third of the visible Dismiss glyph
// would delete a Gmail draft. The gap below keeps the boxes apart.

/** Side of the finger hit box, from `size-11`. */
export const FINGER_BOX = 44;
/** Layout width the box occupies, before `-m-2.5` bleeds it out. */
export const FINGER_SLOT = 24;
/** A destructive action is 44px and 12px clear of its neighbour. */
export const MIN_DESTRUCTIVE_GAP = 12;

/**
 * Clear air between two finger hit boxes whose 24px slots are `slotDistance`
 * apart. Negative means the boxes overlap and the top one wins the tap.
 *
 * This is the number the minimum gap applies to. The distance between the slots, and the
 * gap the eye sees, are both larger and neither is a safety figure: quote what
 * this function returns. At `gap-5` it is 21px, chosen over the
 * 13px that `gap-4` gave, because 13 clears the 12px floor by one pixel and a
 * fingertip contact patch is about 45px wide. 21 is not generous either, but
 * it is a real margin.
 */
export function clearBetweenFingerBoxes(slotDistance: number): number {
  return slotDistance - (FINGER_BOX - FINGER_SLOT);
}

/** Flex gap on the row's action strip. Both are literals so Tailwind emits them. */
export const ACTION_GAP_CLASS = { finger: "gap-5", pointer: "gap-0.5" } as const;
/** What those classes are worth in px. */
export const ACTION_GAP_PX = { finger: 20, pointer: 2 } as const;
/** The hairline between Dismiss and Discard draft is a flex item of its own. */
export const ACTION_DIVIDER_PX = 1;

/** Slot-edge distance between Dismiss and Discard draft on a finger surface. */
export const FINGER_ACTION_SLOT_DISTANCE = ACTION_GAP_PX.finger * 2 + ACTION_DIVIDER_PX;

// --- the dock's word buttons -------------------------------------------
//
// FINGER_WORD in signals.tsx is "-mx-1 -my-3 min-h-11 px-1": a 44px-tall box
// bled 4px past each side of its slot. The dock row is gap-x-4, so two
// neighbouring words are 8px apart on a finger, and Discard sits between
// Save draft and Ask chief. 8px is under the 12px minimum and the left-hand neighbour
// is the button you press when you want to keep the text.

/** How far a dock word button bleeds past its slot on each side. */
export const FINGER_WORD_BLEED = 4;
/** The dock action row's gap, from `gap-x-4`. */
export const DOCK_GAP_PX = 16;
/** Extra margin the destructive word carries on a finger, from `mx-2`. */
export const DOCK_DESTRUCTIVE_MARGIN_CLASS = "mx-2";
export const DOCK_DESTRUCTIVE_MARGIN_PX = 8;

/** Clear air between two dock word buttons whose slots are `slotDistance` apart. */
export function clearBetweenFingerWords(slotDistance: number): number {
  return slotDistance - FINGER_WORD_BLEED * 2;
}

/** Slot distance from Discard to either neighbour on a finger surface. */
export const DOCK_DISCARD_SLOT_DISTANCE = DOCK_GAP_PX + DOCK_DESTRUCTIVE_MARGIN_PX;
