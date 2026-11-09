// An unchanged mail pass
// and an unchanged draft listing make no per-message or per-draft gets. A fake
// gw counts what reaches Gmail. Every id and address here is invented.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { createMail, type GwRunner } from "../gmail.ts";
import { MIGRATIONS, createStore, type PluginDatabase } from "../store.ts";
import { listDraftsChangedOnly } from "../draft-listing.ts";
import { FULL_PASS_EVERY_MS, mailFingerprint, needsFullPass } from "../mail-probe.ts";

/** A fake gw: an inbox, an unread set, sent mail and drafts, counting every call by kind. */
function fakeGw() {
  const state = {
    inbox: ["m1", "m2"],
    unread: ["m2"],
    sent: ["s1"],
    drafts: [{ draft_id: "d1", message_id: "dm1", thread_id: "t1" }] as { draft_id: string; message_id: string; thread_id: string }[],
  };
  const calls: string[] = [];
  const gw: GwRunner = {
    async run(args) {
      const sub = args[3] ?? "";
      const idsOnly = args.includes("--ids-only");
      calls.push(idsOnly ? `${sub}:ids` : sub);
      if (sub === "search") {
        const query = args[4] ?? "";
        const ids = query.startsWith("from:me") ? state.sent : query.includes("is:unread") ? state.unread : state.inbox;
        if (idsOnly) return { ok: true, ids_only: true, messages: ids.map((id) => ({ id, thread_id: `t-${id}` })) };
        // The full search: one get per message inside gw, counted as such.
        for (const _ of ids) calls.push("message-get");
        return { ok: true, messages: ids.map((id) => ({ id, thread_id: `t-${id}`, labels: ["INBOX"] })) };
      }
      if (sub === "drafts") {
        if (idsOnly) return { ok: true, ids_only: true, drafts: state.drafts };
        for (const _ of state.drafts) calls.push("draft-get-inside-list");
        return { ok: true, drafts: state.drafts };
      }
      if (sub === "draft-get") {
        const d = state.drafts.find((x) => x.draft_id === args[4]);
        return { ok: true, ...d, to: "desma@client.invalid", subject: "Re: lessons", body: "See you Friday.", attachments: [], bcc: null };
      }
      throw new Error(`unexpected gw call ${args.join(" ")}`);
    },
  };
  const gets = () => calls.filter((c) => c === "message-get" || c === "draft-get" || c === "draft-get-inside-list").length;
  return { state, calls, gw, gets };
}

function freshStore() {
  const db = new DatabaseSync(":memory:");
  for (const statement of MIGRATIONS) {
    try {
      db.exec(statement);
    } catch (cause) {
      if (!String(cause).includes("duplicate column")) throw cause;
    }
  }
  return createStore(db as unknown as PluginDatabase, { emailOf: () => "me@home-office.invalid" });
}

