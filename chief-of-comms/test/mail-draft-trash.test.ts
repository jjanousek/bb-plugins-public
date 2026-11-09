// A discarded Gmail draft is recoverable for a day. Gmail's drafts.delete
// destroys rather than trashes, so the only copy is the one bb takes first,
// and these tests are what say the copy is complete, that the window is real
// at both ends, and that the purge and the offer agree about where it ends.
// An off-by-one between them would advertise an undo for a row already gone.
//
// Runs against a real sqlite database (node:sqlite, in memory) with the
// plugin's own migrations, because the thing under test is the schema and the
// SQL, not a shape a fake could stand in for.
//
// Run with: npm test  (node --test, native TypeScript stripping)

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MIGRATIONS, RESTORE_WINDOW_MS, createStore, type PluginDatabase } from "../store.ts";

function freshStore() {
  const db = new DatabaseSync(":memory:");
  for (const statement of MIGRATIONS) {
    try {
      db.exec(statement);
    } catch (cause) {
      // ALTER TABLE ADD COLUMN re-runs are how the plugin's migration list
      // works against an existing database; a fresh one is no different.
      if (!String(cause).includes("duplicate column")) throw cause;
    }
  }
  return createStore(db as unknown as PluginDatabase);
}

function discard(store: ReturnType<typeof freshStore>, at: number, draftId = "r1") {
  store.trashMailDraft({
    account: "work",
    draftId,
    threadId: "t1",
    to: "desma.sample@brookvale.invalid",
    cc: null,
    subject: "Garden plans",
    body: "Hi Desma,\n\nThe tulips can go along the north fence, if that suits you.",
    inReplyTo: "<CA+abc@mail.invalid>",
    replyToId: "1a0000000000bbb7",
    conversationKey: "mail:work:t1",
    at,
  });
}

describe("discarded Gmail drafts", () => {
  it("keeps everything needed to write the draft again", () => {
    const store = freshStore();
    discard(store, 1_000);
    const row = store.trashedMailDraft("work", "r1");
    assert.equal(row?.to_header, "desma.sample@brookvale.invalid");
    assert.equal(row?.subject, "Garden plans");
    assert.match(row?.body ?? "", /tulips can go/);
    // Two different ids, and the restore needs the second one: the header is
    // RFC, and Gmail's draft API threads by its own message id. The id is
    // resolved at discard time because deleting the draft can prune the
    // cached thread it would have been read from.
    assert.equal(row?.in_reply_to, "<CA+abc@mail.invalid>");
    assert.equal(row?.reply_to_id, "1a0000000000bbb7");
    assert.notEqual(row?.in_reply_to, row?.reply_to_id);
    assert.equal(row?.thread_id, "t1");
    assert.equal(row?.conversation_key, "mail:work:t1");
  });

  it("offers the newest discard while it is inside the window", () => {
    const store = freshStore();
    const now = 10 * RESTORE_WINDOW_MS;
    discard(store, now - 1);
    assert.equal(store.newestTrashedMailDraft(now)?.draft_id, "r1");
  });

  it("offers nothing once the window has passed", () => {
    const store = freshStore();
    const now = 10 * RESTORE_WINDOW_MS;
    discard(store, now - RESTORE_WINDOW_MS - 1);
    assert.equal(store.newestTrashedMailDraft(now), null);
  });

  it("purges exactly what it stops offering, and nothing it still offers", () => {
    const store = freshStore();
    const now = 10 * RESTORE_WINDOW_MS;
    // Sitting on the boundary from both sides: the purge and the offer have
    // to draw the line in the same place or one advertises a row the other
    // has deleted.
    for (const at of [now - RESTORE_WINDOW_MS, now - RESTORE_WINDOW_MS + 1]) {
      const store2 = freshStore();
      discard(store2, at);
      const offered = store2.newestTrashedMailDraft(now) !== null;
      const purged = store2.purgeTrashedMailDrafts(now) === 1;
      assert.notEqual(offered, purged, `at ${at}: offered=${offered} purged=${purged}`);
    }
    discard(store, now);
    assert.equal(store.purgeTrashedMailDrafts(now), 0);
  });

  it("a second discard of the same draft replaces the copy rather than failing", () => {
    const store = freshStore();
    discard(store, 1_000);
    discard(store, 2_000);
    assert.equal(store.trashedMailDraft("work", "r1")?.discarded_at, 2_000);
  });

  it("forgets the copy once it has been used", () => {
    const store = freshStore();
    discard(store, 1_000);
    store.dropTrashedMailDraft("work", "r1");
    assert.equal(store.trashedMailDraft("work", "r1"), null);
  });

  it("lists what is still restorable, newest first, and drops what is not", () => {
    // This is the list the panel shows. It has to draw the window at the same
    // place the offer and the purge do, or the panel hands him a restore
    // control for a row that is already gone.
    const store = freshStore();
    const now = 10 * RESTORE_WINDOW_MS;
    discard(store, now - 60_000, "recent");
    discard(store, now - 3 * 60_000, "older");
    discard(store, now - RESTORE_WINDOW_MS - 1, "expired");
    assert.deepEqual(
      store.trashedMailDrafts(now).map((row) => row.draft_id),
      ["recent", "older"],
    );
  });

  it("keeps the window at a day, which is what the dialog promises", () => {
    assert.equal(RESTORE_WINDOW_MS, 24 * 60 * 60 * 1000);
  });
});

// The audit row is written before the delete and is not conditional on it
// working, so a delete that throws still leaves a trace of which caller did it.
describe("the discard audit", () => {
  it("writes the attempt before the outcome is known", () => {
    const store = freshStore();
    const id = store.recordMailDiscardAttempt({
      account: "work",
      draftId: "r1",
      threadKey: "mail:work:t1",
      caller: "panel:draft_discard",
      copyTaken: true,
    });
    const [row] = store.mailDiscardAudit();
    assert.equal(row.id, id);
    assert.equal(row.draft_id, "r1");
    assert.equal(row.caller, "panel:draft_discard");
    assert.equal(row.copy_taken, 1);
    // The row exists with no outcome yet: this is the state a delete that
    // throws leaves behind, which is why the attempt is written first.
    assert.equal(row.outcome, null);
  });

  it("keeps a row whose delete never came back distinguishable from a clean one", () => {
    const store = freshStore();
    const crashed = store.recordMailDiscardAttempt({
      account: "work", draftId: "r-crashed", threadKey: null, caller: "cli:discard", copyTaken: true,
    });
    const clean = store.recordMailDiscardAttempt({
      account: "work", draftId: "r-clean", threadKey: null, caller: "chief-tool", copyTaken: true,
    });
    store.setMailDiscardOutcome(clean, "deleted");
    const byId = new Map(store.mailDiscardAudit().map((r) => [r.id, r]));
    assert.equal(byId.get(crashed)?.outcome, null);
    assert.equal(byId.get(clean)?.outcome, "deleted");
  });

  it("records a failure as an outcome rather than losing the row", () => {
    const store = freshStore();
    const id = store.recordMailDiscardAttempt({
      account: "work", draftId: "r2", threadKey: null, caller: "cli:mail-draft-delete", copyTaken: true,
    });
    store.setMailDiscardOutcome(id, "failed: api error (404): no such draft");
    assert.match(store.mailDiscardAudit()[0].outcome ?? "", /404/);
  });
});
