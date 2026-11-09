// These tests pin what comms does through the Superhuman client and the
// server source, so a drift in the client fails loudly.
//
// No network and no live send: every call goes to the fake MCP server below.
// Every name, address, id and token here is invented for this file.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { SuperhumanClient, TokenStore, type FetchImpl, type McpTool } from "../superhuman.ts";
import { AGENT_SEND_REFUSAL, cliCallerIsAgent } from "../send-block.ts";
import { undoSend, type UndoClient, type UndoDeps } from "../undo-send.ts";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, createStore, type PluginDatabase, type UndoCopy } from "../store.ts";

const MCP = "https://mcp.example.test/mcp";
const AUTH = "https://auth.example.test";
const ENDPOINTS = {
  mcpEndpoint: MCP,
  authorizationServer: AUTH,
  authorizationEndpoint: `${AUTH}/authorize`,
  tokenEndpoint: `${AUTH}/token`,
  registrationEndpoint: `${AUTH}/register`,
};
const NOW = Date.parse("2031-06-24T02:00:00Z");

// The four tools this file calls, with the argument names SUPERHUMAN-TOOLS.md records.
const TOOLS: McpTool[] = [
  {
    name: "create_or_update_draft",
    description: "",
    inputSchema: {
      type: "object",
      properties: {
        acting_email: { type: "string" }, bcc: { type: "array" }, body: { type: "string" }, cc: { type: "array" },
        draft_id: { type: "string" }, from: { type: "string" }, subject: { type: "string" }, thread_id: { type: "string" },
        to: { type: "array" }, type: { type: "string" },
      },
      required: ["type"],
    },
  },
  {
    name: "send_draft",
    description: "",
    inputSchema: { type: "object", properties: { acting_email: { type: "string" }, draft_id: { type: "string" }, smart_send: { type: "boolean" }, undo_timeout: { type: "integer" } }, required: ["draft_id"] },
  },
  { name: "discard_draft", description: "", inputSchema: { type: "object", properties: { acting_email: { type: "string" }, draft_id: { type: "string" } }, required: ["draft_id"] } },
  { name: "undo_send", description: "", inputSchema: { type: "object", properties: { acting_email: { type: "string" }, message_id: { type: "string" }, undo_token: { type: "string" } } } },
  {
    name: "get_draft_send_status",
    description: "",
    inputSchema: { type: "object", properties: { acting_email: { type: "string" }, draft_id: { type: "string" }, thread_id: { type: "string" } }, required: ["draft_id"] },
  },
];

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fakeClient(answer: (tool: string, args: Record<string, unknown>) => unknown) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const reply = (id: unknown, result: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers: { "content-type": "application/json", ...headers } });
  const fetchImpl: FetchImpl = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { id?: unknown; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (body.method === "initialize") return reply(body.id, { protocolVersion: "2025-06-18" }, { "mcp-session-id": "s-1" });
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    if (body.method === "tools/list") return reply(body.id, { tools: TOOLS });
    const tool = body.params?.name ?? "";
    const args = body.params?.arguments ?? {};
    calls.push({ tool, args });
    return reply(body.id, answer(tool, args));
  };
  const dir = mkdtempSync(join(tmpdir(), "comms-pin-"));
  dirs.push(dir);
  const store = new TokenStore(join(dir, "t.json"));
  store.write({ clientId: "c", accessToken: "fake-access", refreshToken: "fake-refresh", expiresAtMs: NOW + 3_600_000, scope: "", tokenType: "Bearer", obtainedAtMs: NOW });
  const client = new SuperhumanClient({ store, fetchImpl, endpoint: MCP, endpoints: ENDPOINTS, now: () => NOW });
  return { client, calls };
}

const structured = (value: unknown) => ({ content: [], structuredContent: value });
const text = (value: string) => ({ content: [{ type: "text", text: value }] });

// ---------------------------------------------------------------------------

