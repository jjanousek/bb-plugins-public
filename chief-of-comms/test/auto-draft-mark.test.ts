// The auto-draft mark rollback, driven through the real store.
//
// setAutoDraftMark(jid, 0) cannot lower the mark: the setter returns early on
// at <= 0, and its upsert takes MAX(existing, new), so the mark is monotonic on
// purpose. The rollback therefore needs its own path. test/auto-draft-retry.test.ts
// keeps the mark in a plain local object, where lowering it always works, so it
// cannot catch this.
//
// So these run against a real sqlite database with the plugin's own migrations.
// The thing under test is the SQL and the monotonicity, which no fake can stand
// in for.
//
// Run with: npm test  (node --test, native TypeScript stripping)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MIGRATIONS, createStore, type PluginDatabase } from "../store.ts";
import { MAX_ASK_ATTEMPTS, countEmptyAsk, decideAutoDraft, verifyAsk } from "../auto-draft-retry.ts";

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

describe("the auto-draft mark", () => {
  it("refuses to go backwards through the setter, which is why a rollback needs its own path", () => {
    const store = freshStore();
    store.setAutoDraftMark(JID, 1_000);
    store.setAutoDraftMark(JID, 0);
    assert.equal(store.autoDraftMark(JID), 1_000, "zero is refused before any SQL runs");
    store.setAutoDraftMark(JID, 500);
    assert.equal(store.autoDraftMark(JID), 1_000, "and a lower value is swallowed by MAX()");
  });

  it("rolls back to unhandled, so the burst is asked about again", () => {
    const store = freshStore();
    store.setAutoDraftMark(JID, 1_000);
    store.rollbackAutoDraftMark(JID, 1_000);
    assert.equal(store.autoDraftMark(JID), 0);
    // The point of the rollback: the next tick sends rather than skipping.
    const d = decideAutoDraft({
      lastMessageAt: 1_000,
      mark: store.autoDraftMark(JID),
      lastFromMe: false,
      muted: false,
      dismissed: false,
      hasPendingDraft: false,
      cooldownUntil: 0,
      now: 2_000,
    });
    assert.deepEqual(d, { action: "send" });
  });

  it("leaves a newer burst's mark alone", () => {
    // A message arriving mid-ask writes its own mark. Rolling that back would
    // re-ask for something already in flight, so the compare is in the DELETE.
    const store = freshStore();
    store.setAutoDraftMark(JID, 2_000);
    store.rollbackAutoDraftMark(JID, 1_000);
    assert.equal(store.autoDraftMark(JID), 2_000);
  });

  it("is a no-op on a chat that was never marked", () => {
    const store = freshStore();
    store.rollbackAutoDraftMark(JID, 1_000);
    assert.equal(store.autoDraftMark(JID), 0);
  });
});

describe("the attempt cap survives a rollback", () => {
  it("rolling the mark back keeps the attempt count", () => {
    const store = freshStore();
    store.setAutoDraftMark(JID, 1_000, 1_000);
    store.setAutoDraftAttempts(JID, 1);
    store.rollbackAutoDraftMark(JID, 1_000);
    assert.equal(store.autoDraftMark(JID), 0, "unhandled again");
    assert.equal(store.autoDraftAskedAt(JID), null, "and no ask outstanding");
    store.setAutoDraftMark(JID, 1_000, 2_000);
    assert.equal(store.autoDraftAttempts(JID), 1, "the count was kept");
  });

  it("four asks that produce nothing give up on the fourth, through the real store", () => {
    const store = freshStore();
    const outcome = { ok: false as const, rateLimited: false, error: "produced nothing" };
    const results = [];
    for (let round = 0; round < MAX_ASK_ATTEMPTS; round += 1) {
      store.setAutoDraftMark(JID, 1_000, 1_000 + round);
      results.push(countEmptyAsk(store, JID, 1_000, outcome, 10_000));
    }
    assert.deepEqual(results.map((r) => r.giveUp), [false, false, false, true]);
    assert.equal(results[3]!.attempt, MAX_ASK_ATTEMPTS);
    assert.equal(store.autoDraftMark(JID), 1_000, "giving up keeps the mark, which stops the loop");
  });

  it("resets the count only when an ask settles, not when it is delivered", () => {
    const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    const at = source.indexOf('await requestDraftFor(key, "automatic");');
    assert.ok(at > 0);
    assert.doesNotMatch(source.slice(at, at + 400), /setAutoDraftAttempts\(jid, 0\)/);
    assert.match(source, /if \(result\.settled\) \{[\s\S]{0,400}setAutoDraftAttempts\(jid, 0\)/);
  });
});

describe("a draft the chief keeps settles the ask", () => {
  function chatWithOldDraft() {
    const db = new DatabaseSync(":memory:");
    for (const statement of MIGRATIONS) {
      try {
        db.exec(statement);
      } catch (cause) {
        if (!String(cause).includes("duplicate column")) throw cause;
      }
    }
    const store = createStore(db as unknown as PluginDatabase);
    const jid = "chat-keep@chat.invalid";
    db.prepare(`INSERT INTO wa_chats (jid, name, is_group, last_message_at, last_message_text, last_from_me) VALUES (?, 'Nel', 0, 0, 'hi', 0)`).run(jid);
    const draft = store.createDraft({ id: "d-nel", chatJid: jid, chatName: "Nel", text: "Thursday works for us.", sourceThreadId: null });
    const askedFor = draft.updatedAt + 60_000;
    db.prepare(`INSERT INTO wa_messages (id, chat_jid, from_me, text, timestamp) VALUES ('n2', ?, 0, 'ok?', ?)`).run(jid, askedFor);
    return { db, store, jid, draft, askedFor };
  }
  const state = (store: ReturnType<typeof createStore>, jid: string, askedFor: number) => {
    const pending = store.pendingDraftFor(jid);
    return { markNow: askedFor, askedFor, hasPendingDraft: pending !== null, pendingDraftAt: pending?.updatedAt ?? null, dismissed: false, failure: null };
  };

  it("an ask over an old draft that the chief confirms as kept settles", () => {
    const { store, jid, askedFor } = chatWithOldDraft();
    assert.equal(verifyAsk(state(store, jid, askedFor)).settled, false, "unanswered while the draft is older than the burst");
    const kept = store.keepPendingDraft(jid, askedFor + 5_000);
    assert.equal(kept?.text, "Thursday works for us.", "the text is unchanged");
    assert.equal(verifyAsk(state(store, jid, askedFor)).settled, true);
  });

  it("a draft he overtook is not kept", () => {
    const { db, store, jid, draft } = chatWithOldDraft();
    db.prepare(`INSERT INTO wa_messages (id, chat_jid, from_me, text, timestamp) VALUES ('n3', ?, 1, 'answered by hand', ?)`).run(jid, draft.updatedAt + 120_000);
    assert.equal(store.keepPendingDraft(jid), null);
  });

  it("the replace prompt points the chief at comms_wa_keep", () => {
    const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    assert.match(source, /Decide whether that draft still fits\. If it still answers the newest message as it stands, call \\`comms_wa_keep/);
    assert.match(source, /name: "comms_wa_keep"[\s\S]{0,1200}store\.keepPendingDraft\(target\.jid\)/);
  });
});
