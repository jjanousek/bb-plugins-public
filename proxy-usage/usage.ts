// Pure account-result logic for proxy-usage. No Plugin SDK imports, so
// node --test can load this file directly. server.ts calls decideAccount()
// after reading the credential file and attempting the usage fetch.
export interface UsageWindowShape {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface AccountBase {
  email: string;
  file: string;
  disabled: boolean;
}

export interface PreviousFigures {
  windows: UsageWindowShape[];
  okAt: string | null;
}

export type AccountStatus = "ok" | "expired" | "error" | "stale" | "on-hold";

export interface AccountResult extends AccountBase {
  status: AccountStatus;
  windows: UsageWindowShape[];
  message: string | null;
  okAt: string | null;
}

/** What the usage fetch produced. Null when no fetch ran (expired token). */
export type FetchOutcome =
  | { kind: "ok"; windows: UsageWindowShape[] }
  | { kind: "unauthorized" }
  | { kind: "http"; status: number }
  | { kind: "shape" }
  | { kind: "transport"; message: string };

/** True when the credential file carries a past expiry timestamp. */
export function isTokenExpired(expired: string | undefined, now: number): boolean {
  if (!expired) return false;
  const at = new Date(expired).getTime();
  return Number.isNaN(at) ? false : at < now;
}

/**
 * Why an account cannot be renewed, or null. Set from omp's agent.db when the
 * credential row's `disabled_cause` is "account_on_hold": Anthropic refuses the
 * account. A re-login does not fix it and re-enabling the account does not
 * refresh it, so it gets its own status instead of "stale".
 */
export type HoldReason = "on-hold";

/**
 * Map one account's fetch inputs to its result.
 *
 * A disabled account is never used, so its token is never refreshed and any
 * failure is staleness, not a live problem:
 * report "stale" and keep the last good figures. Enabled accounts keep the
 * existing "expired" and "error" results. A disabled account whose token
 * still works reports "ok" with fresh figures.
 */
export function decideAccount(
  base: AccountBase,
  previous: PreviousFigures | undefined,
  nowIso: string,
  expiredPast: boolean,
  outcome: FetchOutcome | null,
  hold: HoldReason | null = null,
): AccountResult {
  const fallback = { windows: previous?.windows ?? [], okAt: previous?.okAt ?? null };
  // Only say figures are shown when some are. An account with none (for
  // example right after the plugin starts) must not read "last good figures shown".
  const kept = fallback.windows.length > 0 ? "; last good figures shown" : "";
  if (!expiredPast && outcome?.kind === "ok") {
    return { ...base, status: "ok", windows: outcome.windows, message: null, okAt: nowIso };
  }
  if (hold === "on-hold" && (expiredPast || outcome?.kind === "unauthorized")) {
    return {
      ...base,
      status: "on-hold",
      ...fallback,
      message: `on hold at Anthropic (account_on_hold, claude.ai/restricted); a re-login does not fix it${kept}`,
    };
  }
  if (base.disabled) {
    const deadToken = expiredPast || outcome?.kind === "unauthorized";
    return {
      ...base,
      status: "stale",
      ...fallback,
      message: deadToken
        ? `token went stale while disabled${kept}; refreshes once re-enabled`
        : `fetch failed while disabled (${describeOutcome(outcome)})${kept}`,
    };
  }
  if (expiredPast || outcome?.kind === "unauthorized") {
    return {
      ...base,
      status: "expired",
      ...fallback,
      message: expiredPast
        ? "access token expired; it is refreshed on its next use"
        : "token rejected (401); it is refreshed on its next use",
    };
  }
  if (outcome?.kind === "http") {
    return { ...base, status: "error", ...fallback, message: `usage endpoint returned ${outcome.status}` };
  }
  if (outcome?.kind === "shape") {
    return { ...base, status: "error", ...fallback, message: "usage endpoint returned an unexpected shape" };
  }
  return { ...base, status: "error", ...fallback, message: outcome?.kind === "transport" ? outcome.message : "usage fetch did not run" };
}

function describeOutcome(outcome: FetchOutcome | null): string {
  switch (outcome?.kind) {
    case "http":
      return `HTTP ${outcome.status}`;
    case "shape":
      return "unexpected shape";
    case "transport":
      return outcome.message;
    case "unauthorized":
      return "401";
    default:
      return "no fetch ran";
  }
}

/** One account that could not be taken out of use, and why. */
export interface DisableFailure {
  file: string;
  reason: string;
}

/**
 * Disable every file except the one being kept, and keep going when one fails.
 *
 * Aborting on the first failure leaves the remaining accounts enabled while the
 * caller reports an error, so the proxy quietly serves two accounts at once.
 * Every failure is collected instead, so the caller can name them and show the
 * state that really resulted.
 */
export async function disableOthers(
  files: string[],
  keep: string,
  disable: (file: string) => Promise<void>,
): Promise<DisableFailure[]> {
  const failed: DisableFailure[] = [];
  for (const other of files) {
    if (other === keep) continue;
    try {
      await disable(other);
    } catch (error) {
      failed.push({ file: other, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return failed;
}

/** The line shown when a switch left accounts enabled that should not be. */
export function describeSwitchFailure(
  keptEmail: string,
  failed: DisableFailure[],
  emailOf: (file: string) => string,
): string {
  const detail = failed.map((entry) => `${emailOf(entry.file)} (${entry.reason})`).join("; ");
  const subject = failed.length === 1 ? "this account" : "these accounts";
  return `Switched to ${keptEmail}, but could not take ${subject} out of use: ${detail}`;
}

/**
 * When the figures on screen were actually obtained, or null if any account
 * showing figures cannot say.
 *
 * A state's `fetchedAt` records when the last check ran, not where its numbers
 * came from. A check that fails leaves the previous figures in place and still
 * moves `fetchedAt` to now, so the display claims to be current while showing
 * readings from before the failure. Quote the oldest `okAt` instead: on a
 * capacity display a stale but plausible number is worse than no number.
 */
export function figuresAt(accounts: readonly { windows: readonly unknown[]; okAt: string | null }[]): string | null {
  const shown = accounts.filter((account) => account.windows.length > 0);
  if (shown.length === 0) return null;
  let oldest: string | null = null;
  for (const account of shown) {
    if (account.okAt === null) return null;
    if (oldest === null || account.okAt < oldest) oldest = account.okAt;
  }
  return oldest;
}

/** How old a reading may be before it counts as older than one poll. */
export const POLL_WINDOW_MS = 5 * 60_000;

/** True when every account's figures came from the most recent poll window. */
export function figuresAreCurrent(
  accounts: readonly { status: AccountStatus; okAt?: string | null }[],
  now?: number,
): boolean {
  if (accounts.length === 0) return false;
  return accounts.every((account) => {
    if (account.status !== "ok") return false;
    if (now !== undefined && account.okAt !== undefined) {
      if (account.okAt === null) return false;
      const age = now - new Date(account.okAt).getTime();
      if (Number.isNaN(age) || age > POLL_WINDOW_MS) return false;
    }
    return true;
  });
}

/**
 * Overlay freshly read `disabled` flags onto cached account results.
 *
 * Which account the proxy is using is read from local files and costs nothing,
 * unlike the usage figures, which come from a rate limited endpoint. Refresh
 * the cheap half on every read so the "in use" tag is never stale, and leave
 * the figures to the poll, which carries its own age.
 */
export function applyDisabled<T extends { file: string; disabled: boolean }>(
  accounts: readonly T[],
  flags: ReadonlyMap<string, boolean>,
): T[] {
  return accounts.map((account) => {
    const fresh = flags.get(account.file);
    return fresh === undefined || fresh === account.disabled ? account : { ...account, disabled: fresh };
  });
}

/**
 * The ceiling the poll's retry delay backs off to, after doubling on failure.
 * Lives here rather than in server.ts only so the vouch limit can follow it.
 */
export const RETRY_MAX_MS = 30 * 60_000;

/**
 * How old figures may be before the popup stops presenting them as usable.
 *
 * These two mean different things: one is how often we retry, the other is when
 * we stop believing what we have. It follows the backoff ceiling because that
 * is what makes an age diagnostic rather than arbitrary. Attempts land at 0, 5,
 * 15 and 35 minutes, so figures this old mean two consecutive failures with a
 * third in flight, which no single unlucky attempt can explain. Raise the
 * ceiling and this must rise with it, or the popup starts calling normal
 * backoff a failure.
 */
export const VOUCH_LIMIT_MS = RETRY_MAX_MS;

/** The parts of a usage state that decide what the footer may claim. */
export interface FreshnessState {
  fetchedAt: string | null;
  accounts: readonly { status: AccountStatus; windows: readonly unknown[]; okAt: string | null }[];
}

/** How long ago a timestamp was, in words. */
export function ageText(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "not fetched yet";
  const ms = now - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "at an unknown time";
  if (ms < 90_000) return "just now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

/**
 * False once the figures are too old to be presented as a capacity reading.
 *
 * The popup keeps the last good numbers when a check fails, which is useful.
 * What is not useful is painting them in the danger scale as if they were live,
 * because that is the whole distance between "you have room" and "you do not".
 */
export function vouchedFor(state: FreshnessState, now: number = Date.now()): boolean {
  if (figuresAreCurrent(state.accounts, now)) return true;
  const at = figuresAt(state.accounts);
  if (at === null) return false;
  const age = now - new Date(at).getTime();
  return !Number.isNaN(age) && age <= VOUCH_LIMIT_MS;
}

/**
 * What the footer says about the figures on screen.
 *
 * It quotes where the numbers came from, not `fetchedAt`: a failed check still
 * moves `fetchedAt` forward, so quoting it would call old figures current.
 */
export function freshnessText(state: FreshnessState, now: number = Date.now()): string {
  if (figuresAreCurrent(state.accounts, now)) return `Updated ${ageText(state.fetchedAt, now)}`;
  const at = figuresAt(state.accounts);
  // `figuresAt` returns null for two different situations, and they must not be
  // reported the same way: an empty panel, and bars on screen that cannot say
  // when they were read. The second is the one worth a warning.
  if (at === null) {
    const anyShown = state.accounts.some((account) => account.windows.length > 0);
    return anyShown
      ? "Not current: figures from an unknown time"
      : `No figures yet; last check ${ageText(state.fetchedAt, now)}`;
  }
  if (!vouchedFor(state, now)) return `Not current: figures ${ageText(at, now)}`;
  return `Figures ${ageText(at, now)}; last check ${ageText(state.fetchedAt, now)}`;
}

/**
 * Wait, or stop early when the signal aborts. A signal that is ALREADY aborted
 * resolves at once: its abort event has fired and will not fire again, so a
 * listener added now would never run, and an abort that lands during a fetch
 * would otherwise leave the poll sleeping a full cycle after a reload.
 */
export function sleep(ms: number, signal: AbortSignal = new AbortController().signal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    // Same signal every cycle, so the listener has to come off again when the
    // timer wins the race; otherwise one is left behind per poll.
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** A window this full is effectively spent; switching to it buys little. */
export const SWITCH_WARN_PERCENT = 95;

/**
 * Why switching to this account is probably a mistake, for the button label,
 * or null when nothing argues against it, so a nearly spent account does not
 * get the same plain "Switch" as a healthy one. Only a window that is still
 * shut counts: one whose reset has passed is open again, whatever its last
 * figure says.
 */
export function switchWarning(
  account: { windows: readonly { label: string; usedPercent: number; resetsAt: string | null }[] },
  now: number,
): string | null {
  let worst: { label: string; usedPercent: number } | null = null;
  for (const window of account.windows) {
    if (window.usedPercent < SWITCH_WARN_PERCENT) continue;
    const at = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    if (!Number.isNaN(at) && at <= now) continue;
    if (worst === null || window.usedPercent > worst.usedPercent) worst = window;
  }
  return worst ? `${worst.label} ${Math.round(worst.usedPercent)}%` : null;
}

/**
 * The promise's value, or null as soon as the signal aborts, whichever comes
 * first. The poll can wait on a refresh another caller started, which does not
 * see the poll's signal; awaiting it plainly could outlast bb's 5 s stop
 * deadline on reload. The promise itself is left to finish on its own.
 */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Which account `use` should switch to, or why it must not. Shared by the CLI
 * and the popup's RPC, so neither can send work to an account Anthropic has on
 * hold: the popup hides its button, but the RPC is callable on its own.
 */
export function pickAccountToUse<T extends { email: string; file: string; status: AccountStatus }>(
  accounts: readonly T[],
  match: (account: T) => boolean,
  asked: string,
): { ok: true; account: T } | { ok: false; error: string } {
  const matches = accounts.filter(match);
  if (matches.length !== 1) {
    return { ok: false, error: `need exactly one account matching "${asked}", got ${matches.map((m) => m.email).join(", ") || "none"}` };
  }
  if (matches[0].status === "on-hold") {
    return { ok: false, error: `${matches[0].email} is on hold at Anthropic; the proxy cannot use it. Not switched.` };
  }
  return { ok: true, account: matches[0] };
}

/**
 * Whether the proxy can currently send traffic to this account.
 * An account on hold at Anthropic is restricted and its token is unrenewed,
 * so it is never in use even if its file on disk still says disabled: false.
 */
export function isAccountInUse(account: { disabled: boolean; status: AccountStatus }): boolean {
  if (account.disabled) return false;
  return account.status !== "on-hold";
}

/**
 * Whether a single account's figures are current enough to paint on the live
 * scale. Checking per account keeps a held account with day-old figures from
 * greying out the bars and Limit-hit pill of a healthy active account beside it.
 */
export function accountVouchedFor(
  account: { status: AccountStatus; windows: readonly unknown[]; okAt: string | null },
  now: number = Date.now(),
): boolean {
  if (account.status === "ok") return true;
  if (account.windows.length === 0 || account.okAt === null) return false;
  const age = now - new Date(account.okAt).getTime();
  return !Number.isNaN(age) && age <= VOUCH_LIMIT_MS;
}

/**
 * The accounts the footer and button dot speak for: the ones in use (plus
 * Antigravity when present), falling back to all accounts when none is in use.
 * A disabled or on-hold account already dates its own bars on its card.
 */
export function activeFreshnessState(state: {
  fetchedAt: string | null;
  accounts: readonly { status: AccountStatus; windows: readonly unknown[]; okAt: string | null; disabled: boolean }[];
  antigravity?: { status: AccountStatus; windows: readonly unknown[]; okAt: string | null; disabled: boolean } | null;
}): FreshnessState {
  const active = state.accounts.filter(isAccountInUse);
  const list = [...(active.length > 0 ? active : state.accounts)];
  if (state.antigravity && isAccountInUse(state.antigravity)) list.push(state.antigravity);
  return { fetchedAt: state.fetchedAt, accounts: list };
}

export interface AntigravitySummaryBucket {
  bucketId?: string | null;
  displayName?: string | null;
  window?: string | null;
  resetTime?: string | null;
  remainingFraction?: number | null;
  disabled?: boolean | null;
}

export interface AntigravitySummaryGroup {
  displayName?: string | null;
  buckets?: readonly AntigravitySummaryBucket[] | null;
}

export interface AntigravityModelBucket {
  modelId?: string | null;
  remainingFraction?: number | null;
  resetTime?: string | null;
}

const ANTIGRAVITY_WINDOWS: readonly { key: string; label: string }[] = [
  { key: "gemini:5h", label: "5-hour, Gemini" },
  { key: "gemini:weekly", label: "Weekly, Gemini" },
  { key: "3p:5h", label: "5-hour, Claude & GPT" },
  { key: "3p:weekly", label: "Weekly, Claude & GPT" },
];

/**
 * Build the Google AI Ultra (Antigravity) quota windows from Cloud Code Assist's
 * summary groups and per-model buckets. `cloudcode-pa` carries the weekly
 * Gemini bucket (`gemini-weekly`) while `daily-cloudcode-pa` carries the live
 * 5-hour Gemini bucket on `gemini-*` models, so the fuller reading wins per
 * window. An unstarted rolling window (`remainingFraction >= 1`) stamps `now +
 * duration` as a placeholder reset; clearing `resetsAt` at 0% lets the popup
 * say "Starts with the next request", matching the Claude bars.
 */
export function antigravityWindowsFrom(
  summaries: readonly { groups?: readonly AntigravitySummaryGroup[] | null }[],
  modelBuckets: readonly AntigravityModelBucket[],
): UsageWindowShape[] {
  const best = new Map<string, { usedPercent: number; resetsAt: string | null }>();
  const record = (key: string, remainingFraction: number | null | undefined, resetTime: string | null | undefined) => {
    if (typeof remainingFraction !== "number" || !Number.isFinite(remainingFraction)) return;
    const clamped = Math.max(0, Math.min(1, remainingFraction));
    const usedPercent = (1 - clamped) * 100;
    const resetsAt = clamped < 1 && typeof resetTime === "string" && resetTime.length > 0 ? resetTime : null;
    const prev = best.get(key);
    if (!prev || usedPercent > prev.usedPercent || (usedPercent === prev.usedPercent && prev.resetsAt === null && resetsAt !== null)) {
      best.set(key, { usedPercent, resetsAt });
    }
  };
  for (const summary of summaries) {
    for (const group of summary.groups ?? []) {
      const groupName = (group.displayName ?? "").toLowerCase();
      for (const bucket of group.buckets ?? []) {
        if (bucket.disabled === true) continue;
        const id = (bucket.bucketId ?? "").toLowerCase();
        const family =
          id.startsWith("gemini-") || groupName.includes("gemini")
            ? "gemini"
            : id.startsWith("3p-") || groupName.includes("claude") || groupName.includes("gpt")
              ? "3p"
              : null;
        const win =
          bucket.window === "5h" || id.endsWith("-5h")
            ? "5h"
            : bucket.window === "weekly" || id.endsWith("-weekly")
              ? "weekly"
              : null;
        if (family && win) record(`${family}:${win}`, bucket.remainingFraction, bucket.resetTime);
      }
    }
  }
  // Per-model buckets in retrieveUserQuota carry no `window` field and report
  // whichever window (5h or weekly) is currently fuller for that model. Tell
  // a weekly model bucket apart from a 5-hour one by its resetTime: a weekly
  // reset sits more than 24 hours after a 5-hour reset (or within 24 hours of
  // the family's weekly summary reset).
  const DAY_MS = 24 * 60 * 60_000;
  for (const bucket of modelBuckets) {
    const id = (bucket.modelId ?? "").toLowerCase();
    const family = id.startsWith("gemini-") ? "gemini" : id.startsWith("claude-") || id.startsWith("gpt-") ? "3p" : null;
    if (!family) continue;
    const resetMs = bucket.resetTime ? Date.parse(bucket.resetTime) : Number.NaN;
    const weeklyHit = best.get(`${family}:weekly`);
    const fiveHourHit = best.get(`${family}:5h`);
    const weeklyMs = weeklyHit?.resetsAt ? Date.parse(weeklyHit.resetsAt) : Number.NaN;
    const fiveHourMs = fiveHourHit?.resetsAt ? Date.parse(fiveHourHit.resetsAt) : Number.NaN;
    const isWeekly =
      (!Number.isNaN(resetMs) && !Number.isNaN(weeklyMs) && Math.abs(resetMs - weeklyMs) < DAY_MS) ||
      (!Number.isNaN(resetMs) && !Number.isNaN(fiveHourMs) && resetMs - fiveHourMs > DAY_MS);
    record(`${family}:${isWeekly ? "weekly" : "5h"}`, bucket.remainingFraction, bucket.resetTime);
  }
  const out: UsageWindowShape[] = [];
  for (const { key, label } of ANTIGRAVITY_WINDOWS) {
    const hit = best.get(key);
    if (hit) out.push({ label, usedPercent: hit.usedPercent, resetsAt: hit.resetsAt });
  }
  return out;
}

export interface OmpUsageLimitItem {
  id?: string | null;
  label?: string | null;
  scope?: {
    provider?: string | null;
    windowId?: string | null;
    tier?: string | null;
    shared?: boolean | null;
    sharedGroup?: string | null;
  } | null;
  window?: {
    id?: string | null;
    label?: string | null;
    durationMs?: number | null;
    resetsAt?: number | null;
  } | null;
  amount?: {
    used?: number | null;
    remainingFraction?: number | null;
  } | null;
}

/**
 * Map `omp usage --json`'s `limits` array for an account into the popup's
 * `UsageWindowShape[]` bars, keyed by `window.id` / `scope.windowId` and
 * model family or tier.
 */
export function windowsFromOmpReport(
  provider: string,
  limits: readonly OmpUsageLimitItem[],
): UsageWindowShape[] {
  if (provider === "google-antigravity") {
    const byKey = new Map<string, { usedPercent: number; resetsAt: string | null }>();
    for (const item of limits) {
      const used =
        typeof item.amount?.used === "number" && Number.isFinite(item.amount.used)
          ? item.amount.used
          : typeof item.amount?.remainingFraction === "number" && Number.isFinite(item.amount.remainingFraction)
            ? (1 - Math.max(0, Math.min(1, item.amount.remainingFraction))) * 100
            : null;
      if (used === null) continue;
      const id = (item.id ?? "").toLowerCase();
      const label = (item.label ?? "").toLowerCase();
      const family =
        label.includes("gemini") || id.includes(":google:") || id.endsWith(":gemini-5h") || id.endsWith(":gemini-weekly")
          ? "gemini"
          : label.includes("claude") || label.includes("gpt") || id.includes(":anthropic:") || id.includes(":openai:") || id.includes(":3p-")
            ? "3p"
            : null;
      const winRaw = (item.window?.id ?? item.scope?.windowId ?? item.window?.label ?? "").toLowerCase();
      const win =
        winRaw === "5h" || winRaw === "5 hour" || id.endsWith("-5h")
          ? "5h"
          : winRaw === "weekly" || winRaw === "7d" || id.endsWith("-weekly")
            ? "weekly"
            : null;
      if (!family || !win) continue;
      const key = `${family}:${win}`;
      if (byKey.has(key)) continue;
      const resetsAt =
        used > 0 && typeof item.window?.resetsAt === "number" && Number.isFinite(item.window.resetsAt)
          ? new Date(item.window.resetsAt).toISOString()
          : null;
      byKey.set(key, { usedPercent: Math.max(0, Math.min(100, used)), resetsAt });
    }
    const out: UsageWindowShape[] = [];
    for (const { key, label } of ANTIGRAVITY_WINDOWS) {
      const hit = byKey.get(key);
      if (hit) out.push({ label, usedPercent: hit.usedPercent, resetsAt: hit.resetsAt });
    }
    return out;
  }
  const out: UsageWindowShape[] = [];
  for (const item of limits) {
    const used =
      typeof item.amount?.used === "number" && Number.isFinite(item.amount.used)
        ? item.amount.used
        : typeof item.amount?.remainingFraction === "number" && Number.isFinite(item.amount.remainingFraction)
          ? (1 - Math.max(0, Math.min(1, item.amount.remainingFraction))) * 100
          : null;
    if (used === null) continue;
    const winRaw = (item.window?.id ?? item.scope?.windowId ?? "").toLowerCase();
    const tier = item.scope?.tier?.trim();
    let label: string;
    if (winRaw === "5h" || item.id?.endsWith(":5h")) {
      label = "5-hour";
    } else if (tier) {
      const tierName = tier.charAt(0).toUpperCase() + tier.slice(1);
      label = `Weekly, ${tierName} only`;
    } else if (winRaw === "7d" || winRaw === "weekly" || item.id?.endsWith(":7d")) {
      label = "Weekly";
    } else {
      label = item.label ?? item.window?.label ?? "Usage";
    }
    const resetsAt =
      typeof item.window?.resetsAt === "number" && Number.isFinite(item.window.resetsAt) && (label !== "5-hour" || used > 0)
        ? new Date(item.window.resetsAt).toISOString()
        : null;
    out.push({ label, usedPercent: Math.max(0, Math.min(100, used)), resetsAt });
  }
  return out;
}

/** Traffic-light level shared by the footer strip's usage rows and server status. */
export type HealthLevel = "green" | "amber" | "red" | "unknown";

/** One subscription account's line in the sidebar footer strip. */
export interface StripUsageRow {
  key: string;
  label: string;
  provider: string;
  email: string;
  level: HealthLevel;
  usedPercent: number | null;
  text: string;
  windowLabel: string | null;
  resetsAt: string | null;
  tooltip: string;
}

/** One of the checks behind the footer strip's server status word. */
export interface ServerHealthCheck {
  id: "systemd" | "machines" | "disk" | "watchdog";
  label: string;
  level: HealthLevel;
  detail: string;
}

/** The footer strip's server status: one word, a level, and the checks behind it. */
export interface ServerHealth {
  level: HealthLevel;
  word: string;
  tooltip: string;
  checkedAt: string | null;
  checks: ServerHealthCheck[];
}

/** Raw readings for aggregateServerHealth. Null means that source could not be read. */
export interface ServerHealthInput {
  checkedAt: string | null;
  systemFailedUnits: readonly string[] | null;
  userFailedUnits: readonly string[] | null;
  ignoredUnits?: readonly string[];
  hosts: readonly { id: string; name?: string | null; status: string; phase?: string | null }[] | null;
  diskRoot: { availBytes: number; totalBytes: number } | null;
  watchdog: {
    unitName?: string;
    loadState: string | null;
    activeState: string | null;
    result: string | null;
    execMainStatus: number | null;
    exitAtMs: number | null;
  } | null;
}

function resetMs(resetsAt: string | null): number {
  if (resetsAt === null) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(resetsAt);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * The window closest to its limit: highest usedPercent, and on a tie the one
 * that resets first. Null when there are no windows.
 */
export function closestWindow(windows: readonly UsageWindowShape[]): UsageWindowShape | null {
  let best: UsageWindowShape | null = null;
  for (const window of windows) {
    if (
      best === null ||
      window.usedPercent > best.usedPercent ||
      (window.usedPercent === best.usedPercent && resetMs(window.resetsAt) < resetMs(best.resetsAt))
    ) {
      best = window;
    }
  }
  return best;
}

type StripAccount = AccountResult & { id?: number; provider?: string };

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  "google-antigravity": "Ultra",
  anthropic: "Claude",
};

function unknownRow(tooltip: string): StripUsageRow {
  return {
    key: "unknown",
    label: "Usage",
    provider: "unknown",
    email: "",
    level: "unknown",
    usedPercent: null,
    text: "unknown",
    windowLabel: null,
    resetsAt: null,
    tooltip,
  };
}

function errorRow(tooltip: string): StripUsageRow {
  return {
    key: "error",
    label: "Usage",
    provider: "unknown",
    email: "",
    level: "red",
    usedPercent: null,
    text: "error",
    windowLabel: null,
    resetsAt: null,
    tooltip,
  };
}

/**
 * The footer strip's usage rows: one per account in use (Antigravity first),
 * each showing its window closest to the limit. Disabled and on-hold accounts
 * are left out; figures that are not current read "unknown" rather than a
 * percentage nobody can vouch for.
 */
export function stripUsageRows(
  state: {
    accounts: readonly StripAccount[];
    antigravity?: StripAccount | null;
    message: string | null;
  } | null,
  now: number = Date.now(),
): StripUsageRow[] {
  if (state === null) return [unknownRow("Usage figures unavailable")];
  const active: StripAccount[] = [];
  const ag = state.antigravity;
  if (
    ag &&
    isAccountInUse(ag) &&
    !state.accounts.some(
      (account) =>
        account.file === ag.file ||
        (account.email === ag.email && (account.provider ?? "anthropic") === (ag.provider ?? "anthropic")),
    )
  ) {
    active.push(ag);
  }
  active.push(...state.accounts.filter(isAccountInUse));
  if (active.length === 0) return [state.message ? errorRow(state.message) : unknownRow("No active subscription account")];

  const perProvider = new Map<string, number>();
  for (const account of active) {
    const provider = account.provider ?? "anthropic";
    perProvider.set(provider, (perProvider.get(provider) ?? 0) + 1);
  }

  return active.map((account) => {
    const provider = account.provider ?? "anthropic";
    const base = PROVIDER_LABELS[provider] ?? provider;
    const label = (perProvider.get(provider) ?? 0) > 1 ? `${base} · ${account.email.split("@")[0]}` : base;
    const key = `${provider}:${account.id ?? account.file}`;
    const isUltra = provider === "google-antigravity";
    const candidates = isUltra
      ? account.windows.filter((window) => window.label.toLowerCase().includes("weekly"))
      : account.windows;
    const readable = account.status === "ok" && accountVouchedFor(account, now) && candidates.length > 0;
    if (!readable) {
      const failed = account.status === "error" || account.status === "expired";
      const stateWord = failed ? "error" : "unknown";
      return {
        key,
        label,
        provider,
        email: account.email,
        level: failed ? "red" : "unknown",
        usedPercent: null,
        text: stateWord,
        windowLabel: null,
        resetsAt: null,
        tooltip: `${label} (${account.email}): ${stateWord} (${account.message ?? "figures stale or unavailable"})`,
      };
    }
    const best = closestWindow(candidates)!;
    const pct = Math.round(best.usedPercent);
    const level: HealthLevel = pct > 85 ? "red" : pct >= 60 ? "amber" : "green";
    if (isUltra) {
      const lower = best.label.toLowerCase();
      const tag = lower.includes("gemini") ? "wk · G" : lower.includes("claude") || lower.includes("gpt") ? "wk · C/GPT" : "wk";
      const weeklyLines = candidates.map((window) => {
        const wPct = Math.round(window.usedPercent);
        const wReset = window.resetsAt === null ? "no reset time" : `resets ${window.resetsAt}`;
        return `${window.label}: ${wPct}%, ${wReset}`;
      });
      return {
        key,
        label: `${label} ${tag}`,
        provider,
        email: account.email,
        level,
        usedPercent: best.usedPercent,
        text: `${pct}%`,
        windowLabel: best.label,
        resetsAt: best.resetsAt,
        tooltip: [`${label} (${account.email})`, ...weeklyLines].join("\n"),
      };
    }
    const reset = best.resetsAt === null ? "no reset time" : `resets ${best.resetsAt}`;
    return {
      key,
      label,
      provider,
      email: account.email,
      level,
      usedPercent: best.usedPercent,
      text: `${pct}%`,
      windowLabel: best.label,
      resetsAt: best.resetsAt,
      tooltip: `${label} (${account.email}): ${best.label}: ${pct}%, ${reset}`,
    };
  });
}

const UNIT_NAME = /^[^\s]+\.(service|timer|socket|path|mount|scope|target)$/u;

/**
 * Failed unit names from `systemctl [--user] --failed --no-legend --plain --no-pager`.
 * A leading status bullet is dropped; lines without a unit name are ignored.
 */
export function parseSystemctlFailedUnits(stdout: string): string[] {
  const units: string[] = [];
  for (const line of stdout.split("\n")) {
    const tokens = line.trim().replace(/^[●×*]\s*/u, "").split(/\s+/u);
    const unit = tokens.find((token) => UNIT_NAME.test(token));
    if (unit) units.push(unit);
  }
  return units;
}

function parseExitTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const epoch = /^@(\d+(?:\.\d+)?)$/u.exec(value);
  if (epoch) return Number(epoch[1]) * 1000;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The watchdog unit's state from `systemctl show <unit> --timestamp=unix
 * --property=LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainExitTimestamp`.
 * Missing or empty properties come back as null.
 */
export function parseSystemctlShowWatchdog(stdout: string): {
  loadState: string | null;
  activeState: string | null;
  result: string | null;
  execMainStatus: number | null;
  exitAtMs: number | null;
} {
  const props = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    props.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const text = (key: string): string | null => props.get(key) || null;
  const statusRaw = text("ExecMainStatus");
  const status = statusRaw === null ? null : Number(statusRaw);
  return {
    loadState: text("LoadState"),
    activeState: text("ActiveState"),
    result: text("Result"),
    execMainStatus: status !== null && Number.isFinite(status) ? status : null,
    exitAtMs: parseExitTimestamp(props.get("ExecMainExitTimestamp")),
  };
}

/** A watchdog run older than this is late (amber). */
const WATCHDOG_LATE_MS = 10 * 60_000;
/** A watchdog run older than this is overdue (red). */
const WATCHDOG_OVERDUE_MS = 30 * 60_000;

function systemdCheck(input: ServerHealthInput): ServerHealthCheck {
  const check = { id: "systemd", label: "Systemd" } as const;
  if (input.systemFailedUnits === null || input.userFailedUnits === null) {
    return { ...check, level: "unknown", detail: "Systemd units: unknown" };
  }
  const ignored = new Set((input.ignoredUnits ?? []).map((unit) => unit.trim()).filter((unit) => unit.length > 0));
  const failed = [...input.systemFailedUnits, ...input.userFailedUnits].filter((unit) => !ignored.has(unit));
  if (failed.length > 0) return { ...check, level: "red", detail: `Failed units: ${failed.join(", ")}` };
  return { ...check, level: "green", detail: "Systemd units: 0 failed" };
}

/** Host lifecycle phases that are not expected to be online. */
const GONE_PHASES: Readonly<Record<string, true>> = { destroyed: true, removing: true, suspended: true };

function machinesCheck(input: ServerHealthInput): ServerHealthCheck {
  const check = { id: "machines", label: "Machines" } as const;
  if (input.hosts === null) return { ...check, level: "unknown", detail: "Machines: unknown" };
  const active = input.hosts.filter((host) => !(host.phase && GONE_PHASES[host.phase]));
  const offline = active.filter((host) => host.status !== "connected");
  if (offline.length > 0) {
    return { ...check, level: "red", detail: `Machines offline: ${offline.map((host) => host.name || host.id).join(", ")}` };
  }
  return { ...check, level: "green", detail: `Machines: ${active.length}/${active.length} online` };
}

function diskCheck(input: ServerHealthInput): ServerHealthCheck {
  const check = { id: "disk", label: "Disk /" } as const;
  if (input.diskRoot === null || input.diskRoot.totalBytes <= 0) {
    return { ...check, level: "unknown", detail: "Disk /: unknown" };
  }
  const freePct = Math.round((input.diskRoot.availBytes / input.diskRoot.totalBytes) * 100);
  const freeGiB = Math.round(input.diskRoot.availBytes / 1024 ** 3);
  const amount = `${freePct}% free (${freeGiB} GiB)`;
  if (freePct < 5) return { ...check, level: "red", detail: `Disk / low: ${amount}` };
  if (freePct < 10) return { ...check, level: "amber", detail: `Disk / low: ${amount}` };
  return { ...check, level: "green", detail: `Disk /: ${amount}` };
}

function watchdogCheck(input: ServerHealthInput, now: number): ServerHealthCheck {
  const check = { id: "watchdog", label: "Watchdog" } as const;
  const watchdog = input.watchdog;
  const unitName = watchdog?.unitName || "watchdog.service";
  const unknown: ServerHealthCheck = { ...check, level: "unknown", detail: `Watchdog (${unitName}): unknown` };
  if (watchdog === null) return unknown;
  if (watchdog.loadState && watchdog.loadState !== "loaded") {
    return { ...check, level: "red", detail: `Watchdog: ${unitName} ${watchdog.loadState}` };
  }
  if ((watchdog.result && watchdog.result !== "success") || (watchdog.execMainStatus !== null && watchdog.execMainStatus !== 0)) {
    const why = watchdog.result && watchdog.result !== "success" ? watchdog.result : `exit ${watchdog.execMainStatus}`;
    return { ...check, level: "red", detail: `Watchdog: ${unitName} failed (${why})` };
  }
  if (watchdog.exitAtMs === null || !Number.isFinite(watchdog.exitAtMs)) return unknown;
  const ageMs = Math.max(0, now - watchdog.exitAtMs);
  // ageText already words the age as "just now" or "N min ago".
  const age = ageText(new Date(watchdog.exitAtMs).toISOString(), now);
  if (ageMs > WATCHDOG_OVERDUE_MS) return { ...check, level: "red", detail: `Watchdog (${unitName}): last run ${age} (overdue)` };
  if (ageMs > WATCHDOG_LATE_MS) return { ...check, level: "amber", detail: `Watchdog (${unitName}): last run ${age} (late)` };
  return { ...check, level: "green", detail: `Watchdog: last run ${age}` };
}

/**
 * The footer strip's server status from raw readings. Any red check makes it
 * "fail", any amber "warn"; a source that could not be read, or readings older
 * than one poll window, make it "unknown" rather than a reassuring "ok".
 */
export function aggregateServerHealth(input: ServerHealthInput, now: number = Date.now()): ServerHealth {
  const checks = [systemdCheck(input), machinesCheck(input), diskCheck(input), watchdogCheck(input, now)];
  const checkedMs = input.checkedAt ? Date.parse(input.checkedAt) : Number.NaN;
  const has = (level: HealthLevel) => checks.some((check) => check.level === level);
  let level: HealthLevel;
  let word: string;
  if (Number.isNaN(checkedMs) || now - checkedMs > POLL_WINDOW_MS) {
    level = "unknown";
    word = "unknown";
  } else if (has("red")) {
    level = "red";
    word = "fail";
  } else if (has("amber")) {
    level = "amber";
    word = "warn";
  } else if (has("unknown")) {
    level = "unknown";
    word = "unknown";
  } else {
    level = "green";
    word = "ok";
  }
  const ordered = [...checks.filter((check) => check.level !== "green"), ...checks.filter((check) => check.level === "green")];
  return {
    level,
    word,
    tooltip: ordered.map((check) => check.detail).join("\n"),
    checkedAt: input.checkedAt,
    checks,
  };
}

export const SERVER_METRICS_WINDOW_MS = 45_000;

export interface ProcStatSample {
  total: number;
  idle: number;
  cores: number;
}

export interface ProcMeminfo {
  memTotalKiB: number;
  memAvailableKiB: number;
  memUsedKiB: number;
  usedPercent: number;
  swapTotalKiB: number;
  swapUsedKiB: number;
}

export interface ServerMetricRow {
  level: HealthLevel;
  usedPercent: number | null;
  text: string;
  tooltip: string;
}

export interface ServerMetrics {
  checkedAt: string | null;
  cpu: ServerMetricRow;
  memory: ServerMetricRow;
}

export function parseProcStat(raw: string): ProcStatSample | null {
  let total: number | null = null;
  let idle: number | null = null;
  let cores = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (/^cpu\d+\s+/u.test(trimmed)) {
      cores++;
      continue;
    }
    if (/^cpu\s+/u.test(trimmed) && total === null) {
      const parts = trimmed.split(/\s+/u).slice(1, 9).map(Number);
      if (parts.length < 4 || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
      total = parts.reduce((sum, n) => sum + n, 0);
      idle = parts[3]! + (parts[4] ?? 0);
    }
  }
  if (total === null || idle === null || total <= 0) return null;
  return { total, idle, cores };
}

export function cpuPercentFromStatSamples(prev: ProcStatSample | null, curr: ProcStatSample | null): number | null {
  if (!prev || !curr) return null;
  const totalDelta = curr.total - prev.total;
  const idleDelta = curr.idle - prev.idle;
  if (totalDelta <= 0 || idleDelta < 0) return null;
  const busyDelta = Math.max(0, totalDelta - idleDelta);
  return Math.max(0, Math.min(100, (busyDelta / totalDelta) * 100));
}

export function parseProcLoadavg(raw: string): { load1: string; load5: string; load15: string } | null {
  const parts = raw.trim().split(/\s+/u);
  if (parts.length < 3) return null;
  const [load1, load5, load15] = parts;
  if (!load1 || !load5 || !load15) return null;
  if ([load1, load5, load15].some((v) => !Number.isFinite(Number(v)))) return null;
  return { load1, load5, load15 };
}

export function parseProcMeminfo(raw: string): ProcMeminfo | null {
  const values: Record<string, number> = {};
  for (const line of raw.split("\n")) {
    const match = /^([A-Za-z0-9_()]+):\s+(\d+)/u.exec(line.trim());
    if (!match) continue;
    values[match[1]!] = Number(match[2]);
  }
  const memTotalKiB = values.MemTotal;
  const memAvailableKiB = values.MemAvailable;
  if (
    memTotalKiB === undefined ||
    memAvailableKiB === undefined ||
    !Number.isFinite(memTotalKiB) ||
    !Number.isFinite(memAvailableKiB) ||
    memTotalKiB <= 0 ||
    memAvailableKiB < 0 ||
    memAvailableKiB > memTotalKiB
  ) {
    return null;
  }
  const memUsedKiB = memTotalKiB - memAvailableKiB;
  const usedPercent = Math.max(0, Math.min(100, (memUsedKiB / memTotalKiB) * 100));
  const swapTotalKiB = Math.max(0, values.SwapTotal ?? 0);
  const swapFreeKiB = Math.max(0, Math.min(swapTotalKiB, values.SwapFree ?? 0));
  const swapUsedKiB = Math.max(0, swapTotalKiB - swapFreeKiB);
  return { memTotalKiB, memAvailableKiB, memUsedKiB, usedPercent, swapTotalKiB, swapUsedKiB };
}

/** CPU and Memory strip threshold: green below 70%, amber 70 to 90%, red above 90%. */
export function serverMetricLevel(percent: number | null): HealthLevel {
  if (percent === null || !Number.isFinite(percent)) return "unknown";
  if (percent > 90) return "red";
  if (percent >= 70) return "amber";
  return "green";
}

export function buildServerMetrics(
  input: {
    checkedAt: string | null;
    cpuPercent: number | null;
    cores: number | null;
    loadavg: { load1: string; load5: string; load15: string } | null;
    mem: ProcMeminfo | null;
  },
  now: number = Date.now(),
): ServerMetrics {
  const checkedMs = input.checkedAt ? Date.parse(input.checkedAt) : Number.NaN;
  const fresh = !Number.isNaN(checkedMs) && now - checkedMs <= SERVER_METRICS_WINDOW_MS;

  let cpu: ServerMetricRow;
  if (!fresh || input.cpuPercent === null || !Number.isFinite(input.cpuPercent)) {
    cpu = { level: "unknown", usedPercent: null, text: "unknown", tooltip: "CPU: unknown" };
  } else {
    const pct = Math.round(input.cpuPercent);
    const level = serverMetricLevel(input.cpuPercent);
    const parts: string[] = [];
    if (input.cores && input.cores > 0) parts.push(`${input.cores} cores`);
    if (input.loadavg) parts.push(`load ${input.loadavg.load1}, ${input.loadavg.load5}, ${input.loadavg.load15} over 1, 5, 15 min`);
    cpu = {
      level,
      usedPercent: input.cpuPercent,
      text: `${pct}%`,
      tooltip: parts.length > 0 ? `CPU: ${pct}% (${parts.join(" · ")})` : `CPU: ${pct}%`,
    };
  }

  let memory: ServerMetricRow;
  if (!fresh || input.mem === null) {
    memory = { level: "unknown", usedPercent: null, text: "unknown", tooltip: "Memory: unknown" };
  } else {
    const pct = Math.round(input.mem.usedPercent);
    const level = serverMetricLevel(input.mem.usedPercent);
    const usedGb = (input.mem.memUsedKiB / 1024 ** 2).toFixed(1);
    const totalGb = (input.mem.memTotalKiB / 1024 ** 2).toFixed(1);
    const swapGb = (input.mem.swapUsedKiB / 1024 ** 2).toFixed(1);
    memory = {
      level,
      usedPercent: input.mem.usedPercent,
      text: `${pct}%`,
      tooltip: `Memory: ${pct}% (${usedGb} / ${totalGb} GB used · swap ${swapGb} GB used)`,
    };
  }

  return { checkedAt: input.checkedAt, cpu, memory };
}
