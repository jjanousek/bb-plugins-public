// Tests for the stale-account decision in usage.ts. Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ageText,
  applyDisabled,
  decideAccount,
  describeSwitchFailure,
  disableOthers,
  figuresAreCurrent,
  figuresAt,
  freshnessText,
  vouchedFor,
  VOUCH_LIMIT_MS,
  isTokenExpired,
  sleep,
  switchWarning,
  untilAborted,
  pickAccountToUse,
  isAccountInUse,
  accountVouchedFor,
  activeFreshnessState,
  antigravityWindowsFrom,
  windowsFromOmpReport,
  closestWindow,
  stripUsageRows,
  parseSystemctlFailedUnits,
  parseSystemctlShowWatchdog,
  aggregateServerHealth,
  POLL_WINDOW_MS,
  SERVER_METRICS_WINDOW_MS,
  parseProcStat,
  cpuPercentFromStatSamples,
  parseProcLoadavg,
  parseProcMeminfo,
  serverMetricLevel,
  buildServerMetrics,
  type AccountBase,
  type AccountResult,
  type PreviousFigures,
  type ServerHealthInput,
} from "./usage.ts";

const NOW_MS = new Date(2031, 1, 18, 12, 0, 0, 0).getTime();
const NOW_ISO = new Date(NOW_MS).toISOString();

const ENABLED: AccountBase = { email: "a@example.com", file: "claude-a.json", disabled: false };
const DISABLED: AccountBase = { email: "b@example.com", file: "claude-b.json", disabled: true };
const PREVIOUS: PreviousFigures = {
  windows: [{ label: "5-hour limit", usedPercent: 42, resetsAt: null }],
  okAt: new Date(NOW_MS - 86_400_000).toISOString(),
};

describe("isTokenExpired", () => {
  it("past timestamp is expired", () => {
    assert.equal(isTokenExpired(new Date(NOW_MS - 1000).toISOString(), NOW_MS), true);
  });
  it("future timestamp is live", () => {
    assert.equal(isTokenExpired(new Date(NOW_MS + 1000).toISOString(), NOW_MS), false);
  });
  it("missing timestamp is live", () => {
    assert.equal(isTokenExpired(undefined, NOW_MS), false);
  });
  it("garbage timestamp is live", () => {
    assert.equal(isTokenExpired("not-a-date", NOW_MS), false);
  });
});

describe("decideAccount: disabled accounts go stale, never expired", () => {
  it("disabled plus past expiry keeps last good figures as stale", () => {
    const got = decideAccount(DISABLED, PREVIOUS, NOW_ISO, true, null);
    assert.equal(got.status, "stale");
    assert.deepEqual(got.windows, PREVIOUS.windows);
    assert.equal(got.okAt, PREVIOUS.okAt);
    assert.match(got.message ?? "", /re-enabled/);
  });
  it("disabled plus 401 keeps last good figures as stale", () => {
    const got = decideAccount(DISABLED, PREVIOUS, NOW_ISO, false, { kind: "unauthorized" });
    assert.equal(got.status, "stale");
    assert.deepEqual(got.windows, PREVIOUS.windows);
    assert.equal(got.okAt, PREVIOUS.okAt);
  });
  it("disabled plus transport failure keeps last good figures as stale", () => {
    const got = decideAccount(DISABLED, PREVIOUS, NOW_ISO, false, { kind: "transport", message: "boom" });
    assert.equal(got.status, "stale");
    assert.deepEqual(got.windows, PREVIOUS.windows);
  });
  it("disabled and stale with no previous figures reports empty windows", () => {
    const got = decideAccount(DISABLED, undefined, NOW_ISO, true, null);
    assert.equal(got.status, "stale");
    assert.deepEqual(got.windows, []);
    assert.equal(got.okAt, null);
  });
  it("disabled with a live token still reports fresh figures", () => {
    const fresh = [{ label: "5-hour limit", usedPercent: 7, resetsAt: null }];
    const got = decideAccount(DISABLED, PREVIOUS, NOW_ISO, false, { kind: "ok", windows: fresh });
    assert.equal(got.status, "ok");
    assert.deepEqual(got.windows, fresh);
    assert.equal(got.okAt, NOW_ISO);
    assert.equal(got.message, null);
  });
});

describe("decideAccount: enabled accounts keep expired and error", () => {
  it("enabled plus past expiry is expired", () => {
    const got = decideAccount(ENABLED, PREVIOUS, NOW_ISO, true, null);
    assert.equal(got.status, "expired");
    assert.deepEqual(got.windows, PREVIOUS.windows);
  });
  it("enabled plus 401 is expired", () => {
    const got = decideAccount(ENABLED, PREVIOUS, NOW_ISO, false, { kind: "unauthorized" });
    assert.equal(got.status, "expired");
    assert.deepEqual(got.windows, PREVIOUS.windows);
  });
  it("enabled plus HTTP 500 is error", () => {
    const got = decideAccount(ENABLED, PREVIOUS, NOW_ISO, false, { kind: "http", status: 500 });
    assert.equal(got.status, "error");
    assert.deepEqual(got.windows, PREVIOUS.windows);
    assert.match(got.message ?? "", /500/);
  });
  it("enabled plus fresh fetch is ok", () => {
    const fresh = [{ label: "Weekly limit", usedPercent: 11, resetsAt: null }];
    const got = decideAccount(ENABLED, undefined, NOW_ISO, false, { kind: "ok", windows: fresh });
    assert.equal(got.status, "ok");
    assert.deepEqual(got.windows, fresh);
    assert.equal(got.okAt, NOW_ISO);
  });
});

