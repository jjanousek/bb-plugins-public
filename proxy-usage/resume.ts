// Auto-resume of turns that failed on a usage-limit 429, or on a lost login
// (503 auth_unavailable, 400 unknown provider). Pure decisions only; server.ts
// owns the events, storage and the bb.sdk.threads.retry call.

/** Wait after a window reopens before the first resume, so the proxy's own cooldown has cleared too. */
export const RESUME_MARGIN_MS = 60_000;
/** Spacing between resumes that share a reset, so a reopened window is not hit by every thread at once. */
export const STAGGER_MS = 45_000;
/** 503 auth_unavailable: retries per thread before giving up and raising the alert. */
export const AUTH_RETRY_CAP = 3;
/** Backoff for those retries: 2, 4, 8 minutes. */
export function authBackoffMs(attempt: number): number {
  return 2 * 60_000 * 2 ** Math.max(0, attempt - 1);
}
/** One-more-try failures: how long to wait, and how long one try covers a thread. */
export const ONCE_DELAY_MS = 5 * 60_000;
/**
 * A 529 means Anthropic is overloaded. It clears in minutes, not seconds, so
 * the one try waits longer than the others: bb's own retries, about a minute
 * apart, can all fail inside one overload.
 */
export const OVERLOAD_DELAY_MS = 15 * 60_000;
/** bb's provider-retry stops after this many attempts (decideRetry: attemptNumber >= 5). */
export const PROVIDER_RETRY_MAX_ATTEMPTS = 5;

/**
 * Whether bb's own retry chain for a turn is over: it gave up at its cap, or it
 * has nothing queued. Only then may this plugin add its one try, or the two
 * would retry the same overload side by side.
 */
export function providerChainEnded(attemptNumber: number, providerRetryQueued: boolean): boolean {
  return attemptNumber >= PROVIDER_RETRY_MAX_ATTEMPTS || !providerRetryQueued;
}
export const ONCE_WINDOW_MS = 60 * 60_000;
/** An auth alert with no fresh 503 for this long is over. */
export const AUTH_ALERT_TTL_MS = 30 * 60_000;

export type FailureKind = "quota" | "auth" | "other";

/**
 * What the failure was, from the event's classification and the provider's own
 * message. A pool with every credential cooling down arrives as a bare
 * rate-limit 429. A lost login arrives as a generic 503 that only its message
 * tells apart from any other server error, so the message is read.
 *
 * A 400 "unknown provider for model" means no login is loaded at all. It is
 * the same outage as the 503 and is retried the same way. Only that text
 * counts: any other 400 is a bad request and retrying it cannot help.
 */
export function classifyCompletedTurnError(
  text: string | null,
): { kind: "quota" | "auth" | "once"; why?: string } | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (
    /^Cloud Code Assist API error \(429\)/iu.test(trimmed) ||
    /^API Error:\s*429\b/iu.test(trimmed) ||
    (trimmed.startsWith("{") && /\bRESOURCE_EXHAUSTED\b/u.test(trimmed)) ||
    /^(?:Error:\s*)?All credentials for model\s+\S+\s+are cooling down\b/iu.test(trimmed)
  ) {
    return { kind: "quota" };
  }
  if (
    /^API Error:\s*503\b[\s\S]*\bauth_unavailable\b/iu.test(trimmed) ||
    /^API Error:\s*400\b[\s\S]*\bunknown provider for model\b/iu.test(trimmed) ||
    /^(?:Error:\s*)?No API key found for\s+/iu.test(trimmed)
  ) {
    return { kind: "auth" };
  }
  if (trimmed === "Connection error.") {
    return { kind: "once", why: "connection error" };
  }
  if (/^(?:API Error:\s*529\b|Cloud Code Assist API error \(529\))/iu.test(trimmed)) {
    return { kind: "once", why: "529 overloaded" };
  }
  if (/^(?:API Error:\s*5\d\d\b|Cloud Code Assist API error \(5\d\d\))/iu.test(trimmed)) {
    return { kind: "once", why: "provider 5xx error" };
  }
  return null;
}

