// A dismissed conversation stays dismissed, and a draft already sent from
// Gmail or Superhuman stops showing as ready to send. Both run against the
// real schema, because the thing under test is the SQL.
//
// Names and addresses are invented.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MIGRATIONS, createStore, originOfThread, type PluginDatabase } from "../store.ts";

function freshStore() {
  const db = new DatabaseSync(":memory:");
  for (const statement of MIGRATIONS) {
    try {
      db.exec(statement);
    } catch (cause) {
      if (!String(cause).includes("duplicate column")) throw cause;
    }
  }
  const store = createStore(db as unknown as PluginDatabase, { emailOf: () => "me@example.com" });
  return { db, store };
}

const MIN = 60_000;

describe("a dismissed WhatsApp chat", () => {
  function chat() {
    const { db, store } = freshStore();
    const jid = "chat-one@chat.invalid";
    const t0 = Date.now() - 60 * MIN;
    db.prepare(`INSERT INTO wa_chats (jid, name, is_group, last_message_at, last_message_text, last_from_me) VALUES (?, 'Desma', 0, ?, 'hi', 0)`).run(jid, t0);
    db.prepare(`INSERT INTO wa_messages (id, chat_jid, from_me, text, timestamp) VALUES ('m1', ?, 0, 'hi', ?)`).run(jid, t0);
    const key = `wa:${jid}`;
    const add = (id: string, fromMe: boolean, at: number) => {
      db.prepare(`INSERT INTO wa_messages (id, chat_jid, from_me, text, timestamp) VALUES (?, ?, ?, 'x', ?)`).run(id, jid, fromMe ? 1 : 0, at);
      db.prepare(`UPDATE wa_chats SET last_message_at = ?, last_from_me = ? WHERE jid = ?`).run(at, fromMe ? 1 : 0, jid);
    };
    return { store, key, add };
  }

  it("stays dismissed when the user writes into it afterwards", () => {
    const { store, key, add } = chat();
    store.setDismissed(key, true);
    add("m2", true, Date.now() + 5 * MIN);
    assert.equal(store.conversation(key)?.dismissed, true);
  });

  it("comes back when the other side writes again", () => {
    const { store, key, add } = chat();
    store.setDismissed(key, true);
    add("m3", false, Date.now() + 5 * MIN);
    assert.equal(store.conversation(key)?.dismissed, false);
  });
});

describe("a mail draft overtaken by a reply sent elsewhere", () => {
  function thread() {
    const { db, store } = freshStore();
    const t0 = Date.now() - 120 * MIN;
    db.prepare(
      `INSERT INTO mail_threads (account, thread_id, subject, last_at, last_from, last_from_me, message_count) VALUES ('work', 't1', 'Fees', ?, 'Desma <desma@example.com>', 0, 1)`,
    ).run(t0);
    db.prepare(
      `INSERT INTO mail_messages (account, id, thread_id, date_ms, from_header, to_header, subject, body, from_me, labels) VALUES ('work', 'in1', 't1', ?, 'Desma <desma@example.com>', 'me@example.com', 'Fees', 'Question', 0, '["INBOX"]')`,
    ).run(t0);
    store.upsertMailDraft({ account: "work", draftId: "r1", messageId: "dm1", threadId: "t1", to: "desma@example.com", cc: null, subject: "Re: Fees", body: "Answer", updatedAt: t0 + MIN });
    return { db, store };
  }

  it("is ready to send while nothing newer went out", () => {
    const { store } = thread();
    assert.equal(store.conversation("mail:work:t1")?.readyToSend, true);
    assert.equal(store.overtakenMailDrafts("work").length, 0);
  });

  it("stops being ready, and is checked against Gmail, once a later reply was sent", () => {
    const { db, store } = thread();
    db.prepare(
      `INSERT INTO mail_messages (account, id, thread_id, date_ms, from_header, to_header, subject, body, from_me, labels) VALUES ('work', 'out1', 't1', ?, 'me@example.com', 'desma@example.com', 'Re: Fees', 'Answer', 1, '["SENT"]')`,
    ).run(Date.now() - 10 * MIN);
    assert.equal(store.conversation("mail:work:t1")?.readyToSend, false);
    assert.deepEqual(store.overtakenMailDrafts("work").map((row) => row.draft_id), ["r1"]);
  });
});

