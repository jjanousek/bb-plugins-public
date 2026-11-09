// A 429 on an auto-draft ask must not drop the burst: the handled mark is
// rolled back and the chat is rescheduled, because the schedule is a one-shot
// debounce per chat rather than a poll. These drive the decision
// against a simulated rate limit; no WhatsApp session and no model call is
// involved.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  afterAsk,
  decideAutoDraft,
  looksRateLimited,
  MAX_ASK_ATTEMPTS,
  OWN_ACTIVITY_HOLD_MS,
  RATE_LIMIT_COOLDOWN_MS,
  RETRY_MAX_MS,
  verifyAsk,
  standingFailureHolds,
} from "../auto-draft-retry.ts";

/** One chat over a series of ticks, with the ask stubbed. */
function simulate(opts: { askFails: number; ticks: number; tickMs: number }) {
  const state = { mark: 0, cooldownUntil: 0 };
  const chat = { lastMessageAt: 1_000, lastFromMe: false };
  let now = 2_000;
  let asks = 0; // every ask is one model turn
  let drafted = false;
  let failsLeft = opts.askFails;

  for (let i = 0; i < opts.ticks; i += 1) {
    const d = decideAutoDraft({
      lastMessageAt: chat.lastMessageAt,
      mark: state.mark,
      lastFromMe: chat.lastFromMe,
      muted: false,
      dismissed: false,
      hasPendingDraft: drafted,
      cooldownUntil: state.cooldownUntil,
      now,
    });
    if (d.action === "send") {
      state.mark = chat.lastMessageAt;
      asks += 1;
      const outcome =
        failsLeft > 0
          ? ({ ok: false, rateLimited: true, error: "Error: too many requests" } as const)
          : ({ ok: true } as const);
      if (failsLeft > 0) failsLeft -= 1;
      else drafted = true;
      const next = afterAsk(outcome, now);
      if (!next.keepMark) state.mark = 0;
      if (next.cooldownUntil !== null) state.cooldownUntil = next.cooldownUntil;
    }
    now += opts.tickMs;
  }
  return { asks, drafted, state };
}

describe("an auto-draft ask that hits a rate limit", () => {
  it("recognises a provider's rate-limit wording", () => {
    assert.ok(looksRateLimited("Upstream error: too many requests, retry later"));
    assert.ok(looksRateLimited("HTTP 429 rate_limit"));
    assert.ok(!looksRateLimited("draft r-1 was not found"));
  });

  it("leaves the burst unhandled, so the message is not dropped", () => {
    const now = 5_000;
    const next = afterAsk({ ok: false, rateLimited: true, error: "429" }, now);
    assert.equal(next.keepMark, false, "the mark is rolled back");
    assert.equal(next.reschedule, true, "the chat comes back without needing another message");
    assert.equal(next.cooldownUntil, now + RATE_LIMIT_COOLDOWN_MS);
  });

  it("picks the message up on a later tick and drafts it", () => {
    // One 429, then ticks spaced past the cooldown.
    const run = simulate({ askFails: 1, ticks: 4, tickMs: RATE_LIMIT_COOLDOWN_MS });
    assert.equal(run.drafted, true, "the parent's message is answered in the end");
    assert.equal(run.asks, 2, "one failed ask, then one that worked");
  });

  it("spends no model turn during the cooldown", () => {
    // Ticks every minute inside a ten minute cooldown: one ask, then silence.
    const run = simulate({ askFails: 1, ticks: 9, tickMs: 60_000 });
    assert.equal(run.asks, 1, "no second ask is made during the cooldown");
    assert.equal(run.drafted, false);
    assert.equal(run.state.mark, 0, "and the burst is still outstanding, not marked handled");
  });

  it("keeps the mark when the ask worked, so one burst is asked once", () => {
    const run = simulate({ askFails: 0, ticks: 5, tickMs: 60_000 });
    assert.equal(run.asks, 1);
    assert.equal(run.drafted, true);
  });

  it("defers rather than skipping, so a chat in cooldown is not recorded as handled", () => {
    const d = decideAutoDraft({
      lastMessageAt: 1_000, mark: 0, lastFromMe: false, muted: false, dismissed: false,
      hasPendingDraft: false, cooldownUntil: 10_000, now: 2_000,
    });
    assert.equal(d.action, "defer");
    if (d.action !== "defer") return;
    assert.equal(d.untilMs, 8_000);
  });

  it("still skips a chat it would never have asked about, without holding a timer", () => {
    // Muted wins over the cooldown: no point rescheduling something that is
    // never asked, so it is marked handled.
    const d = decideAutoDraft({
      lastMessageAt: 1_000, mark: 0, lastFromMe: false, muted: true, dismissed: false,
      hasPendingDraft: false, cooldownUntil: 10_000, now: 2_000,
    });
    assert.deepEqual(d, { action: "skip", reason: "sender is muted", markHandled: true });
  });
});

