// Shared data hooks for the Chief of Staff surfaces.
//
// Every hook fetches once on mount, refetches on the server's "cos-changed"
// realtime signal, and polls every 20s as a fallback when the socket is down.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { formatClock, relativeTime as sharedRelativeTime } from "./format";
import type {
  ActivityEvent,
  BoardItemDto,
  BoardStateDto,
  ExecutionListDto,
  ExternalSession,
  OtherThread,
  ProjectRefDto,
  Summary,
  ThreadExecution,
  Urgency,
  WorkerStatus,
  rpcContract,
} from "@/contract";
import { TEXT_URGENT } from "./tone";
import { startVisiblePoll } from "./visible-poll";

export { displayName, executionLabel, newForYouLabel, projectLabel, stripKindPrefix, unreadLabel } from "./naming";

export type CosRpc = ReturnType<typeof useRpc<typeof rpcContract>>;

export const COS_CHANNEL = "cos-changed";
const POLL_MS = 20_000;
/** External sessions are scanned from disk, so they poll a little slower. */
const SESSIONS_POLL_MS = 30_000;

export function useCosRpc(): CosRpc {
  return useRpc<typeof rpcContract>();
}

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface Live<T> {
  data: T | null;
  error: string | null;
  /**
   * True when there is data on screen and the most recent fetch failed.
   *
   * Every surface guards with `error !== null && data === null`, which only
   * catches a failure on the very first fetch. Once anything has loaded, a
   * refetch that throws leaves the last good payload rendered with no mark on
   * it, so a board that stopped updating looks exactly like a board with
   * nothing new on it. That is the one failure worth interrupting for: the
   * plugin's whole job is telling the user what is waiting.
   */
  stale: boolean;
  refetch: () => void;
}

/**
 * Identical queries share one request.
 *
 * Without sharing, every component that needs the roster would run its own
 * copy of the query, with its own 20-second poll and its own realtime
 * refetch. On the phone page the page body, the Mission tab, the panel header
 * and the homepage strip would each send `summary`, `roster_list` and
 * `projects_list` on load, and again on every realtime signal. The server
 * memoises for a second, so the answers are cheap, but the browser's
 * six-connection limit is not, and the page would sit on "Loading" behind its
 * own duplicate requests.
 *
 * Keyed on the query's name and subject. A request already in flight is
 * joined, and a result younger than `SHARE_MS` is reused. It is a dedupe, not
 * a cache: nothing is kept beyond that window, so a refetch after a change
 * still reaches the server.
 */
const SHARE_MS = 1_500;
const shared = new Map<string, { at: number; promise: Promise<unknown> }>();

/**
 * Every mounted consumer of a shared query, by key. When ANY of them gets a
 * fresh result, all of them take it, so the panel header and the sidebar show
 * one snapshot. On separate timers, a count that moves with time (an urgent
 * Need turning a day old) could show one count in one and the next count up
 * in the other.
 */
const snapshotListeners = new Map<string, Set<(data: unknown) => void>>();

function publishSnapshot(key: string, data: unknown): void {
  for (const listener of snapshotListeners.get(key) ?? []) listener(data);
}

function sharedCall<T>(key: string, run: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = shared.get(key);
  if (hit !== undefined && now - hit.at < SHARE_MS) return hit.promise as Promise<T>;
  const promise = run();
  shared.set(key, { at: now, promise });
  // A failure is not shared past its own moment: the next caller retries.
  promise.catch(() => {
    if (shared.get(key)?.promise === promise) shared.delete(key);
  });
  return promise;
}

/**
 * One live query. `resetKey` re-runs the query and drops stale data when the
 * subject changes (for example the thread a worker lookup is about).
 *
 * `shareKey` names the query for de-duplication across components; queries
 * with the same key and resetKey share one request. Omit it only for a query
 * whose result depends on something other than those two.
 */
