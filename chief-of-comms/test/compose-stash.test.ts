// What the reply dock opens with, given unsaved text and the stored draft.
// Names and texts are invented.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openWith } from "../components/comms/compose-stash.ts";

describe("unsaved text in the reply dock", () => {
  it("never puts an old draft's text into a new draft on the same thread", () => {
    // Typed into draft A (to Desma, since sent). Draft B (to Sam) is stored now.
    const opened = openWith({ text: "Hi Desma, the parcel is on its way", draftId: "r-A" }, "r-B", "Hi Sam, Monday 10:00 works");
    assert.equal(opened.text, "Hi Sam, Monday 10:00 works");
    assert.equal(opened.dirty, false);
    assert.equal(opened.orphan, "Hi Desma, the parcel is on its way");
  });

  it("keeps unsaved edits to the same draft", () => {
    const opened = openWith({ text: "Hi Sam, Monday 11:00 works", draftId: "r-B" }, "r-B", "Hi Sam, Monday 10:00 works");
    assert.deepEqual(opened, { text: "Hi Sam, Monday 11:00 works", dirty: true, orphan: null });
  });

  it("shows the stored draft when there is nothing unsaved", () => {
    assert.deepEqual(openWith(undefined, "r-B", "Hi Sam"), { text: "Hi Sam", dirty: false, orphan: null });
  });

  it("keeps a reply typed before any draft, while there is still none", () => {
    assert.deepEqual(openWith({ text: "Thanks!", draftId: null }, null, ""), { text: "Thanks!", dirty: true, orphan: null });
  });

  it("does not let text typed before a draft existed override the draft that appeared", () => {
    const opened = openWith({ text: "Thanks!", draftId: null }, "r-C", "Thank you, see you Friday.");
    assert.equal(opened.text, "Thank you, see you Friday.");
    assert.equal(opened.dirty, false);
    assert.equal(opened.orphan, "Thanks!");
  });

  it("offers nothing when the old text and the new draft say the same", () => {
    assert.equal(openWith({ text: "Same text", draftId: "r-A" }, "r-B", "Same text").orphan, null);
  });
});