describe("disableOthers", () => {
  const FILES = ["claude-a.json", "claude-b.json", "claude-c.json"];

  it("disables every file except the kept one", async () => {
    const seen: string[] = [];
    const failed = await disableOthers(FILES, "claude-a.json", async (file) => {
      seen.push(file);
    });
    assert.deepEqual(seen, ["claude-b.json", "claude-c.json"]);
    assert.deepEqual(failed, []);
  });

  it("keeps disabling after one fails, and collects it", async () => {
    const seen: string[] = [];
    const failed = await disableOthers(FILES, "claude-a.json", async (file) => {
      seen.push(file);
      if (file === "claude-b.json") throw new Error("HTTP 503");
    });
    // Every other file still gets its disable call after one fails.
    assert.deepEqual(seen, ["claude-b.json", "claude-c.json"]);
    assert.deepEqual(failed, [{ file: "claude-b.json", reason: "HTTP 503" }]);
  });

  it("collects every failure when all of them fail", async () => {
    const failed = await disableOthers(FILES, "claude-a.json", async (file) => {
      throw new Error(`nope ${file}`);
    });
    assert.deepEqual(failed.map((entry) => entry.file), ["claude-b.json", "claude-c.json"]);
  });

  it("reports a non-Error rejection as text", async () => {
    const failed = await disableOthers(["claude-a.json", "claude-b.json"], "claude-a.json", async () => {
      throw "timed out";
    });
    assert.deepEqual(failed, [{ file: "claude-b.json", reason: "timed out" }]);
  });

  it("does nothing when the kept file is the only one", async () => {
    let calls = 0;
    const failed = await disableOthers(["claude-a.json"], "claude-a.json", async () => {
      calls += 1;
    });
    assert.equal(calls, 0);
    assert.deepEqual(failed, []);
  });
});

describe("describeSwitchFailure", () => {
  const emailOf = (file: string): string => (file === "claude-b.json" ? "b@example.com" : file);

  it("names the account that stayed in use", () => {
    const line = describeSwitchFailure("a@example.com", [{ file: "claude-b.json", reason: "HTTP 503" }], emailOf);
    assert.equal(line, "Switched to a@example.com, but could not take this account out of use: b@example.com (HTTP 503)");
  });

  it("pluralises and joins several", () => {
    const line = describeSwitchFailure(
      "a@example.com",
      [
        { file: "claude-b.json", reason: "HTTP 503" },
        { file: "claude-c.json", reason: "timeout" },
      ],
      emailOf,
    );
    assert.equal(
      line,
      "Switched to a@example.com, but could not take these accounts out of use: b@example.com (HTTP 503); claude-c.json (timeout)",
    );
  });
});

describe("figuresAt", () => {
  const OLD = "2031-02-24T00:00:00.000Z";
  const NEW = "2031-02-24T00:30:00.000Z";
  const win = [{ label: "5-hour limit", usedPercent: 10, resetsAt: null }];

  it("quotes the oldest account still showing figures", () => {
    assert.equal(figuresAt([{ windows: win, okAt: NEW }, { windows: win, okAt: OLD }]), OLD);
  });

  it("is null when an account shows figures it cannot date", () => {
    assert.equal(figuresAt([{ windows: win, okAt: NEW }, { windows: win, okAt: null }]), null);
  });

  it("ignores accounts with no figures on screen", () => {
    assert.equal(figuresAt([{ windows: win, okAt: NEW }, { windows: [], okAt: null }]), NEW);
  });

  it("is null when nothing is on screen", () => {
    assert.equal(figuresAt([{ windows: [], okAt: null }]), null);
  });
});

describe("figuresAreCurrent", () => {
  it("is true only when every account came back ok", () => {
    assert.equal(figuresAreCurrent([{ status: "ok" }, { status: "ok" }]), true);
    // An account in error still shows its last good bars, which are not current.
    assert.equal(figuresAreCurrent([{ status: "ok" }, { status: "error" }]), false);
    assert.equal(figuresAreCurrent([{ status: "ok" }, { status: "stale" }]), false);
  });

  it("is false with no accounts", () => {
    assert.equal(figuresAreCurrent([]), false);
  });
});

describe("applyDisabled", () => {
  const accounts = [
    { file: "claude-a.json", disabled: false, okAt: "x" },
    { file: "claude-b.json", disabled: true, okAt: "y" },
  ];

  it("takes the fresh flag over the cached one", () => {
    const out = applyDisabled(accounts, new Map([["claude-a.json", true], ["claude-b.json", false]]));
    assert.deepEqual(
      out.map((a) => [a.file, a.disabled]),
      [["claude-a.json", true], ["claude-b.json", false]],
    );
  });

  it("keeps the cached flag for a file the read did not cover", () => {
    const out = applyDisabled(accounts, new Map());
    assert.deepEqual(out.map((a) => a.disabled), [false, true]);
  });

  it("leaves everything else on the account untouched", () => {
    const out = applyDisabled(accounts, new Map([["claude-a.json", true]]));
    assert.equal(out[0]?.okAt, "x");
    // Unchanged entries are returned as-is rather than copied.
    assert.equal(out[1], accounts[1]);
  });
});

describe("vouchedFor / freshnessText", () => {
  const NOW = new Date("2031-02-24T09:00:00.000Z").getTime();
  const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();
  const win = [{ label: "Weekly limit", usedPercent: 85, resetsAt: null }];
  const ok = (minutesAgo: number) => ({ status: "ok" as const, windows: win, okAt: at(minutesAgo) });
  const failed = (minutesAgo: number) => ({ status: "error" as const, windows: win, okAt: at(minutesAgo) });

  it("vouches for figures from the check that just ran", () => {
    const state = { fetchedAt: at(0), accounts: [ok(0), ok(0)] };
    assert.equal(vouchedFor(state, NOW), true);
    assert.equal(freshnessText(state, NOW), "Updated just now");
  });

  it("still vouches for recent figures behind a failed check, and dates them", () => {
    // A failed check keeps the bars; the footer dates them instead of calling them current.
    const state = { fetchedAt: at(0), accounts: [ok(0), failed(8)] };
    assert.equal(vouchedFor(state, NOW), true);
    assert.equal(freshnessText(state, NOW), "Figures 8 min ago; last check just now");
  });

  it("stops vouching once the figures pass the limit", () => {
    const past = VOUCH_LIMIT_MS / 60_000 + 1;
    const state = { fetchedAt: at(0), accounts: [failed(past)] };
    assert.equal(vouchedFor(state, NOW), false);
    assert.equal(freshnessText(state, NOW), "Not current: figures 31 min ago");
  });

  it("vouches exactly at the limit, not past it", () => {
    const limit = VOUCH_LIMIT_MS / 60_000;
    assert.equal(vouchedFor({ fetchedAt: at(0), accounts: [failed(limit)] }, NOW), true);
    assert.equal(vouchedFor({ fetchedAt: at(0), accounts: [failed(limit + 0.02)] }, NOW), false);
  });

  it("refuses to vouch for figures it cannot date", () => {
    const state = { fetchedAt: at(0), accounts: [{ status: "error" as const, windows: win, okAt: null }] };
    assert.equal(vouchedFor(state, NOW), false);
    assert.equal(freshnessText(state, NOW), "Not current: figures from an unknown time");
  });

  it("says so plainly when there are no figures at all", () => {
    const state = { fetchedAt: at(3), accounts: [{ status: "error" as const, windows: [], okAt: null }] };
    assert.equal(vouchedFor(state, NOW), false);
    assert.equal(freshnessText(state, NOW), "No figures yet; last check 3 min ago");
  });

  it("takes the oldest account's age, not the newest", () => {
    const state = { fetchedAt: at(0), accounts: [ok(1), failed(45)] };
    assert.equal(vouchedFor(state, NOW), false);
    assert.equal(freshnessText(state, NOW), "Not current: figures 45 min ago");
  });

  it("shows the age when an ok reading's okAt is older than one 5-minute poll, never calling it Updated just now", () => {
    const state = { fetchedAt: at(0), accounts: [ok(8)] };
    assert.equal(vouchedFor(state, NOW), true);
    assert.equal(freshnessText(state, NOW), "Figures 8 min ago; last check just now");
  });
});