function useLive<T>(
  run: (rpc: CosRpc) => Promise<T>,
  resetKey = "",
  pollMs: number = POLL_MS,
  shareKey: string | null = null,
): Live<T> {
  const rpc = useCosRpc();
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  const generation = useRef(0);
  const [state, setState] = useState<{ data: T | null; error: string | null }>({
    data: null,
    error: null,
  });

  const refetch = useCallback(() => {
    const mine = generation.current;
    const call = () => runRef.current(rpc);
    const key = `${shareKey}\u0000${resetKey}`;
    const pending = shareKey === null ? call() : sharedCall(key, call);
    pending.then(
      (data) => {
        if (shareKey !== null) {
          // Everyone on this key takes it, including this instance.
          publishSnapshot(key, data);
          return;
        }
        if (generation.current === mine) setState({ data, error: null });
      },
      (cause: unknown) => {
        if (generation.current === mine) {
          setState((previous) => ({ data: previous.data, error: errorText(cause) }));
        }
      },
    );
  }, [rpc, shareKey, resetKey]);

  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    generation.current += 1;
    // Drop the previous subject's data, but never on the first run: an
    // unconditional reset here would fight any re-render of this effect.
    if (lastKey.current !== null && lastKey.current !== resetKey) {
      setState({ data: null, error: null });
    }
    lastKey.current = resetKey;
    refetch();
    const stop = startVisiblePoll(typeof document === "undefined" ? null : document, refetch, pollMs);
    return () => {
      generation.current += 1;
      stop();
    };
  }, [refetch, pollMs, resetKey]);

  // Take any snapshot another consumer of the same query fetched.
  useEffect(() => {
    if (shareKey === null) return;
    const key = `${shareKey}\u0000${resetKey}`;
    const listener = (data: unknown) => setState({ data: data as T, error: null });
    const set = snapshotListeners.get(key) ?? new Set();
    set.add(listener);
    snapshotListeners.set(key, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) snapshotListeners.delete(key);
    };
  }, [shareKey, resetKey]);

  useRealtime(COS_CHANNEL, refetch);

  return {
    data: state.data,
    error: state.error,
    stale: state.error !== null && state.data !== null,
    refetch,
  };
}

export function useSummary(): Live<Summary> {
  return useLive(useCallback((rpc: CosRpc) => rpc.call("summary", null), []), "", POLL_MS, "summary");
}

export interface RosterData {
  chiefThreadId: string | null;
  workers: WorkerStatus[];
  others: OtherThread[];
}

export function useRoster(): Live<RosterData> {
  return useLive(
    useCallback((rpc: CosRpc) => rpc.call("roster_list", { includeOthers: true }), []),
    "",
    POLL_MS,
    "roster",
  );
}

export function useActivity(limit = 120): Live<ActivityEvent[]> {
  return useLive(
    useCallback(
      (rpc: CosRpc) => rpc.call("activity_list", { limit }).then((r) => r.events),
      [limit],
    ),
    String(limit),
  );
}

/**
 * Every activity event in one time window, for the day view. A window, not a
 * count: a busy day can hold more events than `activity_list`'s cap of 500,
 * and a capped list would draw a busy morning as a quiet one.
 */
export function useActivityDay(from: number, to: number): Live<{ events: ActivityEvent[]; truncated: boolean }> {
  return useLive(
    useCallback((rpc: CosRpc) => rpc.call("activity_day", { from, to }), [from, to]),
    `${from}-${to}`,
  );
}

/**
 * The decision board. `states` is the live pair by default: resolved and
 * dismissed items stay in the database and come back only when asked for.
 */
/**
 * Board items in the given states, or the live ones (open and addressed) when
 * `states` is omitted.
 *
 * `enabled: false` returns an empty list and issues no call. The closed-items
 * disclosure needs that: passing `undefined` while it is shut would fetch the
 * DEFAULT states, so the surface would hold every open item twice, poll for
 * them twice, and count each one twice when it reads a move's prior states
 * off screen.
 */
export function useBoard(
  states?: readonly BoardStateDto[],
  opts: { enabled?: boolean } = {},
): Live<BoardItemDto[]> {
  const enabled = opts.enabled !== false;
  const key = `${enabled ? "on" : "off"}:${(states ?? []).join(",")}`;
  return useLive(
    useCallback(
      (rpc: CosRpc) =>
        enabled
          ? rpc
              .call("board_list", states === undefined ? null : { states: [...states] })
              .then((r) => r.items)
          : Promise.resolve<BoardItemDto[]>([]),
      // The array identity changes on every render; its contents do not.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [key],
    ),
    key,
    POLL_MS,
    "board",
  );
}

export function useProjects(): Live<ProjectRefDto[]> {
  return useLive(
    useCallback((rpc: CosRpc) => rpc.call("projects_list", null).then((r) => r.projects), []),
    "",
    POLL_MS,
    "projects",
  );
}

