import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTH_RETRY_CAP,
  classifyFailure,
  classifyCompletedTurnError,
  classifyOnce,
  ONCE_DELAY_MS,
  OVERLOAD_DELAY_MS,
  providerChainEnded,
  releaseParked,
  startTestMode,
  activeTestMode,
  decide,
  dispatchHold,
  modelFromDetail,
  onRecovery,
  readTurnEvents,
  factsFromRows,
  EVENT_PAGE_SIZE,
  isOtherRetry,
  isOurRetry,
  pendingResumeRows,
  raiseAlert,
  resetFor,
  RESUME_MARGIN_MS,
  STAGGER_MS,
  STARTUP_HOLD_MS,
  staggeredSlot,
  type ResumeRecord,
} from "./resume.ts";

const QUOTA_DETAIL = "API Error: 429 window full for model claude-fable-5-1, try later";
const AUTH_DETAIL = "API Error: 503 auth_unavailable: login missing, model=claude-opus-5-5";

describe("classifyFailure", () => {
  it("reads a bare 429 as quota", () => {
    assert.equal(classifyFailure({ category: "rate-limit", httpStatusCode: 429 }, QUOTA_DETAIL), "quota");
  });
  it("reads a 503 as auth only when the message says auth_unavailable", () => {
    assert.equal(classifyFailure({ category: "internal", httpStatusCode: 503 }, AUTH_DETAIL), "auth");
    assert.equal(classifyFailure({ category: "internal", httpStatusCode: 503 }, "HTTP 503 server_error"), "other");
  });
  it("reads a 400 unknown provider as the login outage", () => {
    const detail = "API Error: 400 unknown provider for model claude-opus-5-5";
    assert.equal(classifyFailure({ category: "bad-request", httpStatusCode: 400 }, detail), "auth");
    assert.equal(modelFromDetail(detail), "claude-opus-5-5");
  });
  it("never retries any other 400", () => {
    for (const detail of ["API Error: 400 invalid request", "API Error: 400 prompt is too long: 250000 tokens", "API Error: 400 unknown model"]) {
      assert.equal(classifyFailure({ category: "bad-request", httpStatusCode: 400 }, detail), "other", detail);
    }
    assert.equal(classifyFailure({ category: "bad-request", httpStatusCode: 400 }, null), "other");
  });
  it("retries the provider 400 up to the cap, then alerts once", () => {
    const kind = classifyFailure({ category: "bad-request", httpStatusCode: 400 }, "API Error: 400 unknown provider for model claude-opus-5-5");
    assert.equal(kind, "auth");
    let previous: ResumeRecord | undefined;
    const t0 = Date.parse("2031-07-08T14:30:00Z");
    const waits: number[] = [];
    for (let i = 1; i <= AUTH_RETRY_CAP; i++) {
      const d = decide({ threadId: "t1", requestId: "r", kind: "auth", reset: null }, previous, [], t0);
      assert.equal(d.kind, "schedule");
      if (d.kind === "schedule") { waits.push(d.record.sendAt - t0); previous = d.record; }
    }
    assert.deepEqual(waits, [2 * 60_000, 4 * 60_000, 8 * 60_000]);
    assert.equal(decide({ threadId: "t1", requestId: "r", kind: "auth", reset: null }, previous, [], t0).kind, "alert");
  });
  it("leaves every other failure alone", () => {
    assert.equal(classifyFailure({ category: "internal", httpStatusCode: 500 }, null), "other");
    assert.equal(classifyFailure(null, QUOTA_DETAIL), "other");
  });
  it("detects raw provider errors in the text of completed turns and ignores normal reports", () => {
    assert.deepEqual(classifyCompletedTurnError("Cloud Code Assist API error (429): quota used up"), { kind: "quota" });
    assert.deepEqual(classifyCompletedTurnError(`{"error": {"status": "RESOURCE_EXHAUSTED"}}`), { kind: "quota" });
    assert.deepEqual(classifyCompletedTurnError("API Error: 429 rate limit exceeded"), { kind: "quota" });
    assert.deepEqual(classifyCompletedTurnError(AUTH_DETAIL), { kind: "auth" });
    assert.deepEqual(classifyCompletedTurnError("No API key found for google-antigravity"), { kind: "auth" });
    assert.deepEqual(classifyCompletedTurnError("Connection error."), { kind: "once", why: "connection error" });
    assert.equal(classifyCompletedTurnError("Summary: the Cloud Code Assist API error (429) path now has a test."), null);
  });
});