describe("ageText", () => {
  const NOW = new Date("2031-02-24T09:00:00.000Z").getTime();
  const ago = (ms: number): string => new Date(NOW - ms).toISOString();

  it("reads the scale from seconds to hours", () => {
    assert.equal(ageText(ago(10_000), NOW), "just now");
    assert.equal(ageText(ago(5 * 60_000), NOW), "5 min ago");
    assert.equal(ageText(ago(3 * 3_600_000), NOW), "3 h ago");
  });

  it("does not invent an age for a missing or unreadable timestamp", () => {
    assert.equal(ageText(null, NOW), "not fetched yet");
    assert.equal(ageText("not-a-date", NOW), "at an unknown time");
  });
});

describe("decideAccount: on hold and honest fallbacks", () => {
  it("an account on hold reads on hold at Anthropic, not stale", () => {
    const got = decideAccount(DISABLED, undefined, NOW_ISO, true, null, "on-hold");
    assert.equal(got.status, "on-hold");
    assert.match(got.message ?? "", /on hold at Anthropic/);
    assert.doesNotMatch(got.message ?? "", /stale|re-enabled|last good figures/);
  });
  it("never says last good figures are shown when there are none", () => {
    for (const outcome of [null, { kind: "unauthorized" as const }, { kind: "http" as const, status: 429 }]) {
      const got = decideAccount(DISABLED, undefined, NOW_ISO, outcome === null, outcome);
      assert.deepEqual(got.windows, []);
      assert.doesNotMatch(got.message ?? "", /last good figures/, got.message ?? "");
    }
  });
  it("still says so when figures are kept", () => {
    const got = decideAccount(DISABLED, PREVIOUS, NOW_ISO, true, null);
    assert.match(got.message ?? "", /last good figures shown/);
  });
});

describe("sleep", () => {
  it("returns at once for a signal that is already aborted", { timeout: 2_000 }, async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await sleep(60_000, controller.signal);
    assert.ok(Date.now() - started < 1_000);
  });
  it("still stops early when the abort comes during the wait", { timeout: 2_000 }, async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await sleep(60_000, controller.signal);
  });
});

describe("switchWarning", () => {
  const now = Date.parse("2031-03-18T08:00:00Z");
  it("names the fullest shut window", () => {
    const account = { windows: [
      { label: "5-hour", usedPercent: 0, resetsAt: null },
      { label: "Weekly", usedPercent: 99, resetsAt: "2031-03-18T17:45:00Z" },
    ] };
    assert.equal(switchWarning(account, now), "Weekly 99%");
  });
  it("says nothing for an account with room", () => {
    assert.equal(switchWarning({ windows: [{ label: "Weekly", usedPercent: 75, resetsAt: null }] }, now), null);
  });
  it("ignores a full window whose reset has passed", () => {
    assert.equal(switchWarning({ windows: [{ label: "5-hour", usedPercent: 100, resetsAt: "2031-03-18T07:00:00Z" }] }, now), null);
  });
});

describe("untilAborted", () => {
  it("returns soon after an abort even if the promise never settles, and leaves no listener", { timeout: 2_000 }, async () => {
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const signal = controller.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<typeof add>) => { added += 1; return add(...args); }) as typeof add;
    signal.removeEventListener = ((...args: Parameters<typeof remove>) => { removed += 1; return remove(...args); }) as typeof remove;
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    const result = await untilAborted(new Promise<string>(() => {}), signal);
    assert.equal(result, null);
    assert.ok(Date.now() - started < 1_000);
    assert.equal(added, removed, "every listener added was taken off again");
  });
  it("passes the value through when the promise settles first", async () => {
    const controller = new AbortController();
    assert.equal(await untilAborted(Promise.resolve("ok"), controller.signal), "ok");
  });
  it("returns null at once for a signal already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    assert.equal(await untilAborted(new Promise<string>(() => {}), controller.signal), null);
  });
});

describe("pickAccountToUse: the CLI and the popup refuse an account on hold", () => {
  const accounts = [
    { email: "a@example.com", file: "claude-a@example.com.json", status: "ok" as const },
    { email: "b@example.org", file: "claude-b@example.org.json", status: "on-hold" as const },
  ];
  const byText = (text: string) => (account: { email: string }) => account.email.includes(text);
  it("refuses `use` on an on-hold account and says why", () => {
    const pick = pickAccountToUse(accounts, byText("example.org"), "example.org");
    assert.equal(pick.ok, false);
    if (!pick.ok) assert.match(pick.error, /on hold at Anthropic.*Not switched/);
  });
  it("picks a healthy account", () => {
    const pick = pickAccountToUse(accounts, byText("example.com"), "example.com");
    assert.equal(pick.ok && pick.account.file, "claude-a@example.com.json");
  });
  it("needs exactly one match", () => {
    assert.equal(pickAccountToUse(accounts, byText("example"), "example").ok, false);
    assert.equal(pickAccountToUse(accounts, byText("nobody"), "nobody").ok, false);
  });
});