export interface SessionsLive {
  sessions: ExternalSession[];
  /** Server note explaining what the scan can and cannot see. */
  note: string;
  /** False until the first response lands, so callers can tell empty from loading. */
  loaded: boolean;
  error: string | null;
  refetch: () => void;
}

/** Claude Code sessions running on this machine outside bb. */
export function useSessions(): SessionsLive {
  const live = useLive(
    useCallback((rpc: CosRpc) => rpc.call("sessions_list", null), []),
    "",
    SESSIONS_POLL_MS,
    "sessions",
  );
  return {
    sessions: live.data?.sessions ?? [],
    note: live.data?.note ?? "",
    loaded: live.data !== null,
    error: live.error,
    refetch: live.refetch,
  };
}

/** Sessions that have not been imported into a worker yet. */
export function unimportedSessions(sessions: ExternalSession[]): ExternalSession[] {
  return sessions.filter((session) => session.importedWorkerName === null);
}

/** Sessions grouped by working directory, groups ordered by most recent activity. */
export function groupSessionsByCwd(
  sessions: ExternalSession[],
): { cwd: string; sessions: ExternalSession[] }[] {
  const groups = new Map<string, ExternalSession[]>();
  for (const session of sessions) {
    const bucket = groups.get(session.cwd);
    if (bucket === undefined) groups.set(session.cwd, [session]);
    else bucket.push(session);
  }
  const recency = (session: ExternalSession) => session.lastActivityAt ?? session.startedAt;
  const result = [...groups].map(([cwd, group]) => ({
    cwd,
    sessions: [...group].sort((a, b) => recency(b) - recency(a)),
  }));
  result.sort((a, b) => recency(b.sessions[0]) - recency(a.sessions[0]));
  return result;
}

export interface ThreadRole {
  worker: WorkerStatus | null;
  isChief: boolean;
}

/**
 * Every thread on the model and effort panel, in one call.
 *
 * Deliberately not N copies of `useThreadExecution`: that hook is per thread
 * and each instance mounts its own 20-second poll and reloads the provider
 * catalog on every realtime signal, so a dozen rows would be a dozen of both.
 */
export function useExecutionList(): Live<ExecutionListDto> {
  return useLive(useCallback((rpc: CosRpc) => rpc.call("execution_list", {}), []));
}

export function useWorkerForThread(threadId: string): Live<ThreadRole> {
  return useLive(
    useCallback((rpc: CosRpc) => rpc.call("worker_for_thread", { threadId }), [threadId]),
    threadId,
  );
}

/** What a thread runs with next turn, and the choices it could switch to. */
export function useThreadExecution(threadId: string): Live<ThreadExecution | null> {
  return useLive(
    useCallback((rpc: CosRpc) => rpc.call("thread_execution_get", { threadId }), [threadId]),
    threadId,
  );
}

// --- status helpers ---------------------------------------------------------

const BUSY_STATUSES = new Set([
  "active",
  "starting",
  "stopping",
  "provisioning",
  "waiting-for-host",
  "host-reconnecting",
]);

const PULSING_STATUSES = new Set(["active", "starting", "provisioning"]);

export function isBusyStatus(status: string): boolean {
  return BUSY_STATUSES.has(status);
}

export function isPulsingStatus(status: string): boolean {
  return PULSING_STATUSES.has(status);
}

/** The status string a row should render for a worker. */
export function workerStatus(worker: WorkerStatus): string {
  if (worker.missing) return "missing";
  if (worker.failed) return "error";
  return worker.displayStatus;
}

/** The level the server computed for this worker. */
export function rowUrgency(worker: WorkerStatus): Urgency {
  return worker.urgency;
}

/**
 * The lowercase note a row prints after the project, or null when the worker
 * is not asking for anything. Kept short: it shares a line with the name.
 *
 * A parsed deadline is a note too, so the reason a row is loud is a word and
 * not an inference from its colour. It is only surfaced on a row that is
 * already urgent or attention: a deadline can be parsed out of an `Open:` line
 * as well, and on a working or idle row the absence of a note is itself the
 * signal.
 */
export function workerNote(worker: WorkerStatus): string | null {
  if (worker.missing) return "thread missing";
  if (worker.failed) return "failed";
  if (worker.pendingInteraction) return "needs approval";
  // A timed model limit the plugin waits out itself: a fact, not an alarm. The
  // server already keeps `failed` false for it, so it lands in Idle, muted.
  if (worker.blockedUntil !== null) return `rate-limited until ${formatClock(worker.blockedUntil)}`;
  if (
    worker.dueHint !== null &&
    (worker.urgency === "urgent" || worker.urgency === "attention")
  ) {
    return `due ${worker.dueHint}`;
  }
  return null;
}

