// Tests for the Superhuman MCP client. No network: every test injects its own
// fetch. The fake tokens below are invented strings; nothing here touches a
// real account, and the token file each test writes lives in a temp directory
// it removes again.
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RECONNECT_SENTENCE,
  SuperhumanClient,
  TokenStore,
  buildArgs,
  callIsSend,
  jsonOf,
  parseSseForResult,
  buildAuthorizeUrl,
  createPkce,
  createState,
  exchangeCode,
  pick,
  refresh,
  registerClient,
  textOf,
} from "../superhuman.ts";
import type { FetchImpl, McpTool, OAuthEndpoints, StoredTokens } from "../superhuman.ts";

// The plugin root: superhuman.ts and SUPERHUMAN-TOOLS.md sit there, this file does not.
const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
const MCP_URL = "https://mcp.example.test/mcp";
const AUTH = "https://auth.example.test";

const ENDPOINTS: OAuthEndpoints = {
  mcpEndpoint: MCP_URL,
  authorizationServer: AUTH,
  authorizationEndpoint: `${AUTH}/oauth2/authorize`,
  tokenEndpoint: `${AUTH}/oauth2/token`,
  registrationEndpoint: `${AUTH}/oauth2/register`,
};

const ACCESS_TOKEN = "fake-access-token-first-round";
const REFRESHED_TOKEN = "fake-access-token-second-round";
const REFRESH_TOKEN = "fake-refresh-token-only-one";

const TOOLS: McpTool[] = [
  // These mirror the schemas the live server advertises, recorded
  // in SUPERHUMAN-TOOLS.md. A fixture that invents a friendlier schema is how a
  // client can pass its whole suite while calling a tool that does not exist.
  { name: "list_accounts", description: "list accounts", inputSchema: { type: "object", properties: { acting_email: { type: "string" } } } },
  {
    name: "get_thread",
    description: "get a thread",
    inputSchema: {
      type: "object",
      properties: { thread_id: { type: "string" }, acting_email: { type: "string" }, include_comments: { type: "boolean" }, include_drafts: { type: "boolean" }, message_limit: { type: "integer" } },
      required: ["thread_id"],
    },
  },
  {
    name: "create_or_update_draft",
    description: "create or update a draft",
    inputSchema: {
      type: "object",
      properties: {
        acting_email: { type: "string" },
        body: { type: "string" },
        draft_id: { type: "string" },
        from: { type: "string" },
        subject: { type: "string" },
        thread_id: { type: "string" },
        to: { type: "array" },
        type: { type: "string", enum: ["new", "forward", "reply", "reply_all"] },
      },
      required: ["type"],
    },
  },
  {
    name: "send_draft",
    description: "send a draft",
    inputSchema: {
      type: "object",
      properties: { acting_email: { type: "string" }, draft_id: { type: "string" }, send_at: { type: "string" }, smart_send: { type: "boolean" }, undo_timeout: { type: "integer" } },
      required: ["draft_id"],
    },
  },
  {
    name: "list_threads",
    description: "search email threads",
    inputSchema: {
      type: "object",
      properties: {
        acting_email: { type: "string" },
        body_contains: { type: "string" },
        cursor: { type: "string" },
        end_date: { type: "string" },
        from: { type: "array" },
        has_attachment: { type: "boolean" },
        is_starred: { type: "boolean" },
        is_unread: { type: "boolean" },
        labels: { type: "array" },
        limit: { type: "integer" },
        sort: { type: "string", enum: ["newest", "oldest"] },
        split: { type: "string" },
        start_date: { type: "string" },
        subject_contains: { type: "string" },
        to: { type: "array" },
      },
    },
  },
  {
    name: "undo_send",
    description: "cancel a queued send",
    inputSchema: {
      type: "object",
      properties: { acting_email: { type: "string" }, message_id: { type: "string" }, undo_token: { type: "string" } },
    },
  },
];

const temporaryDirectories: string[] = [];

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporaryStore(tokens: StoredTokens | null = defaultTokens()): TokenStore {
  const directory = mkdtempSync(join(tmpdir(), "comms-superhuman-test-"));
  temporaryDirectories.push(directory);
  const store = new TokenStore(join(directory, "state", "superhuman.json"));
  if (tokens !== null) store.write(tokens);
  return store;
}

function defaultTokens(): StoredTokens {
  return {
    clientId: "client-abc",
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    expiresAtMs: Date.parse("2031-03-10T04:00:00Z") + 3_600_000,
    scope: "openid email profile offline_access",
    tokenType: "Bearer",
    obtainedAtMs: Date.parse("2031-03-10T04:00:00Z"),
  };
}