describe("the Waiting list", () => {
  it("holds a recent thread where the user wrote last, and drops it when done or old", () => {
    const { db, store } = freshStore();
    const jid = "chat-two@chat.invalid";
    const recent = Date.now() - 2 * 24 * 60 * MIN;
    db.prepare(`INSERT INTO wa_chats (jid, name, is_group, last_message_at, last_message_text, last_from_me) VALUES (?, 'Lee', 0, ?, 'see you', 1)`).run(jid, recent);
    db.prepare(`INSERT INTO wa_messages (id, chat_jid, from_me, text, timestamp) VALUES ('w1', ?, 1, 'see you', ?)`).run(jid, recent);
    const waiting = () => store.conversations({ filter: "waiting" }).map((c) => c.key);
    assert.deepEqual(waiting(), [`wa:${jid}`]);
    store.setDismissed(`wa:${jid}`, true);
    assert.deepEqual(waiting(), [], "Done takes it off the list");
    store.setDismissed(`wa:${jid}`, false);
    db.prepare(`UPDATE wa_chats SET last_message_at = ? WHERE jid = ?`).run(Date.now() - 20 * 24 * 60 * MIN, jid);
    assert.deepEqual(waiting(), [], "a chat quiet for 20 days is finished, not waiting");
  });
});

describe("a WhatsApp draft overtaken by a message the user sent himself", () => {
  it("stops being ready to send once he writes in the chat after it was saved", () => {
    const { db, store } = freshStore();
    const jid = "chat-three@chat.invalid";
    const t0 = Date.now() - 600 * MIN;
    db.prepare(`INSERT INTO wa_chats (jid, name, is_group, last_message_at, last_message_text, last_from_me) VALUES (?, 'Rae', 0, ?, 'hi', 0)`).run(jid, t0);
    db.prepare(`INSERT INTO wa_messages (id, chat_jid, from_me, text, timestamp) VALUES ('r1', ?, 0, 'hi', ?)`).run(jid, t0);
    const draft = store.createDraft({ id: "d-rae", chatJid: jid, chatName: "Rae", text: "Hello back", sourceThreadId: null });
    assert.equal(store.conversation(`wa:${jid}`)?.readyToSend, true);
    const later = draft.updatedAt + 60 * MIN;
    db.prepare(`INSERT INTO wa_messages (id, chat_jid, from_me, text, timestamp) VALUES ('r2', ?, 1, 'written outside the panel', ?)`).run(jid, later);
    db.prepare(`UPDATE wa_chats SET last_message_at = ?, last_from_me = 1 WHERE jid = ?`).run(later, jid);
    assert.equal(store.conversation(`wa:${jid}`)?.readyToSend, false);
  });
});

describe("the chief's change on a draft, kept for the dock's highlight", () => {
  it("holds the previous text until the draft says something else", () => {
    const { store } = freshStore();
    store.recordDraftRevision("wa:d1", "Hi, see you at 3.", "Hi, see you at 4.");
    assert.deepEqual(store.draftRevision("wa:d1", "Hi, see you at 4.")?.before, "Hi, see you at 3.");
    // The owner edited it since: the old highlight no longer describes the box.
    assert.equal(store.draftRevision("wa:d1", "Hi, see you at 5."), null);
  });

  it("keeps the first before across two rewrites he has not looked at", () => {
    const { store } = freshStore();
    store.recordDraftRevision("wa:d2", "one", "two");
    store.recordDraftRevision("wa:d2", "two", "three");
    assert.equal(store.draftRevision("wa:d2", "three")?.before, "one");
  });

  it("records nothing for a rewrite that changes nothing, and forgets on clear", () => {
    const { store } = freshStore();
    store.recordDraftRevision("wa:d3", "same ", "same");
    assert.equal(store.draftRevision("wa:d3", "same"), null);
    store.recordDraftRevision("wa:d3", "a", "b");
    store.clearDraftRevision("wa:d3");
    assert.equal(store.draftRevision("wa:d3", "b"), null);
  });
});