describe("modelFromDetail", () => {
  it("finds the model in quota and auth messages", () => {
    assert.equal(modelFromDetail(QUOTA_DETAIL), "claude-fable-5-1");
    assert.equal(modelFromDetail(AUTH_DETAIL), "claude-opus-5-5");
    assert.equal(modelFromDetail(null), null);
  });
  it("reads google-antigravity and anthropic models too", () => {
    assert.equal(modelFromDetail("rate limit for model=google-antigravity/gemini-4-argon"), "google-antigravity/gemini-4-argon");
    assert.equal(modelFromDetail("model anthropic/claude-opus-5-5 hit 429"), "anthropic/claude-opus-5-5");
  });
});

const at = (iso: string) => Date.parse(iso);
const accounts = [
  {
    email: "ops@example.net",
    disabled: true,
    windows: [{ label: "7-day", usedPercent: 100, resetsAt: "2032-08-18T14:30:00Z" }],
  },
  {
    email: "main@example.net",
    disabled: false,
    windows: [
      { label: "Session", usedPercent: 100, resetsAt: "2032-08-18T19:30:00Z" },
      { label: "7-day", usedPercent: 100, resetsAt: "2032-08-20T07:15:00Z" },
      { label: "7-day, Sonnet only", usedPercent: 100, resetsAt: "2032-08-22T07:15:00Z" },
    ],
  },
  {
    email: "spare@example.net",
    disabled: false,
    windows: [{ label: "7-day", usedPercent: 90, resetsAt: "2032-08-21T02:00:00Z" }],
  },
];

const before = at("2032-08-18T16:00:00Z");

describe("resetFor", () => {
  it("ignores a window whose reset is already past, since stale figures cannot explain a fresh 429", () => {
    // Session at 100% but its reset passed; the 7-day is still shut, so that is the one to wait for.
    assert.equal(resetFor(accounts, "claude-opus-5-5", at("2032-08-18T21:00:00Z"))?.label, "7-day");
    assert.equal(resetFor([accounts[1]], "claude-opus-5-5", at("2032-08-22T08:00:00Z")), null);
  });
  it("waits for the latest blocked shared window of the account in use", () => {
    assert.deepEqual(resetFor(accounts, "claude-opus-5-5", before), { at: at("2032-08-20T07:15:00Z"), email: "main@example.net", label: "7-day" });
  });
  it("counts a model-scoped window only for that model", () => {
    assert.equal(resetFor(accounts, "claude-sonnet-5-5", before)?.label, "7-day, Sonnet only");
  });
  it("never reports an account that is not in use", () => {
    assert.notEqual(resetFor(accounts, "claude-opus-5-5", before)?.email, "ops@example.net");
  });
  it("returns null rather than guess when nothing in use is blocked", () => {
    const open = [{ email: "main@example.net", disabled: false, windows: [{ label: "7-day", usedPercent: 55, resetsAt: "2032-08-20T07:15:00Z" }] }];
    assert.equal(resetFor(open, "claude-opus-5-5", before), null);
  });
});

describe("staggeredSlot", () => {
  it("spaces three resumes on one reset a full gap apart", () => {
    const taken: number[] = [];
    for (let i = 0; i < 3; i++) taken.push(staggeredSlot(1000, taken, 100));
    assert.deepEqual(taken, [1000, 1100, 1200]);
  });
  it("reuses a free slot before a later one", () => {
    assert.equal(staggeredSlot(1000, [1300], 100), 1000);
  });
});

const now = at("2032-08-18T17:10:00Z");
const reset = { at: at("2032-08-18T19:30:00Z"), email: "main@example.net", label: "Session" };

