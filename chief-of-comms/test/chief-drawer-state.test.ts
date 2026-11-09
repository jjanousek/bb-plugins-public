// What the chief drawer and its About card remember between visits.
//
// Run with: npm test  (node --test, native TypeScript stripping)
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ABOUT_MEMORY_LIMIT,
  aboutOpenFor,
  initialDrawerOpen,
  parseAboutMemory,
  rememberAbout,
} from "../components/comms/chief-drawer-state.ts";

describe("initialDrawerOpen", () => {
  it("starts open from 1024px and closed below when nothing is stored", () => {
    assert.equal(initialDrawerOpen(null, 1024), true);
    assert.equal(initialDrawerOpen(null, 1023), false);
  });

  it("follows the stored choice on a desktop width", () => {
    assert.equal(initialDrawerOpen("closed", 1600), false);
    assert.equal(initialDrawerOpen("open", 900), true);
  });

  it("ignores a stored value it does not know", () => {
    assert.equal(initialDrawerOpen("yes", 1600), true);
    assert.equal(initialDrawerOpen("yes", 900), false);
  });

  it("starts closed on a phone even when left open, so Comms opens on the inbox", () => {
    assert.equal(initialDrawerOpen("open", 390), false);
    assert.equal(initialDrawerOpen("open", 767), false);
    assert.equal(initialDrawerOpen("open", 768), true);
  });
});

describe("About card memory", () => {
  it("reads anything unreadable as an empty map", () => {
    assert.deepEqual(parseAboutMemory(null), {});
    assert.deepEqual(parseAboutMemory("not json"), {});
    assert.deepEqual(parseAboutMemory("[true]"), {});
    assert.deepEqual(parseAboutMemory('{"a":true,"b":"yes","c":false}'), { a: true, c: false });
  });

  it("is open for a conversation it has not seen", () => {
    assert.equal(aboutOpenFor({}, "wa:1"), true);
    assert.equal(aboutOpenFor({ "wa:1": false }, "wa:1"), false);
  });

  it("remembers per conversation without touching the others", () => {
    const once = rememberAbout({ "wa:1": false }, "mail:work:t2", false);
    assert.deepEqual(once, { "wa:1": false, "mail:work:t2": false });
    const again = rememberAbout(once, "wa:1", true);
    assert.equal(again["wa:1"], true);
    assert.equal(again["mail:work:t2"], false);
  });

  it("keeps the newest keys when the map is full", () => {
    let memory = {};
    for (let i = 0; i < ABOUT_MEMORY_LIMIT + 5; i += 1) memory = rememberAbout(memory, `k${i}`, false);
    const keys = Object.keys(memory);
    assert.equal(keys.length, ABOUT_MEMORY_LIMIT);
    assert.equal(keys.includes("k0"), false);
    assert.equal(keys.at(-1), `k${ABOUT_MEMORY_LIMIT + 4}`);
  });
});
