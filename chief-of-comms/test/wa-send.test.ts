// The point of wa-send.ts is that a send which times out cannot be delivered
// twice. These tests drive that path directly: the first attempt hangs and is
// rejected the way whatsapp.ts rejects a call after CALL_TIMEOUT_MS, the draft
// stays pending, Send is pressed again, and the second attempt must go out
// under the same WhatsApp message id as the first. Same id in the same chat is
// what makes WhatsApp drop the duplicate instead of showing it to the reader.
//
// Run with: npm test  (node --test, native TypeScript stripping, Node 22.18+)

import assert from "node:assert/strict";
import test from "node:test";

import { resetInFlightForTests, sendWaDraftOnce, type WaSendDeps, type WaSendStore } from "../wa-send.ts";
import type { WaDraft } from "../store.ts";
import { looksLikeMissingDraft } from "../gmail.ts";

function makeDraft(patch: Partial<WaDraft> = {}): WaDraft {
  return {
    id: "d1",
    chatJid: "15550100003@s.whatsapp.net",
    chatName: "The user",
    text: "[bb test] hello",
    status: "pending",
    createdAt: 1,
    updatedAt: 1,
    sourceThreadId: null,
    sentMessageId: null,
    sendMessageId: null,
    error: null,
    ...patch,
  };
}

/** An in-memory stand-in for the SQLite store, with the same claim semantics. */
function fakeStore(initial: WaDraft): WaSendStore & { row: WaDraft; mints: number } {
  const state = {
    row: initial,
    mints: 0,
    draft(id: string) {
      return id === state.row.id ? state.row : null;
    },
    claimSendMessageId(id: string, minted: string) {
      if (id !== state.row.id) return null;
      // The real one is a single conditional UPDATE: first writer wins.
      if (state.row.sendMessageId === null) {
        state.row = { ...state.row, sendMessageId: minted };
        state.mints += 1;
      }
      return state.row.sendMessageId;
    },
    updateDraft(id: string, patch: Parameters<WaSendStore["updateDraft"]>[1]) {
      if (id !== state.row.id) return null;
      const text = patch.text ?? state.row.text;
      state.row = {
        ...state.row,
        text,
        status: patch.status ?? state.row.status,
        sentMessageId: patch.sentMessageId === undefined ? state.row.sentMessageId : patch.sentMessageId,
        // Mirrors store.updateDraft: new wording, new id.
        sendMessageId: text === state.row.text ? state.row.sendMessageId : null,
        error: patch.error === undefined ? state.row.error : patch.error,
      };
      return state.row;
    },
  };
  return state;
}

function deps(store: WaSendStore, send: WaSendDeps["send"], ids: string[]): WaSendDeps {
  let n = 0;
  return {
    store,
    send,
    mintMessageId: () => ids[n++] ?? `3EB0FALLBACK${n}`,
    record: () => undefined,
    changed: () => undefined,
  };
}

test("a send that times out is retried under the same message id", async () => {
  resetInFlightForTests();
  const store = fakeStore(makeDraft());
  const used: string[] = [];
  let attempt = 0;
  const send: WaSendDeps["send"] = async (_jid, _name, _text, messageId) => {
    used.push(messageId);
    attempt += 1;
    // Attempt 1 is the timeout path: whatsapp.ts rejects the pending call after
    // CALL_TIMEOUT_MS while Baileys may already have put the message on the
    // wire. That is exactly the case where a fresh id would deliver twice.
    if (attempt === 1) throw new Error("WhatsApp worker timed out.");
    return { id: messageId };
  };
  const d = deps(store, send, ["3EB0AAAAAAAAAAAAAAAAAA", "3EB0BBBBBBBBBBBBBBBBBB"]);

  const first = await sendWaDraftOnce(d, "d1");
  assert.equal(first.ok, false);
  assert.equal(store.row.status, "pending", "a failed send stays pending so Send can retry");
  assert.equal(store.row.sendMessageId, "3EB0AAAAAAAAAAAAAAAAAA", "the id is claimed before the send, not after");

  const second = await sendWaDraftOnce(d, "d1");
  assert.equal(second.ok, true);
  assert.deepEqual(used, ["3EB0AAAAAAAAAAAAAAAAAA", "3EB0AAAAAAAAAAAAAAAAAA"], "the retry reuses the claimed id");
  assert.equal(store.mints, 1, "only one id is ever minted for a draft");
  assert.equal(store.row.status, "sent");
  assert.equal(store.row.sentMessageId, "3EB0AAAAAAAAAAAAAAAAAA");
});

test("two overlapping approvals send once", async () => {
  resetInFlightForTests();
  const store = fakeStore(makeDraft());
  let calls = 0;
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const send: WaSendDeps["send"] = async (_jid, _name, _text, messageId) => {
    calls += 1;
    await gate;
    return { id: messageId };
  };
  const d = deps(store, send, ["3EB0CCCCCCCCCCCCCCCCCC", "3EB0DDDDDDDDDDDDDDDDDD"]);

  // The panel and the CLI press Send at the same moment.
  const a = sendWaDraftOnce(d, "d1");
  const b = sendWaDraftOnce(d, "d1");
  release();
  const [ra, rb] = await Promise.all([a, b]);

  assert.equal(calls, 1, "the second caller joins the first send instead of starting another");
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  assert.equal(store.mints, 1);
});