describe("who gets a voice file, and which of his messages are samples", () => {
  it("counts one-to-one WhatsApp chats and people he mailed alone, never groups", () => {
    const { db, store } = freshStore();
    const now = Date.now();
    db.prepare(`INSERT INTO wa_chats (jid, name, is_group, last_message_at, last_message_text, last_from_me) VALUES ('p1@chat.invalid', 'Hollis', 0, ?, 'x', 1)`).run(now);
    db.prepare(`INSERT INTO wa_chats (jid, name, is_group, last_message_at, last_message_text, last_from_me) VALUES ('group-one@g-us.invalid', 'Group', 1, ?, 'x', 1)`).run(now);
    db.prepare(`INSERT INTO wa_messages (id, chat_jid, from_me, text, kind, timestamp) VALUES ('w1', 'p1@chat.invalid', 1, 'See you on Friday at the usual place, bring the laptop.', 'text', ?)`).run(now);
    db.prepare(`INSERT INTO wa_messages (id, chat_jid, from_me, text, kind, timestamp) VALUES ('w2', 'group-one@g-us.invalid', 1, 'Hello everyone in the group chat here.', 'text', ?)`).run(now);
    db.prepare(
      `INSERT INTO mail_messages (account, id, thread_id, date_ms, from_header, to_header, subject, body, from_me, labels) VALUES ('work', 'm1', 't1', ?, 'me@example.com', 'Desma <desma@example.com>', 'Hi', 'Hi Desma, Thursday works.', 1, '["SENT"]')`,
    ).run(now);
    db.prepare(
      `INSERT INTO mail_messages (account, id, thread_id, date_ms, from_header, to_header, subject, body, from_me, labels) VALUES ('work', 'm2', 't2', ?, 'me@example.com', 'a@example.com, b@example.com', 'Team', 'Hi both', 1, '["SENT"]')`,
    ).run(now);
    const ids = store.activeVoiceContacts(now - 60_000, ["me@example.com"]).map((c) => c.contactId).sort();
    assert.deepEqual(ids, ["mail:desma@example.com", "wa:p1@chat.invalid"]);
    assert.equal(store.sentWaTexts("p1@chat.invalid", 5).length, 1);
    assert.deepEqual(store.sentMailTo("desma@example.com", now - 60_000, 5).map((m) => m.id), ["m1"]);
  });
});

describe("voice samples match the exact address, not a substring", () => {
  it("does not hand mail to dan@ as a sample for an@", () => {
    const { db, store } = freshStore();
    const now = Date.now();
    db.prepare(
      `INSERT INTO mail_messages (account, id, thread_id, date_ms, from_header, to_header, subject, body, from_me, labels) VALUES ('work', 'to-dan', 't1', ?, 'me@example.com', 'Dan <dan@example.com>', 'Hi', 'Hi Dan, see you Monday.', 1, '["SENT"]')`,
    ).run(now);
    db.prepare(
      `INSERT INTO mail_messages (account, id, thread_id, date_ms, from_header, to_header, subject, body, from_me, labels) VALUES ('work', 'to-an', 't2', ?, 'me@example.com', 'an@example.com', 'Hi', 'Hi An, see you Tuesday.', 1, '["SENT"]')`,
    ).run(now);
    assert.deepEqual(store.sentMailTo("an@example.com", now - 60_000, 5).map((m) => m.id), ["to-an"]);
  });

  it("treats % and _ in an address as plain characters", () => {
    const { db, store } = freshStore();
    const now = Date.now();
    db.prepare(
      `INSERT INTO mail_messages (account, id, thread_id, date_ms, from_header, to_header, subject, body, from_me, labels) VALUES ('work', 'x1', 't1', ?, 'me@example.com', 'ab@example.com', 'Hi', 'Hello there friend.', 1, '["SENT"]')`,
    ).run(now);
    assert.deepEqual(store.sentMailTo("a_@example.com", now - 60_000, 5), []);
  });
});