describe("pin: Undo Send at 1 and at 10 minutes", () => {
  for (const minutes of [1, 10]) {
    it(`asks Superhuman for a ${minutes}-minute window and reads its token and deadline back`, async () => {
      const deadline = new Date(NOW + minutes * 60_000).toISOString();
      const { client, calls } = fakeClient(() => structured({ message: { id: "msg-1", thread_id: "thr-1" }, undo_token: `undo-${minutes}`, undo_expires_at: deadline }));
      const sent = await client.sendDraft({ draftId: "shd-1", smartSend: false, undoMinutes: minutes });
      assert.deepEqual(calls.map((c) => c.tool), ["send_draft"]);
      assert.deepEqual(calls[0]!.args, { draft_id: "shd-1", undo_timeout: minutes });
      assert.deepEqual(sent, { messageId: "msg-1", threadId: "thr-1", undoToken: `undo-${minutes}`, undoExpiresAt: deadline });
    });
  }

  it("clamps the window to 1 to 10 minutes and sends no window with smart send", async () => {
    const answers = () => structured({ message: { id: "m" } });
    const low = fakeClient(answers);
    await low.client.sendDraft({ draftId: "d", smartSend: false, undoMinutes: 0 });
    assert.equal(low.calls[0]!.args.undo_timeout, 1);
    const high = fakeClient(answers);
    await high.client.sendDraft({ draftId: "d", smartSend: false, undoMinutes: 30 });
    assert.equal(high.calls[0]!.args.undo_timeout, 10);
    const smart = fakeClient(answers);
    await smart.client.sendDraft({ draftId: "d", smartSend: true, undoMinutes: 5 });
    assert.deepEqual(smart.calls[0]!.args, { draft_id: "d", smart_send: true });
  });

  it("the server takes the window from the undoSendMinutes setting, clamped 1 to 10, default 1", () => {
    const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    assert.match(server, /undoSendMinutes: \{[\s\S]{0,300}default: "1"/);
    assert.match(server, /Math\.min\(10, Math\.max\(1, value\)\)/);
    assert.match(server, /client\.sendDraft\(\{ draftId: shDraftId, smartSend: false, undoMinutes \}\)/);
  });

  // The three outcomes, through the real client against the fake server and
  // the real store, for a send made with each window.
  function undoHarness(minutes: number, undoAnswer: string, statuses: string[]) {
    const db = new DatabaseSync(":memory:");
    for (const statement of MIGRATIONS) {
      try {
        db.exec(statement);
      } catch (cause) {
        if (!String(cause).includes("duplicate column")) throw cause;
      }
    }
    const store = createStore(db as unknown as PluginDatabase);
    const copy: UndoCopy = { to: "Tamsin Rowe <tamsin@example.com>", cc: null, subject: "Re: Monday", body: "Monday at 9 suits.", threadId: "thr-1", replyToId: "in-1", origin: "you", conversationKey: "mail:work:thr-1" };
    const claim = store.claimSuperhumanSend({ account: "work", gmailDraftId: "g-1", threadId: "thr-1", to: copy.to, subject: copy.subject, actor: "panel" });
    assert.ok("id" in claim);
    store.setSuperhumanDraftId(claim.id, "shd-1");
    store.finishSuperhumanSend(claim.id, { status: "sent", messageId: "msg-1", threadId: "thr-1" });
    store.setSuperhumanUndo(claim.id, { token: `undo-${minutes}`, until: NOW + minutes * 60_000, copy });
    store.markSuperhumanGmailDraftDeleted(claim.id);
    let status = 0;
    const { client, calls } = fakeClient((tool) => {
      if (tool === "undo_send") return text(undoAnswer);
      if (tool === "get_draft_send_status") return structured({ status: statuses[Math.min(status++, statuses.length - 1)] });
      if (tool === "discard_draft") return text("discarded");
      throw new Error(`Undo must not call ${tool}`);
    });
    const written: UndoCopy[] = [];
    const narrowed: UndoClient = { undoSend: (input) => client.undoSend(input), getDraftSendStatus: (input) => client.getDraftSendStatus(input) };
    const deps: UndoDeps = {
      client: () => narrowed,
      wait: async () => undefined,
      markCancelled: (id) => store.markSuperhumanSendCancelled(id),
      clearUndo: (id) => store.clearSuperhumanUndo(id),
      writeBack: async (c) => {
        written.push(c);
        return "g-2";
      },
      discardSuperhumanDraft: (draftId) => client.discardDraft({ draftId }),
      note: () => undefined,
    };
    return { store, id: claim.id, calls, written, run: () => undoSend(store.superhumanSendRow(claim.id), claim.id, deps) };
  }

  for (const minutes of [1, 10]) {
    it(`${minutes} min: a cancel Superhuman confirms is "Cancelled, back in drafts"`, async () => {
      const h = undoHarness(minutes, "Send canceled.", ["pending", "idle"]);
      const result = await h.run();
      assert.deepEqual({ outcome: result.outcome, text: result.text }, { outcome: "cancelled", text: "Cancelled, back in drafts." });
      assert.equal(h.calls[0]!.tool, "undo_send");
      assert.deepEqual(h.calls[0]!.args, { undo_token: `undo-${minutes}`, message_id: "msg-1" });
      assert.deepEqual(h.calls.map((c) => c.tool), ["undo_send", "get_draft_send_status", "get_draft_send_status", "discard_draft"]);
      assert.equal(h.store.superhumanSendRow(h.id)?.status, "cancelled");
      assert.equal(h.written.length, 1);
      assert.ok(!h.calls.some((c) => c.tool === "send_draft"), "undo never sends");
    });

    it(`${minutes} min: already sent is "Too late, it was sent"`, async () => {
      // "idle" here would read as a confirmed cancel; an already_sent answer
      // must decide on its own, before any status is asked for.
      const h = undoHarness(minutes, "already_sent: past the undo window", ["idle"]);
      const result = await h.run();
      assert.deepEqual({ outcome: result.outcome, text: result.text }, { outcome: "too_late", text: "Too late, it was sent." });
      assert.deepEqual(h.calls.map((c) => c.tool), ["undo_send"]);
      assert.equal(h.store.superhumanSendRow(h.id)?.status, "sent");
      assert.equal(h.store.undoableSuperhumanSends(NOW - 1).length, 0, "Undo is not offered again");
      assert.deepEqual(h.written, []);
    });

    it(`${minutes} min: a cancel the draft status calls closed is too late too`, async () => {
      const h = undoHarness(minutes, "Send canceled.", ["closed"]);
      assert.equal((await h.run()).outcome, "too_late");
      assert.deepEqual(h.written, []);
    });

    it(`${minutes} min: an unconfirmed cancel fails and still counts as sent`, async () => {
      const h = undoHarness(minutes, "Send canceled.", ["pending", "pending", "pending"]);
      const result = await h.run();
      assert.equal(result.outcome, "failed");
      assert.match(result.text, /still counts as sent/);
      assert.equal(h.store.superhumanSendRow(h.id)?.status, "sent");
      assert.deepEqual(h.written, []);
    });
  }
});

describe("pin: agent sends through bb comms are refused", () => {
  const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");

  it("a call from a thread is an agent, his terminal is not", () => {
    assert.equal(cliCallerIsAgent({ threadId: "thr_anyagent" }), true);
    assert.equal(cliCallerIsAgent({}), false);
    assert.equal(AGENT_SEND_REFUSAL, "Not sent. Only the user sends messages, from the Comms panel. The draft is saved and waiting for him there; tell him it is ready.");
  });

  it("bb comms approve, wa approve and wa send refuse before anything else", () => {
    const first = server.indexOf('case "approve": {');
    const second = server.indexOf('case "approve": {', first + 1);
    const send = server.indexOf('case "send": {');
    for (const at of [first, second, send]) {
      assert.ok(at > 0);
      const firstLine = server.slice(at, at + 200).split("\n")[1] ?? "";
      assert.match(firstLine, /^\s*if \(cliCallerIsAgent\(ctx\)\) return bad\(AGENT_SEND_REFUSAL\);$/);
    }
  });

  it("the three chief send tools refuse and call nothing", () => {
    for (const tool of ["comms_mail_send_draft", "comms_wa_send", "comms_wa_send_draft"]) {
      const at = server.indexOf(`name: "${tool}",`);
      const body = server.slice(at, server.indexOf("\n  });\n", at));
      assert.match(body, /execute\(\) \{\s*return fail\(AGENT_SEND_REFUSAL\);\s*\}/, tool);
    }
  });
});

describe("pin: Superhuman draft create, update and discard", () => {
  it("create sends type, from, to, cc, subject and body, and reads the draft and thread back", async () => {
    const { client, calls } = fakeClient(() => structured({ draft: { draft_id: "shd-9", thread_id: "thr-9" } }));
    const made = await client.createOrUpdateDraft({
      type: "reply",
      threadId: "thr-9",
      from: "me@example.com",
      to: ["tamsin@example.com"],
      cc: ["office@example.com"],
      subject: "Re: Monday",
      bodyHtml: "<p>Monday at 9 suits.</p>",
    });
    assert.deepEqual(made, { draftId: "shd-9", threadId: "thr-9" });
    assert.deepEqual(calls[0], {
      tool: "create_or_update_draft",
      args: { type: "reply", thread_id: "thr-9", from: "me@example.com", to: ["tamsin@example.com"], cc: ["office@example.com"], subject: "Re: Monday", body: "<p>Monday at 9 suits.</p>" },
    });
  });

  it("update passes the existing draft id, and an empty cc is left out", async () => {
    const { client, calls } = fakeClient(() => structured({ draft: { id: "shd-9" } }));
    await client.createOrUpdateDraft({ type: "reply", draftId: "shd-9", threadId: "thr-9", from: "me@example.com", to: ["tamsin@example.com"], cc: [], subject: "Re: Monday", bodyHtml: "<p>x</p>" });
    assert.equal(calls[0]!.args.draft_id, "shd-9");
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0]!.args, "cc"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0]!.args, "instructions"), false, "Superhuman never writes the text");
  });

  it("a new email defaults to type new", async () => {
    const { client, calls } = fakeClient(() => structured({ draft: { id: "shd-1" } }));
    await client.createOrUpdateDraft({ from: "me@example.com", to: ["a@example.com"], subject: "Hello", bodyHtml: "<p>x</p>" });
    assert.equal(calls[0]!.args.type, "new");
  });

  it("discard passes the draft id and nothing else", async () => {
    const { client, calls } = fakeClient(() => text("discarded"));
    await client.discardDraft({ draftId: "shd-9" });
    assert.deepEqual(calls, [{ tool: "discard_draft", args: { draft_id: "shd-9" } }]);
  });

  it("the send path writes a reply twice, create then update with the exact recipients, then reads them back", () => {
    const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    const at = server.indexOf("async function sendViaSuperhumanClaimed(");
    const body = server.slice(at, server.indexOf("\n  }\n", at));
    const create = body.indexOf("client.createOrUpdateDraft({");
    const update = body.indexOf("draftId: shDraftId,", create);
    const readBack = body.indexOf("client.getDraftRecipients({ draftId: shDraftId })");
    const send = body.indexOf("client.sendDraft(");
    assert.ok(create > 0 && update > create && readBack > update && send > readBack, "create, update, read back, send");
  });
});

