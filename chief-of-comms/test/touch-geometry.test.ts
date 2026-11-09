import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACTION_DIVIDER_PX,
  ACTION_GAP_CLASS,
  ACTION_GAP_PX,
  FINGER_ACTION_SLOT_DISTANCE,
  DOCK_DESTRUCTIVE_MARGIN_CLASS,
  DOCK_DESTRUCTIVE_MARGIN_PX,
  DOCK_DISCARD_SLOT_DISTANCE,
  DOCK_GAP_PX,
  FINGER_BOX,
  FINGER_SLOT,
  clearBetweenFingerWords,
  MIN_DESTRUCTIVE_GAP,
  clearBetweenFingerBoxes,
} from "../components/comms/touch-geometry.ts";

describe("row action hit boxes", () => {
  it("shows that a tight gap between two bled boxes makes them overlap", () => {
    // gap-0.5 between two bled 44px boxes overlaps by 18px, which is why the
    // row needs the wider gap below.
    assert.equal(clearBetweenFingerBoxes(2), -18);
  });

  it("keeps Dismiss and Discard draft 12px apart on a finger", () => {
    assert.ok(
      clearBetweenFingerBoxes(FINGER_ACTION_SLOT_DISTANCE) >= MIN_DESTRUCTIVE_GAP,
      `only ${clearBetweenFingerBoxes(FINGER_ACTION_SLOT_DISTANCE)}px of clear air`,
    );
  });

  it("counts the hairline between them as part of the distance", () => {
    assert.equal(FINGER_ACTION_SLOT_DISTANCE, ACTION_GAP_PX.finger * 2 + ACTION_DIVIDER_PX);
  });

  it("names a Tailwind gap class for every gap it measures", () => {
    // gap-N is N*4 px. If someone edits the class and forgets the number, or
    // the number and forgets the class, this fails rather than the layout.
    for (const surface of ["finger", "pointer"] as const) {
      const scale = Number(ACTION_GAP_CLASS[surface].slice("gap-".length));
      assert.equal(scale * 4, ACTION_GAP_PX[surface], `${ACTION_GAP_CLASS[surface]} is not ${ACTION_GAP_PX[surface]}px`);
    }
  });

  it("bleeds the box evenly on both sides", () => {
    assert.equal((FINGER_BOX - FINGER_SLOT) % 2, 0);
  });
});

describe("dock word buttons", () => {
  it("shows the spacing a plain word gap gives", () => {
    // gap-x-4 alone, which is what every other word in the row gets.
    assert.equal(clearBetweenFingerWords(DOCK_GAP_PX), 8);
  });

  it("keeps Discard 12px clear of Save draft and Ask chief on a finger", () => {
    assert.ok(
      clearBetweenFingerWords(DOCK_DISCARD_SLOT_DISTANCE) >= MIN_DESTRUCTIVE_GAP,
      `only ${clearBetweenFingerWords(DOCK_DISCARD_SLOT_DISTANCE)}px of clear air`,
    );
  });

  it("names a Tailwind margin class worth the px it claims", () => {
    const scale = Number(DOCK_DESTRUCTIVE_MARGIN_CLASS.slice("mx-".length));
    assert.equal(scale * 4, DOCK_DESTRUCTIVE_MARGIN_PX);
  });
});