test("a draft that already went out is not sent again", async () => {
  resetInFlightForTests();
  const store = fakeStore(makeDraft({ status: "sent", sentMessageId: "3EB0EEEEEEEEEEEEEEEEEE" }));
  let calls = 0;
  const send: WaSendDeps["send"] = async (_jid, _name, _text, messageId) => {
    calls += 1;
    return { id: messageId };
  };

  const result = await sendWaDraftOnce(deps(store, send, ["3EB0FFFFFFFFFFFFFFFFFF"]), "d1");
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});

test("a draft left in failed is retried under its claimed id", async () => {
  resetInFlightForTests();
  const store = fakeStore(makeDraft({ status: "failed", sendMessageId: "3EB0111111111111111111" }));
  const used: string[] = [];
  const send: WaSendDeps["send"] = async (_jid, _name, _text, messageId) => {
    used.push(messageId);
    return { id: messageId };
  };

  const result = await sendWaDraftOnce(deps(store, send, ["3EB0222222222222222222"]), "d1");
  assert.equal(result.ok, true);
  assert.deepEqual(used, ["3EB0111111111111111111"], "an id claimed on an earlier attempt is never replaced");
  assert.equal(store.mints, 0);
});

test("rewriting the draft after a failed send releases the claimed id", async () => {
  resetInFlightForTests();
  const store = fakeStore(makeDraft({ text: "Tuesday 3pm works" }));
  const used: string[] = [];
  let attempt = 0;
  const send: WaSendDeps["send"] = async (_jid, _name, text, messageId) => {
    used.push(`${messageId}:${text}`);
    attempt += 1;
    if (attempt === 1) throw new Error("WhatsApp worker timed out.");
    return { id: messageId };
  };
  const d = deps(store, send, ["3EB0AAAAAAAAAAAAAAAAAA", "3EB0BBBBBBBBBBBBBBBBBB"]);

  const first = await sendWaDraftOnce(d, "d1");
  assert.equal(first.ok, false);
  assert.equal(store.row.sendMessageId, "3EB0AAAAAAAAAAAAAAAAAA");

  // The owner fixes the time before pressing Send again. Reusing the old id here
  // would let WhatsApp drop the correction as a duplicate and leave the reader
  // with the wrong time, while the panel reports it sent.
  store.updateDraft("d1", { text: "Wednesday 3pm works" });
  assert.equal(store.row.sendMessageId, null, "the edit releases the id");

  const second = await sendWaDraftOnce(d, "d1");
  assert.equal(second.ok, true);
  assert.deepEqual(used, [
    "3EB0AAAAAAAAAAAAAAAAAA:Tuesday 3pm works",
    "3EB0BBBBBBBBBBBBBBBBBB:Wednesday 3pm works",
  ]);
  assert.equal(store.mints, 2, "the rewritten text gets its own id");
});

test("a second caller is refused when the wording changed under the send in flight", async () => {
  resetInFlightForTests();
  const store = fakeStore(makeDraft({ text: "first wording" }));
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const send: WaSendDeps["send"] = async (_jid, _name, _text, messageId) => {
    await gate;
    return { id: messageId };
  };
  const d = deps(store, send, ["3EB0777777777777777777", "3EB0888888888888888888"]);

  const inflight = sendWaDraftOnce(d, "d1");
  store.updateDraft("d1", { text: "second wording" });
  const joined = await sendWaDraftOnce(d, "d1");
  assert.equal(joined.ok, false, "joining must not report success for wording that never went out");

  release();
  assert.equal((await inflight).ok, true);
});

test("a send that comes back under a different id is flagged, not silently accepted", async () => {
  resetInFlightForTests();
  const store = fakeStore(makeDraft());
  const warnings: string[] = [];
  // Baileys ignoring our messageId is the one way the whole guarantee fails.
  const send: WaSendDeps["send"] = async () => ({ id: "3EB0NOTOURSNOTOURSNO" });
  const d = { ...deps(store, send, ["3EB0999999999999999999"]), record: (text: string) => warnings.push(text) };

  const result = await sendWaDraftOnce(d, "d1");
  assert.equal(result.ok, true, "the message did go out, so this is not a failure");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /not the id/);
  assert.equal(store.row.sentMessageId, "3EB0NOTOURSNOTOURSNO", "we record what actually went out");
});

test("a draft deleted mid-send does not report success", async () => {
  resetInFlightForTests();
  const store = fakeStore(makeDraft());
  const send: WaSendDeps["send"] = async (_jid, _name, _text, messageId) => {
    // The row goes away while the send is on the wire.
    store.row = { ...store.row, id: "gone" };
    return { id: messageId };
  };

  const result = await sendWaDraftOnce(deps(store, send, ["3EB0000000000000000000"]), "d1");
  assert.equal(result.ok, false);
});

// gmail.ts: telling "the draft is gone" from any other gw failure is what stops
// a lost confirmation being reported as a failure and sent a second time.
test("a missing Gmail draft is recognised from the gw error text", () => {
  assert.equal(looksLikeMissingDraft("api error (404): no such draft"), true);
  assert.equal(looksLikeMissingDraft("that draft was not found"), true);
  assert.equal(looksLikeMissingDraft("api error (500): the server had a problem"), false);
  assert.equal(looksLikeMissingDraft("Command failed: timeout"), false);
  assert.equal(looksLikeMissingDraft("api error (403): access refused"), false);
});
