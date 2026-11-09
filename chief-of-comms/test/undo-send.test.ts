// Undo Send. The three outcomes against the real
// schema, the rule that only a confirmed cancel puts the draft back, and, from
// the source, that no code path in Undo can send. Names are invented.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MIGRATIONS, createStore, type UndoCopy } from "../store.ts";
import type { PluginDatabase } from "../store.ts";
import { undoSend, type UndoClient, type UndoDeps } from "../undo-send.ts";

function freshStore() {
  const db = new DatabaseSync(":memory:");
  for (const statement of MIGRATIONS) {
    try {
      db.exec(statement);
    } catch (cause) {
      if (!String(cause).includes("duplicate column")) throw cause;
    }
  }
  return createStore(db as unknown as PluginDatabase, { emailOf: () => "me@example.com" });
}

const COPY: UndoCopy = {
  to: "Desma Lee <desma@example.com>",
  cc: null,
  subject: "Re: Thursday",
  body: "Thursday at 3pm works.",
  threadId: "thread-1",
  replyToId: "msg-in-1",
  origin: "you",
  conversationKey: "mail:work:thread-1",
};

/** A sent row with an open undo window, as sendViaSuperhumanClaimed leaves it. */
function sentRow(store: ReturnType<typeof freshStore>) {
  const claim = store.claimSuperhumanSend({ account: "work", gmailDraftId: "g-1", threadId: "thread-1", to: COPY.to, subject: COPY.subject, actor: "panel" });
  assert.ok("id" in claim);
  store.setSuperhumanDraftId(claim.id, "sh-1");
  store.finishSuperhumanSend(claim.id, { status: "sent", messageId: "m-1", threadId: "thread-1" });
  store.setSuperhumanUndo(claim.id, { token: "undo-1", until: Date.now() + 60_000, copy: COPY });
  store.markSuperhumanGmailDraftDeleted(claim.id);
  return claim.id;
}

function harness(answers: { undo: Awaited<ReturnType<UndoClient["undoSend"]>> | Error; status: ("idle" | "pending" | "closed" | "unknown")[] | Error }) {
  const store = freshStore();
  const id = sentRow(store);
  const calls: string[] = [];
  const written: UndoCopy[] = [];
  let statusCall = 0;
  const deps: UndoDeps = {
    client: () => ({
      undoSend: async (input) => {
        calls.push(`undoSend:${input.undoToken}`);
        if (answers.undo instanceof Error) throw answers.undo;
        return answers.undo;
      },
      getDraftSendStatus: async (input) => {
        calls.push(`status:${input.draftId}`);
        if (answers.status instanceof Error) throw answers.status;
        const list = answers.status;
        const state = list[Math.min(statusCall, list.length - 1)] ?? "unknown";
        statusCall += 1;
        return { state, detail: state };
      },
    }),
    wait: async () => undefined,
    markCancelled: (sendId) => store.markSuperhumanSendCancelled(sendId),
    clearUndo: (sendId) => store.clearSuperhumanUndo(sendId),
    writeBack: async (copy) => {
      written.push(copy);
      return "g-2";
    },
    discardSuperhumanDraft: async (draftId) => {
      calls.push(`discard:${draftId}`);
    },
    note: () => undefined,
  };
  return { store, id, deps, calls, written, run: () => undoSend(store.superhumanSendRow(id), id, deps) };
}