// threads.send only enqueues, so a send that returns success can still end in
// a failed turn seconds later. A catch around the send never sees that, so the
// outcome is what has to be checked.
describe("checking whether an ask actually landed", () => {
  const RATE_LIMIT =
    "Upstream error (429): too many requests for this model, retry later";
  const base = { markNow: 1_000, askedFor: 1_000, hasPendingDraft: false, dismissed: false, failure: null };

  it("settles when a draft is waiting", () => {
    const r = verifyAsk({ ...base, hasPendingDraft: true });
    assert.equal(r.settled, true);
  });

  it("settles when the chief decided no reply was needed", () => {
    const r = verifyAsk({ ...base, dismissed: true });
    assert.equal(r.settled, true);
  });

  it("settles when a newer burst has taken the chat over", () => {
    // Rolling back here would clear a mark this ask did not write.
    const r = verifyAsk({ ...base, markNow: 2_000 });
    assert.equal(r.settled, true);
  });

  it("reopens the burst when the turn died on a rate limit", () => {
    const r = verifyAsk({ ...base, failure: RATE_LIMIT });
    assert.equal(r.settled, false);
    if (r.settled) return;
    assert.equal(r.outcome.ok, false);
    if (r.outcome.ok) return;
    assert.equal(r.outcome.rateLimited, true, "the provider's own wording is recognised");
    assert.equal(afterAsk(r.outcome, 0).keepMark, false, "so the message is asked about again");
  });

  it("reopens the burst when nothing happened and nothing failed", () => {
    // No draft, not dismissed, no turn error to name. The parent is still owed
    // a reply, so this is reopened rather than left looking handled.
    const r = verifyAsk(base);
    assert.equal(r.settled, false);
    if (r.settled) return;
    assert.equal(r.outcome.ok, false);
    if (r.outcome.ok) return;
    assert.equal(r.outcome.rateLimited, false, "no cooldown for a failure that was not a rate limit");
    assert.match(r.outcome.error, /produced no draft/);
  });
});

describe("not asking forever, and standing off properly", () => {
  const FAIL = { ok: false, rateLimited: true, error: "too many requests" } as const;

  it("gives up after a fixed number of attempts rather than looping", () => {
    // Without a limit, a chat the chief never drafts for would be re-asked
    // every cycle for as long as it stays unanswered.
    for (let attempts = 0; attempts < MAX_ASK_ATTEMPTS - 1; attempts += 1) {
      const step = afterAsk(FAIL, 0, attempts);
      assert.equal(step.giveUp, false, `attempt ${attempts} still tries`);
      assert.equal(step.reschedule, true);
    }
    const last = afterAsk(FAIL, 0, MAX_ASK_ATTEMPTS - 1);
    assert.equal(last.giveUp, true);
    assert.equal(last.reschedule, false, "it stops asking");
    assert.equal(last.keepMark, true, "and keeps the mark, which is what stops the loop");
  });

  it("backs off between attempts instead of retrying at a fixed rate", () => {
    const first = afterAsk(FAIL, 0, 0).retryInMs;
    const second = afterAsk(FAIL, 0, 1).retryInMs;
    assert.ok(second > first, `${second} is longer than ${first}`);
    assert.ok(afterAsk(FAIL, 0, 20).retryInMs <= RETRY_MAX_MS, "and is capped");
  });

  it("still sets the cooldown on the attempt that gives up", () => {
    // Giving up on one chat must not lift the stand-off for the others.
    const last = afterAsk(FAIL, 1_000, MAX_ASK_ATTEMPTS - 1);
    assert.equal(last.cooldownUntil, 1_000 + RATE_LIMIT_COOLDOWN_MS);
  });

  it("resets nothing on success beyond keeping the mark", () => {
    const ok = afterAsk({ ok: true }, 0, 3);
    assert.deepEqual(ok, { keepMark: true, cooldownUntil: null, reschedule: false, giveUp: false, retryInMs: 0 });
  });
});

