// Pure helpers for the Board as teams. No imports.
//
// A flat list of every worker hides the managers, the one structure that
// would shorten the list. This groups workers under their manager, rolls each
// team up into one line, and opens only the teams with something for the user.

export type TeamLevel = "urgent" | "attention" | "active" | "neutral";

/** The fields this file reads off a worker. A structural subset of WorkerStatus. */
export interface TeamWorker {
  id: string;
  name: string;
  title: string | null;
  /** A string because the contract types it so; only the exact value "manager" makes one. */
  role: string;
  managerId: string | null;
  retired: boolean;
  urgency: TeamLevel;
  failed: boolean;
  missing: boolean;
  displayStatus: string;
  lastNeed: string | null;
  needAudience: "user" | "chief";
  needDismissed: boolean;
  lastOpen: string | null;
  lastDone: string | null;
  lastOutputExcerpt: string | null;
  blockedUntil: number | null;
  /** "tomorrow", "Sat 09-27": a deadline parsed out of the Need, or null. */
  dueHint?: string | null;
  /**
   * Stopped on a permission prompt or a question. Often with no Need line at
   * all, so wantsUser alone cannot see it, and the worker would read
   * "working" on a collapsed team while the strip above says "1 needs you".
   */
  pendingInteraction?: boolean;
}

const BUSY = new Set([
  "active",
  "starting",
  "provisioning",
  "waiting-for-host",
  "host-reconnecting",
  "stopping",
]);

export function isWorking(worker: Pick<TeamWorker, "displayStatus">): boolean {
  return BUSY.has(worker.displayStatus);
}

/** A Need addressed to the user that nobody has dismissed. */
export function wantsUser(worker: TeamWorker): boolean {
  return worker.lastNeed !== null && worker.needAudience === "user" && !worker.needDismissed;
}

export function isBroken(worker: TeamWorker): boolean {
  return worker.failed || worker.missing;
}

/** Stopped until the user answers a prompt: urgent, and never "working". */
export function isBlocked(worker: TeamWorker): boolean {
  return worker.pendingInteraction === true;
}

export interface Team<W extends TeamWorker = TeamWorker> {
  /** The manager's id, or null for the chief's own reports. */
  id: string | null;
  label: string;
  manager: W | null;
  members: W[];
  roll: { members: number; working: number; waiting: number; broken: number; blocked: number };
  /** Starts open when it holds something for the user. */
  open: boolean;
  level: TeamLevel;
}

const RANK: Record<TeamLevel, number> = { urgent: 0, attention: 1, active: 2, neutral: 3 };

/**
 * Workers grouped by manager, managers first by how loud they are.
 *
 * The manager heads its own team rather than sitting in it, so a manager that
 * failed shows on the team line rather than as one member among many. The
 * chief's direct reports are one more team, last, labelled for what it is.
 * Retired workers are left out entirely: the Board is who is available.
 *
 * A team is open when a member (or the manager) wants the user or is broken. That
 * is the whole rule, so a quiet team never opens itself and a team with a
 * failure never hides it.
 */
export function groupTeams<W extends TeamWorker>(workers: readonly W[]): Team<W>[] {
  const live = workers.filter((w) => !w.retired);
  const managers = live.filter((w) => w.role === "manager");
  const managerIds = new Set(managers.map((m) => m.id));
  const byManager = new Map<string | null, W[]>();
  for (const w of live) {
    if (w.role === "manager") continue;
    // A worker whose manager is retired or unknown reports to the chief.
    const key = w.managerId !== null && managerIds.has(w.managerId) ? w.managerId : null;
    const list = byManager.get(key) ?? [];
    list.push(w);
    byManager.set(key, list);
  }
  const make = (manager: W | null, members: W[]): Team<W> => {
    const everyone = manager === null ? members : [manager, ...members];
    // Blocked is its own count: folded into waiting, the team line would say
    // "1 waiting on you" in amber above a row saying "needs approval" in red.
    const waiting = everyone.filter((w) => wantsUser(w) && !isBlocked(w)).length;
    const blocked = everyone.filter(isBlocked).length;
    const broken = everyone.filter(isBroken).length;
    const working = everyone.filter(isWorking).length;
    const level = everyone.reduce<TeamLevel>(
      (worst, w) => (RANK[w.urgency] < RANK[worst] ? w.urgency : worst),
      "neutral",
    );
    return {
      id: manager?.id ?? null,
      label: manager === null ? "Reporting to the chief" : (manager.title ?? manager.name),
      manager,
      members: [...members].sort(memberOrder),
      roll: { members: members.length, working, waiting, broken, blocked },
      open: waiting > 0 || broken > 0 || blocked > 0,
      level,
    };
  };
  const teams = managers.map((m) => make(m, byManager.get(m.id) ?? []));
  teams.sort((a, b) => RANK[a.level] - RANK[b.level] || a.label.localeCompare(b.label));
  const direct = byManager.get(null) ?? [];
  if (direct.length > 0) teams.push(make(null, direct));
  return teams;
}

/** Inside a team: broken, then wanting the user, then working, then the rest, by name. */
function memberOrder(a: TeamWorker, b: TeamWorker): number {
  const weight = (w: TeamWorker) => (isBroken(w) || isBlocked(w) ? 0 : wantsUser(w) ? 1 : isWorking(w) ? 2 : 3);
  return weight(a) - weight(b) || (a.title ?? a.name).localeCompare(b.title ?? b.name);
}

/**
 * The team's one line: "8 on the team · 1 waiting on you". Only the facts that
 * are non-zero, loudest first, and "all idle" when there is nothing else to
 * say, so a quiet team reads as quiet rather than as a row of zeros.
 */