export function classifyFailure(
  errorInfo: { category: string; httpStatusCode: number | null } | null,
  detail: string | null,
): FailureKind {
  if (errorInfo?.category === "rate-limit" && errorInfo.httpStatusCode === 429) return "quota";
  if (errorInfo?.httpStatusCode === 503 && detail !== null && /auth_unavailable/u.test(detail)) return "auth";
  if (errorInfo?.httpStatusCode === 400 && detail !== null && detail.includes("unknown provider for model")) return "auth";
  if (errorInfo !== null) {
    const raw = classifyCompletedTurnError(detail);
    if (raw?.kind === "quota" || raw?.kind === "auth") return raw.kind;
  }
  return "other";
}

export function inferCredentialProvider(
  threadProviderId: string | null | undefined,
  model: string | null | undefined,
): string | null {
  const m = model?.toLowerCase() ?? "";
  if (m.startsWith("google-antigravity/") || m.includes("gemini") || threadProviderId === "acp-antigravity") {
    return "google-antigravity";
  }
  if (m.startsWith("anthropic/") || m.startsWith("claude-") || threadProviderId === "claude-code") {
    return "anthropic";
  }
  return null;
}

/** What one failed turn left in its own events, newest first. */
export interface FailureFacts {
  /** Provider errors of the failed turn: its final one first, then Claude Code's own retries. */
  providerErrors: readonly { detail: string | null; willRetry: boolean; httpStatusCode: number | null }[];
  systemErrorDetails: readonly string[];
  /** From system/thread/interrupted, e.g. "host-daemon-restarted" or "manual-stop". */
  interruptedReason: string | null;
  /** A question to the user was open when the turn ended. */
  questionPending: boolean;
}

/** A 403 this soon after the proxy (re)started means it is still loading its logins. */
export const PROXY_START_WINDOW_MS = 30 * 60_000;

/**
 * Failures worth exactly one more try, after a few minutes, and why; null for
 * anything else. Each is a passing condition that a later try can get past:
 * - a 403 inside PROXY_START_WINDOW_MS of a proxy start, while logins load;
 * - a 5xx that ended a turn after Claude Code's own ten retries;
 * - a final 529 overload, after a longer wait;
 * - the provider exiting on SIGTERM, or the host daemon restarting, but only
 *   when no question to the user was open: that turn was waiting on the user, and a
 *   retry would answer for them. A manual stop never counts.
 */
export function classifyOnce(facts: FailureFacts, proxyStartedAt: number | null, failedAt: number): string | null {
  if (facts.interruptedReason === "manual-stop") return null;
  const newest = facts.providerErrors[0];
  if (newest && newest.httpStatusCode === 403) {
    if (proxyStartedAt !== null && failedAt >= proxyStartedAt && failedAt - proxyStartedAt <= PROXY_START_WINDOW_MS) {
      return "403 soon after a proxy restart";
    }
    return null;
  }
  if (newest && !newest.willRetry && (newest.httpStatusCode === 529 || /Repeated 529 Overloaded/u.test(newest.detail ?? ""))) {
    if (facts.questionPending) return null;
    return "529 overloaded";
  }
  if (newest && !newest.willRetry && (newest.httpStatusCode ?? 0) >= 500) {
    const exhausted = facts.providerErrors.slice(1).some((error) => /retry 10\/10\b/u.test(error.detail ?? ""));
    return exhausted ? `${newest.httpStatusCode} after Claude Code's ten retries` : null;
  }
  if (facts.questionPending) return null;
  if (facts.interruptedReason === "host-daemon-restarted") return "host daemon restarted";
  const sigterm = [...facts.systemErrorDetails, ...facts.providerErrors.map((error) => error.detail ?? "")].some((text) =>
    /exited unexpectedly \(signal SIGTERM\)/u.test(text),
  );
  return sigterm ? "provider exited (SIGTERM)" : null;
}

/** The model named in a provider error message ("model=claude-x-1"), or null. */
export function modelFromDetail(detail: string | null): string | null {
  const match =
    detail?.match(/\bmodel[=: ]+((?:[a-z0-9-]+\/)?(?:claude|gemini|gpt)-[a-z0-9.-]+)/iu) ??
    detail?.match(/\b((?:google-antigravity|anthropic)\/(?:claude|gemini|gpt)-[a-z0-9.-]+)/iu);
  return match ? match[1].toLowerCase() : null;
}

export interface WindowFigure {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}
export interface AccountFigures {
  email: string;
  disabled: boolean;
  windows: readonly WindowFigure[];
  /** "ok" when the figures are from the latest check; anything else is not trusted to show room. */
  status?: string;
  provider?: string;
}

