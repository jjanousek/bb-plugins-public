// The Superhuman send path for work mail.
//
// Three things are pinned here. The pure helpers, where a wrong guess about the
// server returns empty rather than failing. The store claim, which is what
// stops two clicks sending one draft twice. And the call graph: only
// `sendViaSuperhuman`, reached only from `sendMailDraft`, names the Superhuman
// send.
//
// Fixture addresses and times are invented. The feed event shape is the one
// recorded in SUPERHUMAN-TOOLS.md.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { MIGRATIONS, createStore, type PluginDatabase } from "../store.ts";
import {
  addressesIn,
  htmlFromText,
  readEvent,
  readFeedPage,
  readStatusText,
  recipientMismatch,
  resolvedThreadId,
  tallyFor,
} from "../superhuman-send.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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

const HOUR = 60 * 60 * 1000;

describe("recipients", () => {
  it("reads every address out of a header", () => {
    assert.deepEqual(addressesIn('"Desma W" <Desma@Brookvale.invalid>, ops@brookvale.invalid'), ["desma@brookvale.invalid", "ops@brookvale.invalid"]);
    assert.deepEqual(addressesIn(null), []);
  });

  const none = { to: [], cc: [], bcc: [] };
  it("refuses an address Superhuman added from the thread", () => {
    const { problems } = recipientMismatch({ ...none, to: ["desma@brookvale.invalid"] }, { ...none, to: ["desma@brookvale.invalid", "old.contact@brookvale.invalid"] }, ["me@work.invalid"]);
    assert.deepEqual(problems, ["To would also have old.contact@brookvale.invalid"]);
  });

  it("refuses a recipient Superhuman dropped", () => {
    const { problems } = recipientMismatch({ ...none, to: ["desma@brookvale.invalid", "ops@brookvale.invalid"] }, { ...none, to: ["desma@brookvale.invalid"] }, []);
    assert.deepEqual(problems, ["To would be missing ops@brookvale.invalid"]);
  });

  it("refuses a Cc that Superhuman also put in To, which pooling all fields let through", () => {
    // A recipient approved for Cc can also appear in To. As one pooled set both
    // sides hold the same addresses, so the fields are compared one by one.
    const { problems } = recipientMismatch(
      { to: ["lee@partner.invalid"], cc: ["sam@client.invalid"], bcc: [] },
      { to: ["Sam@Client.invalid", "lee@partner.invalid"], cc: ["sam@client.invalid"], bcc: [] },
      ["me@work.invalid"],
    );
    assert.deepEqual(problems, ["To would also have sam@client.invalid", "sam@client.invalid would be in to and cc at once"]);
  });

  it("ignores the user's own addresses and case", () => {
    const { problems } = recipientMismatch({ ...none, to: ["desma@brookvale.invalid"] }, { ...none, to: ["Desma@Brookvale.invalid", "Me@Work.invalid"] }, ["me@work.invalid"]);
    assert.deepEqual(problems, []);
  });
});

describe("body and ids", () => {
  it("turns plain text into paragraphs and escapes it", () => {
    assert.equal(htmlFromText("Hi Desma,\n\nNotes are <b>attached</b>.\nThanks"), "<p>Hi Desma,</p>\n<p>Notes are &lt;b&gt;attached&lt;/b&gt;.<br>Thanks</p>");
  });

  it("treats the draft id send_draft returns for a new thread as no thread", () => {
    assert.equal(resolvedThreadId("draft007aa0e0efcd0000"), null);
    assert.equal(resolvedThreadId("1a0000000000abcd"), "1a0000000000abcd");
    assert.equal(resolvedThreadId(""), null);
  });
});

