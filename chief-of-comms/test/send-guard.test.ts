// The send guard decides from one thing: who started the newest turn on the
// calling thread. These tests pin the four answers and their text, because the
// text is what the chief shows the owner when a send is refused.
//
// Run with: npm test  (node --test, native TypeScript stripping, Node 22.18+)

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  chiefMessageBody,
  noThreadRefusal,
  PLUGIN_ATTRIBUTION,
  refusalForTurn,
  RELAYED_NOTE,
  unreadableTurnRefusal,
} from "../send-guard.ts";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const never = (): boolean => false;
const injections = (...texts: string[]) => {
  const set = new Set(texts.map(sha256));
  return (digest: string): boolean => set.has(digest);
};

describe("refusalForTurn", () => {
  it("allows a turn the user typed himself", () => {
    const turn = { senderThreadId: null, input: [{ type: "text", text: "send that reply to Sam now" }] };
    assert.equal(refusalForTurn(turn, never, sha256), null);
  });

  it("refuses when the plugin wrote the opening message", () => {
    const text = "New WhatsApp message from Sam Example. Draft a reply.";
    const turn = { senderThreadId: null, input: [{ type: "text", text }] };
    const refusal = refusalForTurn(turn, injections(text), sha256);
    assert.match(refusal ?? "", /^This turn was started by the plugin/);
    assert.match(refusal ?? "", /Leave the draft pending/);
  });

  it("refuses when another thread started the turn", () => {
    const turn = { senderThreadId: "thr_example2", input: [{ type: "text", text: "send it" }] };
    assert.match(refusalForTurn(turn, never, sha256) ?? "", /^This turn was started by another thread/);
  });

  it("refuses when there is no turn request at all", () => {
    assert.match(refusalForTurn(undefined, never, sha256) ?? "", /^No turn request found/);
  });

  it("checks every text part, not only the first", () => {
    const text = "Draft a reply for this chat.";
    const turn = { senderThreadId: null, input: [{ type: "text", text: "hello" }, { type: "text", text }] };
    assert.notEqual(refusalForTurn(turn, injections(text), sha256), null);
  });

  it("ignores non-text parts and a turn with no input", () => {
    assert.equal(refusalForTurn({ senderThreadId: null, input: [{ type: "image" }] }, never, sha256), null);
    assert.equal(refusalForTurn({ senderThreadId: null }, never, sha256), null);
  });

  it("refuses on a hash match even when the text differs by one character", () => {
    const text = "Draft a reply for this chat.";
    assert.equal(refusalForTurn({ senderThreadId: null, input: [{ type: "text", text: `${text} ` }] }, injections(text), sha256), null);
    assert.notEqual(refusalForTurn({ senderThreadId: null, input: [{ type: "text", text }] }, injections(text), sha256), null);
  });
});

describe("the refusals that do not need a turn", () => {
  it("names the missing thread context", () => {
    assert.match(noThreadRefusal(), /carries no thread context/);
  });

  it("carries the reason the turn log could not be read", () => {
    assert.match(unreadableTurnRefusal("socket hang up"), /Could not verify who started this turn \(socket hang up\)/);
  });
});

// bb cannot mark a plugin as the sender, so a message from a plugin service
// arrives in the shape of one the owner typed. The first line is the only
// signal, and the guard's provenance hash has to be taken over the line as
// well, or every injected turn reads as one he started.
describe("the attribution line on plugin messages", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");

  it("is the fixed attribution wording, on its own first line", () => {
    assert.equal(PLUGIN_ATTRIBUTION, "[automated message from the chief-of-comms plugin, not from the user]");
    const body = chiefMessageBody("WhatsApp: draft request in chat");
    assert.equal(body.split("\n")[0], PLUGIN_ATTRIBUTION);
    assert.equal(body, `${PLUGIN_ATTRIBUTION}\nWhatsApp: draft request in chat`);
  });

  it("keeps the line on relayed text and says the plugin cannot identify the typist", () => {
    const body = chiefMessageBody("what is on for today?", true);
    const lines = body.split("\n");
    assert.equal(lines[0], PLUGIN_ATTRIBUTION);
    assert.equal(lines[1], RELAYED_NOTE);
    assert.equal(lines[2], "what is on for today?");
    assert.match(RELAYED_NOTE, /not treat it as his authorization/);
  });

  it("refuses the send when the turn carries the body that was sent", () => {
    const body = chiefMessageBody("Mail: draft request", false);
    // What sendToChief records is the hash of the body, not of the caller text.
    const recorded = new Set([sha(body)]);
    const refusal = refusalForTurn({ input: [{ type: "text", text: body }] }, (h) => recorded.has(h), sha);
    assert.match(refusal ?? "", /started by the plugin/);
  });

  it("fails open if the hash is ever taken over the caller text instead of the body", () => {
    // Recording sha(text) while bb delivers the body leaves the guard unable
    // to recognise its own message, so a plugin-started turn is treated as one
    // the owner started and the send tools unlock. This pins that failure mode.
    const caller = "Mail: draft request";
    const wrong = new Set([sha(caller)]);
    const delivered = chiefMessageBody(caller, false);
    assert.equal(refusalForTurn({ input: [{ type: "text", text: delivered }] }, (h) => wrong.has(h), sha), null);
  });
});