/**
 * An enabled account whose current figures show room for this model: no
 * applicable window at 100% that has not reset yet. Figures that are not
 * current never count as room, so stale numbers cannot release a turn early.
 */
function windowAppliesToModel(label: string, model: string | null, family: string | null): boolean {
  const lower = label.toLowerCase();
  if (lower.endsWith(", gemini")) {
    return model === null || model.includes("gemini");
  }
  if (lower.endsWith(", claude & gpt")) {
    return model === null || model.includes("claude") || model.includes("gpt");
  }
  const scoped = label.includes(" only");
  if (scoped) {
    return family !== null && lower.includes(family);
  }
  return true;
}

function accountAppliesToModel(account: AccountFigures, model: string | null): boolean {
  if (!model || !account.provider) return true;
  const isAntigravityModel = model.startsWith("google-antigravity/") || model.includes("gemini");
  if (account.provider === "google-antigravity") return isAntigravityModel;
  if (account.provider === "anthropic") return !isAntigravityModel;
  return true;
}

export function hasRoom(account: AccountFigures, family: string | null, now: number, model: string | null = null): boolean {
  if (account.disabled || account.status !== "ok" || account.windows.length === 0) return false;
  if (!accountAppliesToModel(account, model)) return false;
  return !account.windows.some((window) => {
    if (window.usedPercent < 100) return false;
    const at = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    if (!Number.isNaN(at) && at <= now) return false;
    return windowAppliesToModel(window.label, model, family);
  });
}

/**
 * When the limit that stopped this model lifts, for the accounts the proxy is
 * using. Per account, the latest blocked window that applies (the shared ones
 * always, a model-scoped one only for its model), because opening the 5-hour
 * window while the weekly one is still shut just fails again. Across accounts,
 * the earliest, because the proxy sends to whichever has room.
 *
 * When another enabled account has room, the turn can be served now: the
 * proxy sends to whichever enabled account is free, so a parked turn does not
 * wait for one account's reset while another enabled account has room. That
 * answer is "now" (the account with room, label "has room"); decide() then
 * adds the usual margin.
 *
 * Null when no applicable window is blocked: the figures do not explain the
 * 429, and a guessed reset is worse than none. A window whose reset is already
 * past counts as open whatever its percentage says: the figure is from before
 * the reset, so it cannot be what blocked this request.
 */
/** When a parked turn may go, and why. A "has room" answer keeps the real blocked reset beside it. */
export interface ResetTarget {
  at: number;
  email: string;
  label: string;
  blocked?: { at: number; email: string; label: string };
}

export function resetFor(
  accounts: readonly AccountFigures[],
  model: string | null,
  now: number,
): ResetTarget | null {
  const family = model?.match(/(?:^|\/)claude-([a-z]+)/u)?.[1]?.toLowerCase() ?? null;
  const roomy = accounts.find((account) => hasRoom(account, family, now, model));
  let best: { at: number; email: string; label: string } | null = null;
  for (const account of accounts) {
    if (account.disabled || account.status === "on-hold") continue;
    if (!accountAppliesToModel(account, model)) continue;
    let latest: { at: number; label: string } | null = null;
    for (const window of account.windows) {
      if (window.usedPercent < 100 || !window.resetsAt) continue;
      const at = Date.parse(window.resetsAt);
      if (Number.isNaN(at) || at <= now) continue;
      if (!windowAppliesToModel(window.label, model, family)) continue;
      if (latest === null || at > latest.at) latest = { at, label: window.label };
    }
    if (latest && (best === null || latest.at < best.at)) best = { ...latest, email: account.email };
  }
  // Only when something is actually blocked: with nothing blocked the 429 is
  // not explained by the figures, and the answer stays null.
  if (best !== null && roomy) return { at: now, email: roomy.email, label: "has room", blocked: best };
  return best;
}

/**
 * Two reset times for the same window. The usage endpoint stamps each reset
 * with the moment it answered, so the same window can differ by a fraction of
 * a second between polls. Comparing to the millisecond would make every poll
 * look like a new window and let a thread resume twice in one.
 */
export const SAME_WINDOW_MS = 5 * 60_000;
export function sameWindow(a: number, b: number): boolean {
  return Math.abs(a - b) < SAME_WINDOW_MS;
}