/**
 * The word a decision or routing row carries when nothing harder applies, or
 * null. One helper for the board, the homepage, the at-a-glance strip and the
 * Worker tab header, so a worker is never "waiting on you" on one surface and
 * "idle" on the next (attention always carries a word).
 */
export function levelWord(worker: WorkerStatus): string | null {
  if (worker.lastNeed === null || worker.lastNeed.trim() === "" || worker.needDismissed) return null;
  return worker.needAudience === "chief" ? "for the chief" : "waiting on you";
}

/**
 * Like `workerNote`, but always a word: the level word when the worker is
 * waiting on someone, else "working" or "idle". A run-state word is never a
 * level word, so callers colour only what `isLevelWord` says.
 */
export function workerStateWord(worker: WorkerStatus): string {
  return workerNote(worker) ?? levelWord(worker) ?? (isBusyStatus(worker.displayStatus) ? "working" : "idle");
}

/** True for words that may carry the attention or urgent colour; "working", "idle" and a rate limit never do. */
export function isLevelWord(word: string): boolean {
  return word !== "working" && word !== "idle" && word !== "for the chief" && !word.startsWith("rate-limited");
}

/** Why a worker sits in "Needs you", or null when it does not. */
export function needsYouReason(worker: WorkerStatus): string | null {
  if (worker.pendingInteraction) return "Waiting for your approval";
  if (worker.failed) return "Failed";
  if (worker.missing) return "Thread missing";
  return null;
}

/** The one line a "Needs you" card shows under the name. */
export function needsYouLine(worker: WorkerStatus): string | null {
  return worker.lastOutputExcerpt ?? worker.lastNeed;
}

/**
 * "No chief", "Chief failed", "Chief working", or "Chief idle".
 *
 * A chief whose turn errored out is dead until someone restarts it, so it must
 * never read as a resting one: the word carries the failure, not the dot.
 * "failed" is the word the rest of the plugin already uses for
 * an errored turn (`workerNote`, `needsYouReason`, the activity list).
 *
 * There is deliberately no "missing" arm: `chiefStatus` is the SDK's
 * `runtime.displayStatus`, and an absent chief already arrives as null.
 */
export function chiefLine(chiefStatus: string | null): string {
  if (chiefStatus === null) return "No chief";
  if (chiefStatus === "error") return "Chief failed";
  return isBusyStatus(chiefStatus) ? "Chief working" : "Chief idle";
}

/**
 * The colour the chief word carries, or undefined when it carries none. The
 * strip, the panel header and the home card all read this, so the one state
 * that is worth colouring cannot be coloured on one surface and not another.
 */
export function chiefTone(chiefStatus: string | null): string | undefined {
  return chiefStatus === "error" ? TEXT_URGENT : undefined;
}

export type Bucket = "needs-you" | "decisions" | "routing" | "working" | "idle";

/**
 * Where a worker belongs. Being blocked wins over everything; an outstanding
 * "Need:" line wins over the run state, because an unanswered question is the
 * thing worth acting on whether or not the worker kept going afterwards.
 *
 * A need the worker addressed to the chief is re-bucketed into "routing", not
 * dropped: it is still someone's open question, it is just not one the user has
 * to answer, so it must not sit in the decision count on the header, the
 * sidebar or the home card.
 *
 * A need the chief dismissed as answered out of band is nobody's open question,
 * so the row falls through to its run state. The server's `summary` counter
 * makes the same call, so a chip and its section cannot disagree.
 */
export function workerBucket(worker: WorkerStatus): Bucket {
  if (needsYouReason(worker) !== null) return "needs-you";
  if (worker.lastNeed !== null && worker.lastNeed.trim() !== "" && !worker.needDismissed) {
    return worker.needAudience === "chief" ? "routing" : "decisions";
  }
  return isBusyStatus(worker.displayStatus) ? "working" : "idle";
}

export interface Buckets {
  needsYou: WorkerStatus[];
  decisions: WorkerStatus[];
  /** Needs the worker addressed to the chief, not to the user. */
  routing: WorkerStatus[];
  working: WorkerStatus[];
  idle: WorkerStatus[];
  blockedThreads: OtherThread[];
  otherThreads: OtherThread[];
  /** Every live worker, whichever bucket it landed in. */
  total: number;
}