describe("decide: quota", () => {
  it("schedules after the reset plus the margin", () => {
    const d = decide({ threadId: "t1", requestId: "r1", kind: "quota", reset }, undefined, [], now);
    assert.equal(d.kind, "schedule");
    if (d.kind === "schedule") assert.equal(d.record.sendAt, reset.at + RESUME_MARGIN_MS);
  });
  it("resumes a thread at most once per window", () => {
    const first = decide({ threadId: "t1", requestId: "r1", kind: "quota", reset }, undefined, [], now);
    assert.equal(first.kind, "schedule");
    const previous = first.kind === "schedule" ? first.record : undefined;
    const second = decide({ threadId: "t1", requestId: "r2", kind: "quota", reset }, previous, [], reset.at + 90_000);
    assert.equal(second.kind, "skip");
  });
  it("treats the endpoint's per-poll jitter on one reset as the same window", () => {
    // Two reads of one Session reset a poll apart may differ by a fraction of a second.
    const firstRead = { ...reset, at: Date.parse("2032-08-18T19:30:00.040000+00:00") };
    const secondRead = { ...reset, at: Date.parse("2032-08-18T19:30:00.230000+00:00") };
    const first = decide({ threadId: "t1", requestId: "r1", kind: "quota", reset: firstRead }, undefined, [], now);
    const previous = first.kind === "schedule" ? first.record : undefined;
    assert.equal(decide({ threadId: "t1", requestId: "r2", kind: "quota", reset: secondRead }, previous, [], now).kind, "skip");
  });
  it("resumes again once a new window has closed", () => {
    const previous = { kind: "quota", windowAt: reset.at } as ResumeRecord;
    const later = { ...reset, at: reset.at + 5 * 3600_000 };
    assert.equal(decide({ threadId: "t1", requestId: "r2", kind: "quota", reset: later }, previous, [], now).kind, "schedule");
  });
  it("schedules nothing without a reset time", () => {
    assert.equal(decide({ threadId: "t1", requestId: "r1", kind: "quota", reset: null }, undefined, [], now).kind, "skip");
  });
  it("staggers many threads failing on the same window", () => {
    const taken: number[] = [];
    for (let i = 0; i < 11; i++) {
      const d = decide({ threadId: `t${i}`, requestId: "r", kind: "quota", reset }, undefined, taken, now);
      assert.equal(d.kind, "schedule");
      if (d.kind === "schedule") taken.push(d.record.sendAt);
    }
    const sorted = [...taken].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i] - sorted[i - 1] >= STAGGER_MS);
  });
});

describe("decide: auth", () => {
  it("retries up to the cap, then alerts instead of looping", () => {
    let previous: ResumeRecord | undefined;
    for (let i = 1; i <= AUTH_RETRY_CAP; i++) {
      const d = decide({ threadId: "t1", requestId: "r", kind: "auth", reset: null }, previous, [], now);
      assert.equal(d.kind, "schedule");
      if (d.kind === "schedule") {
        assert.equal(d.record.attempts, i);
        previous = d.record;
      }
    }
    assert.equal(decide({ threadId: "t1", requestId: "r", kind: "auth", reset: null }, previous, [], now).kind, "alert");
  });
});

describe("decide: auth across outages", () => {
  it("starts counting again in a later outage instead of alerting at once", () => {
    const capped = { kind: "auth", attempts: AUTH_RETRY_CAP, createdAt: now, windowAt: 0 } as ResumeRecord;
    assert.equal(decide({ threadId: "t1", requestId: "r", kind: "auth", reset: null }, capped, [], now + 60_000).kind, "alert");
    const later = decide({ threadId: "t1", requestId: "r", kind: "auth", reset: null }, capped, [], now + 5 * 3600_000);
    assert.equal(later.kind, "schedule");
    if (later.kind === "schedule") assert.equal(later.record.attempts, 1);
  });
});

describe("dispatchHold", () => {
  const start = 1_000_000;
  it("holds our overdue resumes for a while after a start", () => {
    assert.equal(dispatchHold(start + 1_000, start, 0, STAGGER_MS), start + STARTUP_HOLD_MS);
  });
  it("lets the first through after the hold, then spaces the rest by the gap", () => {
    const t = start + STARTUP_HOLD_MS;
    assert.equal(dispatchHold(t, start, 0, STAGGER_MS), null);
    assert.equal(dispatchHold(t + 500, start, t, STAGGER_MS), t + STAGGER_MS);
    assert.equal(dispatchHold(t + STAGGER_MS, start, t, STAGGER_MS), null);
  });
  it("rows due in one sweep go out a gap apart", () => {
    let last = 0;
    const sent: number[] = [];
    let clock = start + STARTUP_HOLD_MS;
    while (sent.length < 4) {
      const until = dispatchHold(clock, start, last, STAGGER_MS);
      if (until === null) { sent.push(clock); last = clock; } else clock = until;
    }
    for (let i = 1; i < sent.length; i++) assert.equal(sent[i] - sent[i - 1], STAGGER_MS);
  });
});

describe("raiseAlert", () => {
  it("raises once per outage, not once per thread", () => {
    const first = raiseAlert(null, "lost", now);
    assert.equal(first.raised, true);
    const second = raiseAlert(first.alert, "lost", now + 60_000);
    assert.equal(second.raised, false);
    const nextOutage = raiseAlert(second.alert, "lost", now + 60_000 + 31 * 60_000);
    assert.equal(nextOutage.raised, true);
  });
});