/** One thread's resume, kept in plugin storage so it survives a reload. */
export interface ResumeRecord {
  threadId: string;
  requestId: string;
  kind: "quota" | "auth" | "once";
  /** Quota: the reset it waits for (ms). Auth and once: 0. The once-per-window key. */
  windowAt: number;
  sendAt: number;
  /** Auth retries used so far for this thread. */
  attempts: number;
  /** What it waits on, for the popup and the CLI. */
  note: string;
  /** Made under `resume-test`; removed again when test mode is switched off. */
  test?: boolean;
  /**
   * Whether the provider took the failed turn's input. True means the retry
   * only says "Please continue." and can be dropped once the thread has moved
   * on; false means the retry carries the input itself and must not be lost.
   * Absent means unknown, and the record is kept.
   */
  inputAccepted?: boolean;
  /** When its queued resume was cancelled because the thread recovered by itself. */
  cancelledAt?: number;
  provider?: string;
  model?: string;
  completedError?: boolean;
  createdAt: number;
}

export type Decision =
  | { kind: "schedule"; record: ResumeRecord }
  | { kind: "skip"; reason: string }
  | { kind: "alert"; reason: string };

/**
 * The next free slot at or after `earliest`, at least STAGGER_MS from every
 * resume already scheduled. Taking the last one plus the gap would be simpler
 * and wrong: an earlier slot freed by a cancellation would never be reused, and
 * a large burst would drift further out than it needs to.
 */
export function staggeredSlot(earliest: number, taken: readonly number[], gap: number = STAGGER_MS): number {
  const sorted = [...taken].sort((a, b) => a - b);
  let slot = earliest;
  for (const at of sorted) {
    if (at + gap <= slot) continue;
    if (at - gap >= slot) break;
    slot = at + gap;
  }
  return slot;
}

export interface FailureInput {
  threadId: string;
  requestId: string;
  kind: "quota" | "auth" | "once";
  /** Once only: what the failure was, from classifyOnce. */
  why?: string;
  /** Quota only: when the blocking window lifts, from resetFor. */
  reset: ResetTarget | null;
  provider?: string | null;
  model?: string | null;
}

/** Timings, overridable so a manual test run does not wait real minutes. */
export interface Timing {
  margin: number;
  gap: number;
  backoff: (attempt: number) => number;
  once: number;
  overload: number;
}
export const DEFAULT_TIMING: Timing = {
  margin: RESUME_MARGIN_MS,
  gap: STAGGER_MS,
  backoff: authBackoffMs,
  once: ONCE_DELAY_MS,
  overload: OVERLOAD_DELAY_MS,
};

/**
 * Whether and when to resume one failed turn.
 *
 * `previous` is this thread's last record, if any: the once-per-window rule and
 * the auth cap are both read from it. `taken` is every sendAt already
 * scheduled, across all threads, for the stagger.
 */
