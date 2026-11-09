// The durable half of the auto-draft retry, against the real schema.
//
// Whether an ask is outstanding is stored next to the handled mark, so a
// reload inside the wait keeps both the "handled" and the "check it". The
// sweep below rebuilds the pending checks from what is stored, so it is
// tested against the stored shape, where a wrong column name would show.
//
// Run with: npm test  (node --test, native TypeScript stripping)

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MIGRATIONS, createStore, type PluginDatabase } from "../store.ts";

function freshStore() {
  const db = new DatabaseSync(":memory:");
  for (const statement of MIGRATIONS) {
    try {
      db.exec(statement);
    } catch (cause) {
      if (!String(cause).includes("duplicate column")) throw cause;
    }
  }
  return createStore(db as unknown as PluginDatabase);
}

const JID = "15550100001@s.whatsapp.net";
// Real epoch milliseconds, not toy numbers: setDismissed stamps Math.max(
// Date.now(), lastAt + 1), so a fixture using small integers reads as dismissed
// forever and the dismissal cases pass or fail for the wrong reason.
const BASE = Date.now();
const MSG_AT = BASE - 60 * 60_000;
const ASKED_AT = MSG_AT + 90_000;
const NOW = BASE;

/** Put one message in a chat, which is what bumps its last-message columns. */
function inbound(store: ReturnType<typeof freshStore>, at: number, fromMe = false, id = `m${at}`) {
  store.upsertChat({ jid: JID, name: "A Parent" });
  store.addMessage({
    id,
    chatJid: JID,
    senderJid: JID,
    senderName: "A Parent",
    fromMe,
    text: "is class on Thursday still happening?",
    kind: "text",
    timestamp: at,
  });
}

/** A chat with one inbound message the chief was asked about and never answered. */
function askedAndUnanswered() {
  const store = freshStore();
  inbound(store, MSG_AT);
  store.setAutoDraftMark(JID, MSG_AT, ASKED_AT);
  return store;
}

describe("finding asks that produced nothing", () => {
  it("finds a chat marked handled with no draft to show for it", () => {
    const store = askedAndUnanswered();
    const stale = store.staleAutoDraftAsks(NOW);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].jid, JID);
    assert.equal(stale[0].handledAt, MSG_AT);
  });

  it("does not find one whose ask is still within the wait", () => {
    const store = askedAndUnanswered();
    assert.deepEqual(store.staleAutoDraftAsks(ASKED_AT - 1), []);
  });

  it("does not find one that produced a draft", () => {
    const store = askedAndUnanswered();
    store.createDraft({ id: "d1", chatJid: JID, chatName: "A Parent", text: "hello", sourceThreadId: null });
    assert.deepEqual(store.staleAutoDraftAsks(NOW), []);
  });

  it("does not find one he answered himself", () => {
    const store = askedAndUnanswered();
    inbound(store, MSG_AT + 1, true, "reply");
    assert.deepEqual(store.staleAutoDraftAsks(NOW), []);
  });

  it("does not find one dismissed since the message", () => {
    const store = askedAndUnanswered();
    store.setDismissed(`wa:${JID}`, true);
    assert.deepEqual(store.staleAutoDraftAsks(NOW), []);
  });

  it("finds one dismissed before the message arrived, because that dismissal is spent", () => {
    const store = freshStore();
    inbound(store, MSG_AT, false, "old");
    store.setDismissed(`wa:${JID}`, true);
    // A message that arrives after the dismissal, so the dismissal is spent.
    const later = BASE + 60_000;
    inbound(store, later, false, "new");
    store.setAutoDraftMark(JID, later, ASKED_AT);
    assert.equal(store.staleAutoDraftAsks(later + 1).length, 1);
  });

  it("stops finding it once the ask time is cleared", () => {
    const store = askedAndUnanswered();
    assert.equal(store.staleAutoDraftAsks(NOW).length, 1);
    store.clearAutoDraftAskTime(JID);
    assert.deepEqual(store.staleAutoDraftAsks(NOW), []);
  });

  it("does not find a chat that was never asked about", () => {
    const store = freshStore();
    inbound(store, MSG_AT);
    assert.deepEqual(store.staleAutoDraftAsks(NOW), []);
  });
});