export function rollLine(team: Pick<Team, "roll" | "id"> & { level?: TeamLevel }): { text: string; tone: TeamLevel }[] {
  const { members, working, waiting, broken, blocked } = team.roll;
  // A waiting worker with a deadline inside 48h is urgent, and its row is red,
  // so the team line must not say "2 waiting on you" in amber above it. When
  // nothing failed or is blocked, the team's own level is what made it urgent.
  const waitingTone: TeamLevel =
    team.level === "urgent" && broken === 0 && blocked === 0 ? "urgent" : "attention";
  const size = team.id === null ? `${members}` : `${members} on the team`;
  const parts: { text: string; tone: TeamLevel }[] = [{ text: size, tone: "neutral" }];
  if (broken > 0) parts.push({ text: `${broken} failed`, tone: "urgent" });
  if (blocked > 0) parts.push({ text: `${blocked} need${blocked === 1 ? "s" : ""} approval`, tone: "urgent" });
  if (waiting > 0) parts.push({ text: `${waiting} waiting on you`, tone: waitingTone });
  if (working > 0) parts.push({ text: `${working} working`, tone: "neutral" });
  if (broken === 0 && blocked === 0 && waiting === 0 && working === 0) {
    parts.push({ text: "all idle", tone: "neutral" });
  }
  // One coloured word per line: only the loudest part keeps its
  // tone, and it is first after the size because the order above is loudest
  // first. Done here, in the pure helper, so a test holds it.
  let coloured = false;
  return parts.map((part) => {
    if (part.tone === "neutral") return part;
    if (coloured) return { ...part, tone: "neutral" as const };
    coloured = true;
    return part;
  });
}

/**
 * What one member row says, in words, and the state word in front of it.
 *
 * The execution label (`claude-code claude-opus-5-5[1m] medium`) is not here
 * on purpose: it is a setting, not news. The row says what the worker is
 * doing, and the model lives in the row's title attribute and the Execution
 * tab.
 */
export function memberLine(worker: TeamWorker, now: number): { state: string | null; tone: TeamLevel; text: string } {
  if (worker.missing) return { state: "thread missing", tone: "urgent", text: "" };
  if (worker.failed) return { state: "failed", tone: "urgent", text: worker.lastOutputExcerpt ?? "" };
  // Before "working": a blocked worker's thread is busy, but it is stopped on
  // a prompt only the user can answer.
  if (isBlocked(worker)) return { state: "needs approval", tone: "urgent", text: worker.lastNeed ?? "" };
  if (worker.blockedUntil !== null && worker.blockedUntil > now) {
    return { state: "rate-limited", tone: "neutral", text: worker.lastOpen ?? "" };
  }
  if (wantsUser(worker)) {
    // The word agrees with the dot. The server decides urgency (a deadline
    // inside 48h, or a day unanswered) and the dot paints it, so "waiting on
    // you" in amber beside a red dot would be two levels on one row. And the
    // deadline is said in words, because it is the reason the row is loud.
    const urgent = worker.urgency === "urgent";
    const due = worker.dueHint ?? null;
    return {
      state: due === null ? "waiting on you" : `due ${due}`,
      tone: urgent ? "urgent" : "attention",
      text: worker.lastNeed ?? "",
    };
  }
  if (isWorking(worker)) {
    return { state: "working", tone: "active", text: worker.lastOpen ?? worker.lastDone ?? "" };
  }
  if (worker.lastOpen !== null) return { state: null, tone: "neutral", text: `Open: ${worker.lastOpen}` };
  if (worker.lastDone !== null) return { state: null, tone: "neutral", text: worker.lastDone };
  return { state: null, tone: "neutral", text: "nothing open" };
}

/**
 * The opening sentence: does anything need the user, and what is running.
 *
 * Names at most two things that need the user, by worker, and counts the rest, so
 * the sentence stays one sentence at any board size. It is built from the same
 * rows the teams are, so it can never disagree with what is below it.
 */
export function boardSentence(workers: readonly TeamWorker[]): {
  needs: { id: string; name: string; what: string; tone: TeamLevel }[];
  moreNeeds: number;
  working: string[];
  quiet: boolean;
} {
  const live = workers.filter((w) => !w.retired);
  const needy = live.filter((w) => isBroken(w) || isBlocked(w) || wantsUser(w));
  const weightOf = (w: TeamWorker) => (isBroken(w) || isBlocked(w) ? 0 : w.urgency === "urgent" ? 1 : 2);
  // Most pressing first: broken, then urgent, then the rest, so the two named
  // in the sentence are the two that matter most rather than the first two.
  needy.sort((a, b) => weightOf(a) - weightOf(b));
  const needs = needy.slice(0, 2).map((w) => ({
    // The row to open, by id: titles are not unique across projects, and
    // looking the worker up by name could open the healthy one of two.
    id: w.id,
    name: w.title ?? w.name,
    what: isBroken(w)
      ? w.missing
        ? "thread missing"
        : "failed"
      : isBlocked(w)
        ? "needs approval"
        : w.dueHint
          ? `is due ${w.dueHint}`
          : "is waiting on you",
    // Same rule as the member row, so the sentence and the row agree.
    tone:
      isBroken(w) || isBlocked(w) || w.urgency === "urgent" ? ("urgent" as const) : ("attention" as const),
  }));
  const working = live.filter(isWorking).map((w) => w.title ?? w.name);
  return { needs, moreNeeds: Math.max(0, needy.length - 2), working, quiet: needy.length === 0 };
}
