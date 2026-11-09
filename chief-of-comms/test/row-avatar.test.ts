// The list row avatar: initials and a colour picked from the name.
// Run with: npm test  (node --test, native TypeScript stripping)

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { avatarTone, todoCount } from "../components/comms/format.ts";

describe("avatarTone", () => {
  it("is stable for a name and ignores case and outer space", () => {
    assert.equal(avatarTone("Desma Sample"), avatarTone("  desma sample "));
  });
  it("always returns one of the six tones", () => {
    for (const name of ["", "a", "Desma", "Marja Ostrander", "Lotte Brink", "+1 555", "group"]) {
      assert.match(avatarTone(name), /^bg-\[#[0-9a-f]{6}\] text-\[#[0-9a-f]{6}\]$/, name);
    }
  });
  it("spreads a handful of names over more than one tone", () => {
    const names = ["Desma Sample", "Marja Ostrander", "Lotte Brink", "Petra Rochat", "Teodor Hayes", "Isolde Voss", "Kasimir Brandl"];
    assert.ok(new Set(names.map(avatarTone)).size >= 3);
  });
});

describe("todoCount", () => {
  const row = (needsReply: boolean, readyToSend = true, stale = false) => ({ needsReply, readyToSend, stale });
  it("counts a conversation in both sets once", () => {
    assert.equal(todoCount(8, 6, [row(true), row(true), row(false), row(false), row(false), row(false)]), 12);
  });
  it("adds the two when nothing overlaps", () => {
    assert.equal(todoCount(8, 6, [row(false), row(false)]), 14);
  });
  it("ignores stale and not ready rows", () => {
    assert.equal(todoCount(3, 1, [row(true, true, true), row(true, false)]), 4);
  });
  it("says nothing until the ready rows are loaded", () => {
    assert.equal(todoCount(3, 1, null), null);
  });
});

import { askLine } from "../components/comms/format.ts";

describe("askLine", () => {
  // "Ask chief…" puts this in the chief's composer and sends nothing: it must
  // name the conversation well enough for the chief to find it, and leave the
  // question to him.
  it("names the person, the subject and the key, and ends ready for his question", () => {
    const line = askLine({ key: "mail:work:t1", title: "Re: Room booking", counterpart: "Desma Sample", channel: "mail" }, true);
    assert.equal(line, "About Desma Sample (Re: Room booking), mail:work:t1, the draft in the dock:");
  });

  it("uses the chat name for WhatsApp", () => {
    assert.equal(askLine({ key: "wa:x@chat.invalid", title: "Lenart Pryce", counterpart: "+000", channel: "whatsapp" }, false), "About Lenart Pryce, wa:x@chat.invalid:");
  });
});