describe("isAccountInUse, accountVouchedFor, activeFreshnessState", () => {
  const NOW = new Date("2031-04-01T01:00:00.000Z").getTime();
  const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();
  const win = [{ label: "Weekly", usedPercent: 100, resetsAt: "2031-04-01T20:15:00.000Z" }];

  it("never counts an on-hold account as in use even if disabled is false", () => {
    assert.equal(isAccountInUse({ disabled: false, status: "ok" }), true);
    assert.equal(isAccountInUse({ disabled: true, status: "ok" }), false);
    assert.equal(isAccountInUse({ disabled: false, status: "on-hold" }), false);
  });

  it("vouches per account so a held account with figures over a day old does not grey out a fresh active account", () => {
    const live = { status: "ok" as const, windows: win, okAt: at(0), disabled: false };
    const held = { status: "on-hold" as const, windows: win, okAt: at(30 * 60), disabled: false };
    assert.equal(accountVouchedFor(live, NOW), true);
    assert.equal(accountVouchedFor(held, NOW), false);
    const footer = activeFreshnessState({ fetchedAt: at(0), accounts: [live, held] });
    assert.equal(vouchedFor(footer, NOW), true);
    assert.equal(freshnessText(footer, NOW), "Updated just now");
  });
});

describe("antigravityWindowsFrom", () => {
  it("combines summary groups and per-model buckets, keeping the higher usage and hiding placeholder resets at 0%", () => {
    const cloudcodeSummary = {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.8, resetTime: "2031-05-19T21:45:00Z" },
            { bucketId: "gemini-5h", window: "5h", remainingFraction: 1, resetTime: "2031-05-14T14:45:00Z" },
          ],
        },
        {
          displayName: "Claude and GPT models",
          buckets: [
            { bucketId: "3p-weekly", window: "weekly", remainingFraction: 1, resetTime: "2031-05-20T16:15:00Z" },
            { bucketId: "3p-5h", window: "5h", remainingFraction: 1, resetTime: "2031-05-14T14:45:00Z" },
          ],
        },
      ],
    };
    const dailyModelBuckets = [
      { modelId: "gemini-3-flash", remainingFraction: 0.9, resetTime: "2031-05-14T10:30:00Z" },
      { modelId: "claude-opus-5-5-high", remainingFraction: 1, resetTime: "2031-05-14T14:45:00Z" },
    ];
    const windows = antigravityWindowsFrom([cloudcodeSummary], dailyModelBuckets);
    assert.deepEqual(
      windows.map((w) => ({ label: w.label, usedPercent: Math.round(w.usedPercent), resetsAt: w.resetsAt })),
      [
        { label: "5-hour, Gemini", usedPercent: 10, resetsAt: "2031-05-14T10:30:00Z" },
        { label: "Weekly, Gemini", usedPercent: 20, resetsAt: "2031-05-19T21:45:00Z" },
        { label: "5-hour, Claude & GPT", usedPercent: 0, resetsAt: null },
        { label: "Weekly, Claude & GPT", usedPercent: 0, resetsAt: null },
      ],
    );
  });

  it("does not let a fuller weekly model bucket overwrite the 5-hour Claude & GPT or Gemini bar", () => {
    const summary = {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.6, resetTime: "2031-04-07T23:00:00Z" },
            { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.95, resetTime: "2031-04-06T06:00:00Z" },
          ],
        },
        {
          displayName: "Claude and GPT models",
          buckets: [
            { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.3, resetTime: "2031-04-08T15:00:00Z" },
            { bucketId: "3p-5h", window: "5h", remainingFraction: 0.9, resetTime: "2031-04-06T06:15:00Z" },
          ],
        },
      ],
    };
    // retrieveUserQuota returns the tighter (weekly) remainingFraction & resetTime per model when weekly > 5h.
    const modelBuckets = [
      { modelId: "gemini-3-flash", remainingFraction: 0.6, resetTime: "2031-04-07T23:00:00Z" },
      { modelId: "claude-opus-5-5-high", remainingFraction: 0.3, resetTime: "2031-04-08T15:00:00Z" },
    ];
    const windows = antigravityWindowsFrom([summary], modelBuckets);
    assert.deepEqual(
      windows.map((w) => ({ label: w.label, usedPercent: Math.round(w.usedPercent), resetsAt: w.resetsAt })),
      [
        { label: "5-hour, Gemini", usedPercent: 5, resetsAt: "2031-04-06T06:00:00Z" },
        { label: "Weekly, Gemini", usedPercent: 40, resetsAt: "2031-04-07T23:00:00Z" },
        { label: "5-hour, Claude & GPT", usedPercent: 10, resetsAt: "2031-04-06T06:15:00Z" },
        { label: "Weekly, Claude & GPT", usedPercent: 70, resetsAt: "2031-04-08T15:00:00Z" },
      ],
    );
  });
});