describe("pin: Gmail draft create, update and discard (the drafts the panel sends from)", async () => {
  const { createMail, gwAccountLabels } = await import("../gmail.ts");
  function recordingGw(reply: Record<string, unknown>) {
    const calls: { args: string[]; stdin?: string }[] = [];
    return { calls, gw: { run: async (args: string[], options: { stdin?: string } = {}) => (calls.push({ args, stdin: options.stdin }), reply) } };
  }

  it("create passes the body on stdin and the headers as flags", async () => {
    const r = recordingGw({ draft_id: "gd-1", message_id: "gm-1", thread_id: "gt-1" });
    const made = await createMail(r.gw).draft("work", { to: "tamsin@example.com", subject: "Re: Monday", body: "Monday at 9 suits.", cc: "office@example.com", replyToMessageId: "in-1" });
    assert.deepEqual(r.calls, [
      { args: ["--account", "work", "gmail", "draft", "--to", "tamsin@example.com", "--subject", "Re: Monday", "--body", "-", "--cc", "office@example.com", "--reply-to", "in-1"], stdin: "Monday at 9 suits." },
    ]);
    assert.deepEqual(made, { draftId: "gd-1", messageId: "gm-1", threadId: "gt-1", to: "tamsin@example.com", cc: "office@example.com", subject: "Re: Monday" });
  });

  it("update replaces the body by id and keeps the draft", async () => {
    const r = recordingGw({ draft_id: "gd-1", thread_id: "gt-1" });
    const updated = await createMail(r.gw).draftUpdate("personal", "gd-1", { body: "Tuesday instead." });
    assert.deepEqual(r.calls, [{ args: ["--account", "personal", "gmail", "draft-update", "gd-1", "--body", "-"], stdin: "Tuesday instead." }]);
    assert.equal(updated.draftId, "gd-1");
  });

  it("discard deletes by id", async () => {
    const r = recordingGw({ deleted: true });
    assert.equal(await createMail(r.gw).draftDelete("work", "gd-1"), true);
    assert.deepEqual(r.calls, [{ args: ["--account", "work", "gmail", "draft-delete", "gd-1"], stdin: undefined }]);
  });

  it("the Gmail send keeps the approval flag gw requires, under the configured account label", async () => {
    const r = recordingGw({ message_id: "gm-2" });
    const labels = gwAccountLabels(" ", "home-mail");
    assert.deepEqual(labels, { work: "work", personal: "home-mail" });
    await createMail(r.gw, labels).sendDraft("personal", "gd-1");
    assert.deepEqual(r.calls[0]!.args, ["--account", "home-mail", "gmail", "send-draft", "gd-1", "--i-have-user-approval"]);
  });
});