/** When the worker last had something to say, falling back to its last run. */
function reportedAt(worker: WorkerStatus): number {
  return worker.lastReportAt ?? worker.lastUsedAt;
}

/** A missing thread is worse than a failed turn, which is worse than a prompt. */
function blockedRank(worker: WorkerStatus): number {
  if (worker.missing) return 0;
  if (worker.failed) return 1;
  return 2;
}

const URGENCY_RANK: Record<Urgency, number> = { urgent: 0, attention: 1, active: 2, neutral: 3 };

/** Earliest deadline first, and a row without one sorts after every row with one. */
function byDueAt(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/** Urgent first, then by deadline, then oldest unanswered first. */
function byDecisionOrder(a: WorkerStatus, b: WorkerStatus): number {
  const rank = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
  if (rank !== 0) return rank;
  if (a.urgency === "urgent") {
    const due = byDueAt(a.dueAt, b.dueAt);
    if (due !== 0) return due;
  }
  return reportedAt(a) - reportedAt(b);
}

export function bucketRoster(roster: RosterData): Buckets {
  const needsYou: WorkerStatus[] = [];
  const decisions: WorkerStatus[] = [];
  const routing: WorkerStatus[] = [];
  const working: WorkerStatus[] = [];
  const idle: WorkerStatus[] = [];
  for (const worker of roster.workers) {
    if (worker.retired) continue;
    const bucket = workerBucket(worker);
    if (bucket === "needs-you") needsYou.push(worker);
    else if (bucket === "decisions") decisions.push(worker);
    else if (bucket === "routing") routing.push(worker);
    else if (bucket === "working") working.push(worker);
    else idle.push(worker);
  }
  const blockedThreads: OtherThread[] = [];
  const otherThreads: OtherThread[] = [];
  for (const thread of roster.others) {
    if (thread.pendingInteraction) blockedThreads.push(thread);
    else otherThreads.push(thread);
  }
  // A queue of things you owe someone an answer to reads oldest first: the
  // oldest item is the one most likely to have been forgotten.
  // Working and Idle are live feeds, so those stay newest first.
  const byRecency = (a: WorkerStatus, b: WorkerStatus) => b.lastUsedAt - a.lastUsedAt;
  needsYou.sort((a, b) => blockedRank(a) - blockedRank(b) || reportedAt(a) - reportedAt(b));
  blockedThreads.sort((a, b) => a.updatedAt - b.updatedAt);
  decisions.sort(byDecisionOrder);
  // Routing is the same queue shape as Decisions, just with a different reader.
  routing.sort(byDecisionOrder);
  working.sort(byRecency);
  idle.sort(byRecency);
  otherThreads.sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    needsYou,
    decisions,
    routing,
    working,
    idle,
    blockedThreads,
    otherThreads,
    total:
      needsYou.length + decisions.length + routing.length + working.length + idle.length,
  };
}

/**
 * One line of plain text out of whatever the worker wrote. Excerpts are cut
 * out of chat messages, so they arrive with markdown fences, bold markers,
 * heading hashes, and newlines in them; a clamped row wants none of that.
 */
export function plainLine(text: string): string {
  return text
    .replace(/```[a-z]*/gi, " ")
    // Backticks and asterisks only: an underscore is far more likely to be
    // part of a file name or a symbol than an emphasis marker.
    .replace(/[`*]/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Transcript size as "1.4 MB", or "0.0 MB" when there is no transcript. */
export function formatMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Claude's own session name, falling back to a short session id. */
export function sessionLabel(session: ExternalSession): string {
  return session.name ?? session.sessionId.slice(0, 8);
}

// --- time helpers -----------------------------------------------------------

/**
 * Compact age, e.g. "12s", "4m", "3h", "2d". The callers here append their own
 * " ago", so the suffix is off; the buckets are `format.ts`'s single table.
 */
export function relativeTime(at: number): string {
  return sharedRelativeTime(at, Date.now(), { suffix: false });
}

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** "Today", "Yesterday", or a short local date. */
export function dayLabel(at: number): string {
  const today = startOfDay(Date.now());
  const day = startOfDay(at);
  if (day === today) return "Today";
  if (day === today - 86_400_000) return "Yesterday";
  return new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: day < today - 300 * 86_400_000 ? "numeric" : undefined,
  });
}

export function dayKey(at: number): string {
  return String(startOfDay(at));
}