describe("windowsFromOmpReport", () => {
  it("maps omp usage --json limits for google-antigravity and anthropic by window and group", () => {
    const agLimits = [
      {
        id: "google-antigravity:anthropic:default:3p-weekly",
        label: "Claude & GPT (shared)",
        scope: { provider: "google-antigravity", windowId: "weekly", shared: true, sharedGroup: "3p-weekly:weekly" },
        window: { id: "weekly", label: "Weekly", resetsAt: Date.parse("2031-04-08T15:00:00.000Z") },
        amount: { used: 70, remainingFraction: 0.3 },
      },
      {
        id: "google-antigravity:openai:default:3p-weekly",
        label: "Claude & GPT (shared)",
        scope: { provider: "google-antigravity", windowId: "weekly", shared: true, sharedGroup: "3p-weekly:weekly" },
        window: { id: "weekly", label: "Weekly", resetsAt: Date.parse("2031-04-08T15:00:00.000Z") },
        amount: { used: 70, remainingFraction: 0.3 },
      },
      {
        id: "google-antigravity:google:default:gemini-weekly",
        label: "Gemini",
        scope: { provider: "google-antigravity", windowId: "weekly" },
        window: { id: "weekly", label: "Weekly", resetsAt: Date.parse("2031-04-07T23:00:00.000Z") },
        amount: { used: 40, remainingFraction: 0.6 },
      },
      {
        id: "google-antigravity:anthropic:default:3p-5h",
        label: "Claude & GPT (shared)",
        scope: { provider: "google-antigravity", windowId: "5h", shared: true, sharedGroup: "3p-5h:5h" },
        window: { id: "5h", label: "5 Hour", resetsAt: Date.parse("2031-04-06T06:15:00.000Z") },
        amount: { used: 10, remainingFraction: 0.9 },
      },
      {
        id: "google-antigravity:google:default:gemini-5h",
        label: "Gemini",
        scope: { provider: "google-antigravity", windowId: "5h" },
        window: { id: "5h", label: "5 Hour", resetsAt: Date.parse("2031-04-06T06:00:00.000Z") },
        amount: { used: 5, remainingFraction: 0.95 },
      },
    ];
    assert.deepEqual(
      windowsFromOmpReport("google-antigravity", agLimits).map((w) => ({
        label: w.label,
        usedPercent: Math.round(w.usedPercent),
        resetsAt: w.resetsAt,
      })),
      [
        { label: "5-hour, Gemini", usedPercent: 5, resetsAt: "2031-04-06T06:00:00.000Z" },
        { label: "Weekly, Gemini", usedPercent: 40, resetsAt: "2031-04-07T23:00:00.000Z" },
        { label: "5-hour, Claude & GPT", usedPercent: 10, resetsAt: "2031-04-06T06:15:00.000Z" },
        { label: "Weekly, Claude & GPT", usedPercent: 70, resetsAt: "2031-04-08T15:00:00.000Z" },
      ],
    );

    const claudeLimits = [
      {
        id: "anthropic:5h",
        label: "Claude 5 Hour",
        scope: { provider: "anthropic", windowId: "5h", shared: true },
        window: { id: "5h", label: "5 Hour", resetsAt: Date.parse("2031-04-06T07:45:00.000Z") },
        amount: { used: 35, remainingFraction: 0.65 },
      },
      {
        id: "anthropic:7d",
        label: "Claude 7 Day",
        scope: { provider: "anthropic", windowId: "7d", shared: true },
        window: { id: "7d", label: "7 Day", resetsAt: Date.parse("2031-04-09T18:30:00.000Z") },
        amount: { used: 55, remainingFraction: 0.45 },
      },
      {
        id: "anthropic:7d:fable",
        label: "Claude 7 Day (Fable)",
        scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
        window: { id: "7d", label: "7 Day", resetsAt: Date.parse("2031-04-09T18:30:00.000Z") },
        amount: { used: 0, remainingFraction: 1 },
      },
    ];
    assert.deepEqual(windowsFromOmpReport("anthropic", claudeLimits), [
      { label: "5-hour", usedPercent: 35, resetsAt: "2031-04-06T07:45:00.000Z" },
      { label: "Weekly", usedPercent: 55, resetsAt: "2031-04-09T18:30:00.000Z" },
      { label: "Weekly, Fable only", usedPercent: 0, resetsAt: "2031-04-09T18:30:00.000Z" },
    ]);
  });
});

type StripAccount = AccountResult & { id?: number; provider?: string };

function stripAccount(overrides: Partial<StripAccount>): StripAccount {
  return {
    email: "a@example.com",
    file: "agentdb-anthropic-1.json",
    disabled: false,
    status: "ok",
    windows: [{ label: "5-hour", usedPercent: 10, resetsAt: "2031-02-18T15:00:00.000Z" }],
    message: null,
    okAt: NOW_ISO,
    provider: "anthropic",
    ...overrides,
  };
}

describe("closestWindow", () => {
  it("is null without windows", () => {
    assert.equal(closestWindow([]), null);
  });

  it("picks the highest usedPercent", () => {
    const weekly = { label: "Weekly", usedPercent: 70, resetsAt: "2031-02-23T00:00:00.000Z" };
    assert.equal(closestWindow([{ label: "5-hour", usedPercent: 30, resetsAt: "2031-02-18T15:00:00.000Z" }, weekly]), weekly);
  });

  it("breaks a tie by the earlier reset, with no reset time last", () => {
    const soon = { label: "5-hour", usedPercent: 50, resetsAt: "2031-02-18T15:00:00.000Z" };
    const later = { label: "Weekly", usedPercent: 50, resetsAt: "2031-02-23T00:00:00.000Z" };
    const never = { label: "Other", usedPercent: 50, resetsAt: null };
    assert.equal(closestWindow([never, later, soon]), soon);
  });
});