export function decide(
  failure: FailureInput,
  previous: ResumeRecord | undefined,
  taken: readonly number[],
  now: number,
  timing: Timing = DEFAULT_TIMING,
): Decision {
  if (failure.kind === "quota") {
    if (!failure.reset) {
      return { kind: "skip", reason: "no in-use account shows a blocked window, so there is no reset time to wait for" };
    }
    if (previous?.kind === "quota" && sameWindow(previous.windowAt, failure.reset.at)) {
      return { kind: "skip", reason: "already resumed once in this window" };
    }
    // A "has room" resume is keyed to the moment it was made, so a second 429
    // a few minutes later would look like a new window and loop. One room try
    // per hour; after that the thread waits for the real reset like any other.
    if (failure.reset.label === "has room" && previous?.kind === "quota" && previous.note.endsWith(" has room") && now - previous.createdAt < ONCE_WINDOW_MS) {
      if (!failure.reset.blocked) return { kind: "skip", reason: "already retried on an account with room this hour" };
      return decide({ ...failure, reset: failure.reset.blocked }, previous, taken, now, timing);
    }
    const earliest = Math.max(failure.reset.at, now) + timing.margin;
    const sendAt = staggeredSlot(earliest, taken, timing.gap);
    return {
      kind: "schedule",
      record: {
        threadId: failure.threadId,
        requestId: failure.requestId,
        kind: "quota",
        windowAt: failure.reset.at,
        sendAt,
        attempts: 0,
        note: `${failure.reset.email} ${failure.reset.label}`,
        ...(failure.provider ? { provider: failure.provider } : {}),
        ...(failure.model ? { model: failure.model } : {}),
        createdAt: now,
      },
    };
  }
  if (failure.kind === "once") {
    if (previous?.kind === "once" && now - previous.createdAt < ONCE_WINDOW_MS) {
      return { kind: "skip", reason: "already retried once; a second failure like this is left to the user" };
    }
    return {
      kind: "schedule",
      record: {
        threadId: failure.threadId,
        requestId: failure.requestId,
        kind: "once",
        windowAt: 0,
        sendAt: staggeredSlot(now + (failure.why === "529 overloaded" ? timing.overload : timing.once), taken, timing.gap),
        attempts: 1,
        note: `one retry: ${failure.why ?? "transient failure"}`,
        ...(failure.provider ? { provider: failure.provider } : {}),
        ...(failure.model ? { model: failure.model } : {}),
        createdAt: now,
      },
    };
  }
  // Attempts count within one outage. A record older than the alert's life is
  // from an earlier outage, so a thread that hit the cap then starts again at
  // 1 instead of alerting on its first 503 of a new outage.
  const sameOutage = previous?.kind === "auth" && now - previous.createdAt < AUTH_ALERT_TTL_MS;
  const used = sameOutage ? previous.attempts : 0;
  if (used >= AUTH_RETRY_CAP) {
    return { kind: "alert", reason: `proxy has no usable login; gave up after ${AUTH_RETRY_CAP} retries` };
  }
  const attempt = used + 1;
  const sendAt = staggeredSlot(now + timing.backoff(attempt), taken, timing.gap);
  return {
    kind: "schedule",
    record: {
      threadId: failure.threadId,
      requestId: failure.requestId,
      kind: "auth",
      windowAt: 0,
      sendAt,
      attempts: attempt,
      note: `proxy login lost, retry ${attempt} of ${AUTH_RETRY_CAP}`,
      createdAt: now,
    },
  };
}

/**
 * What to do when a thread goes idle, which only happens after a turn
 * completes: the thread has recovered by itself. A resume still queued for it
 * would land a stale "Please continue." on a thread that is fine. Drop it,
 * unless the failed turn's input was never
 * accepted, in which case the retry is the only copy of that input.
 *
 * The quota record is kept, because it is what stops a second resume in the
 * same window. An auth record is cleared, and so is the alert: a completed
 * turn means the proxy has a login again.
 */
export function onRecovery(
  record: ResumeRecord | undefined,
  ourRowIds: readonly string[],
): { cancel: string[]; keptBecauseUnaccepted: boolean; dropRecord: boolean; clearAlert: boolean } {
  if (!record) return { cancel: [], keptBecauseUnaccepted: false, dropRecord: false, clearAlert: false };
  const safeToCancel = record.inputAccepted === true;
  return {
    cancel: safeToCancel ? [...ourRowIds] : [],
    keptBecauseUnaccepted: !safeToCancel && ourRowIds.length > 0,
    dropRecord: record.kind === "auth",
    clearAlert: record.kind === "auth",
  };
}

/** After a start, how long our overdue resumes wait for the proxy to load its logins. */
export const STARTUP_HOLD_MS = 3 * 60_000;

/**
 * When one of our resumes may go out, or null for now. The stagger in decide()
 * spaces the send times, but rows that are already overdue when bb comes back
 * all fall due in the same sweep. Holding them until the proxy has had time to
 * load its logins, and then spacing them by the gap, keeps them from all going
 * out at once into a proxy that cannot serve them yet.
 */
export function dispatchHold(now: number, startedAt: number, lastOwnDispatchAt: number, gap: number, hold: number = STARTUP_HOLD_MS): number | null {
  const earliest = Math.max(startedAt + hold, lastOwnDispatchAt + gap);
  return now < earliest ? earliest : null;
}

/** The alert raised once per outage, not once per thread. */
export interface AuthAlert {
  since: number;
  lastSeen: number;
  message: string;
}

/** Returns the alert to keep, and whether this call is the one that raised it. */
export function raiseAlert(current: AuthAlert | null, message: string, now: number): { alert: AuthAlert; raised: boolean } {
  if (current && now - current.lastSeen < AUTH_ALERT_TTL_MS) {
    return { alert: { ...current, lastSeen: now }, raised: false };
  }
  return { alert: { since: now, lastSeen: now, message }, raised: true };
}

