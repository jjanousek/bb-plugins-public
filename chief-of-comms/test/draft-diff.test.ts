// The word diff behind the reply dock's "Chief changed this draft" highlight.
// Text is invented.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { REWRITE_SHARE, changedShare, diffWords, groupedDiff, hasChange } from "../components/comms/draft-diff.ts";

const join = (parts: { kind: string; text: string }[], keep: string) => parts.filter((p) => p.kind === "same" || p.kind === keep).map((p) => p.text).join("");

describe("diffWords", () => {
  it("marks only the words that changed", () => {
    const parts = diffWords("Quick note: the parcel has left the depot.", "Quick note: the parcel left the depot yesterday.");
    const changed = parts.filter((p) => p.kind !== "same").map((p) => `${p.kind}:${p.text.trim()}`);
    assert.ok(changed.includes("removed:has"), changed.join(" | "));
    assert.ok(changed.some((c) => c.startsWith("added:") && c.includes("yesterday")), changed.join(" | "));
    assert.ok(parts.some((p) => p.kind === "same" && p.text.includes("Quick note: the parcel")));
  });

  it("rebuilds both texts exactly, line breaks included", () => {
    const before = "Hello Maren,\n\nThe bike is still in the shop.\nTalk soon,\nCorvin";
    const after = "Hello Maren,\n\nThe bike is ready to collect.\n\nTalk soon,\nCorvin";
    const parts = diffWords(before, after);
    assert.equal(join(parts, "removed"), before);
    assert.equal(join(parts, "added"), after);
  });

  it("is all same when nothing changed", () => {
    assert.ok(diffWords("Thanks, see you then.", "Thanks, see you then.").every((p) => p.kind === "same"));
  });

  it("shows a very long rewrite as one replacement instead of stalling", () => {
    const long = Array.from({ length: 1000 }, (_, i) => `w${i}`).join(" ");
    const parts = diffWords(long, `${long} more`);
    assert.equal(join(parts, "added"), `${long} more`);
  });
});

describe("hasChange", () => {
  it("ignores surrounding whitespace and a missing previous text", () => {
    assert.equal(hasChange("Hello ", "Hello"), false);
    assert.equal(hasChange(null, "Hello"), false);
    assert.equal(hasChange("Hello", "Hello there"), true);
  });
});

describe("groupedDiff, for reading", () => {
  it("shows a reworded phrase as one struck phrase and one new phrase", () => {
    const parts = groupedDiff("See you at the cafe on Friday.", "See you at the office on Monday.");
    const changed = parts.filter((p) => p.kind !== "same").map((p) => `${p.kind}:${p.text.trim()}`);
    assert.deepEqual(changed, ["removed:cafe on Friday.", "added:office on Monday."]);
  });

  it("still rebuilds both texts exactly", () => {
    const before = "The lanterns for the harbour walk are stored in the blue crate.";
    const after = "Rain is likely on Sunday, so bring a coat and a flask of tea!";
    const parts = groupedDiff(before, after);
    const keep = (kind: string) => parts.filter((p) => p.kind === "same" || p.kind === kind).map((p) => p.text).join("");
    assert.equal(keep("removed").replace(/\s+/g, " ").trim(), before);
    assert.equal(keep("added").replace(/\s+/g, " ").trim(), after);
  });
});

describe("changedShare", () => {
  it("calls a near-total rewrite a rewrite and a one-word fix a small change", () => {
    assert.ok(changedShare("The lanterns are in the blue crate.", "Rain is likely on Sunday, so bring a coat.") > REWRITE_SHARE);
    assert.ok(changedShare("See you at 3pm on Friday, Desma.", "See you at 4pm on Friday, Desma.") < REWRITE_SHARE);
  });
});