describe("a rate-limited last turn holds asks back only for one cooldown", () => {
  // The hold reads the chief's last finished turn. No ask is sent while it
  // holds, so the last turn would never stop being the failed one; the hold
  // therefore ends with the cooldown.
  const failedAt = Date.parse("2031-02-03T01:00:00Z");
  const refusal = { detail: "Upstream error (429): too many requests, retry later", at: failedAt };

  it("holds while the refusal is fresh", () => {
    assert.equal(standingFailureHolds(refusal, failedAt + 60_000), true);
    assert.equal(standingFailureHolds(refusal, failedAt + RATE_LIMIT_COOLDOWN_MS - 1), true);
  });

  it("lets the next ask through once the cooldown has passed, however long the thread stays quiet", () => {
    assert.equal(standingFailureHolds(refusal, failedAt + RATE_LIMIT_COOLDOWN_MS), false);
    // Well past the cooldown on the same day.
    assert.equal(standingFailureHolds(refusal, Date.parse("2031-02-03T07:00:00Z")), false);
  });

  it("never holds for a failure that is not a rate limit, or when there is none", () => {
    assert.equal(standingFailureHolds({ detail: "tool crashed", at: failedAt }, failedAt + 1), false);
    assert.equal(standingFailureHolds(null, failedAt), false);
  });

  it("treats a failure with no time as old", () => {
    assert.equal(standingFailureHolds({ detail: refusal.detail, at: 0 }, failedAt), false);
  });
});

describe("a pending draft and the messages after it", () => {
  // A chat with a pending draft is asked about again when more messages
  // came in after the draft.
  const draftAt = Date.parse("2031-02-03T05:00:00Z");
  const base = { mark: draftAt - 1, lastFromMe: false, muted: false, dismissed: false, hasPendingDraft: true, pendingDraftAt: draftAt, cooldownUntil: 0 };

  it("asks again when a message came in after the draft was written", () => {
    const later = Date.parse("2031-02-03T11:00:00Z");
    assert.deepEqual(decideAutoDraft({ ...base, lastMessageAt: later, mark: draftAt, now: later + 60_000 }), { action: "send" });
  });

  it("leaves the draft alone when it already covers the newest message", () => {
    const d = decideAutoDraft({ ...base, lastMessageAt: draftAt - 5_000, mark: 0, now: draftAt + 60_000 });
    assert.equal(d.action, "skip");
  });

  it("skips when the draft's time is not known", () => {
    const d = decideAutoDraft({ ...base, pendingDraftAt: null, lastMessageAt: draftAt + 5_000, mark: 0, now: draftAt + 60_000 });
    assert.equal(d.action, "skip");
  });
});

describe("a stale draft does not settle a failed ask", () => {
  const askedFor = Date.parse("2031-06-11T09:00:00Z");
  const base = { markNow: askedFor, askedFor, hasPendingDraft: true, dismissed: false };

  it("reopens the burst when the only draft is older than the message asked about", () => {
    const r = verifyAsk({ ...base, pendingDraftAt: askedFor - 3_600_000, failure: "provider said no (429), try later" });
    assert.equal(r.settled, false);
    if (!r.settled) assert.equal(r.outcome.ok, false);
  });

  it("settles when the draft was written for this burst", () => {
    assert.equal(verifyAsk({ ...base, pendingDraftAt: askedFor + 60_000, failure: null }).settled, true);
  });
});

describe("no ask while the owner is in the chat", () => {
  const now = Date.parse("2031-06-11T12:30:00Z");
  const base = { lastMessageAt: now - 60_000, mark: 0, lastFromMe: false, muted: false, dismissed: false, hasPendingDraft: false, cooldownUntil: 0, now };

  it("holds the ask while his own message is fresh, then lets it go", () => {
    const d = decideAutoDraft({ ...base, lastOwnAt: now - 5 * 60_000 });
    assert.equal(d.action, "defer");
    if (d.action === "defer") assert.equal(d.untilMs, OWN_ACTIVITY_HOLD_MS - 5 * 60_000);
    assert.deepEqual(decideAutoDraft({ ...base, lastOwnAt: now - OWN_ACTIVITY_HOLD_MS }), { action: "send" });
  });

  it("asks at once when he has not written in the chat", () => {
    assert.deepEqual(decideAutoDraft({ ...base, lastOwnAt: null }), { action: "send" });
  });

  it("does not mark the burst handled while holding", () => {
    const d = decideAutoDraft({ ...base, lastOwnAt: now - 60_000 });
    assert.notEqual(d.action, "skip");
  });
});