describe("onRecovery: a thread that recovered by itself", () => {
  const base = { threadId: "t1", requestId: "r1", windowAt: 0, sendAt: 0, attempts: 1, note: "", createdAt: 0 };
  it("cancels our queued resume when the failed input was already accepted", () => {
    const plan = onRecovery({ ...base, kind: "quota", inputAccepted: true } as ResumeRecord, ["qmsg_1"]);
    assert.deepEqual(plan.cancel, ["qmsg_1"]);
    assert.equal(plan.dropRecord, false, "the quota record still guards the window");
  });
  it("keeps a resume that carries input the provider never took", () => {
    const plan = onRecovery({ ...base, kind: "quota", inputAccepted: false } as ResumeRecord, ["qmsg_1"]);
    assert.deepEqual(plan.cancel, []);
    assert.equal(plan.keptBecauseUnaccepted, true);
  });
  it("keeps a resume from a record that predates the field", () => {
    assert.deepEqual(onRecovery({ ...base, kind: "quota" } as ResumeRecord, ["qmsg_1"]).cancel, []);
  });
  it("ends an auth outage: record and alert go", () => {
    const plan = onRecovery({ ...base, kind: "auth", inputAccepted: true } as ResumeRecord, []);
    assert.equal(plan.dropRecord, true);
    assert.equal(plan.clearAlert, true);
  });
  it("does nothing for a thread it never queued", () => {
    assert.deepEqual(onRecovery(undefined, ["qmsg_1"]).cancel, []);
  });
});

describe("classifyOnce: passing failures get exactly one more try", () => {
  const none = { providerErrors: [], systemErrorDetails: [], interruptedReason: null, questionPending: false };
  it("treats the host daemon going away and a provider killed by SIGTERM as passing", () => {
    assert.equal(classifyOnce({ ...none, interruptedReason: "host-daemon-restarted" }, null, 0), "host daemon restarted");
    const killed = { ...none, providerErrors: [{ detail: "agent process exited unexpectedly (signal SIGTERM)", willRetry: false, httpStatusCode: null }] };
    assert.equal(classifyOnce(killed, null, 0), "provider exited (SIGTERM)");
  });
  it("does not answer for the user when a question was open", () => {
    assert.equal(classifyOnce({ ...none, questionPending: true, systemErrorDetails: ["worker exited unexpectedly (signal SIGTERM)"] }, null, 0), null);
    assert.equal(classifyOnce({ ...none, questionPending: true, interruptedReason: "host-daemon-restarted" }, null, 0), null);
  });
  it("never counts a stop the user asked for", () => {
    assert.equal(classifyOnce({ ...none, interruptedReason: "manual-stop", systemErrorDetails: ["worker exited unexpectedly (signal SIGTERM)"] }, null, 0), null);
  });
  it("gives a 5xx one more try only once Claude Code's own retries ran out", () => {
    const spent = { ...none, providerErrors: [
      { detail: "API Error: 504 upstream timed out", willRetry: false, httpStatusCode: 504 },
      { detail: "retry 10/10: 504", willRetry: true, httpStatusCode: 504 },
      { detail: "retry 9/10: 504", willRetry: true, httpStatusCode: 504 },
    ] };
    assert.equal(classifyOnce(spent, null, 0), "504 after Claude Code's ten retries");
    const fresh = { ...none, providerErrors: [{ detail: "API Error: 504 upstream timed out", willRetry: false, httpStatusCode: 504 }] };
    assert.equal(classifyOnce(fresh, null, 0), null);
  });
  it("reads a 403 as the proxy still loading its logins only inside the start window", () => {
    const proxyStart = Date.parse("2032-01-20T06:45:00Z");
    const denied = { ...none, providerErrors: [{ detail: "API Error: 403 forbidden", willRetry: false, httpStatusCode: 403 }] };
    assert.equal(classifyOnce(denied, proxyStart, Date.parse("2032-01-20T07:00:00Z")), "403 soon after a proxy restart");
    assert.equal(classifyOnce(denied, proxyStart, proxyStart + 3 * 3600_000), null);
    assert.equal(classifyOnce(denied, proxyStart, proxyStart - 15 * 60_000), null);
    assert.equal(classifyOnce(denied, null, proxyStart), null);
  });
  it("leaves a plain bad request alone", () => {
    assert.equal(classifyOnce({ ...none, providerErrors: [{ detail: "API Error: 400 invalid request", willRetry: false, httpStatusCode: 400 }] }, null, 0), null);
  });
});