describe("an overtaken WhatsApp draft is not a live pending draft", () => {
  it("is no longer offered once the user wrote in the chat after it", () => {
    const { db, store } = freshStore();
    const jid = "chat-four@chat.invalid";
    const t0 = Date.now() - 600 * MIN;
    db.prepare(`INSERT INTO wa_chats (jid, name, is_group, last_message_at, last_message_text, last_from_me) VALUES (?, 'Kim', 0, ?, 'hi', 0)`).run(jid, t0);
    db.prepare(`INSERT INTO wa_messages (id, chat_jid, from_me, text, timestamp) VALUES ('k1', ?, 0, 'hi', ?)`).run(jid, t0);
    const draft = store.createDraft({ id: "d-kim", chatJid: jid, chatName: "Kim", text: "Hello back", sourceThreadId: null });
    assert.equal(store.livePendingDraftFor(jid)?.id, "d-kim");
    db.prepare(`INSERT INTO wa_messages (id, chat_jid, from_me, text, timestamp) VALUES ('k2', ?, 1, 'written outside the panel', ?)`).run(jid, draft.updatedAt + 60 * MIN);
    assert.equal(store.livePendingDraftFor(jid), null);
    // Still there for the panel's own use, not discarded.
    assert.equal(store.pendingDraftFor(jid)?.id, "d-kim");
  });
});

describe("the store counts needs-reply without the ready overlap", () => {
  it("counts a conversation with a ready draft once, under ready", () => {
    const { db, store } = freshStore();
    const now = Date.now();
    for (const [jid, name] of [["c-a@chat.invalid", "A"], ["c-b@chat.invalid", "B"]] as const) {
      db.prepare(`INSERT INTO wa_chats (jid, name, is_group, last_message_at, last_message_text, last_from_me) VALUES (?, ?, 0, ?, 'hi', 0)`).run(jid, name, now - 60_000);
      db.prepare(`INSERT INTO wa_messages (id, chat_jid, from_me, text, timestamp) VALUES (?, ?, 0, 'hi', ?)`).run(`m-${name}`, jid, now - 60_000);
    }
    store.createDraft({ id: "d-a", chatJid: "c-a@chat.invalid", chatName: "A", text: "Hello", sourceThreadId: null });
    const counts = store.counts();
    assert.equal(counts.needsReply, 2);
    assert.equal(counts.ready, 1);
    assert.equal(counts.needsReplyOnly, 1);
  });
});

describe("unaskedWaBursts finds a deferred ask lost to a reload", () => {
  it("lists a recent one-to-one chat whose newest message is from them and not yet asked about", () => {
    const { db, store } = freshStore();
    const now = Date.now();
    db.prepare(`INSERT INTO wa_chats (jid, name, is_group, last_message_at, last_message_text, last_from_me) VALUES ('u1@chat.invalid', 'U', 0, ?, 'hi', 0)`).run(now - 60_000);
    db.prepare(`INSERT INTO wa_chats (jid, name, is_group, last_message_at, last_message_text, last_from_me) VALUES ('u2@chat.invalid', 'V', 0, ?, 'hi', 0)`).run(now - 60_000);
    db.prepare(`INSERT INTO wa_chats (jid, name, is_group, last_message_at, last_message_text, last_from_me) VALUES ('g1@group.invalid', 'G', 1, ?, 'hi', 0)`).run(now - 60_000);
    db.prepare(`INSERT INTO wa_chats (jid, name, is_group, last_message_at, last_message_text, last_from_me) VALUES ('u3@chat.invalid', 'W', 0, ?, 'hi', 1)`).run(now - 60_000);
    store.setAutoDraftMark("u2@chat.invalid", now - 60_000);
    assert.deepEqual(store.unaskedWaBursts(now - 3_600_000), ["u1@chat.invalid"]);
  });
});