describe("An unchanged mail pass makes no message gets", () => {
  it("the fingerprint uses ids-only calls only", async () => {
    const g = fakeGw();
    await mailFingerprint(createMail(g.gw), "work", 14, 100);
    assert.deepEqual(g.calls, ["search:ids", "search:ids", "search:ids"]);
    assert.equal(g.gets(), 0);
  });

  it("an unchanged mailbox inside the backstop window skips the full pass", async () => {
    const g = fakeGw();
    const mail = createMail(g.gw);
    const first = await mailFingerprint(mail, "work", 14, 100);
    const memory = { fingerprint: first, fullAt: 1_000 };
    const again = await mailFingerprint(mail, "work", 14, 100);
    assert.deepEqual(needsFullPass(memory, again, 1_000 + 60_000), { full: false, reason: "unchanged" });
    assert.equal(g.gets(), 0, "no message was read to find that out");
  });

  it("a new message, an archived one, a read one and a sent reply each change it", async () => {
    const g = fakeGw();
    const mail = createMail(g.gw);
    const base = await mailFingerprint(mail, "work", 14, 100);
    const changed = async (edit: () => void) => {
      const before = JSON.stringify(g.state);
      edit();
      const fp = await mailFingerprint(mail, "work", 14, 100);
      Object.assign(g.state, JSON.parse(before));
      return needsFullPass({ fingerprint: base, fullAt: 1_000 }, fp, 2_000).full;
    };
    assert.equal(await changed(() => g.state.inbox.push("m3")), true, "new message");
    assert.equal(await changed(() => (g.state.inbox = ["m2"])), true, "archived");
    assert.equal(await changed(() => (g.state.unread = [])), true, "read");
    assert.equal(await changed(() => g.state.sent.push("s2")), true, "reply sent elsewhere");
  });

  it("a failed probe, a first pass, and the backstop all run the full pass", () => {
    assert.equal(needsFullPass({ fingerprint: "x", fullAt: 0 }, null, 1).full, true);
    assert.equal(needsFullPass({ fingerprint: null, fullAt: null }, "x", 1).full, true);
    assert.equal(needsFullPass({ fingerprint: "x", fullAt: 0 }, "x", FULL_PASS_EVERY_MS).full, true);
    assert.equal(needsFullPass({ fingerprint: "x", fullAt: 0 }, "x", 1, true).full, true);
  });

  it("runMailSync probes first and keeps the full search as the fallback", () => {
    const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    const body = server.slice(server.indexOf("async function runMailSync("), server.indexOf("async function runMailSync(") + 4000);
    const probe = body.indexOf("mailFingerprint(");
    const decide = body.indexOf("needsFullPass(");
    const search = body.indexOf("await mail.search(account, `in:inbox");
    assert.ok(probe > 0 && decide > probe && search > decide, "probe, decide, then the full search");
  });
});

describe("An unchanged draft listing makes no draft gets", () => {
  it("first listing reads each draft once; the next, unchanged, reads none", async () => {
    const g = fakeGw();
    const store = freshStore();
    const mail = createMail(g.gw);
    const first = await listDraftsChangedOnly(mail, store, "personal", 200, () => undefined);
    assert.equal(first.read, 1);
    const getsAfterFirst = g.gets();
    const second = await listDraftsChangedOnly(mail, store, "personal", 200, () => undefined);
    assert.equal(second.read, 0);
    assert.equal(g.gets(), getsAfterFirst, "0 gets on an unchanged listing");
    assert.deepEqual(g.calls.filter((c) => c.startsWith("drafts")), ["drafts:ids", "drafts:ids"], "never the full listing");
  });

  it("a draft edited in Gmail (new message id) is read again, and only that one", async () => {
    const g = fakeGw();
    g.state.drafts.push({ draft_id: "d2", message_id: "dm2", thread_id: "t2" });
    const store = freshStore();
    const mail = createMail(g.gw);
    await listDraftsChangedOnly(mail, store, "personal", 200, () => undefined);
    g.state.drafts[0]!.message_id = "dm1-edited";
    const before = g.gets();
    const again = await listDraftsChangedOnly(mail, store, "personal", 200, () => undefined);
    assert.equal(again.read, 1);
    assert.equal(g.gets() - before, 1);
    assert.equal(store.mailDraftRow("personal", "d1")?.message_id, "dm1-edited");
  });

  it("syncMailDrafts lists through the changed-only path, and the full listing is only the fallback", () => {
    const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    const body = server.slice(server.indexOf("async function syncMailDrafts("), server.indexOf("async function syncMailDrafts(") + 2500);
    const changedOnly = body.indexOf("listDraftsChangedOnly(mail, store, account, MAIL_DRAFT_LIMIT");
    const returnEarly = body.indexOf("if (changedOnly !== null) {");
    const full = body.indexOf("await mail.drafts(account, MAIL_DRAFT_LIMIT");
    assert.ok(changedOnly > 0 && returnEarly > changedOnly && full > returnEarly, "changed-only first, full listing only when it failed");
  });
});
