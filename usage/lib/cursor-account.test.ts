import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURSOR_ACCOUNT_ENDPOINT,
  cursorAccountCollectorScript, extractCursorAccountScan,
} from "./cursor-account";
import { cursorAccountCollector } from "./host/cursor-account.host";

const temporaryDirectories: string[] = [];

// Things the credential file and the API response really hold, and that the
// collector must never hand back: the account's bearer token and the
// server-side chat id that identifies a conversation.
const FAKE_TOKEN = "eyJhbGciOiJIUzI1NiJ9.fake-cursor-access-token-value.9f13c77deadbeef";
const FAKE_CONVERSATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// Cursor returns the account's user id on every event; any string works here.
const FAKE_OWNING_USER = "fake-owning-user";

async function authFile(contents: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "bb-usage-cursor-account-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "auth.json");
  await writeFile(path, JSON.stringify(contents));
  return path;
}

function event(timestamp: number, model: string, tokens: Partial<Record<string, number>>, chargedCents: number) {
  return {
    timestamp: String(timestamp),
    model,
    kind: "USAGE_EVENT_KIND_INCLUDED_IN_PRO",
    conversationId: FAKE_CONVERSATION,
    owningUser: FAKE_OWNING_USER,
    subscriptionProductId: "pro",
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalCents: 0, ...tokens },
    chargedCents,
  };
}

function stubFetch(pages: unknown[][], seen: { authorization?: string; bodies: string[] } = { bodies: [] }) {
  const fetchStub = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    seen.authorization = init.headers.authorization;
    seen.bodies.push(init.body);
    const page = JSON.parse(init.body).page as number;
    const events = pages[page - 1] ?? [];
    return {
      ok: true,
      status: 200,
      json: async () => ({ totalUsageEventsCount: pages.flat().length, usageEventsDisplay: events }),
    };
  }) as unknown as typeof globalThis.fetch;
  return { fetchStub, seen };
}