describe("the drafts listing flags a draft the owner overtook", () => {
  it("a pending draft then a later message from him is not offered as waiting", () => {
    const { db, store } = freshStore();
    const jid = "chat-nine@chat.invalid";
    const t0 = Date.now() - 300 * MIN;
    db.prepare(`INSERT INTO wa_chats (jid, name, is_group, last_message_at, last_message_text, last_from_me) VALUES (?, 'Lio', 0, ?, 'hi', 0)`).run(jid, t0);
    db.prepare(`INSERT INTO wa_messages (id, chat_jid, from_me, text, timestamp) VALUES ('l1', ?, 0, 'hi', ?)`).run(jid, t0);
    const draft = store.createDraft({ id: "d-lio", chatJid: jid, chatName: "Lio", text: "See you then", sourceThreadId: null });
    const listed = () => store.drafts({ status: "pending" }).find((d) => d.id === "d-lio")!;
    assert.equal(store.waDraftIsOvertaken(listed()), false, "waiting while he has not written");
    db.prepare(`INSERT INTO wa_messages (id, chat_jid, from_me, text, timestamp) VALUES ('l2', ?, 1, 'typed in WhatsApp itself', ?)`).run(jid, draft.updatedAt + 10 * MIN);
    assert.equal(store.waDraftIsOvertaken(listed()), true, "overtaken once he wrote after it");
    assert.equal(store.conversation(`wa:${jid}`)?.readyToSend, false, "and not in Ready to send");
  });

  it("the listing formatter and the chief's rule use it", () => {
    const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    const fmt = source.slice(source.indexOf("function formatWaDraft("), source.indexOf("function formatWaDraft(") + 400);
    assert.match(fmt, /store\.waDraftIsOvertaken\(d\)/);
    assert.match(source, /^\s*READY_LIST_RULE,$/m);
    assert.match(source, /only from the "Ready to send" section of a comms_inbox call made in this turn/);
  });
});

describe("a draft from another thread is a worker's, not the owner's", () => {
  function storeWithChief(chief: string | null) {
    const db = new DatabaseSync(":memory:");
    for (const statement of MIGRATIONS) {
      try {
        db.exec(statement);
      } catch (cause) {
        if (!String(cause).includes("duplicate column")) throw cause;
      }
    }
    const titles: Record<string, string> = { thr_worker1: "Parent update" };
    const store = createStore(db as unknown as PluginDatabase, {
      emailOf: () => "me@example.com",
      chiefThreadId: () => chief,
      threadTitle: (id) => titles[id] ?? null,
    });
    return { db, store };
  }

  it("names the author from the thread that wrote it", () => {
    assert.equal(originOfThread(null, "thr_chief"), "you");
    assert.equal(originOfThread("thr_chief", "thr_chief"), "chief");
    assert.equal(originOfThread("thr_worker1", "thr_chief"), "worker");
  });

  it("a WhatsApp draft written by a worker thread stores that id and reads as worker, with its title", () => {
    const { db, store } = storeWithChief("thr_chief");
    const jid = "chat-ten@chat.invalid";
    db.prepare(`INSERT INTO wa_chats (jid, name, is_group, last_message_at, last_message_text, last_from_me) VALUES (?, 'Ari', 0, 1, 'hi', 0)`).run(jid);
    const draft = store.createDraft({ id: "d-ari", chatJid: jid, chatName: "Ari", text: "Class moved to Friday.", sourceThreadId: "thr_worker1" });
    assert.equal(store.draft(draft.id)?.sourceThreadId, "thr_worker1");
    const dto = store.waDraftDto(draft.id);
    assert.equal(dto?.origin, "worker");
    assert.equal(dto?.authorTitle, "Parent update");
    store.setDraftAuthor(draft.id, "thr_chief");
    assert.equal(store.waDraftDto(draft.id)?.origin, "chief");
    store.setDraftAuthor(draft.id, null);
    assert.equal(store.waDraftDto(draft.id)?.origin, "you");
  });

  it("a mail draft written by a worker thread keeps that thread", () => {
    const { store } = storeWithChief("thr_chief");
    store.upsertMailDraft({ account: "work", draftId: "md-1", messageId: null, threadId: "t-1", to: "a@example.com", cc: null, subject: "Re: x", body: "Fine", updatedAt: 1 });
    store.setMailDraftOrigin("work", "md-1", "worker", "thr_worker1");
    assert.equal(store.mailDraftDto("work", "md-1")?.origin, "worker");
    assert.equal(store.mailDraftDto("work", "md-1")?.authorTitle, "Parent update");
    store.setMailDraftOrigin("work", "md-1", "you");
    assert.equal(store.mailDraftDto("work", "md-1")?.origin, "you");
  });

  it("bb comms wa draft and bb comms draft keep the calling thread for every caller", () => {
    const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    assert.match(source, /createWaDraft\(chat, text, ctx\.threadId \?\? null\)/);
    assert.match(source, /saveDraftReporting\(key, text, ctx\.signal, ctx\.threadId \?\? null\)/);
    assert.doesNotMatch(source, /store\.setDraftAuthor\(pending\.id, null\)/, "the panel save no longer drops a caller's thread");
  });
});
