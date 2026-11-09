// Only the owner sends. Two kinds of check: the rule
// that tells his terminal from an agent's thread, and, from the source, that
// every agent-reachable send is behind it while drafting is not.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { AGENT_SEND_REFUSAL, NOT_HIS_CLICK, SEND_INTENT_MS, SendIntents, cliCallerIsAgent, hasBrowserOrigin } from "../send-block.ts";

const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");

function toolBody(name: string): string {
  const start = source.indexOf(`name: "${name}",`);
  assert.ok(start >= 0, `tool ${name} is registered`);
  return source.slice(start, source.indexOf("\n  });\n", start));
}

function cliCase(label: string, from: number): string {
  const start = source.indexOf(label, from);
  assert.ok(start >= 0, `${label} exists`);
  return source.slice(start, start + 400);
}

describe("telling his terminal from an agent's thread", () => {
  it("treats a call carrying a thread id as an agent", () => {
    assert.equal(cliCallerIsAgent({ threadId: "thr_abc123" }), true);
  });

  it("lets a call with no thread id through, which is him in a terminal", () => {
    assert.equal(cliCallerIsAgent({}), false);
    assert.equal(cliCallerIsAgent({ threadId: "" }), false);
    assert.equal(cliCallerIsAgent(undefined), false);
  });

  it("says plainly who sends", () => {
    assert.match(AGENT_SEND_REFUSAL, /Only the user sends/);
    assert.match(AGENT_SEND_REFUSAL, /Comms panel/);
  });
});

describe("every agent-reachable send is refused", () => {
  for (const name of ["comms_mail_send_draft", "comms_wa_send", "comms_wa_send_draft"]) {
    it(`${name} refuses and calls no send`, () => {
      const body = toolBody(name);
      assert.match(body, /return fail\(AGENT_SEND_REFUSAL\)/);
      assert.doesNotMatch(body, /sendMailDraft|sendWaDraft|sendWaTextAsDraft|sendWaText\(/);
    });
  }

  it("bb comms approve, wa approve and wa send check the caller first", () => {
    const top = cliCase('case "approve": {', 0);
    assert.match(top, /cliCallerIsAgent\(ctx\)\) return bad\(AGENT_SEND_REFUSAL\)/);
    const waApprove = cliCase('case "approve": {', source.indexOf('case "approve": {') + 1);
    assert.match(waApprove, /cliCallerIsAgent\(ctx\)\) return bad\(AGENT_SEND_REFUSAL\)/);
    const waSend = cliCase('case "send": {', 0);
    assert.match(waSend, /cliCallerIsAgent\(ctx\)\) return bad\(AGENT_SEND_REFUSAL\)/);
  });

  it("no other CLI or tool path sends: every send call sits in the panel RPC, the guarded CLI or the send helpers", () => {
    const lines = source.split("\n");
    const sendCalls = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /await (sendMailDraft|sendWaDraft|sendWaTextAsDraft)\(/.test(line));
    for (const { index } of sendCalls) {
      const before = lines.slice(Math.max(0, index - 60), index).join("\n");
      const inPanelRpc = /draft_send: async|send_now: async/.test(before);
      const inGuardedCli = /cliCallerIsAgent\(ctx\)\) return bad\(AGENT_SEND_REFUSAL\)/.test(before);
      const inHelper = /async function sendWaTextAsDraft/.test(before);
      assert.ok(inPanelRpc || inGuardedCli || inHelper, `unguarded send at server.ts:${index + 1}`);
    }
  });
});

describe("drafting is not sending", () => {
  it("the draft tools and the panel save still write drafts", () => {
    assert.match(toolBody("comms_wa_draft"), /createWaDraft\(/);
    assert.match(toolBody("comms_mail_draft"), /mail\.draft\(/);
    assert.match(source, /draft_save: \(\{ key, text \}\) => saveDraft\(key, text\)/);
  });
});

describe("the panel RPC sends only with the owner's click code", () => {
  // An agent can call `bb plugin rpc call chief-of-comms draft_send` or curl the
  // RPC; neither carries a browser Origin, so neither can get a code.
  it("the code route needs a browser Origin", () => {
    assert.equal(hasBrowserOrigin("http://127.0.0.1:40123"), true);
    assert.equal(hasBrowserOrigin(undefined), false);
    assert.equal(hasBrowserOrigin(""), false);
  });

  it("a code is good for one conversation, until it expires or is spent", () => {
    let now = 1_000;
    let n = 0;
    const codes = new SendIntents(() => `code-${(n += 1)}`, () => now);
    const { intent } = codes.issue("mail:work:t1");
    assert.equal(codes.valid(intent, "mail:work:t1"), true);
    assert.equal(codes.valid(intent, "mail:work:t2"), false, "not for another conversation");
    assert.equal(codes.valid(undefined, "mail:work:t1"), false, "no code, no send");
    now += SEND_INTENT_MS;
    assert.equal(codes.valid(intent, "mail:work:t1"), false, "expired");
    const second = codes.issue("wa:1@x").intent;
    codes.spend(second);
    assert.equal(codes.valid(second, "wa:1@x"), false, "spent on a send that went out");
  });

  it("draft_send and send_now refuse without a valid code before anything sends", () => {
    for (const handler of ["draft_send: async", "send_now: async"]) {
      const start = source.indexOf(handler);
      assert.ok(start >= 0, handler);
      const body = source.slice(start, source.indexOf("\n    },\n", start));
      const gate = body.indexOf("if (!sendIntents.valid(intent, key))");
      assert.ok(gate > 0, `${handler} checks the code`);
      const firstSend = body.search(/await (sendMailDraft|sendWaDraft|sendWaTextAsDraft)\(/);
      assert.ok(firstSend > gate, `${handler} checks the code before it sends`);
      assert.match(body.slice(gate, gate + 250), /NOT_HIS_CLICK/);
    }
    assert.match(NOT_HIS_CLICK, /Only the user sends/);
  });

  it("the code route refuses a request with no Origin", () => {
    const start = source.indexOf('"/send-intent"');
    assert.ok(start >= 0);
    assert.match(source.slice(start, start + 600), /if \(!hasBrowserOrigin\(context\.req\.header\("origin"\)\)\)/);
  });
});