describe("Undo Send: the three outcomes", () => {
  it("cancelled: Superhuman confirms the draft is idle, the row is cancelled and the draft is written back", async () => {
    const h = harness({ undo: { state: "cancelled", detail: "Send canceled." }, status: ["pending", "idle"] });
    const result = await h.run();
    assert.equal(result.outcome, "cancelled");
    assert.equal(result.text, "Cancelled, back in drafts.");
    assert.equal(h.store.superhumanSendRow(h.id)?.status, "cancelled");
    assert.deepEqual(h.written, [COPY], "the same text, recipients and thread go back into Gmail drafts");
    assert.deepEqual(h.calls, ["undoSend:undo-1", "status:sh-1", "status:sh-1", "discard:sh-1"]);
    assert.equal(h.store.undoableSuperhumanSends(Date.now()).length, 0, "no longer offered");
    // A cancelled row does not block the restored draft from being sent again by his click.
    assert.equal(h.store.superhumanBlockFor("work", "g-1"), null);
  });

  it("too late: Superhuman says it already went, the row stays sent and Undo is not offered again", async () => {
    const h = harness({ undo: { state: "already_sent", detail: "already_sent: past the undo window" }, status: ["closed"] });
    const result = await h.run();
    assert.equal(result.outcome, "too_late");
    assert.equal(result.text, "Too late, it was sent.");
    assert.equal(h.store.superhumanSendRow(h.id)?.status, "sent");
    assert.deepEqual(h.written, [], "nothing goes back into drafts");
    assert.equal(h.store.undoableSuperhumanSends(Date.now()).length, 0);
  });

  it("too late: a cancel the draft status calls closed is too late, not cancelled", async () => {
    const h = harness({ undo: { state: "cancelled", detail: "Send canceled." }, status: ["closed"] });
    assert.equal((await h.run()).outcome, "too_late");
    assert.deepEqual(h.written, []);
  });

  it("failed: an unconfirmed cancel still counts as sent and writes nothing back", async () => {
    const h = harness({ undo: { state: "cancelled", detail: "Send canceled." }, status: ["pending", "pending", "pending"] });
    const result = await h.run();
    assert.equal(result.outcome, "failed");
    assert.match(result.text, /still counts as sent/);
    assert.equal(h.store.superhumanSendRow(h.id)?.status, "sent");
    assert.deepEqual(h.written, []);
    assert.equal(h.store.undoableSuperhumanSends(Date.now()).length, 1, "the window is still open, so Undo can be tried again");
  });

  it("failed: an error from undo_send, or words nobody can read, is a failure and never a cancel", async () => {
    const thrown = harness({ undo: new Error("HTTP 502"), status: ["idle"] });
    assert.equal((await thrown.run()).outcome, "failed");
    assert.equal(thrown.store.superhumanSendRow(thrown.id)?.status, "sent");
    const unread = harness({ undo: { state: "unknown", detail: "hmm" }, status: ["idle"] });
    assert.equal((await unread.run()).outcome, "failed");
    assert.deepEqual(unread.written, []);
  });

  it("failed: a row with no undo window on record is refused before Superhuman is called", async () => {
    const h = harness({ undo: { state: "cancelled", detail: "x" }, status: ["idle"] });
    h.store.clearSuperhumanUndo(h.id);
    assert.equal((await h.run()).outcome, "failed");
    assert.deepEqual(h.calls, []);
  });

  it("a second Undo of the same send writes nothing a second time", async () => {
    const h = harness({ undo: { state: "cancelled", detail: "Send canceled." }, status: ["idle"] });
    await h.run();
    const again = await h.run();
    assert.equal(again.outcome, "failed");
    assert.equal(h.written.length, 1);
  });
});

describe("Undo never sends", () => {
  const undoSource = readFileSync(new URL("../undo-send.ts", import.meta.url), "utf8");
  const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");

  function fnBody(name: string): string {
    const start = server.indexOf(`async function ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    return server.slice(start, server.indexOf("\n  }\n", start));
  }

  it("undo-send.ts names no send", () => {
    assert.doesNotMatch(undoSource.replace(/^\s*\/\/.*$/gm, ""), /sendDraft|sendMailDraft|send_draft|sendViaSuperhuman|sendWa/);
  });

  it("the server's undo and write-back name no send, and hand undo-send.ts only undoSend and getDraftSendStatus", () => {
    for (const name of ["undoSuperhumanSend", "writeBackCancelledDraft"]) {
      assert.doesNotMatch(fnBody(name), /sendDraft|sendMailDraft|sendViaSuperhuman|sendWa|send_draft/, name);
    }
    const handed = fnBody("undoSuperhumanSend").match(/return \{\n([\s\S]*?)\n\s*\};/)?.[1] ?? "";
    assert.deepEqual([...handed.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]), ["undoSend", "getDraftSendStatus"]);
  });

  it("the send_undo RPC reaches only undoSuperhumanSend", () => {
    assert.match(server, /send_undo: async \(\{ sendId \}\) => undoSuperhumanSend\(sendId\),/);
  });
});