describe("the read feed", () => {
  const event = (thread: string, message: string, who: string, at: string) => ({
    thread_id: thread,
    message_id: message,
    subject: "Workshop notes",
    recipient: { email: who },
    occurred_at: at,
    device: "desktop",
  });

  it("reads the real event shape", () => {
    const read = readEvent(event("t1", "m1", "Desma@Brookvale.invalid", "2031-10-08T09:00:00Z"));
    assert.equal(read.threadId, "t1");
    assert.equal(read.recipient, "desma@brookvale.invalid");
    assert.equal(read.at, Date.parse("2031-10-08T09:00:00Z"));
  });

  it("throws on an event with no time, instead of counting it as nothing", () => {
    assert.throws(() => readEvent({ thread_id: "t1", read_at: "2031-10-08T09:00:00Z" }), /occurred_at/);
  });

  it("throws on a page with no event list, instead of returning an empty feed", () => {
    assert.throws(() => readFeedPage({ unexpected: [] }), /without an event list/);
    assert.equal(readFeedPage({ events: [], next_cursor: null }).events.length, 0);
  });

  it("counts opens and people separately", () => {
    const events = [
      event("t1", "m1", "desma@brookvale.invalid", "2031-10-08T09:00:00Z"),
      event("t1", "m1", "desma@brookvale.invalid", "2031-10-08T12:00:00Z"),
      event("t1", "m1", "ops@brookvale.invalid", "2031-10-08T10:00:00Z"),
      event("t2", "m9", "someone@else.invalid", "2031-10-08T10:00:00Z"),
    ].map(readEvent);
    const tally = tallyFor(events, { threadId: "t1", messageId: "m1", sentAt: Date.parse("2031-10-08T08:00:00Z") });
    assert.equal(tally.opens, 3);
    assert.deepEqual(tally.readers, ["desma@brookvale.invalid", "ops@brookvale.invalid"]);
    assert.equal(tally.firstAt, Date.parse("2031-10-08T09:00:00Z"));
    assert.deepEqual(
      tally.events.map((event) => event.at),
      ["2031-10-08T09:00:00Z", "2031-10-08T10:00:00Z", "2031-10-08T12:00:00Z"].map(Date.parse),
      "each open is handed back, oldest first, so it can be stored with its time",
    );
    assert.equal(tally.events[0]?.device, "desktop");
  });

  it("without a message match, counts only opens after the send", () => {
    const events = [
      event("t1", "older", "desma@brookvale.invalid", "2031-10-06T09:00:00Z"),
      event("t1", "other", "desma@brookvale.invalid", "2031-10-08T09:00:00Z"),
    ].map(readEvent);
    const tally = tallyFor(events, { threadId: "t1", messageId: "m1", sentAt: Date.parse("2031-10-08T08:00:00Z") });
    assert.equal(tally.opens, 1);
  });
});

describe("the read status line", () => {
  const now = Date.parse("2031-10-08T13:00:00Z");
  const sent = { sentAt: now - 3 * HOUR, threadId: "t1", opens: 0, readers: [], firstReadAt: null, lastReadAt: null };

  it("says not opened only when the feed was read after the send and recently", () => {
    assert.equal(readStatusText(sent, { lastOkAt: now - 60_000, lastError: null }, now).state, "not-opened");
  });

  it("never says not opened when the feed is stale or failing", () => {
    // "Nobody opened it" and "we could not check"
    // must never render alike.
    const stale = readStatusText(sent, { lastOkAt: now - 2 * HOUR, lastError: null }, now);
    assert.equal(stale.state, "unknown");
    const failing = readStatusText(sent, { lastOkAt: null, lastError: "timeout" }, now);
    assert.equal(failing.state, "unknown");
    assert.match(failing.text, /timeout/);
    const beforeSend = readStatusText(sent, { lastOkAt: sent.sentAt - 1, lastError: null }, now);
    assert.equal(beforeSend.state, "unknown");
  });

  it("says pending while the thread of a new message is not known yet", () => {
    assert.equal(readStatusText({ ...sent, threadId: null }, { lastOkAt: now, lastError: null }, now).state, "pending");
  });

  it("says opened, with people, whatever the feed state", () => {
    const opened = readStatusText({ ...sent, opens: 2, readers: ["desma@brookvale.invalid"], firstReadAt: now - HOUR, lastReadAt: now }, { lastOkAt: null, lastError: "down" }, now);
    assert.equal(opened.state, "opened");
    assert.match(opened.text, /2 times by desma@brookvale.invalid/);
  });
});