describe("decide: once", () => {
  const t0 = Date.parse("2032-01-22T17:30:00Z");
  it("schedules one retry after the short delay, then leaves a repeat within the hour to the user", () => {
    const first = decide({ threadId: "t9", requestId: "r", kind: "once", reset: null, why: "provider exited (SIGTERM)" }, undefined, [], t0);
    assert.equal(first.kind, "schedule");
    if (first.kind !== "schedule") return;
    assert.equal(first.record.sendAt, t0 + ONCE_DELAY_MS);
    assert.match(first.record.note, /provider exited \(SIGTERM\)/);
    assert.equal(decide({ threadId: "t9", requestId: "r2", kind: "once", reset: null }, first.record, [], t0 + 25 * 60_000).kind, "skip");
  });
});

describe("classifyOnce: a final 529 overload", () => {
  const none = { providerErrors: [], systemErrorDetails: [], interruptedReason: null, questionPending: false };
  const final529 = {
    detail: "Repeated 529 Overloaded",
    willRetry: false,
    httpStatusCode: 529,
  };
  it("gets one more try", () => {
    assert.equal(classifyOnce({ ...none, providerErrors: [final529] }, null, 0), "529 overloaded");
  });
  it("also with Claude Code's own earlier retries in the same turn", () => {
    const facts = { ...none, providerErrors: [
      final529,
      { detail: "Claude Code API retry 3/10 after 2000ms: HTTP 503 server_error", willRetry: true, httpStatusCode: 503 },
      { detail: "Claude Code API retry 2/10 after 1000ms: HTTP 503 server_error", willRetry: true, httpStatusCode: 503 },
      { detail: "Claude Code API retry 1/10 after 500ms: HTTP 503 server_error", willRetry: true, httpStatusCode: 503 },
    ] };
    assert.equal(classifyOnce(facts, null, 0), "529 overloaded");
  });
  it("is read from the text when the status is missing", () => {
    assert.equal(classifyOnce({ ...none, providerErrors: [{ ...final529, httpStatusCode: null }] }, null, 0), "529 overloaded");
  });
  it("never when a question to the user was open", () => {
    assert.equal(classifyOnce({ ...none, providerErrors: [final529], questionPending: true }, null, 0), null);
  });
  it("never after a manual stop", () => {
    assert.equal(classifyOnce({ ...none, providerErrors: [final529], interruptedReason: "manual-stop" }, null, 0), null);
  });
  it("waits longer than other one-more-try cases, and a second 529 within the hour queues nothing", () => {
    const t0 = Date.parse("2032-01-23T11:15:00Z");
    const first = decide({ threadId: "t1", requestId: "r", kind: "once", reset: null, why: "529 overloaded" }, undefined, [], t0);
    assert.equal(first.kind, "schedule");
    if (first.kind !== "schedule") return;
    assert.equal(first.record.sendAt - t0, OVERLOAD_DELAY_MS);
    assert.ok(OVERLOAD_DELAY_MS > ONCE_DELAY_MS);
    assert.equal(decide({ threadId: "t1", requestId: "r2", kind: "once", reset: null, why: "529 overloaded" }, first.record, [], t0 + 40 * 60_000).kind, "skip");
  });
});

describe("providerChainEnded", () => {
  it("is over at bb's attempt cap, or when provider-retry queued nothing", () => {
    assert.equal(providerChainEnded(5, true), true);
    assert.equal(providerChainEnded(3, false), true);
  });
  it("is still running while provider-retry has a row queued below its cap", () => {
    assert.equal(providerChainEnded(3, true), false);
  });
});

describe("test mode ends by itself", () => {
  const t0 = Date.parse("2031-03-25T03:00:00Z");
  it("is on at t0 and gone 16 minutes later", () => {
    const mode = startTestMode(20, t0);
    assert.notEqual(activeTestMode(mode, t0), null);
    assert.equal(activeTestMode(mode, t0 + 16 * 60_000), null);
  });
  it("outlives a long fake reset by 5 minutes", () => {
    const mode = startTestMode(30 * 60, t0);
    assert.notEqual(activeTestMode(mode, t0 + 34 * 60_000), null);
    assert.equal(activeTestMode(mode, t0 + 36 * 60_000), null);
  });
});