export function alertActive(alert: AuthAlert | null, now: number): boolean {
  return alert !== null && now - alert.lastSeen < AUTH_ALERT_TTL_MS;
}

/** Test mode: shortened timings and a fake reset, switched on by `resume-test`. */
export interface TestMode {
  timing: Timing;
  reset: { at: number; email: string; label: string };
  until: number;
}

/** The fewest minutes test mode lasts, and how long it outlives its fake reset. */
export const TEST_MODE_MIN_MS = 15 * 60_000;
export const TEST_MODE_TAIL_MS = 5 * 60_000;

/**
 * Turn test mode on. It applies to every real thread while it lasts, so it
 * must end by itself: a test left on would make every real failure resume
 * seconds later instead of after its window. It ends at the later of 15
 * minutes or the fake reset plus 5 minutes.
 */
export function startTestMode(resetSeconds: number, now: number): TestMode {
  const resetAt = now + resetSeconds * 1000;
  return {
    timing: { margin: 2_000, gap: 5_000, backoff: () => 5_000, once: 5_000, overload: 5_000 },
    reset: { at: resetAt, email: "test", label: "fake window" },
    until: now + Math.max(TEST_MODE_MIN_MS, resetSeconds * 1000 + TEST_MODE_TAIL_MS),
  };
}

/** Test mode as it applies now: null once it has run out. */
export function activeTestMode(mode: TestMode | null, now: number): TestMode | null {
  return mode !== null && now < mode.until ? mode : null;
}

/**
 * The resumes still waiting to go out, soonest first: not cancelled, and not
 * more than 5 minutes past their send time. Used by the popup, the CLI and the
 * stagger, so a resume cancelled on recovery neither shows as pending nor holds
 * a slot another thread could use.
 */
export function pendingResumeRows(records: readonly ResumeRecord[], now: number): ResumeRecord[] {
  return records
    .filter((record) => record.cancelledAt === undefined && record.sendAt > now - 5 * 60_000)
    .sort((a, b) => a.sendAt - b.sendAt);
}

/** Starts the reason on every retry row this plugin queues, so its own rows can be recognised. */
export const RETRY_REASON_PREFIX = "proxy-usage: ";

/** A queued row as far as telling retries apart needs. */
export interface QueuedRowLike {
  payload: unknown;
  originPluginId?: string | null;
}

function retryReason(row: QueuedRowLike): string | null {
  const payload = row.payload as { kind?: string; reason?: unknown } | null;
  if (payload?.kind !== "retry") return null;
  return typeof payload.reason === "string" ? payload.reason : "";
}

/** A retry row this plugin queued. */
export function isOurRetry(row: QueuedRowLike): boolean {
  if (row.originPluginId === "proxy-usage") return true;
  return retryReason(row)?.startsWith(RETRY_REASON_PREFIX) === true;
}

/** A retry row someone else queued, in practice bb's own provider-retry. */
export function isOtherRetry(row: QueuedRowLike): boolean {
  const reason = retryReason(row);
  return reason !== null && !reason.startsWith(RETRY_REASON_PREFIX);
}

/** One stored thread event, as far as reading a failed turn needs. */
export interface EventRowLike {
  type: string;
  data: Record<string, unknown>;
  seq: number;
}

/** The API's cap on one page of thread events ("Thread event limit cannot exceed 100"). */
export const EVENT_PAGE_SIZE = 100;
/** Pages read before giving up; a turn with Claude Code's ten retries fits in one. */
export const EVENT_PAGES_MAX = 3;
const FAILURE_EVENT_TYPES = [
  "client/turn/requested",
  "provider/error",
  "system/error",
  "system/thread/interrupted",
  "system/interaction/lifecycle",
] as const;

/**
 * A failed turn's events, newest first, back to and including its own
 * client/turn/requested row, read in pages of at most 100, the most the API
 * accepts in one page. Null when the turn's request is not found within
 * EVENT_PAGES_MAX pages.
 */