describe("stripUsageRows", () => {
  it("shows Ultra weekly quota (ignoring a higher 5-hour window) with both weeklies in the tooltip, plus active Claude", () => {
    const rows = stripUsageRows(
      {
        accounts: [
          stripAccount({
            id: 1,
            email: "a@example.com",
            windows: [
              { label: "5-hour", usedPercent: 30, resetsAt: "2031-02-18T15:00:00.000Z" },
              { label: "Weekly", usedPercent: 70.4, resetsAt: "2031-02-23T00:00:00.000Z" },
            ],
          }),
          stripAccount({ id: 2, email: "b@example.com", file: "agentdb-anthropic-2.json", disabled: true }),
          stripAccount({ id: 3, email: "c@example.com", file: "agentdb-anthropic-3.json", status: "on-hold" }),
        ],
        antigravity: stripAccount({
          id: 9,
          provider: "google-antigravity",
          email: "u@example.com",
          file: "agentdb-google-antigravity-9.json",
          windows: [
            { label: "5-hour, Gemini", usedPercent: 95, resetsAt: "2031-02-18T14:00:00.000Z" },
            { label: "Weekly, Gemini", usedPercent: 48, resetsAt: "2031-02-22T07:00:00.000Z" },
            { label: "5-hour, Claude & GPT", usedPercent: 88, resetsAt: "2031-02-18T14:30:00.000Z" },
            { label: "Weekly, Claude & GPT", usedPercent: 60, resetsAt: "2031-02-23T15:00:00.000Z" },
          ],
        }),
        message: null,
      },
      NOW_MS,
    );
    assert.deepEqual(
      rows.map(({ label, level, text, windowLabel, usedPercent }) => ({ label, level, text, windowLabel, usedPercent })),
      [
        { label: "Ultra wk · C/GPT", level: "amber", text: "60%", windowLabel: "Weekly, Claude & GPT", usedPercent: 60 },
        { label: "Claude", level: "amber", text: "70%", windowLabel: "Weekly", usedPercent: 70.4 },
      ],
    );
    assert.equal(
      rows[0]!.tooltip,
      [
        "Ultra (u@example.com)",
        "Weekly, Gemini: 48%, resets 2031-02-22T07:00:00.000Z",
        "Weekly, Claude & GPT: 60%, resets 2031-02-23T15:00:00.000Z",
      ].join("\n"),
    );
    assert.equal(rows[1]!.tooltip, "Claude (a@example.com): Weekly: 70%, resets 2031-02-23T00:00:00.000Z");
    assert.equal(rows[1]!.resetsAt, "2031-02-23T00:00:00.000Z");

    const geminiHigher = stripUsageRows(
      {
        accounts: [],
        antigravity: stripAccount({
          id: 9,
          provider: "google-antigravity",
          email: "u@example.com",
          file: "agentdb-google-antigravity-9.json",
          windows: [
            { label: "5-hour, Claude & GPT", usedPercent: 99, resetsAt: "2031-02-18T14:30:00.000Z" },
            { label: "Weekly, Gemini", usedPercent: 52, resetsAt: "2031-02-22T07:00:00.000Z" },
            { label: "Weekly, Claude & GPT", usedPercent: 40, resetsAt: null },
          ],
        }),
        message: null,
      },
      NOW_MS,
    );
    assert.equal(geminiHigher[0]!.label, "Ultra wk · G");
    assert.equal(geminiHigher[0]!.text, "52%");
    assert.equal(geminiHigher[0]!.level, "green");
  });
  it("turns red above 85% and names accounts sharing a provider", () => {
    const rows = stripUsageRows(
      {
        accounts: [
          stripAccount({ id: 1, email: "first@example.com", windows: [{ label: "5-hour", usedPercent: 86, resetsAt: null }] }),
          stripAccount({ id: 2, email: "second@example.com", file: "agentdb-anthropic-2.json", windows: [{ label: "5-hour", usedPercent: 85, resetsAt: null }] }),
        ],
        message: null,
      },
      NOW_MS,
    );
    assert.deepEqual(
      rows.map(({ label, level }) => ({ label, level })),
      [
        { label: "Claude · first", level: "red" },
        { label: "Claude · second", level: "amber" },
      ],
    );
  });

  it("does not list Antigravity twice when it is also among the accounts", () => {
    const ag = stripAccount({ id: 9, provider: "google-antigravity", file: "agentdb-google-antigravity-9.json" });
    const rows = stripUsageRows({ accounts: [ag], antigravity: ag, message: null }, NOW_MS);
    assert.equal(rows.length, 1);
  });

  it("shows a visible red error row when an account read fails, and unknown when figures are merely stale", () => {
    const rows = stripUsageRows(
      {
        accounts: [
          stripAccount({ id: 1, status: "error", message: "HTTP 500" }),
          stripAccount({ id: 2, email: "b@example.com", file: "agentdb-anthropic-2.json", status: "stale", message: null }),
        ],
        message: null,
      },
      NOW_MS,
    );
    assert.deepEqual(
      rows.map(({ level, text, usedPercent, windowLabel, resetsAt }) => ({ level, text, usedPercent, windowLabel, resetsAt })),
      [
        { level: "red", text: "error", usedPercent: null, windowLabel: null, resetsAt: null },
        { level: "unknown", text: "unknown", usedPercent: null, windowLabel: null, resetsAt: null },
      ],
    );
    assert.equal(rows[0]!.tooltip, "Claude · a (a@example.com): error (HTTP 500)");
    assert.equal(rows[1]!.tooltip, "Claude · b (b@example.com): unknown (figures stale or unavailable)");
  });

  it("reads unknown for an ok account without windows", () => {
    const [row] = stripUsageRows({ accounts: [stripAccount({ windows: [] })], message: null }, NOW_MS);
    assert.equal(row!.level, "unknown");
  });

  it("is one unknown row without state", () => {
    assert.deepEqual(stripUsageRows(null, NOW_MS), [
      {
        key: "unknown",
        label: "Usage",
        provider: "unknown",
        email: "",
        level: "unknown",
        usedPercent: null,
        text: "unknown",
        windowLabel: null,
        resetsAt: null,
        tooltip: "Usage figures unavailable",
      },
    ]);
  });

  it("shows a visible red error row when agent.db could not be read, and unknown when no account is in use", () => {
    const rows = stripUsageRows({ accounts: [], message: "cannot read /bad/agent.db: unable to open database file" }, NOW_MS);
    assert.deepEqual(rows, [
      {
        key: "error",
        label: "Usage",
        provider: "unknown",
        email: "",
        level: "red",
        usedPercent: null,
        text: "error",
        windowLabel: null,
        resetsAt: null,
        tooltip: "cannot read /bad/agent.db: unable to open database file",
      },
    ]);
    const idle = stripUsageRows({ accounts: [stripAccount({ disabled: true })], message: null }, NOW_MS);
    assert.equal(idle.length, 1);
    assert.equal(idle[0]!.key, "unknown");
    assert.equal(idle[0]!.level, "unknown");
    assert.equal(idle[0]!.tooltip, "No active subscription account");
  });
});

describe("parseSystemctlFailedUnits", () => {
  it("reads unit names with or without a status bullet", () => {
    const stdout = [
      "● foo.service loaded failed failed Foo daemon",
      "bar.timer     loaded failed failed Bar timer",
      "× baz.mount loaded failed failed Baz mount",
      "",
    ].join("\n");
    assert.deepEqual(parseSystemctlFailedUnits(stdout), ["foo.service", "bar.timer", "baz.mount"]);
  });

  it("is empty when nothing failed", () => {
    assert.deepEqual(parseSystemctlFailedUnits(""), []);
    assert.deepEqual(parseSystemctlFailedUnits("\n"), []);
  });
});

describe("parseSystemctlShowWatchdog", () => {
  it("reads a loaded unit with a unix exit timestamp", () => {
    const tsSec = Math.floor(NOW_MS / 1000);
    const stdout = [
      "LoadState=loaded",
      "ActiveState=inactive",
      "SubState=dead",
      "Result=success",
      "ExecMainStatus=0",
      `ExecMainExitTimestamp=@${tsSec}`,
      "",
    ].join("\n");
    assert.deepEqual(parseSystemctlShowWatchdog(stdout), {
      loadState: "loaded",
      activeState: "inactive",
      result: "success",
      execMainStatus: 0,
      exitAtMs: tsSec * 1000,
    });
  });

  it("reads a date exit timestamp", () => {
    const parsed = parseSystemctlShowWatchdog("ExecMainExitTimestamp=2031-04-06T10:00:00Z\n");
    assert.equal(parsed.exitAtMs, Date.parse("2031-04-06T10:00:00Z"));
  });

  it("gives nulls for a missing unit that never ran", () => {
    const stdout = "LoadState=not-found\nActiveState=inactive\nResult=success\nExecMainStatus=0\nExecMainExitTimestamp=\n";
    assert.deepEqual(parseSystemctlShowWatchdog(stdout), {
      loadState: "not-found",
      activeState: "inactive",
      result: "success",
      execMainStatus: 0,
      exitAtMs: null,
    });
  });
});