describe("pendingResumeRows", () => {
  const now = Date.parse("2031-03-25T03:00:00Z");
  const row = (threadId: string, sendAt: number, extra: Partial<ResumeRecord> = {}) =>
    ({ threadId, requestId: "r", kind: "quota", windowAt: 0, sendAt, attempts: 0, note: "", createdAt: now, ...extra }) as ResumeRecord;
  it("leaves out a resume cancelled on recovery", () => {
    const rows = pendingResumeRows([row("t1", now + 60_000, { cancelledAt: now }), row("t2", now + 120_000)], now);
    assert.deepEqual(rows.map((r) => r.threadId), ["t2"]);
  });
  it("keeps the ones still waiting, soonest first, and drops long-past ones", () => {
    const rows = pendingResumeRows([row("late", now + 90_000), row("soon", now + 30_000), row("old", now - 10 * 60_000)], now);
    assert.deepEqual(rows.map((r) => r.threadId), ["soon", "late"]);
  });
});

describe("isOurRetry / isOtherRetry", () => {
  const retry = (reason?: unknown) => ({ payload: { kind: "retry", attempt: 2, retryOfTurnRequestId: "r", ...(reason === undefined ? {} : { reason }) } });
  it("ours: a retry whose reason has our prefix", () => {
    const row = retry("proxy-usage: resume after a@example.com 5-hour resets");
    assert.equal(isOurRetry(row), true);
    assert.equal(isOtherRetry(row), false);
  });
  it("theirs: provider-retry's own reason", () => {
    const row = retry("Rate limited");
    assert.equal(isOurRetry(row), false);
    assert.equal(isOtherRetry(row), true);
  });
  it("a retry with no reason is not ours", () => {
    assert.equal(isOurRetry(retry()), false);
    assert.equal(isOtherRetry(retry()), true);
  });
  it("an ordinary queued message is neither", () => {
    const row = { payload: { kind: "inline" } };
    assert.equal(isOurRetry(row), false);
    assert.equal(isOtherRetry(row), false);
    assert.equal(isOurRetry({ payload: null }), false);
  });
});

describe("readTurnEvents: pages of 100 back to the turn's own request", () => {
  type Row = { type: string; data: Record<string, unknown>; seq: number };
  // 180 events: seq 180 newest. The failed turn's request is seq 35, its errors 36-180.
  const all: Row[] = [];
  for (let seq = 1; seq <= 180; seq++) {
    all.push(seq === 35
      ? { type: "client/turn/requested", data: { requestId: "creq_mine" }, seq }
      : { type: "provider/error", data: { detail: `attempt ${seq} failed`, willRetry: true }, seq });
  }
  const pager = (calls: { limit: string; beforeSeq?: string }[]) =>
    async (args: { limit: string; beforeSeq?: string }) => {
      calls.push({ limit: args.limit, beforeSeq: args.beforeSeq });
      if (Number(args.limit) > 100) throw new Error("limit too large");
      const below = args.beforeSeq === undefined ? Infinity : Number(args.beforeSeq);
      return all.filter((r) => r.seq < below).sort((a, b) => b.seq - a.seq).slice(0, Number(args.limit));
    };
  it("asks for at most 100 at a time and follows beforeSeq onto the next page", async () => {
    const calls: { limit: string; beforeSeq?: string }[] = [];
    const rows = await readTurnEvents(pager(calls), "creq_mine");
    assert.equal(EVENT_PAGE_SIZE, 100);
    assert.deepEqual(calls.map((c) => c.limit), ["100", "100"]);
    assert.equal(calls[1].beforeSeq, "81");
    assert.equal(rows?.length, 146, "seq 180 down to the request at seq 35");
    assert.equal(rows?.at(-1)?.data.requestId, "creq_mine");
  });
  it("leaves out a newer turn's events", async () => {
    const rows = await readTurnEvents(async () => [
      { type: "provider/error", data: { detail: "later turn: 401" }, seq: 44 },
      { type: "client/turn/requested", data: { requestId: "creq_later" }, seq: 43 },
      { type: "provider/error", data: { detail: "this turn: upstream timeout" }, seq: 42 },
      { type: "provider/error", data: { detail: "this turn: socket hang up" }, seq: 41 },
      { type: "client/turn/requested", data: { requestId: "creq_mine" }, seq: 40 },
    ], "creq_mine");
    const facts = factsFromRows(rows ?? []);
    assert.deepEqual(facts.providerErrors.map((e) => e.detail), ["this turn: upstream timeout", "this turn: socket hang up"]);
  });
});

