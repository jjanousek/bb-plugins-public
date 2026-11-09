// Discarding a draft asks first exactly when the discard is not a soft delete,
// whichever of the three controls is used (reply dock, list row icon, header
// menu). A mail discard is a real Gmail drafts.delete; bb keeps its own copy
// for 24 hours, which the question has to say, because a question that
// overstates what is lost gets waved through.
//
// Run with: npm test  (node --test, native TypeScript stripping)

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { discardConfirmFor } from "../components/comms/discard-confirm.ts";

describe("discardConfirmFor", () => {
  it("asks before deleting a Gmail draft, because Gmail keeps no copy", () => {
    const prompt = discardConfirmFor({ channel: "mail", counterpart: "odile@example.com" });
    assert.notEqual(prompt, null);
    assert.equal(prompt?.title, "Delete the Gmail draft?");
    assert.equal(prompt?.confirmLabel, "Delete draft");
  });

  it("names the recipient, because the mistake it guards against is the wrong conversation", () => {
    const prompt = discardConfirmFor({ channel: "mail", counterpart: "  Odile Ferrant  " });
    assert.match(prompt?.description ?? "", /draft to Odile Ferrant in Gmail/);
    // Trimmed, and not left with a double space where the name goes.
    assert.doesNotMatch(prompt?.description ?? "", / {2}/);
  });

  it("says what is lost rather than only that it cannot be undone", () => {
    const prompt = discardConfirmFor({ channel: "mail", counterpart: "a@b.invalid" });
    assert.match(prompt?.description ?? "", /not just the row here/);
  });

  it("promises the restore window the server actually keeps, and its end", () => {
    const prompt = discardConfirmFor({ channel: "mail", counterpart: "a@b.invalid" });
    assert.match(prompt?.description ?? "", /24 hours/);
    assert.match(prompt?.description ?? "", /after that it is gone/);
  });

  it("still asks when the draft was never addressed, without a dangling recipient", () => {
    const prompt = discardConfirmFor({ channel: "mail", counterpart: "   " });
    assert.notEqual(prompt, null);
    assert.match(prompt?.description ?? "", /This deletes the draft in Gmail/);
    assert.doesNotMatch(prompt?.description ?? "", /draft to\b/);
  });

  it("does not ask for WhatsApp, where the server soft-deletes and the text is still there", () => {
    assert.equal(discardConfirmFor({ channel: "whatsapp", counterpart: "Odile" }), null);
  });

  it("does not ask for a channel it does not know, which is not a mail delete", () => {
    assert.equal(discardConfirmFor({ channel: "sms", counterpart: "x" }), null);
  });
});