const day = (iso: string) => Date.parse(iso);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Cursor account collector", () => {
  it("aggregates billed events by day and model", async () => {
    const path = await authFile({ accessToken: FAKE_TOKEN, refreshToken: FAKE_TOKEN });
    const { fetchStub, seen } = stubFetch([[
      event(day("2031-07-22T10:00:00"), "cursor-model-b", { inputTokens: 410, outputTokens: 40, cacheReadTokens: 1230 }, 2),
      event(day("2031-07-21T16:15:00"), "cursor-model-a", { inputTokens: 910, outputTokens: 60, cacheReadTokens: 0 }, 1.25),
      event(day("2031-07-22T09:30:00"), "cursor-model-a", { inputTokens: 170, outputTokens: 15, cacheReadTokens: 310 }, 0.5),
      event(day("2031-07-22T11:45:00"), "cursor-model-b", { inputTokens: 630, outputTokens: 20, cacheReadTokens: 790 }, 3),
      event(day("2031-07-23T14:00:00"), "cursor-model-c", { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0 }, 0.75),
    ]]);

    const result = await cursorAccountCollector(
      Buffer.from(JSON.stringify({ authPath: path, endpoint: CURSOR_ACCOUNT_ENDPOINT, sinceDay: "2031-07-15", pageSize: 1000, maxPages: 5 })).toString("base64"),
      { buffer: Buffer, fs, fetch: fetchStub },
    );

    expect(result.eventCount).toBe(5);
    expect(result.rows).toEqual([
      { day: "2031-07-21", model: "cursor-model-a", events: 1, inputTokens: 910, outputTokens: 60, cacheReadTokens: 0, cents: 1.25 },
      { day: "2031-07-22", model: "cursor-model-a", events: 1, inputTokens: 170, outputTokens: 15, cacheReadTokens: 310, cents: 0.5 },
      { day: "2031-07-22", model: "cursor-model-b", events: 2, inputTokens: 1040, outputTokens: 60, cacheReadTokens: 2020, cents: 5 },
      { day: "2031-07-23", model: "cursor-model-c", events: 1, inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cents: 0.75 },
    ]);
    // The token is used as a bearer header and nowhere else.
    expect(seen.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    for (const body of seen.bodies) expect(body).not.toContain(FAKE_TOKEN);
  });

  it("returns no access token and no conversation id", async () => {
    const path = await authFile({ accessToken: FAKE_TOKEN, refreshToken: FAKE_TOKEN });
    const { fetchStub } = stubFetch([[
      event(day("2031-05-14T08:00:00"), "cursor-model-a", { inputTokens: 2000, outputTokens: 20 }, 3),
    ]]);

    const result = await cursorAccountCollector(
      Buffer.from(JSON.stringify({ authPath: path, endpoint: CURSOR_ACCOUNT_ENDPOINT, sinceDay: "2031-05-08", pageSize: 1000, maxPages: 5 })).toString("base64"),
      { buffer: Buffer, fs, fetch: fetchStub },
    );
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(FAKE_TOKEN);
    expect(serialized).not.toContain(FAKE_CONVERSATION);
    expect(serialized).not.toContain(FAKE_OWNING_USER);
    // Nor does the script that gets shipped to the host carry a token: it reads
    // the credential there, rather than being handed one from here.
    const script = cursorAccountCollectorScript({ authPath: path, endpoint: CURSOR_ACCOUNT_ENDPOINT, sinceDay: "2031-05-08", pageSize: 1000, maxPages: 5 });
    expect(script).not.toContain(FAKE_TOKEN);
  });

  it("stops paging once a page falls before the history window", async () => {
    const path = await authFile({ accessToken: FAKE_TOKEN });
    const { fetchStub, seen } = stubFetch([
      [event(day("2031-05-14T08:00:00"), "cursor-model-a", { inputTokens: 10 }, 1)],
      [event(day("2031-04-20T08:00:00"), "cursor-model-a", { inputTokens: 99 }, 9)],
      [event(day("2031-03-25T08:00:00"), "cursor-model-a", { inputTokens: 99 }, 9)],
    ]);

    const result = await cursorAccountCollector(
      Buffer.from(JSON.stringify({ authPath: path, endpoint: CURSOR_ACCOUNT_ENDPOINT, sinceDay: "2031-05-08", pageSize: 1, maxPages: 5 })).toString("base64"),
      { buffer: Buffer, fs, fetch: fetchStub },
    );

    expect(result.eventCount).toBe(1);
    expect(seen.bodies).toHaveLength(2);
    expect(result.rows.map((row) => row.inputTokens)).toEqual([10]);
  });

  it("reports a machine with no signed-in Cursor as a skip, not a failure", async () => {
    const path = await authFile({ refreshToken: FAKE_TOKEN });
    const { fetchStub } = stubFetch([[]]);
    const absent = await cursorAccountCollector(
      Buffer.from(JSON.stringify({ authPath: `${path}.missing`, endpoint: CURSOR_ACCOUNT_ENDPOINT, sinceDay: "2031-05-08", pageSize: 10, maxPages: 2 })).toString("base64"),
      { buffer: Buffer, fs, fetch: fetchStub },
    );
    expect(absent).toMatchObject({ error: "no-cursor-credential", rows: [], eventCount: 0 });

    // A file that exists but holds no usable token is the same case.
    const tokenless = await cursorAccountCollector(
      Buffer.from(JSON.stringify({ authPath: path, endpoint: CURSOR_ACCOUNT_ENDPOINT, sinceDay: "2031-05-08", pageSize: 10, maxPages: 2 })).toString("base64"),
      { buffer: Buffer, fs, fetch: fetchStub },
    );
    expect(tokenless.error).toBe("no-cursor-credential");
  });

  it("surfaces an HTTP failure with the rows it already had", async () => {
    const path = await authFile({ accessToken: FAKE_TOKEN });
    const failing = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof globalThis.fetch;
    const result = await cursorAccountCollector(
      Buffer.from(JSON.stringify({ authPath: path, endpoint: CURSOR_ACCOUNT_ENDPOINT, sinceDay: "2031-05-08", pageSize: 10, maxPages: 2 })).toString("base64"),
      { buffer: Buffer, fs, fetch: failing },
    );
    expect(result.error).toBe("Cursor usage API returned HTTP 401.");
    expect(result.rows).toEqual([]);
  });

  it("rejects output that is not a Cursor account scan", () => {
    expect(() => extractCursorAccountScan("nothing here")).toThrow(/incomplete output/);
    expect(() => extractCursorAccountScan("__BB_USAGE_SCAN_BEGIN__\nnot-base64-gzip\n__BB_USAGE_SCAN_END__")).toThrow(/malformed output/);
  });
});