describe("aggregateServerHealth", () => {
  const healthy = (): ServerHealthInput => ({
    checkedAt: NOW_ISO,
    systemFailedUnits: [],
    userFailedUnits: [],
    hosts: [
      { id: "m-a", name: "desk", status: "connected", phase: "active" },
      { id: "m-b", name: "rack", status: "connected", phase: "active" },
      { id: "m-c", name: "spare", status: "disconnected", phase: "suspended" },
    ],
    diskRoot: { availBytes: 250 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 },
    watchdog: {
      unitName: "watchdog.service",
      loadState: "loaded",
      activeState: "inactive",
      result: "success",
      execMainStatus: 0,
      exitAtMs: NOW_MS - 4 * 60_000,
    },
  });

  it("is ok when every check is green", () => {
    const health = aggregateServerHealth(healthy(), NOW_MS);
    assert.equal(health.level, "green");
    assert.equal(health.word, "ok");
    assert.equal(health.checkedAt, NOW_ISO);
    assert.deepEqual(
      health.checks.map(({ id, label, level }) => ({ id, label, level })),
      [
        { id: "systemd", label: "Systemd", level: "green" },
        { id: "machines", label: "Machines", level: "green" },
        { id: "disk", label: "Disk /", level: "green" },
        { id: "watchdog", label: "Watchdog", level: "green" },
      ],
    );
    assert.equal(
      health.tooltip,
      "Systemd units: 0 failed\nMachines: 2/2 online\nDisk /: 50% free (250 GiB)\nWatchdog: last run 4 min ago",
    );
  });

  it("fails on a failed unit and names it first", () => {
    const health = aggregateServerHealth({ ...healthy(), userFailedUnits: ["sync.service"] }, NOW_MS);
    assert.equal(health.level, "red");
    assert.equal(health.word, "fail");
    assert.equal(health.tooltip.split("\n")[0], "Failed units: sync.service");
  });

  it("ignores configured units", () => {
    const health = aggregateServerHealth(
      { ...healthy(), systemFailedUnits: ["noisy.service"], ignoredUnits: [" noisy.service ", ""] },
      NOW_MS,
    );
    assert.equal(health.word, "ok");
  });

  it("fails when the watchdog unit is missing", () => {
    const input = healthy();
    const health = aggregateServerHealth({ ...input, watchdog: { ...input.watchdog!, loadState: "not-found", exitAtMs: null } }, NOW_MS);
    assert.equal(health.word, "fail");
    assert.equal(health.tooltip.split("\n")[0], "Watchdog: watchdog.service not-found");
  });

  it("fails when the watchdog's last run failed", () => {
    const input = healthy();
    const health = aggregateServerHealth({ ...input, watchdog: { ...input.watchdog!, result: "exit-code", execMainStatus: 1 } }, NOW_MS);
    assert.equal(health.word, "fail");
    assert.equal(health.tooltip.split("\n")[0], "Watchdog: watchdog.service failed (exit-code)");
  });

  it("warns when the watchdog is late and fails when it is overdue", () => {
    const input = healthy();
    const late = aggregateServerHealth({ ...input, watchdog: { ...input.watchdog!, exitAtMs: NOW_MS - 15 * 60_000 } }, NOW_MS);
    assert.equal(late.word, "warn");
    assert.equal(late.tooltip.split("\n")[0], "Watchdog (watchdog.service): last run 15 min ago (late)");
    const overdue = aggregateServerHealth({ ...input, watchdog: { ...input.watchdog!, exitAtMs: NOW_MS - 40 * 60_000 } }, NOW_MS);
    assert.equal(overdue.word, "fail");
    assert.equal(overdue.tooltip.split("\n")[0], "Watchdog (watchdog.service): last run 40 min ago (overdue)");
  });

  it("fails on an offline machine and names it first", () => {
    const input = healthy();
    const health = aggregateServerHealth(
      { ...input, hosts: [...input.hosts!, { id: "m-d", name: "", status: "disconnected", phase: "active" }] },
      NOW_MS,
    );
    assert.equal(health.word, "fail");
    assert.equal(health.tooltip.split("\n")[0], "Machines offline: m-d");
  });

  it("warns below 10% free disk and fails below 5%", () => {
    const total = 500 * 1024 ** 3;
    const low = aggregateServerHealth({ ...healthy(), diskRoot: { availBytes: 0.08 * total, totalBytes: total } }, NOW_MS);
    assert.equal(low.level, "amber");
    assert.equal(low.word, "warn");
    assert.equal(low.tooltip.split("\n")[0], "Disk / low: 8% free (40 GiB)");
    const critical = aggregateServerHealth({ ...healthy(), diskRoot: { availBytes: 0.03 * total, totalBytes: total } }, NOW_MS);
    assert.equal(critical.level, "red");
    assert.equal(critical.tooltip.split("\n")[0], "Disk / low: 3% free (15 GiB)");
  });

  it("is unknown when a source could not be read", () => {
    for (const patch of [
      { systemFailedUnits: null },
      { userFailedUnits: null },
      { hosts: null },
      { diskRoot: null },
      { watchdog: null },
    ] satisfies Partial<ServerHealthInput>[]) {
      const health = aggregateServerHealth({ ...healthy(), ...patch }, NOW_MS);
      assert.equal(health.level, "unknown", JSON.stringify(patch));
      assert.equal(health.word, "unknown");
      assert.match(health.tooltip.split("\n")[0]!, /unknown/u);
    }
  });

  it("is unknown when the readings are older than one poll window or undated", () => {
    const stale = new Date(NOW_MS - POLL_WINDOW_MS - 1).toISOString();
    assert.equal(aggregateServerHealth({ ...healthy(), checkedAt: stale }, NOW_MS).word, "unknown");
    assert.equal(aggregateServerHealth({ ...healthy(), checkedAt: null }, NOW_MS).level, "unknown");
    assert.equal(aggregateServerHealth({ ...healthy(), checkedAt: "not a date" }, NOW_MS).level, "unknown");
  });

  it("is unknown even with a failed unit once the readings are stale", () => {
    const stale = new Date(NOW_MS - POLL_WINDOW_MS - 1).toISOString();
    const health = aggregateServerHealth({ ...healthy(), checkedAt: stale, systemFailedUnits: ["x.service"] }, NOW_MS);
    assert.equal(health.level, "unknown");
    assert.equal(health.tooltip.split("\n")[0], "Failed units: x.service");
  });
});