describe("the send claim", () => {
  const entry = { account: "work" as const, gmailDraftId: "r1", threadId: "t1", to: "desma@brookvale.invalid", subject: "Notes", actor: "panel" };

  it("lets one send through and refuses the second while it runs", () => {
    const store = freshStore();
    const first = store.claimSuperhumanSend(entry);
    assert.ok("id" in first);
    const second = store.claimSuperhumanSend(entry);
    assert.ok("blocked" in second && second.blocked.status === "sending");
  });

  it("refuses a send of a draft that already went out, even if its Gmail copy is still there", () => {
    const store = freshStore();
    const first = store.claimSuperhumanSend(entry);
    assert.ok("id" in first);
    store.finishSuperhumanSend(first.id, { status: "sent", messageId: "m1", threadId: "t1" });
    const again = store.claimSuperhumanSend(entry);
    assert.ok("blocked" in again && again.blocked.status === "sent");
  });

  it("refuses while an earlier send is uncertain", () => {
    const store = freshStore();
    const first = store.claimSuperhumanSend(entry);
    assert.ok("id" in first);
    store.finishSuperhumanSend(first.id, { status: "uncertain", error: "timeout" });
    assert.ok("blocked" in store.claimSuperhumanSend(entry));
  });

  it("allows a new attempt after a clean failure", () => {
    const store = freshStore();
    const first = store.claimSuperhumanSend(entry);
    assert.ok("id" in first);
    store.finishSuperhumanSend(first.id, { status: "failed", error: "refused" });
    assert.ok("id" in store.claimSuperhumanSend(entry));
  });

  it("keeps every open with its own time, and a re-read of the feed adds nothing", () => {
    const store = freshStore();
    const first = store.claimSuperhumanSend(entry);
    assert.ok("id" in first);
    const opens = [
      { recipient: "desma@brookvale.invalid", at: 3000, device: "desktop" },
      { recipient: "desma@brookvale.invalid", at: 1000, device: "desktop" },
      { recipient: "ops@brookvale.invalid", at: 2000, device: null },
    ];
    assert.equal(store.recordSuperhumanOpens(first.id, opens), 3);
    assert.equal(store.recordSuperhumanOpens(first.id, opens), 0, "the feed returns the same events on every read");
    assert.deepEqual(
      store.superhumanOpens(first.id).map((open) => [open.openedAt, open.recipient]),
      [[1000, "desma@brookvale.invalid"], [2000, "ops@brookvale.invalid"], [3000, "desma@brookvale.invalid"]],
    );
  });

  it("blocks every path from resending a draft that went or may have gone", () => {
    const store = freshStore();
    const first = store.claimSuperhumanSend(entry);
    assert.ok("id" in first);
    assert.equal(store.superhumanBlockFor("work", "r1")?.status, "sending");
    store.finishSuperhumanSend(first.id, { status: "uncertain", error: "timeout" });
    assert.equal(store.superhumanBlockFor("work", "r1")?.status, "uncertain", "the Gmail path reads this too");
    store.finishSuperhumanSend(first.id, { status: "failed", error: "never sent" });
    assert.equal(store.superhumanBlockFor("work", "r1"), null, "a clean failure frees it");
  });

  it("forgets the draft's own thread for a new email, so the real one is looked up", () => {
    const store = freshStore();
    const first = store.claimSuperhumanSend({ ...entry, threadId: "draft-thread", to: null, subject: null });
    assert.ok("id" in first);
    store.setSuperhumanSendDetails(first.id, { threadId: null, to: "desma@brookvale.invalid", subject: "Notes" });
    store.finishSuperhumanSend(first.id, { status: "sent", messageId: "m1", threadId: null });
    const row = store.superhumanSendRow(first.id);
    assert.equal(row?.thread_id, null);
    assert.equal(row?.to_header, "desma@brookvale.invalid");
    store.setSuperhumanSendThread(first.id, "real-thread");
    assert.equal(store.superhumanSendRow(first.id)?.thread_id, "real-thread");
  });

  it("never lowers an open count already recorded", () => {
    const store = freshStore();
    const first = store.claimSuperhumanSend(entry);
    assert.ok("id" in first);
    store.finishSuperhumanSend(first.id, { status: "sent", messageId: "m1", threadId: "t1" });
    store.recordSuperhumanReads(first.id, { opens: 3, readers: ["desma@brookvale.invalid"], firstAt: 1000, lastAt: 3000 });
    store.recordSuperhumanReads(first.id, { opens: 1, readers: [], firstAt: 2000, lastAt: 2000 });
    const row = store.latestSuperhumanSend("work", "t1");
    assert.equal(row?.opens, 3);
    assert.equal(row?.first_read_at, 1000);
  });
});

describe("the call graph", () => {
  const server = readFileSync(join(ROOT, "server.ts"), "utf8");

  it("names the Superhuman send in exactly one place", () => {
    const calls = [...server.matchAll(/\.sendDraft\(\{/g)];
    assert.equal(calls.length, 1, "only sendViaSuperhumanClaimed may call the Superhuman send_draft");
    const at = calls[0]!.index!;
    const owner = server.lastIndexOf("async function ", at);
    assert.match(server.slice(owner, owner + 50), /async function sendViaSuperhumanClaimed\(/);
  });

  it("reaches the claimed send only from sendViaSuperhuman, after the claim", () => {
    const callers = [...server.matchAll(/sendViaSuperhumanClaimed\(account/g)];
    assert.equal(callers.length, 1);
    const at = callers[0]!.index!;
    const owner = server.lastIndexOf("async function ", at);
    assert.match(server.slice(owner, owner + 40), /async function sendViaSuperhuman\(/);
    assert.ok(server.lastIndexOf("claimSuperhumanSend(", at) > owner, "the claim is taken before the send runs");
  });

  it("reaches sendViaSuperhuman only from sendMailDraft", () => {
    const callers = [...server.matchAll(/sendViaSuperhuman\(account/g)];
    assert.equal(callers.length, 1);
    const owner = server.lastIndexOf("async function ", callers[0]!.index!);
    assert.match(server.slice(owner, owner + 40), /async function sendMailDraft\(/);
  });

  it("never names send_draft as a raw tool call", () => {
    assert.doesNotMatch(server, /["']send_draft["']/);
  });
});