describe("resetFor: another enabled account with room means now", () => {
  const now = Date.parse("2033-05-09T13:15:00Z");
  const scopedShut = {
    email: "ash@example.org",
    disabled: false,
    status: "ok",
    windows: [{ label: "Weekly, Opus only", usedPercent: 100, resetsAt: "2033-05-10T09:30:00Z" }],
  };
  const bothShut = {
    email: "elm@example.org",
    disabled: false,
    status: "ok",
    windows: [
      { label: "5-hour", usedPercent: 100, resetsAt: "2033-05-09T17:45:00Z" },
      { label: "Weekly", usedPercent: 100, resetsAt: "2033-05-12T21:00:00Z" },
    ],
  };
  const free = {
    email: "oak@example.org",
    disabled: false,
    status: "ok",
    windows: [{ label: "Weekly", usedPercent: 70, resetsAt: "2033-05-14T08:00:00Z" }],
  };
  const blockedAt = Date.parse("2033-05-10T09:30:00Z");

  it("answers now with the free account, keeping the earliest blocked reset beside it", () => {
    assert.deepEqual(resetFor([bothShut, free, scopedShut], "claude-opus-5-5", now), {
      at: now,
      email: "oak@example.org",
      label: "has room",
      blocked: { at: blockedAt, email: "ash@example.org", label: "Weekly, Opus only" },
    });
  });
  it("waits for the earliest blocked reset when the free account is disabled", () => {
    const reset = resetFor([bothShut, { ...free, disabled: true }, scopedShut], "claude-opus-5-5", now);
    assert.equal(reset?.at, blockedAt);
    assert.equal(reset?.email, "ash@example.org");
  });
  it("does not take figures that are not current as room", () => {
    assert.equal(resetFor([bothShut, { ...free, status: "error" }], "claude-opus-5-5", now)?.at, Date.parse("2033-05-12T21:00:00Z"));
  });
  it("ignores a full window on an account on hold", () => {
    const held = { email: "fir@example.org", disabled: false, status: "on-hold", windows: [{ label: "Weekly", usedPercent: 100, resetsAt: "2033-05-09T14:00:00Z" }] };
    const reset = resetFor([held, scopedShut], "claude-opus-5-5", now);
    assert.equal(reset?.email, "ash@example.org");
    assert.equal(reset?.at, blockedAt);
  });
  it("after one room retry, a further 429 within the hour waits for the blocked reset", () => {
    const pool = [scopedShut, free];
    const first = decide({ threadId: "t7", requestId: "r", kind: "quota", reset: resetFor(pool, "claude-opus-5-5", now)! }, undefined, [], now);
    assert.equal(first.kind, "schedule");
    const previous = first.kind === "schedule" ? first.record : undefined;
    const later = now + 35 * 60_000;
    const second = decide({ threadId: "t7", requestId: "r2", kind: "quota", reset: resetFor(pool, "claude-opus-5-5", later)! }, previous, [], later);
    assert.equal(second.kind, "schedule");
    if (second.kind === "schedule") {
      assert.equal(second.record.windowAt, blockedAt);
      assert.equal(second.record.sendAt, blockedAt + RESUME_MARGIN_MS);
    }
  });
});

describe("releaseParked", () => {
  const now = Date.parse("2033-06-21T10:45:00Z");
  const shut = {
    email: "kite@example.org",
    disabled: false,
    status: "ok",
    windows: [{ label: "5-hour", usedPercent: 100, resetsAt: "2033-06-21T14:30:00Z" }],
  };
  const open = {
    email: "tamarind@example.org",
    disabled: false,
    status: "ok",
    windows: [
      { label: "5-hour", usedPercent: 10, resetsAt: "2033-06-21T12:00:00Z" },
      { label: "Weekly", usedPercent: 45, resetsAt: "2033-06-25T09:15:00Z" },
    ],
  };
  const quota = (threadId: string, sendAt: string): ResumeRecord => ({
    threadId, requestId: "r", kind: "quota", windowAt: Date.parse("2033-06-21T14:30:00Z"),
    sendAt: Date.parse(sendAt), attempts: 0, note: "kite@example.org 5-hour", createdAt: now - 2 * 3600_000,
  });
  const timing = { margin: 120_000, gap: 30_000, backoff: () => 0, once: 0, overload: 0 };

  it("moves parked quota resumes to now plus the margin, a gap apart, in their old order", () => {
    const records: ResumeRecord[] = [
      quota("t2", "2033-06-21T15:00:00Z"),
      { ...quota("t5", "2033-06-21T14:45:00Z"), kind: "once", windowAt: 0, note: "one retry: connection error" },
      quota("t1", "2033-06-21T14:45:00Z"),
      { ...quota("t3", "2033-06-21T14:40:00Z"), cancelledAt: now - 60_000 },
    ];
    const moves = releaseParked(records, [shut, open], now, timing);
    assert.deepEqual(moves.map((m) => m.threadId), ["t1", "t2"]);
    assert.deepEqual(moves.map((m) => m.sendAt - now), [120_000, 150_000]);
    assert.ok(moves.every((m) => m.email === "tamarind@example.org"));
  });
  it("moves nothing without an account with room", () => {
    assert.deepEqual(releaseParked([quota("t1", "2033-06-21T14:45:00Z")], [shut], now), []);
  });
  it("leaves a resume that is already due within the margin", () => {
    const due = { ...quota("t1", "2033-06-21T14:45:00Z"), sendAt: now + RESUME_MARGIN_MS - 30_000 };
    assert.deepEqual(releaseParked([due], [shut, open], now), []);
  });
});