describe("CPU and Memory strip metrics (/proc/stat, /proc/loadavg, /proc/meminfo, thresholds)", () => {
  it("calculates whole-machine CPU busy percent from two /proc/stat samples and counts cores", () => {
    const sample1 = [
      ["cpu", 1000, 100, 300, 8400, 200, 0, 0, 0, 50, 10].join(" "),
      ["cpu0", 500, 50, 150, 4200, 100, 0, 0, 0, 25, 5].join(" "),
      ["cpu1", 500, 50, 150, 4200, 100, 0, 0, 0, 25, 5].join(" "),
      "",
    ].join("\n");
    const sample2 = [
      ["cpu", 1150, 100, 350, 9050, 250, 50, 50, 0, 60, 10].join(" "),
      ["cpu0", 575, 50, 175, 4525, 125, 25, 25, 0, 30, 5].join(" "),
      ["cpu1", 575, 50, 175, 4525, 125, 25, 25, 0, 30, 5].join(" "),
      "",
    ].join("\n");
    const s1 = parseProcStat(sample1);
    const s2 = parseProcStat(sample2);
    assert.deepEqual(s1, { total: 10000, idle: 8600, cores: 2 });
    assert.deepEqual(s2, { total: 11000, idle: 9300, cores: 2 });
    // Total delta = 1000, idle+iowait delta = 700 -> busy = 300 -> 30%
    assert.equal(cpuPercentFromStatSamples(s1, s2), 30);
    assert.equal(cpuPercentFromStatSamples(s2, s2), null);
    assert.equal(cpuPercentFromStatSamples(s2, s1), null);
    assert.equal(parseProcStat("not a stat file"), null);
  });

  it("parses /proc/loadavg 1, 5, and 15 minute load averages", () => {
    assert.deepEqual(parseProcLoadavg("0.23 0.31 0.84 2/840 12345\n"), {
      load1: "0.23",
      load5: "0.31",
      load15: "0.84",
    });
    assert.equal(parseProcLoadavg("bad"), null);
  });

  it("calculates memory used percent as (MemTotal - MemAvailable) / MemTotal and swap used from /proc/meminfo", () => {
    const totalKiB = 48 * 1024 * 1024;
    const availKiB = 36 * 1024 * 1024;
    const swapTotalKiB = 6 * 1024 * 1024;
    const swapFreeKiB = 5 * 1024 * 1024;
    const raw = [
      `MemTotal:       ${totalKiB} kB`,
      "MemFree:         102400 kB",
      `MemAvailable:   ${availKiB} kB`,
      `SwapTotal:       ${swapTotalKiB} kB`,
      `SwapFree:        ${swapFreeKiB} kB`,
      "",
    ].join("\n");
    const mem = parseProcMeminfo(raw);
    assert.deepEqual(mem, {
      memTotalKiB: totalKiB,
      memAvailableKiB: availKiB,
      memUsedKiB: 12 * 1024 * 1024,
      usedPercent: 25,
      swapTotalKiB,
      swapUsedKiB: 1 * 1024 * 1024,
    });
    assert.equal(parseProcMeminfo("MemTotal: 1000 kB\n"), null);
  });

  it("applies CPU and Memory level thresholds: green below 70%, amber 70 to 90%, red above 90%, unknown on null", () => {
    assert.equal(serverMetricLevel(0), "green");
    assert.equal(serverMetricLevel(69.9), "green");
    assert.equal(serverMetricLevel(70), "amber");
    assert.equal(serverMetricLevel(90), "amber");
    assert.equal(serverMetricLevel(90.1), "red");
    assert.equal(serverMetricLevel(100), "red");
    assert.equal(serverMetricLevel(null), "unknown");
  });

  it("formats CPU and Memory tooltips and returns unknown when a read fails or is stale", () => {
    const mem = parseProcMeminfo(
      `MemTotal: ${44 * 1024 * 1024} kB\nMemAvailable: ${11 * 1024 * 1024} kB\nSwapTotal: ${6 * 1024 * 1024} kB\nSwapFree: ${4 * 1024 * 1024} kB\n`,
    );
    const fresh = buildServerMetrics(
      {
        checkedAt: NOW_ISO,
        cpuPercent: 12.4,
        cores: 6,
        loadavg: { load1: "0.40", load5: "0.55", load15: "0.70" },
        mem,
      },
      NOW_MS,
    );
    assert.equal(fresh.cpu.level, "green");
    assert.equal(fresh.cpu.text, "12%");
    assert.equal(fresh.cpu.tooltip, "CPU: 12% (6 cores · load 0.40, 0.55, 0.70 over 1, 5, 15 min)");
    assert.equal(fresh.memory.level, "amber");
    assert.equal(fresh.memory.text, "75%");
    assert.equal(fresh.memory.tooltip, "Memory: 75% (33.0 / 44.0 GB used · swap 2.0 GB used)");

    const missingCpu = buildServerMetrics(
      { checkedAt: NOW_ISO, cpuPercent: null, cores: 6, loadavg: null, mem },
      NOW_MS,
    );
    assert.equal(missingCpu.cpu.level, "unknown");
    assert.equal(missingCpu.cpu.text, "unknown");
    assert.equal(missingCpu.memory.level, "amber");

    const stale = buildServerMetrics(
      {
        checkedAt: new Date(NOW_MS - SERVER_METRICS_WINDOW_MS - 1).toISOString(),
        cpuPercent: 12.4,
        cores: 6,
        loadavg: { load1: "0.40", load5: "0.55", load15: "0.70" },
        mem,
      },
      NOW_MS,
    );
    assert.equal(stale.cpu.level, "unknown");
    assert.equal(stale.memory.level, "unknown");
  });
});