export async function readTurnEvents(
  list: (args: { types: readonly string[]; order: "desc"; limit: string; beforeSeq?: string }) => Promise<EventRowLike[]>,
  requestId: string,
): Promise<EventRowLike[] | null> {
  const rows: EventRowLike[] = [];
  let beforeSeq: string | undefined;
  for (let page = 0; page < EVENT_PAGES_MAX; page++) {
    const batch = await list({
      types: FAILURE_EVENT_TYPES,
      order: "desc",
      limit: String(EVENT_PAGE_SIZE),
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    });
    for (const row of batch) {
      if (row.type === "client/turn/requested" && row.data.requestId !== requestId) {
        // A newer turn started after ours failed (our handler runs behind a
        // queue); what was read so far is that turn's, not ours.
        rows.length = 0;
        continue;
      }
      rows.push(row);
      if (row.type === "client/turn/requested") return rows;
    }
    if (batch.length < EVENT_PAGE_SIZE) return null;
    beforeSeq = String(batch[batch.length - 1].seq);
  }
  return null;
}

/** What the failed turn left behind, from its own events (see readTurnEvents). */
export function factsFromRows(rows: readonly EventRowLike[]): FailureFacts {
  const providerErrors: FailureFacts["providerErrors"][number][] = [];
  const systemErrorDetails: string[] = [];
  let interruptedReason: string | null = null;
  let questionPending = false;
  const seenInteraction = new Set<string>();
  for (const row of rows) {
    const data = row.data;
    if (row.type === "provider/error") {
      const info = data.errorInfo as { httpStatusCode?: number | null } | undefined;
      providerErrors.push({
        detail: typeof data.detail === "string" ? data.detail : null,
        willRetry: data.willRetry === true,
        httpStatusCode: info?.httpStatusCode ?? null,
      });
    } else if (row.type === "system/error") {
      if (typeof data.detail === "string") systemErrorDetails.push(data.detail);
      if (typeof data.message === "string") systemErrorDetails.push(data.message);
    } else if (row.type === "system/thread/interrupted") {
      if (interruptedReason === null && typeof data.reason === "string") interruptedReason = data.reason;
    } else if (row.type === "system/interaction/lifecycle") {
      // Newest first: the first row per interaction is its latest state. A
      // question interrupted by the failure was open when the turn ended.
      const interaction = data.interaction as { id?: string; status?: string } | undefined;
      if (!interaction?.id || seenInteraction.has(interaction.id)) continue;
      seenInteraction.add(interaction.id);
      if (interaction.status === "pending" || interaction.status === "interrupted") questionPending = true;
    }
  }
  return { providerErrors, systemErrorDetails, interruptedReason, questionPending };
}

/**
 * Parked resumes that can go out now because an enabled account has room,
 * with their new send times: the margin from now, then the stagger gap apart, in their
 * old order. Resumes already due within the margin are left alone, and so is
 * any non-quota resume. This releases turns parked for an exhausted account
 * once another account has room.
 */
export function releaseParked(
  records: readonly ResumeRecord[],
  accounts: readonly AccountFigures[],
  now: number,
  timing: Timing = DEFAULT_TIMING,
): { threadId: string; sendAt: number; email: string }[] {
  const parked = records
    .filter((record) => record.kind === "quota" && record.cancelledAt === undefined && record.sendAt > now + timing.margin)
    .sort((a, b) => a.sendAt - b.sendAt);
  const taken: number[] = [];
  const out: { threadId: string; sendAt: number; email: string }[] = [];
  const hasProviderTags = accounts.some((a) => a.provider !== undefined);
  for (const record of parked) {
    const lowerNote = record.note.toLowerCase();
    const modelHint =
      record.model ??
      (lowerNote.includes(", claude & gpt")
        ? "google-antigravity/claude-opus-5-5"
        : lowerNote.includes(", gemini") || record.provider === "google-antigravity"
          ? "google-antigravity/gemini-4-argon"
          : "claude-opus-5-5");
    const family = modelHint.match(/(?:^|\/)claude-([a-z]+)/u)?.[1]?.toLowerCase() ?? null;
    const roomy = accounts.find((account) => {
      if (record.provider && account.provider && account.provider !== record.provider) return false;
      return hasProviderTags || record.model !== undefined
        ? hasRoom(account, family, now, modelHint)
        : hasRoom(account, family, now);
    });
    if (!roomy) continue;
    const sendAt = staggeredSlot(now + timing.margin, taken, timing.gap);
    taken.push(sendAt);
    out.push({ threadId: record.threadId, sendAt, email: roomy.email });
  }
  return out;
}