const NOW = () => Date.parse("2031-03-10T04:00:00Z");

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function sseResponse(messages: string[]): Response {
  const body = messages.map((message) => `event: message\ndata: ${message}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface JsonRpcPayload {
  id?: string;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

interface FakeServer {
  fetchImpl: FetchImpl;
  calls: string[];
  toolArguments: Array<Record<string, unknown>>;
}

/**
 * A fake Superhuman that answers the handshake and hands every `tools/call` to
 * the test's own function. `tokenReply` stands in for the OAuth token endpoint.
 */
function fakeServer(options: {
  onCall: (payload: JsonRpcPayload, attempt: number) => Response;
  tokenReply?: () => Response;
  tools?: McpTool[];
}): FakeServer {
  const calls: string[] = [];
  const toolArguments: Array<Record<string, unknown>> = [];
  let callAttempts = 0;

  const fetchImpl: FetchImpl = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";

    if (url === ENDPOINTS.tokenEndpoint) {
      calls.push("token");
      const reply = options.tokenReply ?? (() => jsonResponse({ access_token: REFRESHED_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3600 }));
      return reply();
    }

    assert.equal(url, MCP_URL, `unexpected URL in a test: ${url}`);
    const payload = JSON.parse(body) as JsonRpcPayload;
    calls.push(`mcp:${payload.method}`);

    if (payload.method === "initialize") {
      return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "superhuman" } } }, 200, {
        "mcp-session-id": "session-1",
      });
    }
    if (payload.method === "notifications/initialized") return new Response("", { status: 202 });
    if (payload.method === "tools/list") {
      return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: { tools: options.tools ?? TOOLS } });
    }
    if (payload.method === "tools/call") {
      callAttempts += 1;
      if (payload.params?.arguments !== undefined) toolArguments.push(payload.params.arguments);
      return options.onCall(payload, callAttempts);
    }
    throw new Error(`unexpected method in a test: ${payload.method}`);
  };

  return { fetchImpl, calls, toolArguments };
}

function client(server: FakeServer, store: TokenStore): SuperhumanClient {
  return new SuperhumanClient({ store, fetchImpl: server.fetchImpl, endpoint: MCP_URL, endpoints: ENDPOINTS, now: NOW });
}

function toolResult(payload: JsonRpcPayload, result: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", id: payload.id, result });
}

// ---------------------------------------------------------------------------

describe("parseSseForResult", () => {
  const stream = [
    "event: message",
    'data: {"jsonrpc":"2.0","id":"other-1","result":{"ignored":true}}',
    "",
    ": keep-alive",
    "",
    "event: message",
    'data: {"jsonrpc":"2.0","id":"wanted","result":{"value":"right one"}}',
    "",
    "event: message",
    'data: {"jsonrpc":"2.0","id":"other-2","result":{"ignored":true}}',
    "",
  ].join("\n");

  test("finds the message whose id matches and ignores the others", () => {
    const found = parseSseForResult(stream, "wanted");
    assert.notEqual(found, null);
    assert.deepEqual(found?.result, { value: "right one" });
  });

  test("returns null when no event carries the id", () => {
    assert.equal(parseSseForResult(stream, "absent"), null);
  });

  test("takes the last matching message and survives a data line that is not JSON", () => {
    const messy = [
      "data: not json at all",
      "",
      'data: {"jsonrpc":"2.0","id":"7","result":{"round":1}}',
      "",
      'data: {"jsonrpc":"2.0","id":"7","result":{"round":2}}',
      "",
    ].join("\n");
    assert.deepEqual(parseSseForResult(messy, 7)?.result, { round: 2 });
  });

  test("reads a payload split over several data lines", () => {
    const split = ["event: message", 'data: {"jsonrpc":"2.0","id":"a",', 'data: "result":{"ok":true}}', ""].join("\n");
    assert.deepEqual(parseSseForResult(split, "a")?.result, { ok: true });
  });

  test("returns null for an empty stream", () => {
    assert.equal(parseSseForResult("", "a"), null);
  });
});

describe("transport", () => {
  test("a plain JSON reply parses and normalises", async () => {
    const server = fakeServer({
      onCall: (payload) =>
        toolResult(payload, {
          content: [],
          structuredContent: { accounts: ["work@example.com", { email: "alias@example.com", isDefault: true }] },
        }),
    });
    const accounts = await client(server, temporaryStore()).listAccounts();
    assert.deepEqual(accounts.accounts, ["work@example.com", "alias@example.com"]);
    assert.equal(accounts.defaultAccount, "alias@example.com");
    assert.deepEqual(server.calls, ["mcp:initialize", "mcp:notifications/initialized", "mcp:tools/list", "mcp:tools/call"]);
  });

  test("an SSE reply parses, and a thread normalises for classifyIncoming", async () => {
    const thread = {
      thread_id: "t-1",
      subject: "Your enquiry",
      messages: [
        {
          message_id: "m-1",
          from: "Celyn Example <celyn@example.com>",
          to: ["alias@example.com"],
          subject: "Automatic reply: Your enquiry",
          received_at: "2031-03-10T01:30:00Z",
          snippet: "I am away",
          headers: [{ name: "Auto-Submitted", value: "auto-replied" }, { name: "X-Vacation", value: "1" }],
        },
      ],
    };
    const server = fakeServer({
      onCall: (payload) =>
        sseResponse([
          JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} }),
          JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { content: [{ type: "text", text: JSON.stringify(thread) }] } }),
        ]),
    });
    const result = await client(server, temporaryStore()).getThread("t-1", "alias@example.com");
    assert.equal(result.threadId, "t-1");
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].id, "m-1");
    assert.equal(result.messages[0].autoSubmitted, "auto-replied");
    assert.deepEqual(result.messages[0].headerNames, ["Auto-Submitted", "X-Vacation"]);
    assert.equal(result.messages[0].receivedAt, "2031-03-10T01:30:00.000Z");
    assert.deepEqual(result.messages[0].to, ["alias@example.com"]);
  });

  test("the session id and protocol version are echoed back after initialize", async () => {
    const seen: Array<Record<string, string>> = [];
    const base = fakeServer({ onCall: (payload) => toolResult(payload, { content: [], structuredContent: { accounts: [] } }) });
    const recording: FetchImpl = async (input, init) => {
      seen.push({ ...((init?.headers ?? {}) as Record<string, string>) });
      return base.fetchImpl(input, init);
    };
    const store = temporaryStore();
    const connected = new SuperhumanClient({ store, fetchImpl: recording, endpoint: MCP_URL, endpoints: ENDPOINTS, now: NOW });
    await connected.listAccounts();
    assert.equal(seen[0]["mcp-protocol-version"], undefined, "initialize must not carry the negotiated version");
    const last = seen[seen.length - 1];
    assert.equal(last["mcp-protocol-version"], "2025-06-18");
    assert.equal(last["mcp-session-id"], "session-1");
    assert.equal(last.authorization, `Bearer ${ACCESS_TOKEN}`);
  });

  test("one 401 refreshes once and retries the call once", async () => {
    const server = fakeServer({
      onCall: (payload, attempt) => {
        if (attempt === 1) return new Response("", { status: 401 });
        return toolResult(payload, { content: [], structuredContent: { accounts: ["alias@example.com"] } });
      },
    });
    const store = temporaryStore();
    const result = await client(server, store).listAccounts();
    assert.deepEqual(result.accounts, ["alias@example.com"]);
    assert.equal(server.calls.filter((call) => call === "token").length, 1, "the token endpoint is called exactly once");
    assert.equal(server.calls.filter((call) => call === "mcp:tools/call").length, 2, "the tool call is retried exactly once");
    assert.equal(store.read()?.accessToken, REFRESHED_TOKEN, "the refreshed token is stored");
  });

  test("two 401s tell the user to reconnect and leak no token", async () => {
    const server = fakeServer({ onCall: () => new Response("", { status: 401 }) });
    await assert.rejects(
      () => client(server, temporaryStore()).listAccounts(),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /bb comms connect superhuman/);
        assert.equal(message.includes(ACCESS_TOKEN), false);
        assert.equal(message.includes(REFRESHED_TOKEN), false);
        assert.equal(message.includes(REFRESH_TOKEN), false);
        return true;
      },
    );
    assert.equal(server.calls.filter((call) => call === "token").length, 1);
    assert.equal(server.calls.filter((call) => call === "mcp:tools/call").length, 2);
  });

  test("a tool this server does not advertise fails by name", async () => {
    const server = fakeServer({ onCall: (payload) => toolResult(payload, { content: [] }), tools: [TOOLS[0]] });
    await assert.rejects(() => client(server, temporaryStore()).getThread("t-1"), /get_thread/);
  });

  test("a JSON-RPC error names the method", async () => {
    const server = fakeServer({
      onCall: (payload) => jsonResponse({ jsonrpc: "2.0", id: payload.id, error: { code: -32602, message: "bad arguments" } }),
    });
    await assert.rejects(() => client(server, temporaryStore()).listAccounts(), /bad arguments/);
  });
});

describe("arguments and results", () => {
  test("the draft carries the required type and the body under the name the server uses", async () => {
    // `type` is required, and the body field is `body`, not `body_html`.
    const server = fakeServer({
      onCall: (payload) => toolResult(payload, { content: [], structuredContent: { draft: { id: "d-1", thread_id: "t-9" } } }),
    });
    const draft = await client(server, temporaryStore()).createOrUpdateDraft({
      from: "alias@example.com",
      to: ["celyn@example.com", "sam@example.com"],
      subject: "Your question about the course",
      bodyHtml: "<p>hello</p>",
    });
    assert.deepEqual(draft, { draftId: "d-1", threadId: "t-9" });
    const sent = server.toolArguments[0];
    assert.equal(sent.type, "new");
    assert.equal(sent.body, "<p>hello</p>");
    assert.deepEqual(sent.to, ["celyn@example.com", "sam@example.com"], "the schema declares an array, so it stays one");
    assert.equal(sent.from, "alias@example.com");
    assert.equal(Object.prototype.hasOwnProperty.call(sent, "body_html"), false);
  });

  test("the send call carries the draft id and nothing else about the message", async () => {
    // `send_draft` accepts only draft_id, smart_send, send_at, undo_timeout
    // and acting_email. Passing the recipient or the body would be refused by
    // the server.
    const server = fakeServer({
      onCall: (payload) => toolResult(payload, { content: [], structuredContent: { message: { id: "m-1", thread_id: "t-9" } } }),
    });
    const sent = await client(server, temporaryStore()).sendDraft({ draftId: "d-1", smartSend: false });
    assert.deepEqual(sent, { messageId: "m-1", threadId: "t-9", undoToken: null, undoExpiresAt: null });
    const args = server.toolArguments[0];
    assert.deepEqual(Object.keys(args).sort(), ["draft_id"], "nothing about the message travels here");
    for (const forbidden of ["to", "from", "subject", "body", "body_html", "send_mode"]) {
      assert.equal(Object.prototype.hasOwnProperty.call(args, forbidden), false, `${forbidden} must not be sent to send_draft`);
    }
  });

  test("an undo window is asked for, clamped to 1 to 10 minutes, and the deadline is read back", async () => {
    const server = fakeServer({
      onCall: (payload) =>
        toolResult(payload, {
          content: [],
          structuredContent: { message: { id: "m-1", thread_id: "t-9" }, undo_token: "undo-1", undo_expires_at: "2031-03-10T04:30:00Z" },
        }),
    });
    const sent = await client(server, temporaryStore()).sendDraft({ draftId: "d-1", smartSend: false, undoMinutes: 30 });
    assert.equal(server.toolArguments[0].undo_timeout, 10);
    assert.equal(sent.undoToken, "undo-1");
    assert.equal(sent.undoExpiresAt, "2031-03-10T04:30:00.000Z");
  });

  test("an unreadable undo deadline is null, never a throw after the send was accepted", async () => {
    const server = fakeServer({
      onCall: (payload) => toolResult(payload, { content: [], structuredContent: { message: { id: "m-1" }, undo_expires_at: "not a date" } }),
    });
    const sent = await client(server, temporaryStore()).sendDraft({ draftId: "d-1", smartSend: false, undoMinutes: 1 });
    assert.equal(sent.messageId, "m-1");
    assert.equal(sent.undoExpiresAt, null);
  });

  test("buildArgs refuses a field the tool does not accept, and a missing required field", () => {
    const tool = TOOLS[2];
    assert.throws(
      () => buildArgs("create_or_update_draft", tool, [{ names: ["attachments"], value: ["a.pdf"] }]),
      /create_or_update_draft/,
    );
    // `type` is the one field this tool actually requires.
    assert.throws(() => buildArgs("create_or_update_draft", tool, [{ names: ["subject"], value: "hi" }]), /requires type/);
  });

  test("buildArgs passes the first name through when the server advertises no schema", () => {
    const args = buildArgs("get_thread", { name: "get_thread", description: "", inputSchema: null }, [
      { names: ["thread_id", "id"], value: "t-1" },
      { names: ["account"], value: undefined },
    ]);
    assert.deepEqual(args, { thread_id: "t-1" });
  });

  test("pick finds a value under an alternative name and names the field when it is missing", () => {
    assert.equal(pick({ draft_id: "d-1" }, "draftId", "id"), "d-1");
    assert.equal(pick({ DraftID: "d-2" }, "draftId"), "d-2");
    assert.throws(() => pick({ subject: "hi" }, "draftId", "draft_id", "id"), /draftId, draft_id, id/);
  });

  test("textOf joins the text blocks and jsonOf prefers structuredContent", () => {
    assert.equal(textOf({ content: [{ type: "text", text: "one" }, { type: "image" }, { type: "text", text: "two" }], structuredContent: null, isError: false }), "one\ntwo");
    assert.deepEqual(jsonOf({ content: [{ type: "text", text: '{"a":2}' }], structuredContent: { a: 1 }, isError: false }), { a: 1 });
    assert.deepEqual(jsonOf({ content: [{ type: "text", text: '{"a":2}' }], structuredContent: null, isError: false }), { a: 2 });
    assert.equal(jsonOf({ content: [{ type: "text", text: "sent, but not as JSON" }], structuredContent: null, isError: false }), null);
  });

  test("the read feed normalises a list of open events", async () => {
    // The event shape here is the one recorded in SUPERHUMAN-TOOLS.md. The time
    // field is `occurred_at`; if it were misread every read event would reduce
    // to `firstReadAt: null` while still counting, so a mail that had been
    // opened would look unopened and `followUpOnlyIfOpened` would hold its
    // follow-up back. A fixture that matched a guessed field name would only
    // prove that client and fixture agree with each other.
    const server = fakeServer({
      onCall: (payload) =>
        toolResult(payload, {
          content: [],
          structuredContent: {
            events: [
              { thread_id: "t-1", message_id: "m-1", subject: "a note", recipient: { email: "one@example.test" }, occurred_at: "2031-03-08T02:00:00Z", device: "desktop" },
              { thread_id: "t-1", message_id: "m-1", subject: "a note", recipient: { email: "one@example.test" }, occurred_at: "2031-03-08T06:30:00Z", device: "mobile" },
            ],
          },
        }),
      tools: [...TOOLS, { name: "get_read_status_feed", description: "", inputSchema: null }],
    });
    const read = await client(server, temporaryStore()).getReadStatusFeed({ threadId: "t-1", since: "2031-03-08T00:00:00Z" });
    assert.deepEqual(read, { firstReadAt: "2031-03-08T02:00:00.000Z", readCount: 2, lastDevice: "mobile" });
  });

  test("a read event with no recognisable time is loud, not an unopened message", async () => {
    // The failure this client is built to avoid, in the one place it was
    // silent. An unrecognised argument throws with the tool named; an
    // unrecognised read time returned null, which renders exactly like nobody
    // having opened the mail. Silence is the wrong answer here because it is
    // indistinguishable from the right one.
    const server = fakeServer({
      onCall: (payload) => toolResult(payload, { content: [], structuredContent: { events: [{ thread_id: "t-1", opened_when: "2031-03-08T02:00:00Z" }] } }),
      tools: [...TOOLS, { name: "get_read_status_feed", description: "", inputSchema: null }],
    });
    await assert.rejects(
      () => client(server, temporaryStore()).getReadStatusFeed({ threadId: "t-1", since: null }),
      /get_read_status_feed/,
      "an event with no time must name the tool it came from",
    );
  });

  test("the send state comes back as the server's own word, because closed is not delivered", async () => {
    // The live tool answers idle, pending or closed, and closed covers
    // delivered AND discarded. Collapsing that into a delivered boolean would
    // either record a message as sent that never went or send a second copy to
    // somebody who already had the first.
    async function state(result: unknown) {
      const server = fakeServer({
        onCall: (payload) => toolResult(payload, result),
        tools: [...TOOLS, { name: "get_draft_send_status", description: "", inputSchema: null }],
      });
      return client(server, temporaryStore()).getDraftSendStatus({ draftId: "d-1" });
    }
    assert.equal((await state({ content: [], structuredContent: { status: "closed" } })).state, "closed");
    assert.equal((await state({ content: [], structuredContent: { status: "idle" } })).state, "idle");
    assert.equal((await state({ content: [], structuredContent: { status: "pending" } })).state, "pending");
    assert.equal((await state({ content: [{ type: "text", text: "The draft is pending." }] })).state, "pending");
    assert.equal((await state({ content: [{ type: "text", text: "no idea" }] })).state, "unknown", "an answer we cannot read is not a state we may act on");
  });
});

describe("the tool names this client calls", () => {
  // Every tool name in superhuman.ts, read out of the source rather than
  // listed by hand, so a new call site is covered the day it is written.
  function toolNamesUsed(): string[] {
    const source = readFileSync(join(HERE, "superhuman.ts"), "utf8");
    const names = new Set<string>();
    for (const match of source.matchAll(/\.call(?:Tool|Json)\("([a-z_]+)"/g)) names.add(match[1]);
    return [...names].sort();
  }

  test("every tool the client calls is one the live server advertises", () => {
    // A fake tool list built from the names the client uses could only ever
    // agree with the client, so it would not catch a call to a tool that does
    // not exist. The list below is read from SUPERHUMAN-TOOLS.md instead.
    const advertised = new Set(
      readFileSync(join(HERE, "SUPERHUMAN-TOOLS.md"), "utf8")
        .split("\n")
        .flatMap((line) => {
          const match = line.match(/^- `([a-z_]+)`:/);
          return match === null ? [] : [match[1]];
        }),
    );
    assert.ok(advertised.size > 20, `SUPERHUMAN-TOOLS.md should list the whole surface, found ${advertised.size}`);

    const used = toolNamesUsed();
    assert.ok(used.length > 0, "no tool call sites were found, so this check is not checking anything");
    const unknown = used.filter((name) => !advertised.has(name));
    assert.deepEqual(unknown, [], `these tool names are not advertised by the live server: ${unknown.join(", ")}`);
  });

  test("the client calls no tool that sends or mutates, except the one send path", () => {
    const used = toolNamesUsed();
    const dangerous = used.filter((name) => callIsSend(name));
    assert.deepEqual(dangerous, ["send_draft"], `only send_draft may be called: found ${dangerous.join(", ")}`);
  });
});

describe("the authorization-code sign-in", () => {
  test("the registration body is the shape the endpoint demands", async () => {
    // The server advertises the device grant in its metadata but its
    // registration endpoint accepts only authorization_code and
    // refresh_token, with redirect_uris as an array. This test pins that.
    let sent: Record<string, unknown> = {};
    const fetchImpl: FetchImpl = async (input, init) => {
      assert.equal(String(input), ENDPOINTS.registrationEndpoint);
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ client_id: "client_01TEST" }, 201);
    };
    const clientId = await registerClient(fetchImpl, ENDPOINTS, "https://bb.example/api/v1/plugins/chief-of-comms/http/oauth/callback");
    assert.equal(clientId, "client_01TEST");
    assert.deepEqual(sent.redirect_uris, ["https://bb.example/api/v1/plugins/chief-of-comms/http/oauth/callback"], "an array, even for one entry");
    assert.deepEqual(sent.grant_types, ["authorization_code", "refresh_token"], "the device grant is refused here");
    assert.deepEqual(sent.response_types, ["code"]);
    assert.equal(sent.token_endpoint_auth_method, "none");
  });

  test("the PKCE challenge is the S256 hash of the verifier, and neither repeats", () => {
    const a = createPkce();
    const b = createPkce();
    assert.notEqual(a.verifier, b.verifier, "a repeated verifier would make the exchange forgeable");
    assert.notEqual(createState(), createState());
    assert.equal(createHash("sha256").update(a.verifier).digest("base64url"), a.challenge);
    assert.ok(a.verifier.length >= 43, "RFC 7636 wants at least 43 characters");
    assert.ok(!/[+/=]/.test(a.challenge), "base64url, so it survives a query string");
  });

  test("the authorize URL carries the challenge and never the verifier", () => {
    const pkce = createPkce();
    const url = new URL(buildAuthorizeUrl(ENDPOINTS, { clientId: "c-1", redirectUri: "https://bb.example/cb", state: "st-1", challenge: pkce.challenge }));
    assert.equal(url.origin + url.pathname, ENDPOINTS.authorizationEndpoint);
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("client_id"), "c-1");
    assert.equal(url.searchParams.get("redirect_uri"), "https://bb.example/cb");
    assert.equal(url.searchParams.get("state"), "st-1");
    assert.equal(url.searchParams.get("code_challenge"), pkce.challenge);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("resource"), ENDPOINTS.mcpEndpoint, "ask for a token the MCP endpoint will accept");
    // The whole point of PKCE: the secret half never travels.
    assert.ok(!url.toString().includes(pkce.verifier));
  });

  test("the code exchange sends the verifier and returns an absolute expiry", async () => {
    let sent = new URLSearchParams();
    const fetchImpl: FetchImpl = async (input, init) => {
      assert.equal(String(input), ENDPOINTS.tokenEndpoint);
      sent = new URLSearchParams(String(init?.body));
      return jsonResponse({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3600, token_type: "Bearer" });
    };
    const tokens = await exchangeCode(fetchImpl, ENDPOINTS, { clientId: "c-1", code: "code-1", verifier: "ver-1", redirectUri: "https://bb.example/cb" }, NOW());
    assert.equal(sent.get("grant_type"), "authorization_code");
    assert.equal(sent.get("code"), "code-1");
    assert.equal(sent.get("code_verifier"), "ver-1");
    assert.equal(sent.get("redirect_uri"), "https://bb.example/cb");
    assert.equal(tokens.accessToken, ACCESS_TOKEN);
    assert.equal(tokens.expiresAtMs, NOW() + 3_600_000);
  });

  test("a refused exchange throws with the reason and leaks neither the code nor the verifier", async () => {
    // Realistic lengths on purpose: `redact` has an eight character floor so
    // that it cannot mangle a message by matching a trivial substring, and
    // every real code and verifier is far longer than that.
    const code = "authcode_01JQX7YH2K9V3M8N4P6R5T0W";
    const verifier = createPkce().verifier;
    const fetchImpl: FetchImpl = async () => jsonResponse({ error: "invalid_grant", error_description: `code already used: ${code} with ${verifier}` }, 400);
    await assert.rejects(
      () => exchangeCode(fetchImpl, ENDPOINTS, { clientId: "c-1", code, verifier, redirectUri: "https://bb.example/cb" }),
      (error: Error) => {
        assert.match(error.message, /invalid_grant/);
        assert.match(error.message, /\[redacted\]/);
        assert.ok(!error.message.includes(code), error.message);
        assert.ok(!error.message.includes(verifier), error.message);
        return true;
      },
    );
  });
});

describe("the token file", () => {
  test("is written 0600 inside a directory 0700, and reads back", () => {
    const store = temporaryStore(null);
    const tokens = defaultTokens();
    store.write(tokens);
    assert.equal(statSync(dirname(store.path)).mode & 0o777, 0o700);
    assert.equal(statSync(store.path).mode & 0o777, 0o600);
    assert.deepEqual(store.read(), tokens);
    // A second write over an existing file has to keep the mode, which is the
    // case writeFileSync does not cover on its own.
    store.write({ ...tokens, accessToken: REFRESHED_TOKEN });
    assert.equal(statSync(store.path).mode & 0o777, 0o600);
    assert.equal(store.read()?.accessToken, REFRESHED_TOKEN);
  });

  test("an absent file reads as null and counts as expired", () => {
    const store = temporaryStore(null);
    assert.equal(store.read(), null);
    assert.equal(store.isExpired(NOW()), true);
  });

  test("isExpired allows for clock skew", () => {
    const store = temporaryStore({ ...defaultTokens(), expiresAtMs: NOW() + 30_000 });
    assert.equal(store.isExpired(NOW()), true, "30 seconds left is inside the default one minute skew");
    assert.equal(store.isExpired(NOW(), 5_000), false);
  });
});

describe("no token reaches an error message", () => {
  test("several failure paths, none of which names a token", async () => {
    const messages: string[] = [];

    async function capture(run: () => Promise<unknown>): Promise<void> {
      try {
        await run();
        assert.fail("this path was supposed to fail");
      } catch (error) {
        messages.push((error as Error).message);
      }
    }

    // 1. Two 401s in a row.
    const dead = fakeServer({ onCall: () => new Response("", { status: 401 }) });
    await capture(() => client(dead, temporaryStore()).listAccounts());

    // 2. A server that echoes the access token back in a JSON-RPC error.
    const echoing = fakeServer({
      onCall: (payload) =>
        jsonResponse({ jsonrpc: "2.0", id: payload.id, error: { code: -32000, message: `token ${ACCESS_TOKEN} rejected` } }),
    });
    await capture(() => client(echoing, temporaryStore()).listAccounts());

    // 3. A tool result flagged isError whose text carries the refresh token.
    const isError = fakeServer({
      onCall: (payload) => toolResult(payload, { content: [{ type: "text", text: `refresh ${REFRESH_TOKEN} is invalid` }], isError: true }),
    });
    await capture(() => client(isError, temporaryStore()).listAccounts());

    // 4. An HTTP error whose body quotes the Authorization header.
    const chatty = fakeServer({
      onCall: () => new Response(`upstream said: Bearer ${ACCESS_TOKEN}`, { status: 500 }),
    });
    await capture(() => client(chatty, temporaryStore()).listAccounts());

    // 5. A refresh the server refuses with a description holding the token.
    const noisyRefresh: FetchImpl = async () =>
      jsonResponse({ error: "server_error", error_description: `refresh_token ${REFRESH_TOKEN} blew up` }, 500);
    await capture(() => refresh(noisyRefresh, ENDPOINTS, "client-abc", REFRESH_TOKEN, NOW()));

    // 6. A dead refresh token, which is the one the owner has to act on.
    const invalidGrant: FetchImpl = async () => jsonResponse({ error: "invalid_grant" }, 400);
    await capture(() => refresh(invalidGrant, ENDPOINTS, "client-abc", REFRESH_TOKEN, NOW()));

    assert.equal(messages.length, 6);
    for (const message of messages) {
      assert.equal(message.includes(ACCESS_TOKEN), false, `an access token reached: ${message}`);
      assert.equal(message.includes(REFRESHED_TOKEN), false, `a refreshed token reached: ${message}`);
      assert.equal(message.includes(REFRESH_TOKEN), false, `a refresh token reached: ${message}`);
    }
    assert.match(messages[5], new RegExp(RECONNECT_SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

describe("the send tripwire", () => {
  test("names the tools that make something leave", () => {
    assert.equal(callIsSend("send_draft"), true);
    assert.equal(callIsSend("get_thread"), false);
    assert.equal(callIsSend("trash_thread"), true);
    assert.equal(callIsSend("unsubscribe"), true);
    assert.equal(callIsSend("create_or_update_draft"), false);
  });
});

describe("list_accounts", () => {
  test("reads the address out of the record instead of stringifying the whole thing", async () => {
    // The record shape the server returns. Putting the whole record where an
    // address belongs would show a lump of JSON in the panel and the from
    // address could never match. A wrong key guess in this client is supposed
    // to be loud, not silent.
    const server = fakeServer({
      tools: [TOOLS[0]],
      onCall: (payload) => toolResult(payload, { content: [], structuredContent: { accounts: [{ accountEmail: "work@example.com", isPrimary: true, addedAt: "2031-02-17T09:00:00Z" }] } }),
    });
    const listed = await client(server, temporaryStore()).listAccounts();
    assert.deepEqual(listed.accounts, ["work@example.com"]);
    assert.equal(listed.defaultAccount, "work@example.com", "isPrimary marks the default");
  });

  test("a plain string account still works, and an account with no address anywhere throws by name", async () => {
    const strings = fakeServer({ tools: [TOOLS[0]], onCall: (payload) => toolResult(payload, { content: [], structuredContent: { accounts: ["a@example.test"] } }) });
    assert.deepEqual((await client(strings, temporaryStore()).listAccounts()).accounts, ["a@example.test"]);

    const broken = fakeServer({ tools: [TOOLS[0]], onCall: (payload) => toolResult(payload, { content: [], structuredContent: { accounts: [{ mailbox_handle: "x", isPrimary: true }] } }) });
    await assert.rejects(
      () => client(broken, temporaryStore()).listAccounts(),
      (error: Error) => {
        assert.match(error.message, /list_accounts/);
        assert.match(error.message, /mailbox_handle/, "say what the server did send, so the next guess is informed");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// list_threads and undo_send
//
// Neither has a caller yet. They are tested anyway against the argument names
// the server's schemas advertise: a method nobody calls and nobody tests will
// be wrong on the day somebody calls it, and for undo_send that is the day a
// message goes to the wrong person.

describe("list_threads", () => {
  test("sends the argument names the server advertises", async () => {
    const server = fakeServer({
      onCall: (payload) => toolResult(payload, { content: [], structuredContent: { threads: [], next_cursor: null } }),
    });
    await client(server, temporaryStore()).listThreads({
      to: ["client@example.org"],
      subjectContains: "workflow",
      startDate: "2031-01-01",
      limit: 50,
      actingEmail: "alias@example.com",
    });
    const sent = server.toolArguments[0];
    assert.deepEqual(Object.keys(sent).sort(), ["acting_email", "limit", "start_date", "subject_contains", "to"]);
    assert.deepEqual(sent.to, ["client@example.org"]);
    assert.equal(sent.subject_contains, "workflow", "the filter is a substring named subject_contains, not subject");
    assert.equal(sent.start_date, "2031-01-01");
    assert.equal(sent.acting_email, "alias@example.com", "the account argument is acting_email");
  });

  test("a single address passed as a string is coerced to the array the schema declares", async () => {
    const server = fakeServer({ onCall: (payload) => toolResult(payload, { content: [], structuredContent: { threads: [] } }) });
    // The type says string[], but the seed import reads one address at a time
    // and the schema says array, so the coercion is what keeps that honest.
    await client(server, temporaryStore()).listThreads({ to: "one@example.test" as unknown as string[] });
    assert.deepEqual(server.toolArguments[0].to, ["one@example.test"]);
  });

  test("threads and the pagination cursor come back read", async () => {
    const server = fakeServer({
      onCall: (payload) =>
        toolResult(payload, {
          content: [],
          structuredContent: {
            threads: [
              { thread_id: "t-1", subject: "A first note", snippet: "hello there", last_message_at: "2031-03-05T07:00:00Z" },
              { thread_id: "t-2", subject: "Another", snippet: "", last_message_at: 1_970_000_000_000 },
            ],
            next_cursor: "page-2",
          },
        }),
    });
    const found = await client(server, temporaryStore()).listThreads({ to: ["someone@example.test"] });
    assert.deepEqual(found.threads.map((thread) => thread.threadId), ["t-1", "t-2"]);
    assert.equal(found.threads[0].subject, "A first note");
    assert.equal(found.threads[0].lastMessageAt, "2031-03-05T07:00:00.000Z", "a date is normalised to a full ISO string");
    assert.equal(found.threads[1].lastMessageAt, new Date(1_970_000_000_000).toISOString(), "epoch milliseconds read as a date");
    assert.equal(found.nextCursor, "page-2");
  });

  test("no cursor in the reply is no cursor, not an error", async () => {
    const server = fakeServer({ onCall: (payload) => toolResult(payload, { content: [], structuredContent: { threads: [] } }) });
    const found = await client(server, temporaryStore()).listThreads({ limit: 1 });
    assert.deepEqual(found.threads, []);
    assert.equal(found.nextCursor, null);
  });
});

describe("undo_send", () => {
  test("prefers the undo token, and names the account argument acting_email", async () => {
    const server = fakeServer({ onCall: (payload) => toolResult(payload, { content: [{ type: "text", text: "Send canceled." }] }) });
    await client(server, temporaryStore()).undoSend({
      undoToken: "undo-abc",
      messageId: "msg-1",
      actingEmail: "alias@example.com",
    });
    const sent = server.toolArguments[0];
    assert.equal(sent.undo_token, "undo-abc");
    assert.equal(sent.message_id, "msg-1");
    assert.equal(sent.acting_email, "alias@example.com");
  });

  test("a message that had already gone is already_sent, never a cancellation", async () => {
    // This is the whole reason the method returns a state. callTool throws on
    // an error result, so a plain `ok: !result.isError` flag would always be
    // false and every outcome would read as a successful cancel. A message
    // recorded as cancelled that in fact went out is a person who gets a
    // second one.
    const server = fakeServer({ onCall: (payload) => toolResult(payload, { content: [{ type: "text", text: "already_sent: past the undo window." }] }) });
    const result = await client(server, temporaryStore()).undoSend({ messageId: "msg-1" });
    assert.equal(result.state, "already_sent");
    assert.match(result.detail, /already_sent/);
  });

  test("no queued send is not_found, which is a normal answer", async () => {
    const server = fakeServer({ onCall: (payload) => toolResult(payload, { content: [{ type: "text", text: "send not found, the draft is still local" }] }) });
    assert.equal((await client(server, temporaryStore()).undoSend({ messageId: "msg-1" })).state, "not_found");
  });

  test("a cancellation is a cancellation", async () => {
    const server = fakeServer({ onCall: (payload) => toolResult(payload, { content: [{ type: "text", text: "Canceled the queued send." }] }) });
    assert.equal((await client(server, temporaryStore()).undoSend({ undoToken: "undo-abc" })).state, "cancelled");
  });

  test("wording nobody anticipated is unknown rather than a guess either way", async () => {
    const server = fakeServer({ onCall: (payload) => toolResult(payload, { content: [{ type: "text", text: "hmm" }] }) });
    const result = await client(server, temporaryStore()).undoSend({ undoToken: "undo-abc" });
    assert.equal(result.state, "unknown");
    assert.equal(result.detail, "hmm", "the server's own words travel with the state");
  });

  test("neither identifier is refused before anything is called", async () => {
    const server = fakeServer({ onCall: () => assert.fail("undo_send must not be called with nothing to identify the send") });
    await assert.rejects(
      () => client(server, temporaryStore()).undoSend({}),
      (error: Error) => {
        assert.match(error.message, /undo token|message id/);
        return true;
      },
    );
    assert.deepEqual(server.calls, [], "nothing reached the server");
  });
});

describe("log volume", () => {
  test("a tool's schema is logged once per connection, not on every call, and no per-call field line", async () => {
    const lines: string[] = [];
    const server = fakeServer({ onCall: (payload) => toolResult(payload, { content: [], structuredContent: { accounts: ["a@example.com"] } }) });
    const mail = new SuperhumanClient({
      store: temporaryStore(),
      fetchImpl: server.fetchImpl,
      endpoint: MCP_URL,
      endpoints: ENDPOINTS,
      now: NOW,
      log: (line) => lines.push(line),
    });
    for (let index = 0; index < 5; index += 1) await mail.listAccounts();
    assert.equal(lines.filter((line) => /list_accounts advertises input schema/.test(line)).length, 1);
    assert.equal(lines.filter((line) => /sending fields/.test(line)).length, 0);
  });
});
