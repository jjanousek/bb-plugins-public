// Needs reply counts only mail he can answer from Comms. Every address
// here is invented.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MIGRATIONS, createStore, type PluginDatabase } from "../store.ts";
import { parseAddressList, quietReason, type QuietRules } from "../quiet-mail.ts";

const ME = "me@home-office.invalid";

const RULES: QuietRules = {
  ownAddresses: ["me.archive@oldmail.invalid", "me.travel@roaming.invalid"],
  answerElsewhereTo: ["@rowing-club.invalid"],
  noReplyFrom: ["@parcel-tracker.invalid", "statements@utility.invalid"],
  accountAddress: ME,
};

describe("quietReason", () => {
  it("one of his other addresses as From is his own forward", () => {
    assert.equal(quietReason({ from: "Me <me.travel@roaming.invalid>", to: ME, cc: null, subject: "Fwd: hotel receipt" }, RULES), "own");
    assert.equal(quietReason({ from: "me.archive@oldmail.invalid", to: ME, cc: null, subject: "notes to self" }, RULES), "own");
  });
  it("mail to a domain he answers from another client is answered elsewhere, list or person", () => {
    assert.equal(quietReason({ from: "Coach <coach@rowing-club.invalid>", to: "me@rowing-club.invalid", cc: null, subject: "Saturday crew" }, RULES), "elsewhere");
    assert.equal(quietReason({ from: "Secretary <sec@rowing-club.invalid>", to: "Members <members@rowing-club.invalid>", cc: null, subject: "Regatta volunteers" }, RULES), "elsewhere");
  });
  it("but not when this account is also on it, even only in Cc", () => {
    assert.equal(quietReason({ from: "Coach <coach@rowing-club.invalid>", to: "me@rowing-club.invalid", cc: ME, subject: "Saturday crew" }, RULES), null);
  });
  it("a no-reply sender needs no reply, by domain or by exact address", () => {
    assert.equal(quietReason({ from: "Depot <depot.desk@parcel-tracker.invalid>", to: ME, cc: null, subject: "Your parcel is out for delivery" }, RULES), "no-reply");
    assert.equal(quietReason({ from: "Utility <statements@utility.invalid>", to: ME, cc: null, subject: "Statement ready" }, RULES), "no-reply");
  });
  it("calendar replies and app senders need no reply", () => {
    assert.equal(quietReason({ from: "Ottilie <ottilie@studio.invalid>", to: ME, cc: null, subject: "Declined: Kiln check" }, RULES), "calendar");
    assert.equal(quietReason({ from: "Ottilie <ottilie@studio.invalid>", to: ME, cc: null, subject: "Invitation: Glaze test @ Wed" }, RULES), "calendar");
    assert.equal(quietReason({ from: "Notes <notes-app@tools.invalid>", to: ME, cc: null, subject: "Shared list changed" }, RULES), "no-reply");
  });
  it("a person writing to this account needs a reply", () => {
    assert.equal(quietReason({ from: "Ottilie <ottilie@studio.invalid>", to: ME, cc: null, subject: "Declining clay order, any alternative?" }, RULES), null);
  });
  it("settings parse into lower-case address entries", () => {
    assert.deepEqual(parseAddressList(" A@x.invalid, @Tracker.invalid;b@y.invalid "), ["a@x.invalid", "@tracker.invalid", "b@y.invalid"]);
    assert.deepEqual(parseAddressList(""), []);
  });
});

describe("the store leaves quiet threads out of Needs reply, never out of the list", () => {
  function storeWith(rules: QuietRules | null) {
    const db = new DatabaseSync(":memory:");
    for (const statement of MIGRATIONS) {
      try {
        db.exec(statement);
      } catch (cause) {
        if (!String(cause).includes("duplicate column")) throw cause;
      }
    }
    const store = createStore(db as unknown as PluginDatabase, { emailOf: () => ME, quietRules: rules === null ? undefined : () => rules });
    const now = Date.now();
    const add = (threadId: string, from: string, to: string, subject: string) => {
      store.upsertMailThread({ account: "work", threadId, subject, lastAt: now - 60_000, lastFrom: from, lastFromMe: false, preview: "hello there", unread: true, messageCount: 1 });
      store.upsertMailHeader({ account: "work", id: `${threadId}-m1`, threadId, dateMs: now - 60_000, from, to, cc: null, subject, fromMe: false, labels: ["INBOX", "UNREAD"], bulk: false });
    };
    add("t-own", "Me <me.travel@roaming.invalid>", ME, "Fwd: hotel receipt");
    add("t-tracker", "Depot <depot.desk@parcel-tracker.invalid>", ME, "Your parcel is out for delivery");
    add("t-person", "Ottilie <ottilie@studio.invalid>", ME, "Shelf measurements");
    return store;
  }

  it("before: his other address and the tracker notice count as needs-reply", () => {
    const store = storeWith(null);
    assert.equal(store.conversation("mail:work:t-own")?.needsReply, true);
    assert.equal(store.conversation("mail:work:t-tracker")?.needsReply, true);
  });

  it("after: they leave Needs reply and the count, the person stays", () => {
    const store = storeWith(RULES);
    assert.equal(store.conversation("mail:work:t-own")?.needsReply, false);
    assert.equal(store.conversation("mail:work:t-own")?.quiet, "own");
    assert.equal(store.conversation("mail:work:t-tracker")?.needsReply, false);
    assert.equal(store.conversation("mail:work:t-tracker")?.quiet, "no-reply");
    assert.equal(store.conversation("mail:work:t-person")?.needsReply, true);
    assert.equal(store.counts().needsReply, 1);
  });

  it("they still appear in search, in the needs-reply list as quiet rows, in All, and open as conversations", () => {
    const store = storeWith(RULES);
    const keys = (rows: { key: string }[]) => rows.map((r) => r.key).sort();
    assert.deepEqual(keys(store.conversations({ filter: "all", query: "delivery" })), ["mail:work:t-tracker"]);
    assert.deepEqual(keys(store.conversations({ filter: "needs-reply", query: "hotel" })), ["mail:work:t-own"]);
    assert.deepEqual(keys(store.conversations({ filter: "needs-reply" })), ["mail:work:t-own", "mail:work:t-person", "mail:work:t-tracker"]);
    assert.ok(store.conversation("mail:work:t-tracker"));
  });
});
