/**
 * Whether to ask the chief for a draft right now, and what to do when that ask
 * fails, kept apart from the handlers so a rate limit can be simulated without
 * a WhatsApp session or a model call.
 *
 * The schedule is a one-shot debounce per chat, not a poll, so if the handled
 * mark were written before the send, a burst whose turn failed (a 429, say)
 * would be recorded as handled and nothing would come back for it: the message
 * would sit unanswered until another message arrived on the same chat or a
 * person looked. A question from a contact must not depend on either.
 *
 * Two rules follow, and the second is the one that matters:
 *
 * 1. While the provider is cooling down, do not send at all. A turn started
 *    into a rate limit burns a model call and fails anyway.
 * 2. The mark is written only once the ask has been made without a rate limit,
 *    and is rolled back if one is seen. An unhandled burst must stay unhandled.
 */

/** How long to stand off after a rate limit before asking again. */
export const RATE_LIMIT_COOLDOWN_MS = 10 * 60_000;

/**
 * How many times one burst is re-asked before it is left for a person.
 *
 * Without a cap, a chat the chief never drafts for is asked again every cycle
 * for as long as it stays unanswered. Giving up keeps the mark
 * so the loop stops, and says so loudly: the chat still reads as unanswered in
 * the panel, because that is computed from the message and not from the mark.
 */
export const MAX_ASK_ATTEMPTS = 4;

/** First retry delay; each further attempt doubles it, up to the cap. */
export const RETRY_BASE_MS = 5 * 60_000;
export const RETRY_MAX_MS = 60 * 60_000;

export interface AutoDraftState {
  /** Newest inbound message in the chat, or null when there is none. */
  lastMessageAt: number | null;
  /** The last message this chat has already been asked about. */
  mark: number;
  lastFromMe: boolean;
  muted: boolean;
  dismissed: boolean;
  hasPendingDraft: boolean;
  /**
   * When the pending draft was last written, or null when there is none. A
   * message newer than this means the draft was written without it.
   */
  pendingDraftAt?: number | null;
  /** Epoch ms until which the provider is cooling down, 0 when it is not. */
  cooldownUntil: number;
  /** When the owner last wrote in this chat himself, or null. */
  lastOwnAt?: number | null;
  now: number;
}

/**
 * Hold an ask while the owner is in the conversation himself. A chat he is
 * answering live does not need the chief, and an ask sent then is rarely
 * used. When the window passes and the message is still unanswered, the ask
 * goes out as before.
 */
export const OWN_ACTIVITY_HOLD_MS = 15 * 60_000;

export type AutoDraftDecision =
  | { action: "send" }
  | { action: "skip"; reason: string; markHandled: boolean }
  | { action: "defer"; untilMs: number; reason: string };

/**
 * What the next tick for one chat should do. `defer` means come back later
 * without touching the model; it is the only outcome that keeps the burst
 * unhandled on purpose.
 */
export function decideAutoDraft(s: AutoDraftState): AutoDraftDecision {
  if (s.lastMessageAt === null) return { action: "skip", reason: "no message", markHandled: false };
  if (s.lastFromMe) return { action: "skip", reason: "he wrote last", markHandled: false };
  if (s.lastMessageAt <= s.mark) return { action: "skip", reason: "already handled up to this message", markHandled: false };
  if (s.muted) return { action: "skip", reason: "sender is muted", markHandled: true };
  if (s.dismissed) return { action: "skip", reason: "dismissed since the last message", markHandled: false };
  // A pending draft covers the messages it was written after, not the ones that
  // came later, so a draft written for an older message does not stay "ready"
  // after newer messages have arrived in that chat.
  // A later message sends the ask again, and the request tells the chief
  // to replace the draft, never to add a second one.
  const draftCoversIt = s.pendingDraftAt == null || s.lastMessageAt <= s.pendingDraftAt;
  if (s.hasPendingDraft && draftCoversIt) return { action: "skip", reason: "a draft is already pending", markHandled: false };
  if (s.lastOwnAt != null && s.now - s.lastOwnAt < OWN_ACTIVITY_HOLD_MS) {
    return { action: "defer", untilMs: s.lastOwnAt + OWN_ACTIVITY_HOLD_MS - s.now, reason: "he is in this chat himself" };
  }
  // Checked last, so a chat that would not have been asked anyway is not
  // rescheduled and does not hold a timer open through the cooldown.
  if (s.now < s.cooldownUntil) {
    return { action: "defer", untilMs: s.cooldownUntil - s.now, reason: "the provider is cooling down" };
  }
  return { action: "send" };
}

/** How an ask ended, as far as this plugin can tell. */
export type AskOutcome = { ok: true } | { ok: false; rateLimited: boolean; error: string };

export interface AfterAsk {
  /** Keep the handled mark. False means roll it back so the burst is asked again. */
  keepMark: boolean;
  /** Epoch ms to cool down until, or null to leave the cooldown alone. */
  cooldownUntil: number | null;
  /** Come back for this chat rather than waiting for another message. */
  reschedule: boolean;
  /** Stop trying and leave it for a person, because it has failed enough times. */
  giveUp: boolean;
  /** How long to wait before the next attempt, when there is one. */
  retryInMs: number;
}

/**
 * What to do once the ask has returned. A rate limit is not the chat's fault,
 * so the burst goes back to unhandled and the whole plugin stands off; any
 * other failure also keeps the burst, because the message is still unanswered
 * either way.
 */