describe("Antigravity windows apply to their own models only", () => {
  const now = Date.parse("2033-08-02T07:30:00Z");
  const claudeShut = {
    provider: "anthropic",
    email: "birch@example.org",
    disabled: false,
    status: "ok",
    windows: [{ label: "5-hour", usedPercent: 100, resetsAt: "2033-08-02T11:15:00Z" }],
  };

  it("picks the Gemini window for a Gemini model and skips the Anthropic account", () => {
    const geminiWeeklyShut = {
      provider: "google-antigravity",
      email: "cedar@example.org",
      disabled: false,
      status: "ok",
      windows: [
        { label: "5-hour, Claude & GPT", usedPercent: 0, resetsAt: null },
        { label: "Weekly, Gemini", usedPercent: 100, resetsAt: "2033-08-05T16:45:00Z" },
        { label: "5-hour, Gemini", usedPercent: 25, resetsAt: "2033-08-02T09:00:00Z" },
      ],
    };
    const reset = resetFor([claudeShut, geminiWeeklyShut], "google-antigravity/gemini-4-argon", now);
    assert.equal(reset?.at, Date.parse("2033-08-05T16:45:00Z"));
    assert.equal(reset?.label, "Weekly, Gemini");
  });

  it("does not let Antigravity room release a turn parked on an Anthropic account", () => {
    const geminiFree = {
      provider: "google-antigravity",
      email: "cedar@example.org",
      disabled: false,
      status: "ok",
      windows: [{ label: "Weekly, Gemini", usedPercent: 50, resetsAt: "2033-08-05T16:45:00Z" }],
    };
    const parked: ResumeRecord[] = [{
      threadId: "t-claude", requestId: "r", kind: "quota", windowAt: Date.parse("2033-08-02T11:15:00Z"),
      sendAt: Date.parse("2033-08-02T11:30:00Z"), attempts: 0, note: "birch@example.org 5-hour", createdAt: now - 2 * 3600_000,
    }];
    assert.deepEqual(releaseParked(parked, [claudeShut, geminiFree], now), []);
  });

  it("keeps a turn parked on the Claude & GPT window while only Gemini has room", () => {
    const claudeGptShut = {
      provider: "google-antigravity",
      email: "cedar@example.org",
      disabled: false,
      status: "ok",
      windows: [
        { label: "Weekly, Claude & GPT", usedPercent: 100, resetsAt: "2033-08-06T22:00:00Z" },
        { label: "Weekly, Gemini", usedPercent: 20, resetsAt: "2033-08-05T16:45:00Z" },
      ],
    };
    const reset = resetFor([claudeGptShut], "google-antigravity/claude-opus-5-5", now)!;
    assert.equal(reset.label, "Weekly, Claude & GPT");
    const decided = decide(
      { threadId: "t-ag", requestId: "r-ag", kind: "quota", reset, provider: "google-antigravity", model: "google-antigravity/claude-opus-5-5" },
      undefined,
      [],
      now,
    );
    assert.equal(decided.kind, "schedule");
    if (decided.kind === "schedule") {
      assert.equal(decided.record.provider, "google-antigravity");
      assert.equal(decided.record.model, "google-antigravity/claude-opus-5-5");
      assert.deepEqual(releaseParked([decided.record], [claudeGptShut], now), []);
    }
  });
});