export function afterAsk(outcome: AskOutcome, now: number, attempts = 0): AfterAsk {
  if (outcome.ok) {
    return { keepMark: true, cooldownUntil: null, reschedule: false, giveUp: false, retryInMs: 0 };
  }
  const cooldownUntil = outcome.rateLimited ? now + RATE_LIMIT_COOLDOWN_MS : null;
  // Enough is enough. Keeping the mark is what stops the loop; the burst stays
  // visible as unanswered either way, so this leaves it for a person rather
  // than hiding it.
  if (attempts + 1 >= MAX_ASK_ATTEMPTS) {
    return { keepMark: true, cooldownUntil, reschedule: false, giveUp: true, retryInMs: 0 };
  }
  const backoff = Math.min(RETRY_BASE_MS * 2 ** attempts, RETRY_MAX_MS);
  return { keepMark: false, cooldownUntil, reschedule: true, giveUp: false, retryInMs: backoff };
}

/**
 * Whether the chief's newest failed turn should still hold an ask back.
 *
 * Only while that failure is younger than one cooldown. The check reads the
 * chief's LAST finished turn, and while it holds, no turn is started, so the
 * last turn stays the failed one. Without an age limit that is a loop only a
 * person breaks: one rate-limit reply would hold a chat on every cycle until
 * the plugin was stopped. Once the window has
 * passed, the next ask is itself the probe; if the provider still refuses, that
 * turn fails fresh and the stand-off starts again from it.
 */
export function standingFailureHolds(failure: { detail: string; at: number } | null, now: number): boolean {
  if (failure === null) return false;
  if (!looksRateLimited(failure.detail)) return false;
  return now - failure.at < RATE_LIMIT_COOLDOWN_MS;
}

/** Does this error text mean the provider refused for rate reasons? */
export function looksRateLimited(text: string): boolean {
  return /\b429\b|rate[ _-]?limit|cooling down|too many requests|quota/i.test(text);
}

/**
 * Why the transport cannot be trusted as the signal.
 *
 * `sendToChief` awaits `threads.send`, and that only enqueues the turn. The
 * provider's refusal arrives seconds after the ask has already returned
 * successfully, so a `catch` around it
 * never fires. Rolling back on a thrown send is right but catches nothing here.
 *
 * What is trustworthy is the outcome: some time after asking, either a draft
 * exists for that chat, or the chief decided no reply was needed, or the ask
 * produced nothing and the burst is still owed an answer. That third case is
 * the one to reopen, and it does not require understanding the provider's error
 * at all. The error is read only to decide whether to stand off before retrying.
 */

/** How long to give the chief before an ask that produced nothing counts as failed. */
export const ASK_VERIFY_MS = 15 * 60_000;

export interface VerifyState {
  /** The mark as it stands now. */
  markNow: number;
  /** The mark this ask wrote. */
  askedFor: number;
  hasPendingDraft: boolean;
  /**
   * When the pending draft was last written, or null when unknown. A draft
   * older than the burst this ask was for is the old draft still sitting
   * there, not an answer to the ask.
   */
  pendingDraftAt?: number | null;
  dismissed: boolean;
  /** Error text of the chief's newest failed turn, or null when it did not fail. */
  failure: string | null;
}

export type VerifyResult =
  | { settled: true; reason: string }
  | { settled: false; outcome: AskOutcome };

/**
 * What the check after an ask concludes. Settled means leave it alone: the
 * answer arrived, the chief decided against one, or a newer burst has taken the
 * chat over and owns its own mark.
 */
export function verifyAsk(s: VerifyState): VerifyResult {
  if (s.markNow !== s.askedFor) return { settled: true, reason: "a newer burst owns this chat" };
  // Settled only by a draft written at or after the message this ask was for,
  // so an ask that died on a 429 next to a stale draft is not closed as "a
  // draft is waiting" and is retried.
  const answered = s.hasPendingDraft && (s.pendingDraftAt == null || s.pendingDraftAt >= s.askedFor);
  if (answered) return { settled: true, reason: "a draft is waiting" };
  if (s.dismissed) return { settled: true, reason: "the chief decided no reply was needed" };
  if (s.failure !== null) {
    return { settled: false, outcome: { ok: false, rateLimited: looksRateLimited(s.failure), error: s.failure } };
  }
  // No draft, not dismissed, no failure we can name. The burst is still owed an
  // answer either way, so it is reopened rather than left looking handled.
  return { settled: false, outcome: { ok: false, rateLimited: false, error: "the ask produced no draft" } };
}

/** The three mark operations an empty answer needs, from the real store. */
export interface AttemptStore {
  autoDraftAttempts(jid: string): number;
  setAutoDraftAttempts(jid: string, attempts: number): void;
  rollbackAutoDraftMark(jid: string, expected: number): void;
}

/**
 * An ask that produced nothing, counted. Used by verifyAskLanded in server.ts.
 * The count is not reset on a delivered ask and not deleted with the row on a
 * rollback, or the cap would never fire: it grows across rollbacks and is
 * reset only on a give-up here or when an ask settles.
 */
export function countEmptyAsk(marks: AttemptStore, jid: string, askedFor: number, outcome: AskOutcome, now: number): AfterAsk & { attempt: number } {
  const attempts = marks.autoDraftAttempts(jid);
  const next = afterAsk(outcome, now, attempts);
  if (next.giveUp) {
    marks.setAutoDraftAttempts(jid, 0);
    return { ...next, attempt: attempts + 1 };
  }
  marks.setAutoDraftAttempts(jid, attempts + 1);
  if (!next.keepMark) marks.rollbackAutoDraftMark(jid, askedFor);
  return { ...next, attempt: attempts + 1 };
}
