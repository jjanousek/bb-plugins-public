
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

/** `bb proxy-usage --json` is read through this; see `proxyAccountUsage`. */
const execFile = promisify(execFileCb);

// bb-plugin-chief-of-staff - backend entry.
//
// One "chief" thread orchestrates work across projects by delegating to
// reusable worker threads. The chief gets native cos_* tools, the
// chief-of-staff skill, and injected instructions that forbid doing the work
// itself. Worker threads are keyed by (project, name) and reused so context
// is kept. Worker turn results are forwarded to the chief as messages, and
// every notable event is appended to the activity log the panel reads.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import {
  AVATAR_COMBINATIONS,
  avatarKey,
  avatarSvg,
  isKnownAvatar,
  pickAvatar,
  titleFor,
  type Avatar,
} from "./avatars";
import {
  rpcContract,
  type ActivityKind,
  type ExecutionCatalogDto,
  type ExecutionRowDto,
  type ExternalSession,
  type OtherThread,
  type Urgency,
  type WorkerStatus,
  type PermissionMode,
  type ReasoningLevel,
  type ThreadExecution,
} from "./contract";
import {
  modelChoices,
  permissionChoices,
  reasoningChoices,
  reasoningForModel,
  type CatalogModel,
  type CatalogProvider,
} from "./components/cos/execution-options";
import {
  collapseWhitespace,
  threadStatusMarks,
  sidebarFaces,
  type SidebarFace,
  type ThreadStatusMark,
  CHIEF_TITLE,
  OUTPUT_EXCERPT_MAX,
  REPORT_MAX_CHARS,
  createStore,
  describeInteraction,
  dispatchedBy,
  attributed,
  excerptOf,
  exhaustedPoolNote,
  findProject,
  flagString,
  formatClock,
  formatUsage,
  MIGRATIONS,
  normalizeName,
  parseArgs,
  isNeedDismissed,
  isNeedNew,
  needSignature,
  parseChiefLine,
  parseDisposition,
  parseDue,
  urgencyFrom,
  type UrgencyFacts,
  parseRateLimit,
  turnCountsAsUnread,
  shouldForwardFailure,
  type FailureForwardState,
  delegateWaitShortCircuit,
  resolveDelegateSender,
  PEER_LOOP_MAX,
  PEER_LOOP_WINDOW_MS,
  isPluginRelayedMessage,
  decidePeerRoute,
  type PeerLoopState,
  parseReasoningLevel,
  lastFinishedMessagesFrom,
  transcriptFromEvents,
  buildHandoverTranscript,
  runRehandover,
  folderMoveRefusal,
  folderMoveRequest,
  folderMoveHandover,
  defuseFileMentions,
  isFolderMovePath,
  estimateTokens,
  HANDOVER_MAX_TOKENS,
  type TranscriptMessage,
  type TranscriptRow,
  type HandoverTranscript,
  THREAD_EVENTS_PAGE_MAX,
  PLUGIN_ATTRIBUTION,
  requestedReportRoute,
  serverClockMatchesHome,
  HOME_TIME_ZONE,
  requestedReportDelivery,
  mergeParkedReports,
  memoryIndexFor,
  memoryRolesFrom,
  AGENTS_ROOT_SEGMENTS,
  AGENT_MEMORY_ROLES_DEFAULT,
  type MemoryIndexRead,
  parseStatusBlock,
  rosterReportText,
  turnOriginOf,
  requestForEndedTurn,
  turnProducedAgentMessage,
  type TurnOriginEvent,
  doubleHopLines,
  automationIdOf,
  automationFollowsDispatch,
  rosterContextLabel,
  compactionDecision,
  needForNote,
  needIdsOf,
  needDismissalPlan,
  needItemsHeldDue,
  type ObservedNeedItem,
  boardExpiresAt,
  boardExpiryDay,
  boardSendText,
  PLUGIN_NAME_RE,
  boardRef,
  boardRefsIn,
  boardRefDecision,
  BOARD_DONE_REF_MS,
  lastTypedAt,
  noteForUndispatchedTurn,
  managerChiefLineIsEcho,
  projectDefaultsPlaceholder,
  failureDetail,
  type FailureEvent,
  retryRefusal,
  type RetryEvent,
  chiefLineIsRepeat,
  endedOnCompaction,
  type CompactionEvent,
  type CompactionCandidate,
  type TurnRequestRow,
  relativeUnder,
  TOOL_CALL_BUDGET_MS,
  waitBudget,
  parseTeamLine,
  missingDispositionWord,
  liveDescription,
  sidebarParentThread,
  workerInstructions,
  parseTimeout,
  reasoningForSpawn,
  relativeTime,
  lastTaskLabel,
  buildExecutionList,
  type ExecutionRowSpec,
  projectNameFrom,
  lastActiveAt,
  levelForModelChange,
  resolveWorker,
  sectionMoves,
  shouldRetryAfterLimit,
  parseWorktreeRoots,
  pathUnder,
  spawnEnvironment,
  truncate,
  statusNote,
  truncateReport,
  unreachableThreadNote,
  reportAudience,
  resolveInScope,
  scopeRefusal,
  DISPATCH_TRAILER,
  chiefInstructions,
  chiefNeedsEscalation,
  NO_AUTO_PROVIDERS,
  inheritedPermissionMode,
  permissionModeFor,
  isQuotaFailure,
  isRawProviderError,
  formatProxyUsage,
  managerInstructions,
  chooseSteerReport,
  managerReportGap,
  scrubUntrusted,
  teamScope,
  scrubNote,
  boardSourceResolved,
  boardNeedWorker,
  spawnBriefFirstLine,
  BOARD_PRIORITIES,
  BOARD_PRIORITY_LABEL,
  fenceUntrusted,
  BOARD_AREAS,
  BOARD_AREA_LABEL,
  BOARD_STATES,
  boardItemsAddressedBy,
  boardMoverName,
  boardUndoneNote,
  composeAddressDraft,
  groupBoardItems,
  parseBoardArea,
  parseBoardState,
  type BoardArea,
  type BoardPriority,
  type BoardItem,
  type BoardMover,
  type BoardState,
  unknownWorkerRefusal,
  WORKER_REASONING_LEVELS,
  type ParsedDue,
  type ProjectRef,
  type Worker,
  type WorkerReasoningLevel,
} from "./core";
import { executionWords } from "./core";
import type { ProxyAccountUsage, Scope, SpawnEnvironment, WorkerRole } from "./core";
import {
  DIGEST_MAX_CHARS,
  digestTranscript,
  findTranscriptById,
  listExternalSessions,
  matchProject,
  type DigestResult,
  type ExternalSessionInfo,
  type ProjectPaths,
} from "./sessions";

const CHANGED = "cos-changed";
/**
 * Where new workers and the chief run unless a delegation pins otherwise.
 * Blank on purpose: blank means bb's project default provider and that
 * provider's default model, which works on any install. Set the
 * `chiefProviderId`, `chiefModel`, `workerProviderId` and `workerModel`
 * settings to the provider and model you want.
 */
const DEFAULT_CHIEF_PROVIDER = "";
const DEFAULT_CHIEF_MODEL = "";
const DEFAULT_WORKER_PROVIDER = "";
const DEFAULT_WORKER_MODEL = "";
/**
 * EXAMPLE list, edit it: the `acp-omp` models named to the chief as remodel
 * targets. List the models your own omp logins can run.
 */
const OMP_MODELS = [
  "anthropic/claude-opus-5-5",
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-haiku-4-5",
] as const;
/**
 * Workers and their child threads are dispatched with full access.
 *
 * Not `auto`: on a Cursor provider `permissionModeFor` downgrades auto to
 * accept-edits. The bar shows the LAST TURN's mode and the next dispatch
 * overwrites it from this default, so the default must be a mode every
 * provider honours.
 */
const DEFAULT_WORKER_PERMISSION_MODE = "full";
/**
 * The reasoning level a new worker starts at when nothing else decides.
 *
 * Without one bb takes the provider's own default, which is lower than any
 * worker wants. A Fable model overrides this with `FABLE_SPAWN_LEVEL`
 * (low and medium are the standard there), and an
 * explicit level overrides both.
 */
const DEFAULT_WORKER_REASONING_LEVEL: WorkerReasoningLevel = "high";

/**
 * The roots that want a worktree. Everything else gets the project's own
 * checkout, which is the safe direction: see `spawnEnvironment` in core.ts.
 *
 * Empty by default, so a stock install gives every project its own checkout.
 * Set the `worktreeRoots` setting to a folder whose repos need a worktree per
 * worker (for example repos where several workers commit at once and each
 * needs its own branch).
 */
const DEFAULT_WORKTREE_ROOTS = "";

/**
 * Short "provider model level" suffix for roster rows; the provider alone when
 * the model is unknown, and the level only when the row records one (adopted
 * workers and rows written without a level do not).
 */
/** The roster's label. `executionWords` is the shared body; "" is this caller's empty. */
function executionLabel(providerId: string | null, model: string | null, reasoningLevel: string | null = null): string {
  return executionWords(providerId, model, reasoningLevel) ?? "";
}
const KV_CHIEF = "chief.threadId";
/** When the user last reviewed the board items that closed on their own. */
const KV_AUTO_REVIEWED = "board.autoReviewedAt";
/**
 * bb's Notify parent setting (bb 0.47+, `threads.parent_notifications`), set
 * to off on every worker and manager thread this plugin spawns, adopts or
 * re-parents. This plugin routes their reports, so bb's own wake-up of the
 * parent on each finished turn would be a second copy of every report.
 * Spread, not written inline: the pinned SDK's
 * types (0.5.9) do not declare the field and refuse it in an object literal, while
 * bb's runtime passes it through on both `threads.spawn` and `threads.update`.
 */
const NOTIFY_PARENT_OFF = { parentNotifications: "off" } as const;
/** Sessions live in the home directory of whichever machine runs the bb server. */
const HOME_DIR = os.homedir();
/** This plugin's own folder: the loaded module's directory, or its parent when bb loads a build from `dist/`. */
const PLUGIN_DIR = (() => {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    return path.basename(dir) === "dist" ? path.dirname(dir) : dir;
  } catch {
    return process.cwd();
  }
})();
/** bb's own workspaces and worktrees live here; sessions inside them are bb threads, not external ones. */
const BB_DATA_DIR = path.join(HOME_DIR, ".bb");
const SESSIONS_NOTE = "Sessions are discovered on the bb server machine only.";
/** Hard ceiling for one import seed prompt, digests included. */
const SEED_MAX_CHARS = 150_000;
/** displayStatus values that mean a worker is doing something right now. */
const BUSY_STATUSES = new Set(["active", "starting", "provisioning"]);
/** The wider "the worker is mid-flight" set, used for urgency only. */
const ACTIVE_STATUSES = new Set([...BUSY_STATUSES, "waiting-for-host", "host-reconnecting", "stopping"]);
/** How often the sweep checks for rate limits that have lifted. */
const RATE_LIMIT_SWEEP_MS = 5 * 60 * 1000;
/**
 * How much of a turn's final message the rate-limit matcher reads. The refusal
 * is always the last thing the model wrote, and a long turn that merely
 * mentions "rate limit" in the middle of its work must not be mistaken for one.
 */
const RATE_LIMIT_TAIL_CHARS = 600;
/** A parked chief message this often refused is undeliverable; drop it rather than block the queue. */
const OUTBOX_MAX_ATTEMPTS = 12;

/** Local calendar date as YYYY-MM-DD, in the server's own zone. */
function isoDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isBusyStatus(displayStatus: string): boolean {
  return ACTIVE_STATUSES.has(displayStatus);
}

/** Long enough to collapse one changed() burst, short enough that nothing reads stale. */
const MEMO_TTL_MS = 1_000;

/**
 * Memoize an async build for MEMO_TTL_MS, keyed on its options. One changed()
 * makes every open surface refetch at once, and without this summary,
 * roster_list, the CLI and worker_for_thread would each rebuild the whole
 * roster and rescan the session registry from disk. Concurrent callers share
 * the in-flight promise, so a burst costs one build. A rejection is dropped so
 * the next caller can retry.
 */
/** A remodel is not started with less than this left before the tool deadline. */
const REMODEL_START_MARGIN_MS = 90_000;

/** The sidebar marks: long enough to share one build across windows polling at 5s. */
const THREAD_MARKS_TTL_MS = 3_000;

function shortMemo<A, V>(
  compute: (arg: A) => Promise<V>,
  keyOf: (arg: A) => string,
  ttlMs: number = MEMO_TTL_MS,
): (arg: A) => Promise<V> {
  const cache = new Map<string, { at: number; value: Promise<V> }>();
  return (arg: A) => {
    const key = keyOf(arg);
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < ttlMs) return hit.value;
    const value: Promise<V> = compute(arg).catch((error: unknown) => {
      if (cache.get(key)?.value === value) cache.delete(key);
      throw error;
    });
    cache.set(key, { at: now, value });
    for (const [staleKey, entry] of cache) {
      if (now - entry.at >= ttlMs) cache.delete(staleKey);
    }
    return value;
  };
}

function urgencyOf(w: UrgencyFacts, due: ParsedDue | null, now: number): Urgency {
  return urgencyFrom(w, due, now, isBusyStatus(w.displayStatus));
}

const CHIEF_BRIEFING = [
  "You are now my Chief of Staff. Read the chief-of-staff skill and follow it.",
  "Run cos_projects and cos_roster, then give me a short brief: which projects exist, which workers are active, and what you suggest we tackle first.",
  "Remember: you never do the work yourself. You delegate to workers and report back.",
].join("\n");


/**
 * The one paragraph that makes a worker reach for subagents.
 *
 * Whether a worker parallelises depends more on the SHAPE OF THE BRIEF than
 * on its model or level, which is why this rides on the brief rather than on
 * the worker or in the skill: a skill line reaches every turn including the
 * ones with nothing to parallelise.
 */
const FANOUT_HINT =
  "This brief has independent parts. Run them as two or three omp subagents (task and scout) in parallel and merge what comes back; do not work them in sequence.";

/** The brief as the worker receives it: the chief's text, the hint when asked for, then the standing contract. */
function withFirstLine(line: string | null, body: string): string {
  return line === null ? body : `${line}\n\n${body}`;
}

function withTrailer(message: string, fanoutHint = false): string {
  const body = fanoutHint ? `${message}\n\n${FANOUT_HINT}` : message;
  return `${body}\n\n${DISPATCH_TRAILER}`;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    chiefProject: { type: "project", label: "Chief project (default: personal project)" },
    chiefProviderId: { type: "string", label: "Chief provider id (blank = project default)", default: DEFAULT_CHIEF_PROVIDER },
    chiefModel: { type: "string", label: "Chief model (blank = provider default)", default: DEFAULT_CHIEF_MODEL },
    workerProviderId: {
      type: "string",
      label: "Default provider for new workers (blank = project default)",
      default: DEFAULT_WORKER_PROVIDER,
    },
    workerModel: {
      type: "string",
      label: "Default model for new workers (blank = provider default)",
      default: DEFAULT_WORKER_MODEL,
    },
    workerPermissionMode: {
      type: "select",
      label: "Worker permission mode",
      options: ["full", "auto", "accept-edits"],
      default: DEFAULT_WORKER_PERMISSION_MODE,
    },
    workerReasoningLevel: {
      type: "select",
      label: "Reasoning level for new workers",
      options: [...WORKER_REASONING_LEVELS],
      default: DEFAULT_WORKER_REASONING_LEVEL,
    },
    workerVisibility: {
      type: "select",
      label: "Worker thread visibility",
      options: ["visible", "hidden"],
      default: "visible",
    },
    threadMarks: {
      type: "select",
      label: "Mark sidebar rows that failed, are waiting on you, are rate-limited, or finished and are not read",
      options: ["on", "off"],
      default: "on",
    },
    sidebarFaces: {
      type: "select",
      label: "Show each worker's avatar in the sidebar, and Bloom while it works",
      options: ["on", "off"],
      default: "on",
    },
    worktreeRoots: {
      type: "string",
      label: "Paths whose projects get a worktree (comma separated; everything else gets the project's own checkout)",
      default: DEFAULT_WORKTREE_ROOTS,
    },
    memoryRoles: {
      type: "string",
      label: "Thread roles that load <memoryRoot>/<role>/MEMORY.md (comma separated: chief, or a manager's name)",
      default: AGENT_MEMORY_ROLES_DEFAULT.join(","),
    },
    memoryRoot: {
      type: "string",
      label: "Memory root, one folder per role ($HOME/agents by default)",
      default: path.join(os.homedir(), ...AGENTS_ROOT_SEGMENTS),
    },
  });

  /**
   * The memory settings `bb.agents.configure` reads. Configure is synchronous
   * and settings are not, so this copy is refreshed after every configure call
   * and at load; a changed setting lands on the turn after next at worst.
   */
  let memoryConfig = { roles: [...AGENT_MEMORY_ROLES_DEFAULT], root: path.join(os.homedir(), ...AGENTS_ROOT_SEGMENTS) };
  function refreshMemoryConfig(): void {
    void settings.get().then(
      (current) => {
        memoryConfig = { roles: memoryRolesFrom(current.memoryRoles), root: current.memoryRoot.trim() || memoryConfig.root };
      },
      (error: unknown) => bb.log.warn(`memory settings: ${String(error)}`),
    );
  }
  refreshMemoryConfig();
  /** One log line per role and state, not one per turn. */
  const memoryLogged = new Set<string>();
  /**
   * The instruction section for this role's memory index, or "" (see
   * `memoryIndexFor`). `workingDir` is the thread's environment path from the
   * configure context: in the role's own folder, omp loads the index itself.
   */
  function memorySection(role: string | null, workingDir: string | null): string {
    // Never throws: the chief's instructions are built from this outside any
    // try, and a memory problem must never cost a thread its instructions.
    try {
      refreshMemoryConfig();
      const { roles, root } = memoryConfig;
      const out = memoryIndexFor({
        role,
        roles,
        root,
        workingDir,
        readFolderContext: (dir) => {
          const parts: string[] = [];
          for (const name of ["CLAUDE.md", "AGENTS.md"]) {
            try {
              parts.push(readFileSync(path.join(dir, name), "utf8"));
            } catch {
              // Absent or unreadable: that file imports nothing.
            }
          }
          return parts.length === 0 ? null : parts.join("\n");
        },
        read: (r): MemoryIndexRead => {
          try {
            return { ok: true, text: readFileSync(path.join(root, r, "MEMORY.md"), "utf8") };
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, reason: "missing" };
            throw error;
          }
        },
      });
      if (role !== null && out.state !== "not-pilot" && out.state !== "loaded") {
        const key = `${role}:${out.state}`;
        if (!memoryLogged.has(key)) {
          memoryLogged.add(key);
          bb.log.info(`memory index for ${role}: ${out.state} (${path.join(root, role, "MEMORY.md")})`);
        }
      }
      return out.text === null ? "" : `\n\n${out.text}`;
    } catch (error) {
      bb.log.warn(`memory index for ${role ?? "worker"}: ${String(error)}`);
      return "";
    }
  }

  // Worker results reach the chief (or the worker's manager) through this
  // plugin only, never through bb's native parent notification.

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = createStore(db);
  let chiefThreadId: string | null = (await bb.storage.kv.get<string>(KV_CHIEF)) ?? null;
  /**
   * The board item a boarding note names ("on the board as 00c0ffee"), when
   * it names exactly one live item. A note naming two ("... as <id> and
   * <id>") cannot say which question went where, so it links nothing.
   */
  function boardItemNamedIn(note: string | null, live: readonly BoardItem[]): BoardItem | null {
    const prefix = /on the board as ([0-9a-f]{8})(?! and)/.exec(note ?? "")?.[1];
    return prefix === undefined ? null : (live.find((candidate) => candidate.id.startsWith(prefix)) ?? null);
  }

  /**
   * Give a Need that has no ids yet its ids: each live worker's last report
   * with no need_items rows is treated as already sent, and as dismissed,
   * and on its board item, when its text was. Without this the next note
   * would send every open question again under a new id, and the chief
   * would board it again.
   */
  function seedNeedItems(): void {
    try {
      const now = Date.now();
      const live = store.boardList({ states: ["open", "addressed"], limit: 500 });
      for (const worker of store.list()) {
        if (store.needItems(worker.id).length > 0) continue;
        const need = parseStatusBlock(worker.lastReportText).need;
        if (need === null) continue;
        const at = worker.lastReportTextAt ?? now;
        const ids = needIdsOf(store.observeNeed(worker.id, need, { now: at }));
        store.markNeedItemsSent(ids, at);
        if (!isNeedDismissed(worker, need)) continue;
        store.dismissNeedItems(ids, worker.needDismissedNote, worker.needDismissedAt ?? at);
        const item = boardItemNamedIn(worker.needDismissedNote, live);
        if (item !== null) store.linkNeedItemsToBoard(ids, item.id);
      }
    } catch (error) {
      bb.log.warn(`need ids: could not seed from the last reports: ${String(error)}`);
    }
  }
  seedNeedItems();

  /**
   * Once, behind a kv flag. A dismissal or a "seen" mark stored against only
   * the lead-in of a Need such as `Need: the user, two answers:` does not
   * match the same Need parsed with its list, so a dismissed Need would count
   * as a decision again. This moves those marks to the whole Need and
   * dismisses its questions. Once only: as a standing rule it would silence a
   * new list written under a lead-in that was dismissed bare.
   */
  const KV_NEED_LEADIN_MOVED = "needIds.leadInSignaturesMoved";
  async function moveLeadInSignatures(): Promise<void> {
    if ((await bb.storage.kv.get<boolean>(KV_NEED_LEADIN_MOVED)) === true) return;
    try {
      const now = Date.now();
      const live = store.boardList({ states: ["open", "addressed"], limit: 500 });
      for (const worker of store.list()) {
        const need = parseStatusBlock(worker.lastReportText).need;
        if (need === null) continue;
        // A lead-in-only signature stops before the first numbered line.
        const lead = need.split(/\s\d{1,2}[.)]\s/)[0] ?? need;
        if (lead === need) continue;
        const leadSig = needSignature(lead);
        const sig = needSignature(need);
        if (leadSig === null || sig === null || leadSig === sig) continue;
        if (worker.needSeenSig === leadSig) store.markNeedSeen([{ id: worker.id, sig }], worker.needSeenAt ?? now);
        if (worker.needDismissedSig !== leadSig) continue;
        const at = worker.needDismissedAt ?? now;
        store.dismissNeed(worker.id, sig, worker.needDismissedNote, at);
        const ids = needIdsOf(store.observeNeed(worker.id, need, { now: worker.lastReportTextAt ?? now }));
        store.dismissNeedItems(ids, worker.needDismissedNote, at);
        const item = boardItemNamedIn(worker.needDismissedNote, live);
        if (item !== null) store.linkNeedItemsToBoard(ids, item.id);
        bb.log.info(`need ids: ${worker.name}'s dismissal was taken on the bare lead-in; it now covers the whole Need (${ids.join(", ")})`);
      }
      await bb.storage.kv.set(KV_NEED_LEADIN_MOVED, true);
    } catch (error) {
      bb.log.warn(`need ids: could not move lead-in signatures, will retry on the next load: ${String(error)}`);
    }
  }
  await moveLeadInSignatures();
  /**
   * Spawns in flight, so configure() can classify a thread before its id is
   * known. Keyed by project id and title, because worker names are unique only
   * inside a project: two same-named workers spawning at once in different
   * projects must not get each other's instructions.
   */
  /** One in-flight spawn per project-and-name, so a concurrent pair cannot both insert. */
  const spawnLocks = new Map<string, Promise<void>>();
  const pendingSpawns = new Map<
    string,
    | { kind: "chief" }
    | { kind: "worker"; name: string; projectName: string }
    | { kind: "manager"; name: string; projectName: string }
  >();
  const spawnKey = (projectId: string, title: string) => `${projectId}::${title}`;
  /**
   * Worker threads a caller is actively waiting on, mapped to WHO is waiting.
   *
   * The value is the waiter's thread id, or null for the plugin waiting on its
   * own behalf (a remodel's orientation turn). A bare Set would record only
   * THAT someone is waiting: a manager blocked in `cos_wait` on its own team
   * member would then suppress the report to the CHIEF too, including a
   * failure and a `Chief:` escalation, and invisibly, because the suppression
   * is the normal path when the waiter really is the audience.
   */
  /**
   * Every message the plugin puts into a thread goes through here, so omp
   * cannot turn an at-sign path in it into an attached file
   * (`defuseFileMentions`): a relayed worker report that names files would
   * otherwise attach them to the reader's turn.
   * Spawn prompts get the same treatment at their call sites.
   */
  function sendToThread(args: Parameters<typeof bb.sdk.threads.send>[0]): ReturnType<typeof bb.sdk.threads.send> {
    return bb.sdk.threads.send({
      ...args,
      input: args.input.map((part) => ("text" in part && typeof part.text === "string" ? { ...part, text: defuseFileMentions(part.text) } : part)),
    } as typeof args);
  }

  const waitingOn = new Map<string, Map<symbol, string | null>>();

  /** Register a waiter and return the undo, so two waiters on one worker cannot clobber each other. */
  function addWaiter(workerThreadId: string, waiter: string | null): () => void {
    const token = Symbol("wait");
    const waiters = waitingOn.get(workerThreadId) ?? new Map<symbol, string | null>();
    waiters.set(token, waiter);
    waitingOn.set(workerThreadId, waiters);
    return () => {
      const live = waitingOn.get(workerThreadId);
      if (live === undefined) return;
      live.delete(token);
      if (live.size === 0) waitingOn.delete(workerThreadId);
    };
  }

  /** Is anyone waiting on this worker who will deliver the report themselves? */
  function waitedForBy(workerThreadId: string, reader: string | null): boolean {
    const waiters = waitingOn.get(workerThreadId);
    return waiters !== undefined && [...waiters.values()].includes(reader);
  }

  /**
   * The plugin waiting on its own turn, as distinct from a caller that has no
   * thread id.
   *
   * Both must not be `null`: a user running `bb cos wait` from a plain
   * terminal has no `ctx.threadId`, so that wait would look like the plugin's
   * and swallow the report to the chief entirely, a FAILED one included.
   * Nobody is owed the plugin's own orientation turn; everybody is still owed
   * a report when a user happens to be watching one. A `\0` prefix cannot
   * collide with a thread id.
   */
  const PLUGIN_WAIT = "\0plugin-internal";

  /** When a tool call started now must have answered; see `TOOL_CALL_BUDGET_MS`. */
  const toolDeadline = () => Date.now() + TOOL_CALL_BUDGET_MS;
  const WAIT_TIMEOUT_DESCRIPTION =
    "Seconds to wait, default 600. A tool call returns after about four minutes whatever this says, because bb ends a plugin tool call at 300 seconds; call cos_wait again to keep waiting.";

  /** One row of bb.sdk.threads.list, the cheap source for status and titles. */
  type ListedThread = Awaited<ReturnType<typeof bb.sdk.threads.list>>[number];
  /** One thread as bb.sdk.threads.get returns it; the SDK does not export the type. */
  type FetchedThread = Awaited<ReturnType<typeof bb.sdk.threads.get>>;

  const changed = () => bb.realtime.publish(CHANGED, { at: Date.now() });

  /** Append one activity row and wake the panel. */
  function record(
    kind: ActivityKind,
    entry: {
      excerpt: string;
      workerName?: string | null;
      projectName?: string | null;
      threadId?: string | null;
      unread?: boolean;
    },
  ): void {
    store.logActivity({ kind, ...entry });
    changed();
  }

  /**
   * Retire a worker and say so when that put a team back on the chief.
   *
   * `store.retire` cascades, so a caller that discards what it returns would
   * re-parent a manager's whole team with nothing on any surface. Most
   * callers are automatic (a thread bb says is gone, the rate-limit sweep,
   * and `forget`), which is exactly when nobody is watching.
   */
  function retireWorker(worker: { id: string; name: string; threadId?: string }, projectName: string | null, threadId: string | null): void {
    // Anything parked FOR this worker goes to the chief before the row dies.
    // This lives HERE rather than at the call sites because most of them
    // are automatic: a thread bb says is gone, the rate-limit sweep, and
    // forget. Parked reports addressed to a thread nobody will read again sit
    // for OUTBOX_MAX_ATTEMPTS sweeps and are then escalated as undeliverable.
    const dying = worker.threadId ?? threadId;
    if (dying) store.retargetOutbox(dying, null);
    const { orphaned } = store.retire(worker.id);
    if (orphaned.length === 0) return;
    record("retire", {
      workerName: worker.name,
      projectName,
      threadId,
      excerpt: `${worker.name} was retired and managed ${orphaned.length} worker${orphaned.length === 1 ? "" : "s"}; ${orphaned.join(", ")} now report${orphaned.length === 1 ? "s" : ""} to the chief.`,
    });
  }

  // ---------- helpers ----------

  async function listProjects(): Promise<ProjectRef[]> {
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    return projects.map((p) => {
      // The DEFAULT source, falling back to the first. Same rule the
      // `cos_projects` tool already prints a path with.
      const source = p.sources.find((s) => s.isDefault) ?? p.sources[0];
      return {
        id: p.id,
        name: p.name,
        kind: p.kind,
        path: source?.path ?? null,
        hostId: source?.hostId ?? null,
      };
    });
  }

  /**
   * `listProjects` for sites that only need a name: a failed read warns and
   * returns [], so the caller prints the project id instead, and a
   * projects.list hiccup cannot drop a rate-limited record or skip a retry
   * sweep round. Resolving and finding a project
   * still use the throwing version, since a guess there acts on the wrong one.
   */
  async function listProjectsOrEmpty(why: string): Promise<ProjectRef[]> {
    try {
      return await listProjects();
    } catch (error) {
      bb.log.warn(`${why}: could not list projects, showing ids: ${String(error)}`);
      return [];
    }
  }

  /** bb's fixed id for the personal project. */
  const PERSONAL_PROJECT_ID = "proj_personal";

  /**
   * Where a spawned worker's files land. The rule and its reasoning are in
   * `spawnEnvironment` (core.ts), which is pure and tested; this reads the
   * setting and looks for a reusable sibling, and decides nothing itself.
   *
   * Async, because it may look up a sibling environment. Returning
   * `project-default` for every non-personal project would put workers on
   * invisible `bb/` branches.
   */
  async function environmentFor(project: ProjectRef): Promise<SpawnEnvironment> {
    const current = await settings.get();
    const roots = parseWorktreeRoots(current.worktreeRoots);
    // Only asked in the case it can answer: a checkout project with a path. A
    // worktree root takes `project-default` and bb does its own reuse there, and
    // a project with no path has nothing to match against.
    const wantsCheckout =
      project.kind !== "personal" &&
      project.path !== null &&
      !roots.some((root) => pathUnder(project.path!, root));
    const reusableEnvironmentId = wantsCheckout ? await siblingEnvironment(project) : null;
    return spawnEnvironment({
      projectKind: project.kind,
      projectPath: project.path,
      hostId: project.hostId,
      worktreeRoots: roots,
      reusableEnvironmentId,
    });
  }

  /**
   * A live environment already serving this project AT ITS OWN PATH, or null.
   *
   * There is no `environments.list` in the SDK, so this reads the project's
   * newest live threads and resolves their environments. Bounded to
   * `SIBLING_LOOKUP_MAX` because in a checkout project one environment
   * usually serves every thread, so the first hit is almost always the first
   * thread.
   *
   * A failed read returns null, which falls through to the explicit checkout.
   * That is the safe direction here: the worst case is a second environment row
   * at a path bb already tolerates two rows for, not a worker in the wrong
   * directory.
   */
  const SIBLING_LOOKUP_MAX = 5;
  async function siblingEnvironment(project: ProjectRef): Promise<string | null> {
    if (project.path === null) return null;
    try {
      const threads = await bb.sdk.threads.list({ projectId: project.id, limit: SIBLING_LOOKUP_MAX });
      const seen = new Set<string>();
      for (const thread of threads) {
        const id = thread.environmentId;
        if (typeof id !== "string" || id === "" || seen.has(id)) continue;
        seen.add(id);
        const env = await environmentOrNull(id);
        if (env === null) continue;
        if (env.projectId === project.id && env.path === project.path) return id;
      }
      return null;
    } catch (error) {
      bb.log.warn(`sibling environment lookup for ${project.name}: ${String(error)}`);
      return null;
    }
  }

  /**
   * What a worker's thread is actually set to run at, read from the thread.
   *
   * The roster carries no `model` or `reasoning_level` columns:
   * a model changed by hand in bb's composer never reaches this plugin's
   * write paths, so a stored copy would go on printing the value written at
   * spawn. A cached copy of a value you cannot observe changing is a second
   * source of truth, not a cache.
   *
   * A failed read returns nulls, and `executionLabel` renders a null model as
   * "?" rather than omitting it, so "could not look" never renders as "nothing
   * set". `defaultExecutionOptions` always carries a model when it answers at
   * all, so a null here only ever means the read did not land.
   */
  async function workerExecution(
    threadId: string,
  ): Promise<{ model: string | null; reasoningLevel: string | null }> {
    try {
      const current = await bb.sdk.threads.defaultExecutionOptions({ threadId });
      return current === null
        ? { model: null, reasoningLevel: null }
        : { model: current.model, reasoningLevel: current.reasoningLevel };
    } catch {
      return { model: null, reasoningLevel: null };
    }
  }

  async function threadOrNull(threadId: string) {
    try {
      return await bb.sdk.threads.get({ threadId });
    } catch {
      return null;
    }
  }

  /**
   * Read a thread, telling a gone thread apart from an unreachable one. Delegate
   * retires a worker whose thread is gone; a host restart or a network blip must
   * never do the same to a healthy worker.
   */
  type ThreadState =
    | { kind: "ok"; thread: FetchedThread }
    | { kind: "gone" }
    | { kind: "unreachable"; error: string };

  /**
   * The raw read. "gone" here means only that bb says there is no such thread;
   * whether an archived or deleted thread counts as gone is a policy the caller
   * picks, and `threadState` is that policy for the callers that retire, skip
   * or replace a worker. `readWorker` deliberately does not want it: reading an
   * archived worker's last message is a legitimate thing to do.
   */
  async function readThread(threadId: string): Promise<ThreadState> {
    try {
      return { kind: "ok", thread: await bb.sdk.threads.get({ threadId }) };
    } catch (error) {
      const text = String((error as { message?: string } | null)?.message ?? error);
      // "bb has no such thread" is a fact about the worker; anything else is a
      // fact about the host, and must not retire anyone.
      if (/not[_ ]?found|404|no such thread|does not exist|unknown thread/i.test(text)) return { kind: "gone" };
      return { kind: "unreachable", error: text };
    }
  }

  async function threadState(threadId: string): Promise<ThreadState> {
    const read = await readThread(threadId);
    if (read.kind !== "ok") return read;
    if (read.thread.deletedAt !== null || read.thread.archivedAt !== null) return { kind: "gone" };
    return read;
  }

  async function setChief(threadId: string | null) {
    chiefThreadId = threadId;
    if (threadId === null) await bb.storage.kv.delete(KV_CHIEF);
    else await bb.storage.kv.set(KV_CHIEF, threadId);
    changed();
  }

  /**
   * Return the chief thread id, spawning the chief only when it is really gone.
   *
   * Two things this must not do.
   *
   * It must not read "I could not look" as "it was deleted". `threadOrNull`
   * swallows every error into null, so on that read a host hiccup would forget
   * the live chief, because `setChief(null)` deletes the kv row, and spawn a
   * second one beside it while every parked report and the roster's own
   * [new N] still point at the first. `threadState` is the read that tells a gone thread
   * from an unreachable one, and an unreachable chief is refused rather than
   * replaced: `bb cos reset-chief` is how a chief is forgotten on purpose.
   *
   * And it must not run twice at once. Nothing between the read and
   * `setChief` is atomic, so two callers arriving together both see no chief,
   * both spawn, and the second write wins while the first thread is left
   * holding the briefing with nothing pointing at it. `chiefEnsure` is the
   * single flight. It covers the whole function rather than the spawn alone,
   * because the read is what the decision rests on.
   */
  let chiefEnsure: Promise<{ threadId: string; created: boolean }> | null = null;
  async function ensureChief(): Promise<{ threadId: string; created: boolean }> {
    if (chiefEnsure !== null) return chiefEnsure;
    const run = ensureChiefOnce();
    chiefEnsure = run;
    try {
      return await run;
    } finally {
      chiefEnsure = null;
    }
  }

  async function ensureChiefOnce(): Promise<{ threadId: string; created: boolean }> {
    if (chiefThreadId) {
      const state = await threadState(chiefThreadId);
      if (state.kind === "ok") return { threadId: chiefThreadId, created: false };
      if (state.kind === "unreachable") {
        throw new Error(
          `Could not read the chief thread ${chiefThreadId} (${state.error}). Nothing was changed and no thread was created. Try again; if the chief really is gone, \`bb cos reset-chief\` forgets it on purpose.`,
        );
      }
      await setChief(null);
    }
    const current = await settings.get();
    const projects = await listProjects();
    const project =
      (current.chiefProject ? projects.find((p) => p.id === current.chiefProject) : undefined) ??
      projects.find((p) => p.kind === "personal") ??
      projects[0];
    if (!project) throw new Error("No project available to host the chief thread.");
    pendingSpawns.set(CHIEF_TITLE, { kind: "chief" });
    try {
      const chiefPerm = permissionModeFor(current.chiefProviderId || DEFAULT_CHIEF_PROVIDER, current.workerPermissionMode);
      const thread = await bb.sdk.threads.spawn({
        projectId: project.id,
        environment: await environmentFor(project),
        prompt: defuseFileMentions(CHIEF_BRIEFING),
        title: CHIEF_TITLE,
        permissionMode: chiefPerm,
        ...(current.chiefProviderId ? { providerId: current.chiefProviderId } : {}),
        ...(current.chiefModel ? { model: current.chiefModel } : {}),
      });
      await bb.storage.kv.set(`${KV_PERMISSION_PREFIX}${thread.id}`, chiefPerm).catch(() => {});
      await setChief(thread.id);
      record("chief-created", {
        projectName: project.name,
        threadId: thread.id,
        excerpt: `Chief thread created in ${project.name}.`,
      });
      bb.log.info(`chief thread created: ${thread.id} in ${project.name}`);
      return { threadId: thread.id, created: true };
    } finally {
      pendingSpawns.delete(CHIEF_TITLE);
    }
  }

  interface DelegateInput {
    project: string;
    worker: string;
    message: string;
    description?: string;
    wait?: boolean;
    timeoutSeconds?: number;
    signal?: AbortSignal;
    /** Pin a NEW worker to a provider and model instead of the plugin defaults. */
    providerId?: string;
    /** Model for this turn. On a new worker it pins the thread; on an existing one it runs this turn only. */
    model?: string;
    /**
     * Reasoning level, one of `WORKER_REASONING_LEVELS`. On a new worker it
     * pins the thread; on an existing one it runs this turn only, exactly like
     * model. Blank or absent means the workerReasoningLevel setting.
     */
    reasoningLevel?: string;
    /** What the caller may dispatch to. `delegate` checks it itself; see the check by the lookup. */
    scope: Scope;
    /**
     * Tell the worker this brief has independent parts and to run two or three
     * omp subagents (task and scout) in parallel. Set it when you can NAME the
     * parts; a hint on indivisible work just spends tokens.
     */
    fanoutHint?: boolean;
    /**
     * Spawn this as a manager rather than a worker. Only `spawnManager` passes
     * it, and only with a chief scope, because the spawn guard above already
     * refuses any non-chief caller that would create a row at all.
     *
     * It goes through `delegate` rather than a spawn of its own so a manager
     * inherits everything on this path: the per-name spawn lock, the
     * two-call level and model pin, `brand`, and the exhausted-pool message.
     */
    role?: WorkerRole;
    /**
     * The thread that asked for this dispatch: the chief when the chief called
     * cos_delegate, the calling worker's thread when a worker ran
     * `bb cos delegate`, null when it came from the board. It travels to bb as
     * the message's sender and decides `last_dispatch_by`.
     */
    senderThreadId?: string | null;
    /** When a tool caller must have its answer: bb ends a plugin tool call at 300s. Null on the CLI, which is not cut. */
    deadlineAt?: number | null;
    /**
     * Create the worker when the project has no worker by that name. Off by
     * default, so a typo is refused as an unknown name rather than spawning a
     * thread and a session.
     */
    spawn?: boolean;
  }

  interface DelegateResult {
    /** Human text for a tool result, the CLI, or a toast. */
    text: string;
    /** The worker thread, or null when the request could not be routed. */
    threadId: string | null;
    reused: boolean;
    /** How bb took the message: sent to an idle worker, queued behind its running turn, or nothing was sent. */
    delivery: "sent" | "queued" | "deferred" | "none";
  }

  /**
   * Pin the level, and the model when one was named, onto a thread that was
   * just spawned. Returns what to tell the caller, empty when both landed.
   *
   * `threads.spawn` takes a reasoningLevel and applies it to the spawn TURN
   * only; it writes no override. Without a pin the override stays NULL and
   * every later turn inherits its predecessor's level, so one turn sent at a
   * different level would re-level the worker permanently.
   *
   * TWO calls, not one, and the level first. A model can be refused by
   * `threads.update` with HTTP 400 when it is not in the provider's catalog,
   * even though `threads.spawn` accepts it, and a single combined update
   * would take the level down with it. The level is a plain enum and always
   * lands, so it goes on its own.
   *
   * Non-fatal on purpose: the worker exists either way, and a spawn undone
   * because a pin failed would be worse than a worker running at the level it
   * was spawned with. Never silent, though: a pin that fails unseen leaves the
   * roster claiming a level the thread does not have.
   *
   * Here rather than inline because every spawn site that sets a level has to
   * pin it (`delegate`, `remodelOne`, `remodelChief`). A site that skipped it
   * would put the worker back in the inheritance window with nothing
   * reporting the difference, because `workerExecution` reads the RESOLVED
   * level and shows the intended value either way.
   */
  async function pinExecution(
    threadId: string,
    reasoningLevel: WorkerReasoningLevel,
    model: string | null,
  ): Promise<string> {
    let note = "";
    try {
      await bb.sdk.threads.update({ threadId, reasoningLevel });
    } catch (error) {
      note += ` The level could not be pinned to the thread (${String(error)}), so it will follow whatever its last turn ran at until ${"`"}cos_relevel${"`"} is used.`;
    }
    if (model) {
      try {
        await bb.sdk.threads.update({ threadId, model });
      } catch {
        // Worth knowing and not worth alarming: the thread is already running
        // this model, since the spawn set it. Only the pin is missing, so the
        // model follows the last turn.
        note += ` The model was not pinned to the thread (${model} is not in this provider's catalog), so it follows the last turn rather than being fixed.`;
      }
    }
    return note;
  }

  async function callerProviderOf(threadId: string | null): Promise<string | null> {
    if (!threadId) return null;
    const known = store.byThread(threadId);
    if (known?.providerId) return known.providerId;
    return (await threadOrNull(threadId))?.providerId ?? null;
  }
  async function delegate(input: DelegateInput): Promise<DelegateResult> {
    const problem = (text: string): DelegateResult => ({ text, threadId: null, reused: false, delivery: "none" });
    const projects = await listProjects();
    const project = findProject(projects, input.project);
    if (!project) {
      // SCOPED, like `unknownWorkerRefusal` two guards below. Listing every
      // project WITH its id to any caller would let one call with a nonsense
      // project name rebuild the enumeration the team filter on cos_roster
      // and cos_projects exists to withhold.
      const mayEnumerate = input.scope.kind === "chief" || input.scope.kind === "none";
      return problem(
        mayEnumerate
          ? `Unknown project "${input.project}". Known: ${projects.map((p) => `${p.name} (${p.id})`).join(", ")}.`
          : `No project "${input.project}" that you can reach. Nothing was sent.`,
      );
    }
    const name = normalizeName(input.worker);
    if (name === "") return problem("Worker name must contain letters or digits.");
    const message = input.message.trim();
    if (message === "") return problem("Message is empty.");
    const wantedLevel = parseReasoningLevel(input.reasoningLevel);
    if (!wantedLevel.ok) return problem(`${wantedLevel.error} Nothing was sent.`);
    const current = await settings.get();
    const resolvedSender = resolveDelegateSender(input.senderThreadId, chiefThreadId);
    const sender = resolvedSender.sender;
    const by = dispatchedBy(input.senderThreadId ?? null, chiefThreadId, managerWorkerId);
    const chief = chiefThreadId;

    let worker = store.byProjectName(project.id, name);
    // Scope. `delegate` does not go through resolveInScope because it is the
    // one path that may CREATE the worker it names, so it looks the row up
    // itself and the check has to live here too.
    //
    // Order matters: an existing worker is scope-checked, and a name that does
    // not exist is refused for the spawn right below rather than here, so a
    // manager cannot tell "not on your team" from "does not exist" by which
    // refusal it gets back.
    if (worker !== null) {
      const refusal = scopeRefusal(input.scope, worker);
      if (refusal !== null) return problem(refusal);
    }
    let reused = false;
    if (worker) {
      const state = await threadState(worker.threadId);
      // Only a thread bb says is gone retires the worker. An unreachable host
      // must not retire a healthy worker and then spawn a duplicate beside it.
      if (state.kind === "gone") {
        retireWorker(worker, project.name, worker.threadId);
        worker = null;
      } else if (state.kind === "unreachable") {
        return problem(
          `Worker ${project.name}:${worker.name} could not be reached (${state.error}). Nothing was sent and the worker is untouched. Try again in a moment.`,
        );
      }
    }
    // Creating a worker is the chief's alone, and this check sits HERE rather
    // than beside the scope check above because this is where `worker` reaches
    // its final value. Above it, the gone-thread branch has not run yet: a
    // manager could archive its own team member's thread, delegate to the same
    // name with spawn, and the row would be null by the time the spawn ran
    // while the guard had already passed on the live row.
    if (worker === null && input.spawn === true && input.scope.kind !== "chief") {
      return problem(
        `Only the Chief of Staff creates workers. Ask it to add ${name} to your team, then delegate again.`,
      );
    }
    let delivery: DelegateResult["delivery"] = "none";
    /** Non-empty when a spawn's level could not be written to the thread. Never silent. */
    let pinNote = "";
    if (worker) {
      // A turn sent into a rate limit fails on arrival and would itself count
      // as the one retry, so the dispatch is refused with the time instead.
      if (worker.blockedUntil !== null && worker.blockedUntil > Date.now()) {
        const blockedExec = await workerExecution(worker.threadId);
        return problem(
          `Worker ${project.name}:${worker.name} is rate-limited until ${formatClock(worker.blockedUntil)} (${executionLabel(worker.providerId, blockedExec.model, blockedExec.reasoningLevel) || "its model"} refused the last turn). Nothing was sent. Delegate again after that time, or remodel the worker onto another model.`,
        );
      }
      // A remodel still finishing in the background holds the plugin's own
      // waiter on this thread. A brief queued behind the orientation turn would
      // end while that waiter is up, and its report would be dropped as the
      // plugin's own. Refused until the [Remodel] message says it is done.
      if (waitedForBy(worker.threadId, PLUGIN_WAIT)) {
        return problem(
          `Worker ${project.name}:${worker.name} is still finishing a remodel: its first turn on the new thread has not ended. Nothing was sent. Delegate again after the [Remodel] message arrives.`,
        );
      }
      // queue-if-active, never auto: a brief sent into a running turn would
      // race it. Queued means bb starts it the moment the current turn ends.
      const trailerBody = withTrailer(message, input.fanoutHint === true);
      const sent = await sendToThread({
        threadId: worker.threadId,
        mode: "queue-if-active",
        input: [
          {
            type: "text",
            text: resolvedSender.needsAttribution ? attributed(trailerBody) : trailerBody,
            mentions: [],
          },
        ],
        ...(sender ? { senderThreadId: sender } : {}),
        ...(input.model?.trim() ? { model: input.model.trim() } : {}),
        ...(wantedLevel.level !== null ? { reasoningLevel: wantedLevel.level } : {}),
        ...(await permissionFor(worker.threadId)),
      });
      delivery = sent.delivery;
      store.touch(worker.id);
      store.setLastTask(worker.id, input.description);
      store.markDispatched(worker.id, by, Date.now(), message);
      reused = true;
    } else {
      if (input.spawn !== true) {
        return problem(
          unknownWorkerRefusal(
            name,
            project.name,
            // The roster is listed for the chief only. It is a help when the
            // chief mistypes a name and an ENUMERATION ORACLE for anyone else:
            // cos_delegate is a granted manager tool, so one call per project
            // with a nonsense name would rebuild the whole fleet roster that
            // cos_roster's team filter exists to withhold.
            store.list({ projectId: project.id }).map((w) => w.name),
            input.scope.kind === "chief",
          ),
        );
      }
      const title = name;
      const key = spawnKey(project.id, title);
      // One spawn per project and name at a time. Two `--spawn` calls for the
      // same missing worker both read an empty roster, both spawn a thread and
      // both insert, leaving two rows with the same name and one orphaned
      // thread. The window is the whole of `threads.spawn`, which is seconds,
      // and `cos_fanout` can issue concurrent delegates by design.
      // Wait out EVERY in-flight spawn for this name, not just the one that was
      // in flight on arrival. The lock is deleted before it is resolved, so all
      // the waiters wake with the map already empty; with a single `if` two of
      // them could both find no row (a failed spawn inserts none), both take
      // the lock, and the second overwrite the first. The loop is safe because
      // the first waiter to resume sets its lock synchronously, before its own
      // first await, so the next one re-reads a map that already holds it.
      for (let inFlight = spawnLocks.get(key); inFlight !== undefined; inFlight = spawnLocks.get(key)) {
        await inFlight.catch(() => {});
        const settled = store.byProjectName(project.id, name);
        if (settled !== null) {
          return problem(
            `Worker ${project.name}:${name} was being created by another call that has just finished. Nothing was sent. Delegate again now that it exists.`,
          );
        }
      }
      let release = (): void => {};
      spawnLocks.set(key, new Promise<void>((resolve) => { release = resolve; }));
      pendingSpawns.set(key, { kind: input.role === "manager" ? "manager" : "worker", name, projectName: project.name });
      try {
        // A per-call pin wins over the plugin defaults. A pinned provider with no
        // pinned model gets that provider's own default, not the plugin's default model id.
        const providerId = input.providerId?.trim() || current.workerProviderId || null;
        const model =
          input.providerId?.trim() && input.providerId.trim() !== current.workerProviderId && !input.model?.trim()
            ? null
            : input.model?.trim() || current.workerModel || null;
        // Which level a spawn runs at. Pinning it to the thread happens after
        // the spawn returns, below: `threads.spawn` applies this to the spawn
        // turn and writes no override.
        // `model` is passed so a Fable spawn lands on medium rather than the
        // setting's high.
        const reasoningLevel = reasoningForSpawn(
          wantedLevel.level,
          current.workerReasoningLevel,
          DEFAULT_WORKER_REASONING_LEVEL,
          model,
        );
        // Resolved before the spawn so the parent is part of the create rather
        // than a second update that can fail on its own.
        const spawnParent =
          by === null
            ? null
            : sidebarParentThread(
                by.kind === "manager" ? (store.byId(by.workerId)?.threadId ?? null) : null,
                chief,
              );
        let thread: { id: string };
        const environment = await environmentFor(project);
        // Before the worker exists: its first typed turn reads this row.
        await ensureProjectDefaults(project);
        try {
          thread = await bb.sdk.threads.spawn({
            projectId: project.id,
            environment,
            prompt: defuseFileMentions(withFirstLine(
              spawnBriefFirstLine(by, by?.kind === "manager" ? (store.byId(by.workerId)?.name ?? null) : null),
              withTrailer(message, input.fanoutHint === true),
            )),
            title,
            visibility: current.workerVisibility === "hidden" ? "hidden" : "visible",
            permissionMode: permissionModeFor(providerId, current.workerPermissionMode),
            reasoningLevel,
            // A MANAGER'S SPAWN GETS THE MANAGER, not nothing: a worker a
            // manager spawned with no parent would sit flat in the sidebar
            // while the store has it on a team.
            //
            // `sidebarParentThread` is the only thing that decides a parent, and
            // it returns a manager's thread or the chief's and nothing else.
            // NESTING IS A SIDEBAR FACT, NOT A REPORTING MODE, so it does not
            // depend on any notification setting. bb's
            // native parent notifications are off on the thread itself, set
            // here at creation, parent or not, so a later nesting is quiet too.
            ...(spawnParent !== null ? { parentThreadId: spawnParent } : {}),
            ...NOTIFY_PARENT_OFF,
            ...(providerId ? { providerId } : {}),
            ...(model ? { model } : {}),
          });
        } catch (error) {
          // Say what refused the spawn rather than throwing raw from the tool,
          // and name an exhausted credential pool rather than leaving the
          // chief with "unknown error".
          const raw = String(error);
          const pool = exhaustedPoolNote(raw);
          return problem(
            `Could not spawn worker ${project.name}:${name} on ${executionLabel(providerId, model, reasoningLevel)}: ${raw}${pool ? `\n${pool}` : ""}`,
          );
        }
        pinNote += await pinExecution(thread.id, reasoningLevel, model);
        await bb.storage.kv
          .set(`${KV_PERMISSION_PREFIX}${thread.id}`, permissionModeFor(providerId, current.workerPermissionMode))
          .catch(() => {});
        delivery = "sent";
        worker = store.insert({
          projectId: project.id,
          name,
          description: input.description?.trim() ?? "",
          threadId: thread.id,
          providerId,
          ...(input.role ? { role: input.role } : {}),
        });
        // Name and avatar the moment the worker exists, so the sidebar never
        // shows the first prompt as a title.
        await brand(worker, project.name).catch((error) => bb.log.warn(`brand on spawn: ${String(error)}`));
        store.markChiefSeen(worker.id, Date.now());
        // A spawn's first turn carries no senderThreadId in the event log, so
        // this row is the ONLY thing that tells the report router who asked.
        //
        // Falling back to the chief when the caller has no thread is what makes
        // that true for every spawn door, not just the tool. `bb cos delegate
        // --spawn` from a bare terminal is the user creating a worker, and it
        // passes no sender. Without the fallback this row would go in NULL and
        // the new worker's FIRST report would go nowhere: no dispatcher means
        // the note path, and a first report with no Need and no Chief line has
        // nothing for the note path to send.
        //
        // The chief is the right fallback because a newly spawned worker's
        // audience IS the chief: `manager_id` is null until someone assigns it.
        const spawnDispatcher = by ?? (chiefThreadId ? ({ kind: "chief" } as const) : null);
        store.markDispatched(worker.id, spawnDispatcher, Date.now(), message);
      } finally {
        pendingSpawns.delete(key);
        spawnLocks.delete(key);
        release();
      }
    }
    record(reused ? "delegate" : "spawn", {
      workerName: worker.name,
      projectName: project.name,
      threadId: worker.threadId,
      excerpt: message,
    });
    const queued = delivery === "queued" ? " It was busy, so the brief is queued and starts when the running turn ends." : "";
    // A spawn says what it pinned the thread to: the level is otherwise
    // invisible until the next roster read, and "created at xhigh" is the whole
    // point of passing one.
    const spawnedExec = reused ? { model: null, reasoningLevel: null } : await workerExecution(worker.threadId);
    const on = reused ? "" : ` on ${executionLabel(worker.providerId, spawnedExec.model, spawnedExec.reasoningLevel) || "the project default"}`;
    const header = `${reused ? "Reused" : "Spawned"} worker ${project.name}:${worker.name} (thread ${worker.threadId}${on}).${queued}${pinNote}`;
    if (!input.wait) {
      return {
        text: `${header} The worker's result will be reported here when its turn ends. Use cos_read or cos_wait to check earlier.`,
        threadId: worker.threadId,
        reused,
        delivery,
      };
    }
    const shortCircuit = delegateWaitShortCircuit({
      wait: true,
      isToolCall: input.deadlineAt !== null && input.deadlineAt !== undefined,
      callerProviderId: await callerProviderOf(sender),
      workerLabel: `${project.name}:${worker.name}`,
    });
    if (shortCircuit !== null) {
      return { text: `${header} ${shortCircuit}`, threadId: worker.threadId, reused, delivery };
    }
    const result = await waitForWorker(worker, input.timeoutSeconds ?? 600, input.signal, input.senderThreadId ?? null, input.deadlineAt ?? null);
    return { text: `${header}\n${result}`, threadId: worker.threadId, reused, delivery };
  }

  async function waitForWorker(
    worker: Worker,
    timeoutSeconds: number,
    signal?: AbortSignal,
    /** The thread doing the waiting; it delivers the result itself, so its own copy is suppressed. */
    waiterThreadId: string | null = null,
    /** When a tool caller must have its answer; see `TOOL_CALL_BUDGET_MS`. Null on the CLI. */
    deadlineAt: number | null = null,
  ): Promise<string> {
    const budget = waitBudget(timeoutSeconds, deadlineAt, Date.now());
    const releaseWaiter = addWaiter(worker.threadId, waiterThreadId);
    try {
      // Give a freshly sent message a moment to flip the thread to active.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await bb.sdk.threads.wait({
        threadId: worker.threadId,
        status: "idle",
        timeoutMs: Math.max(5, budget.seconds) * 1000,
        ...(signal ? { signal } : {}),
      });
      const output = await bb.sdk.threads.output({ threadId: worker.threadId });
      // Only the audience clears the unread marker; see readerIsAudience.
      if (readerIsAudience(worker, waiterThreadId)) store.markChiefSeen(worker.id);
      const clean = scrubUntrusted(output.output ?? "(no output)");
      return `Worker ${worker.name} is idle. Last message:\n${fenceUntrusted(truncate(clean.text), {
        nonce: fenceNonce(),
        label: "worker message",
        note: scrubNote(clean),
      })}`;
    } catch (error) {
      const thread = await threadOrNull(worker.threadId);
      const status = thread?.runtime.displayStatus ?? "unknown";
      // A turn refused before it started never reaches idle, so the wait ends
      // as a timeout with the reason sitting unread in the thread. Read it.
      const failure = thread?.status === "error" ? await turnFailureText(worker.threadId, null) : null;
      // Said when the tool's limit, not the caller's timeout, ended the wait,
      // because a caller that asked for ten minutes and got four would
      // otherwise take the shorter wait for a slower worker.
      const limit = budget.capped
        ? " That is as long as one tool call can wait, because bb ends a plugin tool call at 300s. Call cos_wait again to keep waiting."
        : "";
      return `Worker ${worker.name} did not become idle within ${budget.seconds}s (status: ${status}). ${
        error instanceof Error && !/timeout|timed out/i.test(error.message) ? `Error: ${error.message}. ` : ""
      }${failure ? `The turn failed:\n${truncate(failure, 1500)}\n` : `Its result will be reported when the turn ends.${limit}`}`;
    } finally {
      releaseWaiter();
    }
  }

  async function readWorker(scope: Scope, ref: string, projectHint?: string): Promise<string> {
    const projects = await listProjects();
    const resolved = resolveInScope(store, projects, ref, scope, projectHint);
    if (!resolved.ok) return resolved.error;
    const { worker } = resolved;
    // readThread, not threadState: an archived worker's last message is still
    // worth reading. What matters here is only that a host failure must not be
    // reported as a deleted thread, which is what the chief acts on.
    const read = await readThread(worker.threadId);
    if (read.kind === "unreachable") return unreachableThreadNote(worker.threadId, read.error);
    if (read.kind === "gone") return `Worker ${worker.name}: thread ${worker.threadId} no longer exists.`;
    const thread = read.thread;
    const output = await bb.sdk.threads.output({ threadId: worker.threadId });
    const unread = store.turnsSince(worker.threadId, worker.chiefLastSeenAt);
    // Only the audience clears the unread marker. A chief reading a managed
    // worker is a peek: its manager still owes it a read.
    if (scopeIsAudience(worker, scope)) store.markChiefSeen(worker.id);
    const projectName = projects.find((p) => p.id === worker.projectId)?.name ?? worker.projectId;
    const readClean = scrubUntrusted(output.output ?? "(no output yet)");
    const block = parseStatusBlock(readClean.text);
    const needAudience = block.needAudience;
    const dismissal = needDismissal(worker, block.need);
    const dismissed = dismissal.dismissed;
    const retired = worker.retiredAt !== null;
    const now = Date.now();
    const due = parseDue(block.need ?? block.open, now);
    const lastReportAt = store.lastReportAt(worker.threadId);
    const urgency = urgencyOf(
      {
        // threads.get does not carry hasPendingInteraction; only the list does.
        pendingInteraction: false,
        failed: thread.status === "error",
        // A retired worker's thread is archived on purpose, so "missing" would be
        // a false alarm; see toWorkerStatus.
        missing: (thread.deletedAt !== null || thread.archivedAt !== null) && !retired,
        retired,
        lastNeed: block.need,
        needAudience,
        needDismissed: dismissed,
        lastReportAt,
        lastUsedAt: worker.lastUsedAt,
        displayStatus: thread.runtime.displayStatus,
      },
      due,
      now,
    );
    const adoptedExec = await workerExecution(worker.threadId);
    return [
      `Worker ${projectName}:${worker.name} (thread ${worker.threadId}) status: ${thread.runtime.displayStatus}, urgency: ${urgency}, last active ${relativeTime(lastActiveAt({ lastUsedAt: worker.lastUsedAt, lastReportAt }))}.`,
      `Runs on ${executionLabel(worker.providerId ?? thread.providerId, adoptedExec.model, adoptedExec.reasoningLevel) || "unknown provider"}${worker.previousThreadId ? `; previous thread ${worker.previousThreadId}` : ""}.`,
      unread > 0 ? `${unread} finished turn${unread === 1 ? "" : "s"} since you last read this worker; now marked read.` : null,
      worker.description ? `Topic: ${worker.description}` : null,
      // The chief must not be told the user is blocked when the worker asked the
      // chief itself for a routing decision.
      block.need === null
        ? null
        : needAudience === "chief"
          ? `Routing (asked of you, the chief, not of the user)${needIdsLabel(dismissal.ids)}: ${block.need}`
          : dismissed
            ? `Need (dismissed, not counted as a decision)${needIdsLabel(dismissal.ids)}: ${block.need}`
            : `Need (waiting on the user)${needIdsLabel(dismissal.ids)}: ${block.need}`,
      // Why it was silenced and when, so a wrong dismissal is visible here and
      // not only in the activity log.
      dismissed
        ? `  Dismissed ${relativeTime(dismissal.at ?? now)} on ${isoDate(dismissal.at ?? now)}${
            dismissal.note ? `: ${dismissal.note}` : ""
          }. A reworded repeat stays dismissed; a different question comes back by itself, or use cos_dismiss undo.`
        : null,
      due && !dismissed ? `Due: ${due.hint}` : null,
      `Last message:\n${fenceUntrusted(truncate(readClean.text), {
        nonce: fenceNonce(),
        label: "worker message",
        note: scrubNote(readClean),
      })}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // ---------- steering work that is already running ----------

  /**
   * Interrupt a running turn with a correction. Unlike cos_delegate, which
   * queues behind the current turn, this reaches the worker mid-flight, so
   * the chief does not have to watch a worker finish work it already knows is
   * wrong. An idle worker takes it as an ordinary message rather than failing.
   */
  async function steerWorker(
    scope: Scope,
    ref: string,
    message: string,
    projectHint?: string,
    senderThreadId?: string | null,
  ): Promise<{ ok: boolean; text: string }> {
    const body = message.trim();
    if (body === "") return { ok: false, text: "Message is empty." };
    const projects = await listProjects();
    const resolved = resolveInScope(store, projects, ref, scope, projectHint);
    if (!resolved.ok) return { ok: false, text: resolved.error };
    const { worker } = resolved;
    const projectName = projects.find((p) => p.id === worker.projectId)?.name ?? worker.projectId;
    const state = await threadState(worker.threadId);
    if (state.kind === "gone") return { ok: false, text: `Worker ${projectName}:${worker.name}: its thread is gone.` };
    if (state.kind === "unreachable") {
      return { ok: false, text: `Worker ${projectName}:${worker.name} could not be reached (${state.error}). Nothing was sent.` };
    }
    const sent = await sendToThread({
      threadId: worker.threadId,
      mode: "steer-if-active",
      input: [{ type: "text", text: withTrailer(body), mentions: [] }],
      ...(senderThreadId ? { senderThreadId } : {}),
      ...(await permissionFor(worker.threadId)),
    });
    store.touch(worker.id);
    store.markDispatched(worker.id, dispatchedBy(senderThreadId, chiefThreadId, managerWorkerId), Date.now(), body);
    // Only a steer that actually interrupted a running turn produces two
    // reports, so only that one opens the merge window.
    if (sent.delivery === "sent") steerMergeUntil.set(worker.id, Date.now() + STEER_MERGE_MS);
    record("steer", { workerName: worker.name, projectName, threadId: worker.threadId, excerpt: body });
    changed();
    return {
      ok: true,
      text:
        sent.delivery === "sent"
          ? `Steered ${projectName}:${worker.name} mid-turn. Its next report reflects the correction.`
          : `${projectName}:${worker.name} was not running, so the message was ${sent.delivery} as an ordinary turn.`,
    };
  }

  /**
   * Stop a worker's current turn and keep the worker, so runaway work can end
   * without retiring the worker and throwing away the thread's context. An
   * optional brief is sent once the turn has actually stopped.
   */
  async function stopWorker(
    scope: Scope,
    ref: string,
    projectHint?: string,
    brief?: string,
    senderThreadId?: string | null,
  ): Promise<{ ok: boolean; text: string }> {
    const projects = await listProjects();
    const resolved = resolveInScope(store, projects, ref, scope, projectHint);
    if (!resolved.ok) return { ok: false, text: resolved.error };
    const { worker } = resolved;
    const projectName = projects.find((p) => p.id === worker.projectId)?.name ?? worker.projectId;
    // Whether anything was actually running decides the wording and the log:
    // "Stopped the current turn" on an idle worker is a false receipt.
    const before = await threadState(worker.threadId);
    if (before.kind === "gone") return { ok: false, text: `Worker ${projectName}:${worker.name}: its thread is gone.` };
    // An unreachable thread must not fall through as "was not running": the
    // caller would get a receipt saying nothing needed stopping, and a brief
    // would then go into a turn that may well still be running. The
    // precondition could not be read, so nothing happens.
    if (before.kind === "unreachable") {
      return {
        ok: false,
        text: `${unreachableThreadNote(worker.threadId, before.error)} Nothing was stopped and no brief was sent.`,
      };
    }
    const wasRunning = BUSY_STATUSES.has(before.thread.runtime.displayStatus);
    if (wasRunning) {
      try {
        await bb.sdk.threads.stop({ threadId: worker.threadId });
      } catch (error) {
        return { ok: false, text: `Could not stop ${projectName}:${worker.name}: ${String(error)}` };
      }
      record("stop", { workerName: worker.name, projectName, threadId: worker.threadId, excerpt: brief?.trim() || "Turn stopped." });
      changed();
    }
    const next = brief?.trim() ?? "";
    if (next === "") {
      return wasRunning
        ? { ok: true, text: `Stopped the current turn of ${projectName}:${worker.name}. The worker and its context are intact; delegate again when you know what it should do instead.` }
        : { ok: true, text: `${projectName}:${worker.name} was not running, so nothing was stopped.` };
    }
    // The stop is asynchronous in bb, so a brief sent in the same tick can land
    // in the turn being torn down. queue-if-active covers the remaining window.
    const sent = await sendToThread({
      threadId: worker.threadId,
      mode: "queue-if-active",
      input: [{ type: "text", text: withTrailer(next), mentions: [] }],
      ...(senderThreadId ? { senderThreadId } : {}),
      ...(await permissionFor(worker.threadId)),
    });
    store.markDispatched(worker.id, dispatchedBy(senderThreadId, chiefThreadId, managerWorkerId), Date.now(), next);
    return {
      ok: true,
      text: `${wasRunning ? "Stopped" : "Did not need to stop"} ${projectName}:${worker.name} and ${sent.delivery === "queued" ? "queued" : "sent"} the new brief.`,
    };
  }

  /**
   * Re-send a worker's last brief, optionally on another model for this turn
   * only. The message the chief wrote is on the row already, so a turn lost to
   * a host failure or an overloaded model does not have to be retyped.
   */
  async function retryWorker(
    scope: Scope,
    ref: string,
    projectHint?: string,
    model?: string,
    senderThreadId?: string | null,
  ): Promise<{ ok: boolean; text: string }> {
    const projects = await listProjects();
    const resolved = resolveInScope(store, projects, ref, scope, projectHint);
    if (!resolved.ok) return { ok: false, text: resolved.error };
    const { worker } = resolved;
    const projectName = projects.find((p) => p.id === worker.projectId)?.name ?? worker.projectId;
    if (worker.lastDispatchMessage === null) {
      return { ok: false, text: `${projectName}:${worker.name} has no brief from you to retry. Use cos_delegate.` };
    }
    if (worker.blockedUntil !== null && worker.blockedUntil > Date.now() && !model?.trim()) {
      return {
        ok: false,
        text: `${projectName}:${worker.name} is rate-limited until ${formatClock(worker.blockedUntil)}. Retry after that, or pass a model to run this turn on another one.`,
      };
    }
    // Only a brief that is still the thread's latest request and was never
    // answered (retryRefusal). A read that fails refuses: a
    // retry re-runs real work, so it is not sent on a guess.
    let sinceDispatch: RetryEvent[] | null = null;
    try {
      const rows = (await bb.sdk.threads.events.list({
        threadId: worker.threadId,
        types: ["client/turn/requested", "turn/completed"],
        order: "desc",
        limit: "60",
      })) as unknown as RetryEvent[];
      const from = (worker.lastDispatchAt ?? 0) - 2_000;
      sinceDispatch = rows.filter((row) => row.createdAt >= from).reverse();
    } catch (error) {
      return { ok: false, text: `Could not read ${projectName}:${worker.name}'s turns to check the brief is unanswered (${String(error)}); nothing was re-sent.` };
    }
    let queued = false;
    try {
      const listed = (await bb.sdk.threads.queuedMessages.list({ threadId: worker.threadId })) as unknown as readonly {
        content?: readonly { text?: string }[];
      }[];
      queued = listed.some((m) => (m.content ?? []).some((c) => (c.text ?? "").includes(worker.lastDispatchMessage!)));
    } catch {
      queued = false;
    }
    const refusal = retryRefusal({
      lastDispatchAt: worker.lastDispatchAt,
      callerThreadId: senderThreadId ?? null,
      retryQueued: queued,
      eventsSinceDispatch: sinceDispatch,
    });
    if (refusal !== null) return { ok: false, text: `Did not retry ${projectName}:${worker.name}: ${refusal}.` };
    const chosen = model?.trim() ?? "";
    const retryExec = await workerExecution(worker.threadId);
    // The per-turn level follows the per-turn model, so a retry on another
    // model does not run at a level that only suits the worker's own model.
    const level =
      chosen === ""
        ? null
        : levelForModelChange({
            requested: null,
            current: retryExec.reasoningLevel,
            fromModel: retryExec.model,
            toModel: chosen,
            setting: (await settings.get()).workerReasoningLevel,
            fallback: DEFAULT_WORKER_REASONING_LEVEL,
          });
    let delivery: string | null = null;
    try {
      const sent = await sendToThread({
        threadId: worker.threadId,
        mode: "queue-if-active",
        input: [{ type: "text", text: withTrailer(worker.lastDispatchMessage), mentions: [] }],
        ...(senderThreadId ? { senderThreadId } : {}),
        ...(chosen ? { model: chosen } : {}),
        ...(level !== null ? { reasoningLevel: level } : {}),
        ...(await permissionFor(worker.threadId)),
      });
      delivery = sent.delivery;
    } catch (error) {
      return { ok: false, text: `Retry for ${projectName}:${worker.name} failed: ${String(error)}` };
    }
    // A model override clears the block: the limit was the other model's.
    if (chosen) store.clearRateLimit(worker.id, Date.now());
    store.markDispatched(worker.id, dispatchedBy(senderThreadId, chiefThreadId, managerWorkerId), Date.now(), worker.lastDispatchMessage);
    record("retry", {
      workerName: worker.name,
      projectName,
      threadId: worker.threadId,
      excerpt: chosen ? `on ${chosen}: ${worker.lastDispatchMessage}` : worker.lastDispatchMessage,
    });
    changed();
    return {
      ok: true,
      text: `Re-sent the last brief to ${projectName}:${worker.name}${chosen ? ` on ${chosen} for this turn` : ""}${delivery === "queued" ? ", queued behind a running turn" : ""}.`,
    };
  }

  /** One leg of a fan-out: the same shape cos_delegate takes, minus the waiting. */
  interface FanoutTask {
    project: string;
    worker: string;
    message: string;
    description?: string;
    model?: string;
    providerId?: string;
    reasoningLevel?: string;
    /** Create this worker when the project has no worker by that name. */
    spawn?: boolean;
    /** This leg has independent parts; tell the worker to fan out. */
    fanoutHint?: boolean;
  }

  /**
   * Dispatch several briefs at once, so a wide job does not cost the chief a
   * round trip per worker. The legs run concurrently and every one reports its own
   * outcome; one failure does not cancel the others.
   */
  async function fanout(
    scope: Scope,
    tasks: FanoutTask[],
    waitAll: boolean,
    timeoutSeconds: number,
    signal?: AbortSignal,
    senderThreadId?: string | null,
    deadlineAt: number | null = null,
  ): Promise<string> {
    if (tasks.length === 0) return "No tasks given.";
    // EVERY task is scope-checked before ANY of them is dispatched, and the
    // whole call is refused if one fails. The obvious place to put this check
    // is the resolveWorker in the wait block below, and that place is useless:
    // the briefs have all been sent by then, in the Promise.all above it. A
    // fan-out is also one intention, so half a batch dispatched and half
    // refused is a worse answer than none dispatched and a list of why.
    //
    // Skipped for the chief because its scope refuses nothing, and because
    // pre-resolving would fail every `spawn: true` leg, whose worker does not
    // exist yet by design.
    if (scope.kind !== "chief") {
      const known = await listProjects();
      const refused = tasks.flatMap((task) => {
        if (task.spawn === true) {
          return [`${task.project}:${task.worker}: only the chief can create a worker.`];
        }
        const check = resolveInScope(store, known, task.worker, scope, task.project);
        return check.ok ? [] : [`${task.project}:${task.worker}: ${check.error}`];
      });
      if (refused.length > 0) {
        return [`Nothing was dispatched. ${refused.length} of ${tasks.length} briefs could not be sent:`, ...refused].join("\n");
      }
    }
    const results = await Promise.all(
      tasks.map(async (task) => {
        try {
          const result = await delegate({
            scope,
            project: task.project,
            worker: task.worker,
            message: task.message,
            ...(task.description ? { description: task.description } : {}),
            ...(task.model ? { model: task.model } : {}),
            ...(task.providerId ? { providerId: task.providerId } : {}),
            ...(task.reasoningLevel ? { reasoningLevel: task.reasoningLevel } : {}),
            ...(task.spawn === true ? { spawn: true } : {}),
            ...(task.fanoutHint === true ? { fanoutHint: true } : {}),
            ...(senderThreadId ? { senderThreadId } : {}),
          });
          return { task, ok: result.threadId !== null, text: result.text };
        } catch (error) {
          return { task, ok: false, text: `Dispatch failed: ${String(error)}` };
        }
      }),
    );
    const lines = results.map((r) => `- ${r.task.project}:${r.task.worker}: ${r.text}`);
    const failed = results.filter((r) => !r.ok).length;
    const header = `Dispatched ${results.length - failed} of ${results.length} briefs${failed > 0 ? `, ${failed} could not be routed` : ""}.`;
    if (!waitAll) {
      return [header, ...lines, "Each worker reports here when its turn ends."].join("\n");
    }
    const shortCircuit = delegateWaitShortCircuit({
      wait: true,
      isToolCall: deadlineAt !== null,
      callerProviderId: await callerProviderOf(senderThreadId ?? chiefThreadId),
      workerLabel: "<worker>",
    });
    if (shortCircuit !== null) {
      return [header, ...lines, shortCircuit].join("\n");
    }
    // Wait on every leg in parallel: the total is the slowest worker, not the sum.
    const finished = await Promise.all(
      results.map(async (r) => {
        if (!r.ok) return `- ${r.task.project}:${r.task.worker}: not dispatched, ${r.text}`;
        // Unscoped on purpose: every task was checked above, before dispatch.
        const resolved = resolveWorker(store, await listProjects(), r.task.worker, r.task.project);
        if (!resolved.ok) return `- ${r.task.project}:${r.task.worker}: ${resolved.error}`;
        return `- ${r.task.project}:${r.task.worker}:\n${await waitForWorker(resolved.worker, timeoutSeconds, signal, senderThreadId ?? null, deadlineAt)}`;
      }),
    );
    return [header, ...finished].join("\n\n");
  }

  // ---------- decisions a worker is blocked on ----------

  /** One pending interaction, reduced to what the chief needs to decide it. */
  interface WorkerDecision {
    worker: Worker;
    projectName: string;
    interaction: Awaited<ReturnType<typeof bb.sdk.threads.interactions.list>>[number];
  }

  /**
   * Every unanswered permission prompt or question across live workers. A
   * worker sitting on one is not idle and never fires thread.idle, so without
   * this the only symptom is a worker that has stopped reporting.
   */
  /**
   * Pending decisions across the caller's scope, and the workers whose threads
   * could not be read. The second half is not decoration: with every read
   * failing, an empty list alone would make `cos_decisions` answer "No worker
   * is waiting on a decision", and a worker blocked on a permission prompt
   * would then wait for an answer the chief has been told it does not need.
   */
  async function openDecisions(scope: Scope): Promise<{ decisions: WorkerDecision[]; unreadable: string[] }> {
    const projects = await listProjects();
    const found: WorkerDecision[] = [];
    const unreadable: string[] = [];
    // Scoped, because this one enumerates rather than resolves. Unscoped, a
    // manager calling its own sanctioned cos_decisions would get the name,
    // project and verbatim pending-prompt text of every blocked worker in the
    // fleet, which is other teams' file paths, commands and questions.
    const visible =
      scope.kind === "chief"
        ? store.list()
        : scope.kind === "manager"
          ? store.team(scope.managerId)
          : [];
    await Promise.all(
      visible.map(async (worker) => {
        try {
          const list = await bb.sdk.threads.interactions.list({ threadId: worker.threadId });
          const projectName = projects.find((p) => p.id === worker.projectId)?.name ?? worker.projectId;
          for (const interaction of list) {
            if (interaction.status === "pending") found.push({ worker, projectName, interaction });
          }
        } catch {
          // The roster shows an unreachable thread too, but this answer is read
          // on its own and has to carry its own gaps.
          unreadable.push(`${projects.find((p) => p.id === worker.projectId)?.name ?? worker.projectId}:${worker.name}`);
        }
      }),
    );
    return {
      decisions: found.sort((a, b) => a.interaction.createdAt - b.interaction.createdAt),
      unreadable: unreadable.sort(),
    };
  }

  async function listDecisions(scope: Scope): Promise<string> {
    const { decisions, unreadable } = await openDecisions(scope);
    const gap =
      unreadable.length === 0
        ? ""
        : `\nCould not read ${unreadable.length} thread${unreadable.length === 1 ? "" : "s"}, so this list may be short: ${unreadable.join(", ")}.`;
    if (decisions.length === 0) {
      return unreadable.length === 0
        ? "No worker is waiting on a decision."
        : `No decision found among the threads that answered.${gap}`;
    }
    return [
      `${decisions.length} worker decision${decisions.length === 1 ? "" : "s"} waiting. Answer with cos_answer.`,
      ...decisions.map(
        (d) =>
          `- ${d.projectName}:${d.worker.name} (${d.interaction.id}, asked ${relativeTime(d.interaction.createdAt)}): ${describeInteraction(d.interaction.payload)}`,
      ),
    ].join("\n") + gap;
  }

  /**
   * Answer one pending decision. Approvals take allow/allow-session/deny;
   * a question takes the free text in `answer`.
   */
  async function answerDecision(
    scope: Scope,
    ref: string,
    decision: "allow" | "allow-session" | "deny" | "answer",
    answer?: string,
    projectHint?: string,
  ): Promise<{ ok: boolean; text: string }> {
    const projects = await listProjects();
    const resolved = resolveInScope(store, projects, ref, scope, projectHint);
    if (!resolved.ok) return { ok: false, text: resolved.error };
    const { worker } = resolved;
    const projectName = projects.find((p) => p.id === worker.projectId)?.name ?? worker.projectId;
    const list = await bb.sdk.threads.interactions.list({ threadId: worker.threadId });
    const pending = list.find((item) => item.status === "pending");
    if (!pending) return { ok: false, text: `${projectName}:${worker.name} is not waiting on a decision.` };
    const payload = pending.payload;
    try {
      if (decision === "answer") {
        const text = answer?.trim() ?? "";
        if (text === "") return { ok: false, text: "decision 'answer' needs the answer text." };
        if (payload.kind === "user_question") {
          // Every question in the group gets the same free text: bb requires an
          // entry per question id, and the chief answers the prompt as a whole.
          const answers = Object.fromEntries(payload.questions.map((q) => [q.id, { freeText: text, selected: [] as string[] }]));
          await bb.sdk.threads.interactions.resolve({
            threadId: worker.threadId,
            interactionId: pending.id,
            resolution: { kind: "user_answer", answers },
          });
        } else {
          await bb.sdk.threads.interactions.respond({ threadId: worker.threadId, interactionId: pending.id, value: text });
        }
      } else {
        if (payload.kind !== "approval") {
          return { ok: false, text: `${projectName}:${worker.name} is asking a question, not for approval. Use decision "answer".` };
        }
        const wanted = decision === "allow" ? "allow_once" : decision === "allow-session" ? "allow_for_session" : "deny";
        if (!payload.availableDecisions.includes(wanted as (typeof payload.availableDecisions)[number])) {
          return { ok: false, text: `This prompt only offers: ${payload.availableDecisions.join(", ")}.` };
        }
        await bb.sdk.threads.interactions.resolve({
          threadId: worker.threadId,
          interactionId: pending.id,
          resolution: wanted === "deny" ? { decision: "deny" } : { decision: wanted as "allow_once" | "allow_for_session", grantedPermissions: null },
        });
      }
    } catch (error) {
      return { ok: false, text: `Could not answer for ${projectName}:${worker.name}: ${String(error)}` };
    }
    record("answer", {
      workerName: worker.name,
      projectName,
      threadId: worker.threadId,
      excerpt: `${decision}: ${describeInteraction(payload)}`,
    });
    changed();
    return { ok: true, text: `Answered ${projectName}:${worker.name} with "${decision}". Its turn continues.` };
  }

  // ---------- how much quota is left ----------

  /**
   * Plan limits per provider, so delegation can see them rather than the chief
   * finding out a provider is exhausted only when a worker turn comes back 429.
   */
  /**
   * The proxy's own per-account usage, or null when it cannot be read.
   *
   * Read through `bb proxy-usage --json` rather than from the auth directory.
   * That directory holds CREDENTIAL files, and the CLI already computes these
   * percentages and returns no secret, so there is no reason for this plugin to
   * open them.
   *
   * Null means "could not look", never "no accounts": the caller falls back to
   * the provider-level figures and says which it is showing, because a failed
   * read reported as an absence reads as a reassuring answer.
   */
  async function proxyAccountUsage(): Promise<ProxyAccountUsage[] | null> {
    const cli = process.env.BB_CLI ?? "bb";
    try {
      const { stdout } = await execFile(cli, ["proxy-usage", "--json"], { timeout: 10_000 });
      const parsed: unknown = JSON.parse(stdout);
      if (typeof parsed !== "object" || parsed === null) return null;
      const accounts = (parsed as { accounts?: unknown }).accounts;
      if (!Array.isArray(accounts)) return null;
      return accounts as ProxyAccountUsage[];
    } catch {
      return null;
    }
  }

  async function usageReport(): Promise<string> {
    // The proxy first: its per-account state is the only source that knows
    // which account a worker will actually hit. `bb.sdk.system.usageLimits()`
    // reports one row per provider, and that row can be a DIFFERENT
    // account from the one in use, so on its own it can call the pool
    // exhausted while the account in use has plenty left.
    const accounts = await proxyAccountUsage();
    if (accounts !== null && accounts.length > 0) {
      const lines = formatProxyUsage(accounts);
      if (lines.length > 0) return lines.join("\n");
    }
    let usage: Awaited<ReturnType<typeof bb.sdk.system.usageLimits>>;
    try {
      usage = await bb.sdk.system.usageLimits();
    } catch (error) {
      return `Usage limits are unavailable right now (${String(error)}). Delegate as usual; a rate-limited worker still reports here.`;
    }
    const lines = formatUsage(usage);
    if (lines.length === 0) return "No provider reports usage limits on this machine.";
    // Says WHICH source this is, because these figures are per provider and may
    // not be the account in use. Without the caveat they read as authoritative.
    return [
      "Per provider, and the proxy's per-account state could not be read, so these may not be the account in use:",
      ...lines,
    ].join("\n");
  }

  // ---------- roster ----------

  /** The thread facts the roster needs, from either threads.list or threads.get. */
  interface ThreadFacts {
    title: string | null;
    /** bb's provider id for the thread; the model is not in the DTO, so the worker row carries it. */
    providerId: string | null;
    status: string;
    displayStatus: string;
    pendingInteraction: boolean;
    missing: boolean;
  }

  const MISSING_FACTS: ThreadFacts = {
    title: null,
    providerId: null,
    status: "missing",
    displayStatus: "missing",
    pendingInteraction: false,
    missing: true,
  };

  function factsFromListed(thread: ListedThread): ThreadFacts {
    return {
      title: thread.title ?? thread.titleFallback,
      providerId: thread.providerId,
      status: thread.status,
      displayStatus: thread.runtime.displayStatus,
      pendingInteraction: thread.hasPendingInteraction,
      missing: thread.deletedAt !== null || thread.archivedAt !== null,
    };
  }

  /** Fallback for a worker the list did not return: it is usually archived or gone. */
  async function factsFromGet(threadId: string): Promise<ThreadFacts> {
    const thread = await threadOrNull(threadId);
    if (!thread) return MISSING_FACTS;
    return {
      title: thread.title ?? thread.titleFallback,
      providerId: thread.providerId,
      status: thread.status,
      displayStatus: thread.runtime.displayStatus,
      // threads.get does not carry hasPendingInteraction; only the list does.
      pendingInteraction: false,
      missing: thread.deletedAt !== null || thread.archivedAt !== null,
    };
  }

  /**
   * The worker's whole last assistant message.
   *
   * `{ ok: true, text: null }` means the worker really has said nothing;
   * `{ ok: false }` means the read failed and we do not know what it has said.
   * They must not be the same `null`: a transient `threads.output` failure,
   * which happens after a host hiccup or while the target thread is mid-turn,
   * would be indistinguishable from an empty message, `dismissNeed` would
   * answer "has no open Need line; nothing to dismiss", the chief would take
   * the decision as resolved, and the worker's real question would stay open
   * with nobody on it. `threadState` draws the same distinction.
   */
  async function lastOutput(
    threadId: string,
  ): Promise<{ ok: true; text: string | null } | { ok: false; error: string }> {
    try {
      const output = await bb.sdk.threads.output({ threadId });
      const text = scrubUntrusted(output.output ?? "").text;
      return { ok: true, text: text.trim() === "" ? null : text };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  async function toWorkerStatus(
    worker: Worker,
    projectName: string,
    facts: ThreadFacts,
    skipExecution = false,
  ): Promise<WorkerStatus> {
    // The status block sits at the end of the full message, so parse the full
    // text and excerpt it separately for the card preview.
    // The thread's own last message, else the report stored when it was routed:
    // a failed read must not blank the Need line (rosterReportText).
    const report = rosterReportText(facts.missing ? null : await lastOutput(worker.threadId), {
      text: worker.lastReportText,
      at: worker.lastReportTextAt,
    });
    const fullLastOutput = report.text;
    // Read from the thread, not from the roster row: the roster keeps no model
    // or level because this plugin is not their only
    // writer. Parallel with every other worker via the Promise.all in
    // buildRosterStatus, so a full roster is one round of reads, not N in series.
    const execution =
      facts.missing || skipExecution
        ? { model: null, reasoningLevel: null }
        : await workerExecution(worker.threadId);
    const excerpt = fullLastOutput === null ? "" : excerptOf(fullLastOutput, OUTPUT_EXCERPT_MAX);
    const block = parseStatusBlock(fullLastOutput);
    // A different question is undismissed on its own; a reworded repeat of a
    // dismissed one is not (`needDismissal`).
    const dismissal = needDismissal(worker, block.need);
    const dismissed = dismissal.dismissed;
    const now = Date.now();
    // A deadline the worker mentioned in what it is waiting on, or working on.
    const due = parseDue(block.need ?? block.open, now);
    // A turn refused by a rate limit is a known, timed, self-healing state, so
    // the thread's error status is not a failure the user has to act on.
    const blockedUntil = worker.blockedUntil !== null && worker.blockedUntil > now ? worker.blockedUntil : null;
    const base = {
      id: worker.id,
      name: worker.name,
      description: liveDescription(worker.description, worker.role, store.team(worker.id).length),
      projectId: worker.projectId,
      projectName,
      threadId: worker.threadId,
      title: facts.title,
      avatar: parseAvatarKey(worker.avatar),
      providerId: worker.providerId ?? facts.providerId,
      model: execution.model,
      reasoningLevel: execution.reasoningLevel,
      status: facts.status,
      displayStatus: facts.displayStatus,
      pendingInteraction: facts.pendingInteraction,
      failed: (facts.status === "error" || isRawProviderError(fullLastOutput)) && blockedUntil === null,
      // Retiring a worker archives its thread, so an archived thread under a
      // retired worker is the expected end state, not a fault. Reported as
      // missing it would turn the header dot red, print "thread missing" in
      // workerNote and make needsYouReason claim the thread was gone.
      missing: facts.missing && worker.retiredAt === null,
      retired: worker.retiredAt !== null,
      lastDisposition: worker.lastDisposition,
      lastReportDispatched: worker.lastReportDispatched,
      lastTask: worker.lastTask,
      lastTaskAt: worker.lastTaskAt,
      lastUsedAt: worker.lastUsedAt,
      lastOutputExcerpt: excerpt === "" ? null : excerpt,
      lastOutputStoredAt: report.stale ? worker.lastReportTextAt : null,
      lastDone: block.done,
      lastOpen: block.open,
      lastNeed: block.need,
      needChoices: block.needChoices,
      needAudience: block.needAudience,
      needDismissed: dismissed,
      needDismissedAt: dismissed ? dismissal.at : null,
      needDismissedNote: dismissed ? dismissal.note : null,
      needIds: dismissal.ids,
      lastReportAt: store.lastReportAt(worker.threadId),
      chiefLastSeenAt: worker.chiefLastSeenAt,
      newTurns: store.turnsSince(worker.threadId, worker.chiefLastSeenAt),
      role: worker.role,
      managerId: worker.managerId,
      // A manager's row carries its TEAM's unread turns as well as its own.
      // The chief reads a manager instead of its team, so without this a team
      // that has been busy all morning shows as a quiet manager row, and the
      // whole point of the tier is that the chief can still see what is going
      // on without reading every worker.
      teamNewTurns:
        worker.role === "manager"
          ? store
              .team(worker.id)
              .reduce((sum, member) => sum + store.turnsSince(member.threadId, member.chiefLastSeenAt), 0)
          : 0,
      // Parsed here because this is where the full report text is; WorkerStatus
      // carries only the status block. True for a plain worker, so the roster
      // nudge below can ask about every row without a role check of its own.
      reportedTeam: worker.role !== "manager" || parseTeamLine(fullLastOutput).length > 0,
      needIsNew: !dismissed && isNeedNew(worker, block.need),
      blockedUntil,
      retryable: worker.lastDispatchMessage !== null,
      // Only a thread that is actually running has an elapsed time. A stale
      // value on a finished row would tick forever, so busy is the gate.
      turnStartedAt: BUSY_STATUSES.has(facts.displayStatus) ? worker.turnStartedAt : null,
    };
    return { ...base, urgency: urgencyOf(base, due, now), dueHint: due?.hint ?? null, dueAt: due?.at ?? null };
  }

  interface RosterOptions {
    projectId?: string;
    includeOthers?: boolean;
    includeRetired?: boolean;
    /**
     * Show only this manager's team. Set from the caller's scope, so a manager
     * running cos_roster sees its own team and nothing else.
     *
     * It MUST also appear in the memo key below. The memo is shared across
     * every surface for about a second, so a filter that is not part of the
     * key would serve one principal's roster to another, which is the whole
     * of what the scope exists to prevent.
     */
    managerId?: string;
    /**
     * Skip each worker's model and level read (null in the result). For the
     * sidebar marks, the compaction pass and the execution list, none of which
     * reads them from the roster, so they skip one call per worker per build.
     * Part of the memo key, so a light roster is
     * never served to a caller that prints the model.
     */
    skipExecution?: boolean;
  }

  async function buildRosterStatus(opts: RosterOptions) {
    const projects = await listProjects();
    const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
    const everyWorker = store.list({ projectId: opts.projectId, includeRetired: opts.includeRetired });
    const workers =
      opts.managerId === undefined
        ? everyWorker
        : everyWorker.filter((w) => w.managerId === opts.managerId);
    const workerThreadIds = new Set(workers.map((w) => w.threadId));
    // One list call carries status, pending interactions, and titles for every
    // thread; threads.get is only needed for the rare worker missing from it.
    const all = await liveThreads(opts.projectId);
    const listedById = new Map(all.map((thread) => [thread.id, thread]));
    const statuses = await Promise.all(
      workers.map(async (worker) => {
        const listed = listedById.get(worker.threadId);
        const facts = listed ? factsFromListed(listed) : await factsFromGet(worker.threadId);
        return toWorkerStatus(worker, projectName(worker.projectId), facts, opts.skipExecution === true);
      }),
    );
    const others: OtherThread[] = [];
    if (opts.includeOthers) {
      for (const t of all) {
        // Hidden threads are plugin scratch space, not something to adopt.
        if (t.visibility === "hidden") continue;
        if (workerThreadIds.has(t.id) || t.id === chiefThreadId || t.deletedAt !== null || t.archivedAt !== null) continue;
        others.push({
          threadId: t.id,
          title: t.title ?? t.titleFallback,
          projectId: t.projectId,
          projectName: projectName(t.projectId),
          status: t.status,
          displayStatus: t.runtime.displayStatus,
          pendingInteraction: t.hasPendingInteraction,
          updatedAt: t.updatedAt,
        });
      }
      others.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    let chiefStatus: string | null = null;
    if (chiefThreadId) {
      const listedChief = listedById.get(chiefThreadId);
      chiefStatus =
        listedChief?.runtime.displayStatus ?? (await threadOrNull(chiefThreadId))?.runtime.displayStatus ?? null;
    }
    return { chiefThreadId, chiefStatus, workers: statuses, others };
  }

  /**
   * Every live thread, optionally in one project, memoized like the roster. The
   * sidebar poll builds the roster and then needs bb's read times from the same
   * list; this makes that one threads.list call instead of two.
   */
  const liveThreads = shortMemo(
    (projectId: string | undefined) =>
      bb.sdk.threads.list({ ...(projectId ? { projectId } : {}), archived: false, includeHidden: true, limit: 500 }),
    (projectId: string | undefined) => projectId ?? "",
  );

  const rosterStatusMemo = shortMemo(
    (opts: RosterOptions) => buildRosterStatus(opts),
    (opts: RosterOptions) =>
      // managerId is part of the key: see the note on RosterOptions.
      `${opts.projectId ?? ""}|${opts.includeOthers === true}|${opts.includeRetired === true}|${opts.managerId ?? ""}|${opts.skipExecution === true}`,
  );

  /** The roster, memoized for ~1s across every surface that asks for the same view. */
  async function rosterStatus(opts: RosterOptions = {}) {
    return rosterStatusMemo(opts);
  }

  function formatRoster(
    r: Awaited<ReturnType<typeof rosterStatus>>,
    externals: ExternalSession[] = [],
    context: ReadonlyMap<string, { used: number | null; window: number | null }> = new Map(),
  ): string {
    // Context used, from bb's newest reading. Only when
    // the caller read it; a row the read did not cover shows nothing rather
    // than a made-up figure.
    const ctx = (threadId: string): string => {
      const reading = context.get(threadId);
      return reading === undefined ? "" : `  ${rosterContextLabel(reading.used, reading.window)}`;
    };
    const lines: string[] = [];
    // The chief's own state is otherwise invisible on every CLI surface, so a
    // chief in error read exactly like a chief sitting idle.
    lines.push(
      r.chiefThreadId === null
        ? "Chief thread: (none, run bb cos start)"
        : `Chief thread: ${r.chiefThreadId} [${r.chiefStatus ?? "unknown"}]`,
    );
    // Workers whose reports carry no disposition word, named so they can be chased. A
    // report with no disposition word still forwards to the chief,
    // so this is a nudge and never a failure; it is counted rather than
    // enforced because silence would make adoption invisible. Only a report from a dispatched turn is counted: nothing
    // else asked for the word (`missingDispositionWord`).
    const noWord = missingDispositionWord(r.workers);
    // A manager that did not name its team. Same nudge as a missing
    // disposition word and for the same reason: the chief reads a manager
    // INSTEAD of its team, so a report with no Team: line leaves it blind, and
    // a nudge on the roster is how that gets noticed without gating the report.
    const silentManagers = r.workers.filter(
      (w) => !w.retired && w.role === "manager" && w.lastReportAt !== null && !w.reportedTeam,
    );
    if (silentManagers.length > 0) {
      lines.push(
        `${silentManagers.length} manager${silentManagers.length === 1 ? "" : "s"} reported without a Team: line, so you cannot see their teams without reading them: ${silentManagers.map((w) => w.name).join(", ")}`,
      );
    }
    if (noWord.length > 0) {
      lines.push(
        `${noWord.length} of ${r.workers.filter((w) => !w.retired).length} workers' last dispatched report carried no disposition word: ${noWord.map((w) => w.name).join(", ")}`,
      );
    }
    if (r.workers.length === 0) lines.push("Workers: none.");
    else {
      lines.push("Workers:");
      for (const w of r.workers) {
        // Only reachable with --retired; without the label a retired worker reads
        // as available, which is worse than not listing it at all.
        const gone = w.retired ? "  RETIRED" : "";
        const flag = w.pendingInteraction ? "  BLOCKED ON A PROMPT (cos_answer)" : w.failed ? "  FAILED" : "";
        // The urgency word tells the chief what to act on first; the hint says why.
        const mark =
          w.urgency === "urgent" || w.urgency === "attention"
            ? `  ${w.urgency}${w.dueHint ? ` (due ${w.dueHint})` : ""}`
            : "";
        // [new N]: finished turns the chief has not read (direct exchanges with
        // the user are not forwarded). cos_read clears it.
        const fresh = w.newTurns > 0 ? `  [new ${w.newTurns}]` : "";
        // A manager's row also carries its team's unread turns, because the
        // chief reads the manager instead of the team: without it a team that
        // has been busy all morning shows as a quiet manager row.
        const team =
          w.role === "manager"
            ? `  [manages ${store.team(w.id).length}${w.teamNewTurns > 0 ? `, ${w.teamNewTurns} new` : ""}]`
            : "";
        const limited = w.blockedUntil === null ? "" : `  [rate-limited until ${formatClock(w.blockedUntil)}]`;
        const exec = executionLabel(w.providerId, w.model, w.reasoningLevel);
        lines.push(
          `  ${w.projectName}:${w.name}  [${w.missing ? "missing" : w.displayStatus}]${gone}${flag}${mark}${fresh}${team}${limited}  ${w.threadId}${exec ? `  on ${exec}` : ""}  last active ${relativeTime(lastActiveAt(w))}${ctx(w.threadId)}${w.description ? `  - ${w.description}` : ""}${lastTaskLabel(w.lastTask, w.lastTaskAt, Date.now())}`,
        );
        // The Need line is what the worker is waiting on: show it inline, and say
        // who it is waiting on, so the chief is not told the user is blocked by a
        // request the chief itself is meant to answer.
        if (w.lastNeed) {
          const label = w.needDismissed ? "need (dismissed)" : w.needAudience === "chief" ? "routing" : "need";
          lines.push(`  ${label}: ${w.lastNeed}`);
        }
        // The thread could not be read, so the lines here come from the report
        // as it was routed. Said once, and only then, so a normal roster
        // carries no such line.
        if (w.lastOutputStoredAt !== null) {
          lines.push(`  (thread could not be read just now; need and open are from its last report, ${relativeTime(w.lastOutputStoredAt)})`);
        }
        // What the worker still has to do, so the chief can tell a worker that
        // is nearly finished from one that has barely started.
        if (w.lastOpen) lines.push(`  open: ${w.lastOpen}`);
      }
    }
    if (r.others.length > 0) {
      lines.push("Other threads (not managed; adopt with cos_adopt to reuse):");
      for (const t of r.others.slice(0, 40)) {
        lines.push(`  ${t.projectName}  [${t.displayStatus}]  ${t.threadId}  ${t.title ?? "(untitled)"}  updated ${relativeTime(t.updatedAt)}`);
      }
      if (r.others.length > 40) lines.push(`  … ${r.others.length - 40} more`);
    }
    if (externals.length > 0) {
      lines.push("External Claude sessions (not bb threads; import with cos_import_session):");
      for (const s of externals.slice(0, 20)) {
        const imported = s.importedWorkerName ? `  imported as ${s.importedWorkerName}` : "";
        lines.push(
          `  ${s.name ?? s.sessionId.slice(0, 8)}  ${s.cwd}  ${s.title ?? "(no title)"}  last activity ${
            s.lastActivityAt === null ? "unknown" : relativeTime(s.lastActivityAt)
          }${imported}`,
        );
      }
      if (externals.length > 20) lines.push(`  … ${externals.length - 20} more`);
    }
    return lines.join("\n");
  }

  /** Roster text, plus the external Claude sessions when other threads are included. */
  async function rosterText(opts: RosterOptions): Promise<string> {
    const r = await rosterStatus(opts);
    // One context read per live worker, in parallel, like the roster's own reads.
    const context = new Map(
      await Promise.all(
        r.workers
          .filter((w) => !w.retired && !w.missing)
          .map(async (w) => [w.threadId, await contextUsage(w.threadId)] as const),
      ),
    );
    if (!opts.includeOthers) return formatRoster(r, [], context);
    let externals: ExternalSession[] = [];
    try {
      externals = (await sessionsList()).sessions;
    } catch (error) {
      bb.log.warn(`external session scan failed: ${String(error)}`);
    }
    return formatRoster(r, externals, context);
  }

  // ---------- external claude code sessions ----------

  const externalSessionsMemo = shortMemo(
    () => listExternalSessions({ homeDir: HOME_DIR, excludeCwdPrefixes: [BB_DATA_DIR] }),
    () => "importable",
  );

  /**
   * Every live Claude Code session on this machine that is not one of bb's own.
   * Memoized for ~1s: it is a registry read plus a stat per transcript, and one
   * changed() burst can ask for it several times.
   */
  async function externalSessions(): Promise<ExternalSessionInfo[]> {
    return externalSessionsMemo(null);
  }

  /**
   * Entrypoints that mean a terminal session a user started directly. Mirrors the
   * allowlist in sessions.ts, "unknown" included, because readRegistry falls back
   * to it when a registry file omits the field.
   */
  const IMPORTABLE_ENTRYPOINTS = new Set(["cli", "unknown"]);
  /**
   * Harness entrypoints. listExternalSessions hides these, which is right for the
   * list but leaves the import path blind: it must be able to see a bb thread's
   * own session in order to refuse it by name. "sdk-cli" is what bb runs as.
   */
  const HARNESS_ENTRYPOINTS = ["sdk-cli"];

  /** Importable sessions plus the harness ones, so importSessions can name what it refuses. */
  async function locatableSessions(): Promise<ExternalSessionInfo[]> {
    return listExternalSessions({
      homeDir: HOME_DIR,
      excludeCwdPrefixes: [],
      entrypoints: [...IMPORTABLE_ENTRYPOINTS, ...HARNESS_ENTRYPOINTS],
    });
  }

  /** The bb thread a Claude session belongs to, read from its live process, or null. */
  async function bbThreadOfSession(info: ExternalSessionInfo): Promise<string | null> {
    for (const pid of info.pids) {
      try {
        const environ = await readFile(`/proc/${pid}/environ`, "utf8");
        const found = environ.split("\0").find((entry) => entry.startsWith("BB_THREAD_ID="));
        if (found !== undefined) return found.slice("BB_THREAD_ID=".length);
      } catch {
        // Not Linux, or the process has exited: fall back to naming the session.
      }
    }
    return null;
  }

  /** bb projects as (id, name, source paths), the input matchProject needs. */
  async function projectPaths(): Promise<ProjectPaths[]> {
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      paths: p.sources
        .map((s) => s.path)
        .filter((value): value is string => typeof value === "string" && value !== ""),
    }));
  }

  /** External sessions decorated with the matched bb project and any earlier import. */
  async function sessionsList(): Promise<{ sessions: ExternalSession[]; note: string }> {
    const [raw, paths] = await Promise.all([externalSessions(), projectPaths()]);
    const imports = store.importsBySession();
    const activeWorkers = new Map(store.list().map((w) => [w.id, w]));
    const sessions: ExternalSession[] = raw.map((s) => {
      const matched = matchProject(s.cwd, paths);
      const workerId = imports.get(s.sessionId);
      const worker = workerId ? activeWorkers.get(workerId) : undefined;
      return {
        sessionId: s.sessionId,
        pids: s.pids,
        name: s.name,
        cwd: s.cwd,
        entrypoint: s.entrypoint,
        startedAt: s.startedAt,
        lastActivityAt: s.lastActivityAt,
        title: s.title,
        transcriptPath: s.transcriptPath,
        transcriptBytes: s.transcriptBytes,
        tmux: s.tmux,
        matchedProjectId: matched?.id ?? null,
        matchedProjectName: matched?.name ?? null,
        importedWorkerName: worker ? worker.name : null,
      };
    });
    sessions.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
    return { sessions, note: SESSIONS_NOTE };
  }

  interface LocatedSession {
    sessionId: string;
    transcriptPath: string;
    /** null when the process is gone and only the transcript is left. */
    info: ExternalSessionInfo | null;
  }

  /**
   * Find a session's transcript: the live registry first, then any
   * ~/.claude/projects directory for a session whose process has exited.
   */
  async function locateSession(sessionId: string, live?: ExternalSessionInfo[]): Promise<LocatedSession | null> {
    const listed = live ?? (await externalSessions());
    const found = listed.find((s) => s.sessionId === sessionId);
    if (found && found.transcriptPath) {
      return { sessionId, transcriptPath: found.transcriptPath, info: found };
    }
    const orphan = await findTranscriptById(HOME_DIR, sessionId);
    return orphan ? { sessionId, transcriptPath: orphan.transcriptPath, info: null } : null;
  }

  async function sessionDigest(sessionId: string, maxChars?: number): Promise<DigestResult | null> {
    const located = await locateSession(sessionId);
    if (!located) return null;
    const result = await digestTranscript(located.transcriptPath, { maxChars: maxChars ?? DIGEST_MAX_CHARS });
    if (result === null) return result;
    // A Claude Code transcript holds whatever untrusted text that session
    // read, and this digest is seeded into the chief's context and
    // into a new worker's opening prompt. Same class as worker text, so the
    // same rule: scrubbed here, at the single place every caller goes through.
    return { ...result, digest: scrubUntrusted(result.digest).text };
  }

  function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
    return `${bytes}B`;
  }

  /** "2031-01-16 09:00 UTC" - absolute because the user, the people they work with, and the server can be in different zones. */
  function absoluteDate(ms: number): string {
    return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }

  function formatSessionsTable(sessions: ExternalSession[]): string {
    if (sessions.length === 0) return `No external Claude Code sessions found. ${SESSIONS_NOTE}`;
    const header = ["NAME", "SESSION ID", "CWD", "PROJECT", "TITLE", "LAST", "SIZE", "IMPORTED AS"];
    const rows = sessions.map((s) => [
      s.name ?? "(unnamed)",
      s.sessionId,
      s.cwd,
      s.matchedProjectName ?? "-",
      excerptOf(s.title ?? "-", 46),
      s.lastActivityAt === null ? "unknown" : relativeTime(s.lastActivityAt),
      formatBytes(s.transcriptBytes),
      s.importedWorkerName ?? "-",
    ]);
    const widths = header.map((_, column) =>
      Math.max(header[column]!.length, ...rows.map((row) => row[column]!.length)),
    );
    const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd();
    return [line(header), ...rows.map(line), "", SESSIONS_NOTE].join("\n");
  }

  /**
   * Host has no "this is the local machine" flag, so prefer the host that
   * already backs an existing project source, then any connected host.
   */
  async function primaryHostId(): Promise<string | null> {
    const hosts = await bb.sdk.hosts.list();
    if (hosts.length === 0) return null;
    const connected = hosts.filter((h) => h.status === "connected");
    const pool = connected.length > 0 ? connected : hosts;
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    const used = new Set<string>();
    for (const project of projects) {
      for (const source of project.sources) {
        if (typeof source.hostId === "string") used.add(source.hostId);
      }
    }
    return pool.find((h) => used.has(h.id))?.id ?? pool[0]?.id ?? null;
  }

  interface ImportInput {
    sessionIds: string[];
    worker: string;
    project?: string;
    description?: string;
    createProject?: boolean;
  }

  interface ImportResult {
    ok: boolean;
    text: string;
    threadId: string | null;
    projectId: string | null;
  }

  /**
   * Why this session must not be imported, or null. A bb thread's own Claude
   * session is harness driven: seeding a new worker from a worker's transcript
   * forks the thread instead of managing it. The list filter alone does not close
   * this path, because locateSession falls back to scanning ~/.claude/projects
   * for the transcript of any id it is handed.
   */
  async function importRefusal(located: LocatedSession): Promise<string | null> {
    const info = located.info;
    // The process is gone and only the transcript was found, so the registry
    // entry that carries the entrypoint went with it: a dead bb session and a
    // dead terminal session are indistinguishable here, and refusing both would
    // break the documented orphan-transcript import.
    if (info === null) return null;
    const insideBb = info.cwd === BB_DATA_DIR || info.cwd.startsWith(`${BB_DATA_DIR}${path.sep}`);
    if (!insideBb && IMPORTABLE_ENTRYPOINTS.has(info.entrypoint)) return null;
    const threadId = await bbThreadOfSession(info);
    const worker = threadId === null ? null : store.byThread(threadId);
    const owner =
      threadId === null
        ? "a bb thread, not an outside terminal session"
        : worker
          ? `bb worker ${worker.name} (thread ${threadId}), not an outside terminal session`
          : `bb thread ${threadId}, not an outside terminal session`;
    return [
      `Session ${located.sessionId}${info.name === null ? "" : ` (${info.name})`} belongs to ${owner}`,
      `(entrypoint ${info.entrypoint}, cwd ${info.cwd}).`,
      threadId === null
        ? "Importing it would seed a new worker from a bb thread's own transcript."
        : `Manage that thread with cos_adopt ${threadId} instead of importing it.`,
    ].join(" ");
  }

  /** Hand one or more external sessions over to a bb worker seeded with their digests. */
  async function importSessions(input: ImportInput): Promise<ImportResult> {
    const problem = (text: string): ImportResult => ({ ok: false, text, threadId: null, projectId: null });
    const ids = [...new Set(input.sessionIds.map((id) => id.trim()).filter((id) => id !== ""))];
    if (ids.length === 0) return problem("No session ids given.");
    // The harness sessions are included here only so the guard below can see and
    // name them; every one of them is refused.
    const live = await locatableSessions();
    const located: LocatedSession[] = [];
    for (const id of ids) {
      const found = await locateSession(id, live);
      if (!found) return problem(`No transcript found for session ${id}. Run cos_sessions to see valid ids.`);
      const refusal = await importRefusal(found);
      if (refusal !== null) return problem(refusal);
      located.push(found);
    }

    const projects = await listProjects();
    let project: ProjectRef | null = null;
    let createdProject = false;
    if (input.project) {
      project = findProject(projects, input.project);
      if (!project) {
        return problem(`Unknown project "${input.project}". Known: ${projects.map((p) => p.name).join(", ")}.`);
      }
    } else {
      const cwd = located.find((l) => l.info)?.info?.cwd ?? null;
      const matched = cwd ? matchProject(cwd, await projectPaths()) : null;
      if (matched) project = projects.find((p) => p.id === matched.id) ?? null;
      if (!project && input.createProject && cwd) {
        const hostId = await primaryHostId();
        if (!hostId) return problem("No bb host available to create a project on.");
        const name = path.basename(cwd) || "imported-session";
        try {
          const created = await bb.sdk.projects.create({ name, source: { type: "local_path", hostId, path: cwd } });
          // Created from `cwd`, so the path and host are the ones just passed.
          project = { id: created.id, name: created.name, kind: created.kind, path: cwd, hostId };
          createdProject = true;
        } catch (error) {
          return problem(`Could not create a project for ${cwd}: ${String(error)}`);
        }
      }
      if (!project) project = projects.find((p) => p.kind === "personal") ?? null;
    }
    if (!project) return problem("No project available to host the worker.");

    // Split the seed budget across the sessions, leaving room for the framing text.
    const budget = Math.max(8_000, Math.floor((SEED_MAX_CHARS - 8_000) / located.length));
    const perDigest = Math.min(DIGEST_MAX_CHARS, budget);
    const digests: { located: LocatedSession; digest: DigestResult }[] = [];
    for (const entry of located) {
      // Same scrub as `sessionDigest`: this text becomes the opening prompt of
      // a freshly spawned worker, which is another agent's context.
      const raw = await digestTranscript(entry.transcriptPath, { maxChars: perDigest });
      digests.push({ located: entry, digest: { ...raw, digest: scrubUntrusted(raw.digest).text } });
    }

    const label = (entry: LocatedSession, digest: DigestResult): string =>
      entry.info?.name ?? digest.title ?? entry.sessionId.slice(0, 8);
    const workingDir = located.find((l) => l.info)?.info?.cwd ?? "(unknown, ask the user)";
    const anyTruncated = digests.some((d) => d.digest.truncated);

    const facts = digests.map(({ located: entry, digest }) => {
      const parts = [
        `- "${label(entry, digest)}" (session ${entry.sessionId})`,
        `cwd ${entry.info?.cwd ?? "unknown"}`,
        entry.info ? `started ${absoluteDate(entry.info.startedAt)}` : "process has exited, transcript only",
        entry.info?.tmux ? `tmux ${entry.info.tmux}` : null,
        `${digest.messageCount} messages`,
      ].filter((part): part is string => part !== null);
      return parts.join(", ");
    });

    const seed = [
      "You are taking over one or more Claude Code sessions that the user has been running in a terminal on this machine, outside bb.",
      "Those sessions keep running where they are; you are the bb worker that now owns this topic, and the Chief of Staff will send you tasks about it from here.",
      "Sessions handed over:",
      facts.join("\n"),
      anyTruncated || digests.length > 1
        ? `The combined handover is capped at about ${SEED_MAX_CHARS.toLocaleString("en-US")} characters, so some older exchanges may be missing. Compaction summaries were kept first.`
        : null,
      ...digests.map(
        ({ located: entry, digest }) =>
          `# Transcript digest: ${label(entry, digest)} (${entry.sessionId})\n\n${digest.digest}`,
      ),
      [
        "First, without using tools unless a fact is missing, write a VERY detailed handover summary: goals, what was done (with file paths), key decisions and why, open items, blockers, next steps, and anything the user must decide.",
        "Then end with the Done / Open / Need status block and wait for tasks from the chief.",
        `Your working directory for this topic is ${workingDir}.`,
      ].join(" "),
    ]
      .filter((part): part is string => part !== null)
      .join("\n\n");

    const message = seed.length > SEED_MAX_CHARS ? `${seed.slice(0, SEED_MAX_CHARS)}\n[… seed truncated]` : seed;
    const names = digests.map(({ located: entry, digest }) => label(entry, digest)).join(", ");
    const result = await delegate({
      // Internal: seeding a worker from an imported session is the plugin
      // acting on the chief's behalf, not a scoped principal.
      scope: { kind: "chief" },
      project: project.id,
      worker: input.worker,
      message,
      description: input.description ?? `Imported Claude session(s): ${names}`,
      // An import exists to bring a session in as a new worker, so this path
      // creates it rather than failing on the unknown name.
      spawn: true,
    });
    if (!result.threadId) return { ok: false, text: result.text, threadId: null, projectId: project.id };

    const worker = store.byThread(result.threadId);
    if (worker) for (const entry of located) store.recordImport(entry.sessionId, worker.id);
    const workerName = worker?.name ?? normalizeName(input.worker);
    record("import", {
      workerName,
      projectName: project.name,
      threadId: result.threadId,
      excerpt: `Imported ${names} into ${project.name}:${workerName}`,
    });
    changed();
    return {
      ok: true,
      text: [
        `Imported ${located.length} session(s) into ${project.name}:${workerName} (thread ${result.threadId}).`,
        createdProject ? `Created project ${project.name}.` : null,
        `Seed prompt: ${message.length.toLocaleString("en-US")} chars${anyTruncated ? " (digests truncated)" : ""}.`,
        "The worker is writing its detailed handover now; it will arrive as a normal worker report.",
      ]
        .filter((line): line is string => line !== null)
        .join(" "),
      threadId: result.threadId,
      projectId: project.id,
    };
  }

  // ---------- worker lifecycle ----------

  async function adopt(threadId: string, name: string, description?: string): Promise<{ ok: boolean; text: string }> {
    const read = await readThread(threadId);
    if (read.kind === "unreachable") return { ok: false, text: unreachableThreadNote(threadId, read.error) };
    if (read.kind === "gone") return { ok: false, text: `Thread ${threadId} not found.` };
    const thread = read.thread;
    if (thread.id === chiefThreadId) return { ok: false, text: "That is the chief thread itself." };
    const projects = await listProjects();
    const projectName = projects.find((p) => p.id === thread.projectId)?.name ?? thread.projectId;
    const existing = store.byThread(threadId);
    if (existing) {
      const revived = existing.retiredAt !== null;
      if (revived) store.revive(existing.id);
      store.touch(existing.id);
      // An explicit adopt names the topic on purpose, unlike a brief.
      if (description !== undefined) store.setDescription(existing.id, description);
      await linkWorkerThread(threadId, null).catch((error) => bb.log.warn(`re-adopt: could not set Notify parent off: ${String(error)}`));
      record("adopt", {
        workerName: existing.name,
        projectName,
        threadId,
        excerpt: `${revived ? "Revived" : "Re-adopted"} worker ${projectName}:${existing.name}.`,
      });
      return { ok: true, text: `Thread ${threadId} is already worker ${existing.name}${revived ? " (revived)" : ""}.` };
    }
    const slug = normalizeName(name);
    if (slug === "") return { ok: false, text: "Worker name must contain letters or digits." };
    if (store.byProjectName(thread.projectId, slug)) {
      return { ok: false, text: `A worker named "${slug}" already exists in that project.` };
    }
    const worker = store.insert({ projectId: thread.projectId, name: slug, description: description?.trim() ?? "", threadId });
    await brand(worker, projectName).catch((error) => bb.log.warn(`brand on adopt: ${String(error)}`));
    store.markChiefSeen(worker.id, Date.now());
    // Sidebar fact, not a reporting mode; see the spawn site. A thread that
    // already has a parent keeps it, and gets Notify parent off all the same:
    // its reports go through this plugin from now on.
    //
    // Through the one rule, like every other parent write. An adopted worker
    // has no manager yet, so this resolves to the chief today; routing it
    // through `sidebarParentThread` means it keeps following the rule if that
    // ever stops being true.
    const parent =
      chiefThreadId && thread.parentThreadId === null
        ? sidebarParentThread(worker.managerId === null ? null : (store.byId(worker.managerId)?.threadId ?? null), chiefThreadId)
        : null;
    await linkWorkerThread(threadId, parent).catch((error) =>
      bb.log.warn(`adopt: could not ${parent === null ? "set Notify parent off" : "link the worker to the chief"}: ${String(error)}`),
    );
    record("adopt", {
      workerName: worker.name,
      projectName,
      threadId,
      excerpt: `Adopted thread ${threadId} as worker ${projectName}:${worker.name}.`,
    });
    return { ok: true, text: `Adopted thread ${threadId} as worker ${worker.name}.` };
  }

  /**
   * Retire a worker. ok is false both when the ref does not resolve and when the
   * worker was retired but its thread could not be archived; the text tells the
   * caller which. Every surface (tool, CLI, board toast) shows the same text.
   */
  async function retire(
    scope: Scope,
    ref: string,
    projectHint?: string,
    /** Where a manager's team goes. Required when it has one; "chief" or a manager ref. */
    reassign?: string,
  ): Promise<{ ok: boolean; text: string }> {
    const projects = await listProjects();
    const resolved = resolveInScope(store, projects, ref, scope, projectHint);
    if (!resolved.ok) return { ok: false, text: resolved.error };
    const { worker } = resolved;
    // A manager with a live team is not retired by accident. `store.retire`
    // cascades the team back to the chief whatever happens, so the DATA is
    // consistent either way; this guard is about making a human say out loud
    // where a whole team is going, because "back to the chief" is a decision
    // and the automatic paths that cannot ask are a different case.
    const teamSize = worker.role === "manager" ? store.teamSize(worker.id) : 0;
    if (teamSize > 0 && (reassign === undefined || reassign.trim() === "")) {
      const names = store.team(worker.id).map((w) => w.name).join(", ");
      return {
        ok: false,
        text: `${worker.name} manages ${teamSize} worker${teamSize === 1 ? "" : "s"} (${names}). Nothing was retired. Pass reassign: "chief" to move them to you, or a manager's name to move them there.`,
      };
    }
    if (teamSize > 0 && reassign !== undefined) {
      // Move the team BEFORE the archive. `deleteThreadRequestSchema` has
      // `childThreadsConfirmed` and bb keeps a `nonDeletedChildCount`, so a
      // thread with children is a confirmed action on bb's side too; clearing
      // the relation first keeps both sides in step.
      const target = reassign.trim().toLowerCase() === "chief" ? "chief" : reassign.trim();
      for (const member of store.team(worker.id)) {
        const moved = await assignWorker(scope, member.id, target);
        if (!moved.ok) {
          return { ok: false, text: `${moved.text} Nothing was retired; ${worker.name} still manages its team.` };
        }
      }
    }
    // The retirement itself always stands: the likeliest reason both SDK calls
    // fail is a thread that is already gone, and reviving would put a permanently
    // missing worker back on the roster. Each call gets its own try so a failing
    // stop does not skip the archive.
    // BEFORE retireWorker, and the order is the whole point. retireWorker
    // retargets this thread's parked reports to the chief as a safety net for
    // its automatic callers; run first, it would send the parked reports of a
    // manager retired INTO another manager to the chief, and the retarget
    // below would find nothing left to move.
    //
    // Null (the chief) whenever the team went to the chief, or the ref does
    // not resolve; the new manager's thread otherwise, because those reports
    // are that manager's to read now.
    const newHome = (() => {
      const ref = reassign?.trim() ?? "";
      if (ref === "" || ref.toLowerCase() === "chief") return null;
      const found = resolveInScope(store, projects, ref, scope);
      return found.ok ? found.worker.threadId : null;
    })();
    const retargeted = store.retargetOutbox(worker.threadId, newHome);
    if (retargeted > 0) {
      // "retire", not "failed". `failed` is the store's marker for a worker
      // TURN that ended badly: turnsSince, lastReportAt and latestActivityAt
      // all select kind IN ('report','failed'), so a bookkeeping row written
      // under it counts as a finished turn. This one is stamped with the
      // worker's own thread, so as "failed" it would show [new 1] on a worker
      // that finished nothing and reset its staleness clock to now.
      record("retire", {
        workerName: worker.name,
        threadId: worker.threadId,
        excerpt: `${retargeted} parked report${retargeted === 1 ? "" : "s"} moved to ${newHome === null ? "the chief" : (reassign ?? "the new manager")} when ${worker.name} was retired.`,
      });
    }
    retireWorker(worker, projects.find((p) => p.id === worker.projectId)?.name ?? null, worker.threadId);
    let archived = false;
    let failure: string | null = null;
    try {
      await bb.sdk.threads.stop({ threadId: worker.threadId });
    } catch (error) {
      failure = String(error);
      bb.log.warn(`retire ${worker.name}: stop: ${failure}`);
    }
    try {
      await bb.sdk.threads.archive({ threadId: worker.threadId });
      archived = true;
    } catch (error) {
      failure = String(error);
      bb.log.warn(`retire ${worker.name}: archive: ${failure}`);
    }
    const projectName = projects.find((p) => p.id === worker.projectId)?.name ?? worker.projectId;
    record("retire", {
      workerName: worker.name,
      projectName,
      threadId: worker.threadId,
      excerpt: archived
        ? `Retired worker ${projectName}:${worker.name}.`
        : `Retired worker ${projectName}:${worker.name}, but its thread could not be archived.`,
    });
    return archived
      ? { ok: true, text: `Retired worker ${worker.name} (thread ${worker.threadId} archived).` }
      : {
          ok: false,
          text: `Retired worker ${worker.name}, but thread ${worker.threadId} could not be archived: ${failure ?? "unknown error"}. Stop it by hand.`,
        };
  }

  /**
   * Silence a worker's current Need line once it was answered out of band, or
   * undo that. Each question in it is dismissed under
   * its id, so a reworded repeat stays dismissed and a different question
   * comes back on its own. An open board item closes only with a question
   * this dismissal newly answers (`needDismissalPlan`): a Need already on the
   * board was dismissed by the boarding, so dismissing it again changes
   * nothing and says which item it is on. ok is false only when the worker
   * does not resolve or its thread could not be read.
   */
  async function dismissNeed(
    scope: Scope,
    ref: string,
    opts: { project?: string; note?: string; undo?: boolean } = {},
  ): Promise<{ ok: boolean; text: string }> {
    const projects = await listProjects();
    const resolved = resolveInScope(store, projects, ref, scope, opts.project);
    if (!resolved.ok) return { ok: false, text: resolved.error };
    const { worker } = resolved;
    const projectName = projects.find((p) => p.id === worker.projectId)?.name ?? worker.projectId;
    const who = `${projectName}:${worker.name}`;
    const entry = { workerName: worker.name, projectName, threadId: worker.threadId };
    if (opts.undo) {
      if (worker.needDismissedSig === null) return { ok: true, text: `${who} has no dismissed need; nothing to undo.` };
      store.clearDismissedNeed(worker.id);
      // The questions that dismissal covered count again, under their ids. A
      // board item it closed stays closed: Put back on For you reopens it.
      if (worker.needDismissedAt !== null) store.undismissNeedItems(worker.id, worker.needDismissedAt);
      record("dismiss", { ...entry, excerpt: `Undid the dismissal of: ${worker.needDismissedSig}` });
      return { ok: true, text: `${who}: the need counts as a decision again: ${worker.needDismissedSig}` };
    }
    const output = await lastOutput(worker.threadId);
    if (!output.ok) {
      // Not "nothing to dismiss": we did not establish an absence, we failed to
      // look. Saying otherwise retires a decision that is still open.
      return {
        ok: false,
        text: `${who}: could not read the worker's output, so nothing was dismissed. Its Need line may still be open. Try again in a moment. (${excerptOf(output.error, 160)})`,
      };
    }
    const block = parseStatusBlock(output.text);
    const sig = needSignature(block.need);
    if (block.need === null || sig === null) return { ok: true, text: `${who} has no open Need line; nothing to dismiss.` };
    // Recorded like a report, so every question has its id before it is dismissed.
    const items = observeWorkerNeed(worker, block.need, false);
    const live = new Set(
      items
        .map((item) => item.record.boardItemId)
        .filter((id): id is string => id !== null && ["open", "addressed"].includes(store.boardItem(id)?.state ?? "")),
    );
    const plan = needDismissalPlan(worker.needDismissedSig, sig, items.map((item) => item.record), live);
    if (plan.kind === "already") {
      const where = plan.onBoard.join(", ");
      return {
        ok: true,
        text: `${who}: that need is already dismissed${where === "" ? "." : `, because it is on the board as ${where}. Resolve that item (cos_board_resolve) once it is answered.`}`,
      };
    }
    const note = opts.note?.trim() || null;
    const now = Date.now();
    const ids = needIdsOf(items);
    store.dismissNeed(worker.id, sig, note, now);
    store.dismissNeedItems(plan.dismiss, note, now);
    record("dismiss", { ...entry, excerpt: `Dismissed the need "${block.need}"${note ? ` (${note})` : ""}${ids.length > 0 ? ` [${ids.join(", ")}]` : ""}` });
    const closed = closeAnsweredBoardItems(plan.closeBoardItems, `its Need (${ids.join(", ")}) was dismissed${note ? `: ${note}` : ""}`, now);
    return {
      ok: true,
      text: `${who}: dismissed "${block.need}"${note ? ` (${note})` : ""}${ids.length > 0 ? `, Need ${ids.join(", ")}` : ""}. It no longer counts as a decision, and a reworded repeat stays dismissed; a different question comes back by itself, or use undo.${closed.length > 0 ? ` Closed the board item${closed.length === 1 ? "" : "s"} carrying it: ${boardNames(closed)}.` : ""}`,
    };
  }

  /**
   * Close these board items, the ones carrying a question a dismissal newly
   * answered, when still open, stamped automatic so they show in the For you
   * note with a Put back. An addressed item waits for the chief.
   */
  function closeAnsweredBoardItems(boardIds: readonly string[], why: string, at = Date.now()): BoardItem[] {
    const closed: BoardItem[] = [];
    for (const boardId of boardIds) {
      const item = store.boardItem(boardId);
      if (item === null || item.state !== "open") continue;
      if (store.boardAutoDismiss(boardId, `Closed automatically: ${why}.`, at)) closed.push(item);
    }
    if (closed.length > 0) {
      record("board-move", { excerpt: `The plugin closed ${closed.length} item${closed.length === 1 ? "" : "s"} because ${why}: ${boardNames(closed)}` });
    }
    return closed;
  }

  // ---------- branding: title and avatar ----------

  /** Where the exported SVG and PNG-ready files live, one per worker, for anything outside bb. */
  const AVATAR_DIR = path.join(BB_DATA_DIR, "cos-avatars");

  function parseAvatarKey(key: string | null): Avatar | null {
    if (key === null) return null;
    const [shape, color] = key.split("/");
    if (!shape || !color) return null;
    const avatar = { shape, color };
    return isKnownAvatar(avatar) ? avatar : null;
  }

  /**
   * Give a worker its human title and its avatar. Idempotent: an avatar that is
   * already assigned is kept, so the picture never changes under the user. The
   * title is only written when the thread has none or still carries the
   * worker's slug or its first-prompt fallback; a title typed by hand
   * is left alone unless `force` is set.
   */
  async function brand(
    worker: Worker,
    projectName: string,
    opts: { title?: string; force?: boolean } = {},
  ): Promise<{ title: string | null; avatar: Avatar; changed: boolean }> {
    let didChange = false;
    let avatar = parseAvatarKey(worker.avatar);
    if (avatar === null) {
      avatar = pickAvatar(`${projectName}:${worker.name}`, store.takenAvatars(worker.id));
      store.setAvatar(worker.id, avatarKey(avatar));
      didChange = true;
    }
    const wanted = opts.title?.trim() || titleFor(worker.name);
    let title: string | null = null;
    const thread = await threadOrNull(worker.threadId);
    if (thread) {
      const current = thread.title;
      // The slug with every word capitalised counts as generic too ("Chief Of
      // Staff", "Team Lead"), so a brand rewrites it and still leaves a title
      // someone typed alone.
      const oldCasing = worker.name
        .split(/[-_\s]+/)
        .filter((part) => part !== "")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
      const generic =
        current === null || current === "" || current === worker.name || current === titleFor(worker.name) || current === oldCasing;
      if (opts.force || generic) {
        if (current !== wanted) {
          try {
            await bb.sdk.threads.update({ threadId: worker.threadId, title: wanted });
            didChange = true;
          } catch (error) {
            bb.log.warn(`brand ${worker.name}: could not set title: ${String(error)}`);
          }
        }
        title = wanted;
      } else {
        title = current;
      }
    }
    // Export a file too, so anything outside the bb app (docs, dashboards) can use it.
    try {
      await mkdir(AVATAR_DIR, { recursive: true });
      await writeFile(path.join(AVATAR_DIR, `${projectName}--${worker.name}.svg`), avatarSvg(avatar), "utf8");
      const registryPath = path.join(AVATAR_DIR, "registry.json");
      const rows = store
        .list({ includeRetired: true })
        .filter((w) => w.avatar !== null)
        .map((w) => ({ workerId: w.id, projectId: w.projectId, name: w.name, threadId: w.threadId, avatar: w.avatar, retired: w.retiredAt !== null }));
      await writeFile(registryPath, JSON.stringify({ combinations: AVATAR_COMBINATIONS, workers: rows }, null, 2), "utf8");
    } catch (error) {
      bb.log.warn(`brand ${worker.name}: could not export avatar file: ${String(error)}`);
    }
    if (didChange) changed();
    return { title, avatar, changed: didChange };
  }

  /** Brand by reference, for the CLI and the tool. */
  async function brandRef(scope: Scope, ref: string, opts: { title?: string; force?: boolean; project?: string }): Promise<{ ok: boolean; text: string }> {
    const projects = await listProjects();
    const resolved = resolveInScope(store, projects, ref, scope, opts.project);
    if (!resolved.ok) return { ok: false, text: resolved.error };
    const projectName = projects.find((p) => p.id === resolved.worker.projectId)?.name ?? resolved.worker.projectId;
    const result = await brand(resolved.worker, projectName, opts);
    return {
      ok: true,
      text: `${projectName}:${resolved.worker.name}  title "${result.title ?? "(unchanged)"}"  avatar ${result.avatar.shape}/${result.avatar.color}${result.changed ? "" : "  (already branded)"}`,
    };
  }

  /** Every live worker without an avatar or with a slug title gets branded. Safe to run repeatedly. */
  async function brandAll(force = false): Promise<string> {
    const projects = await listProjects();
    const lines: string[] = [];
    for (const worker of store.list()) {
      const projectName = projects.find((p) => p.id === worker.projectId)?.name ?? worker.projectId;
      const result = await brand(worker, projectName, { force });
      lines.push(`${projectName}:${worker.name}  "${result.title ?? "?"}"  ${result.avatar.shape}/${result.avatar.color}`);
    }
    return lines.length === 0 ? "No workers." : lines.join("\n");
  }

  // ---------- remodel: move a worker to another provider or model ----------

  /** Threads that must never be remodelled: the chief itself, and the comms chief on --all. */
  async function protectedThreadIds(explicitTarget = false): Promise<Set<string>> {
    const ids = new Set<string>();
    if (chiefThreadId) ids.add(chiefThreadId);
    // The Chief of Communications plugin keeps its chief id in its own kv; read
    // it through the thread list by title as a fallback so a rename does not
    // unprotect it on --all. When explicitly targeted (input.ref !== null),
    // remodelOne syncs the comms plugin via `bb comms set-chief <newThreadId>`.
    try {
      const all = await bb.sdk.threads.list({ archived: false, includeHidden: true, limit: 500 });
      for (const t of all) {
        if ((t.title ?? "") === CHIEF_TITLE) ids.add(t.id);
        if (!explicitTarget && (t.title ?? "") === "Chief of Communications") ids.add(t.id);
      }
    } catch {
      // list failure only weakens the title fallback; the id list above still holds.
    }
    // Only the kv lookup and the title fallback decide; there are no literal
    // thread ids, since those differ on every install.
    return ids;
  }

  /**
   * The worker's last `count` finished assistant messages, oldest first, from
   * the thread event log. `ok: false` is "could not read", which the handover
   * must not word as "there were none".
   */
  async function lastFinishedMessages(threadId: string, count: number): Promise<{ ok: true; messages: string[] } | { ok: false }> {
    try {
      const messages = await lastFinishedMessagesFrom(
        async (query) => {
          const rows = await bb.sdk.threads.events.list({
            threadId,
            types: query.type === "item/completed" ? ["item/completed", "client/turn/requested"] : [query.type],
            order: "desc",
            limit: String(query.limit),
            ...(query.beforeSeq === null ? {} : { beforeSeq: String(query.beforeSeq) }),
            ...(query.afterSeq === null ? {} : { afterSeq: String(query.afterSeq) }),
          });
          if (query.type === "item/completed" && !rows.some((r) => r.type === "client/turn/requested")) {
            const reqs = await bb.sdk.threads.events.list({
              threadId,
              types: ["client/turn/requested"],
              order: "desc",
              limit: "5",
              ...(query.beforeSeq === null ? {} : { beforeSeq: String(query.beforeSeq) }),
              ...(query.afterSeq === null ? {} : { afterSeq: String(query.afterSeq) }),
            });
            return [...rows, ...reqs];
          }
          return rows;
        },
        count,
      );
      return { ok: true, messages };
    } catch (error) {
      bb.log.warn(`remodel: could not read messages of ${threadId}: ${String(error)}`);
      return { ok: false };
    }
  }

  /** How a sender thread is named in a handover transcript. */
  function transcriptSenderName(threadId: string): string {
    if (threadId === chiefThreadId) return "Chief of Staff";
    const w = store.byThread(threadId);
    return w ? `${w.name} (${threadId})` : `thread ${threadId}`;
  }

  type TranscriptRead = { ok: true; messages: TranscriptMessage[] } | { ok: false; error: string };

  /**
   * Every user and assistant message of a thread, oldest first, read newest
   * first a page at a time (bb caps a page at 100). `ok: false` is "could not
   * read", which the handover must not word as "there were none". The text is
   * scrubbed like any worker text that reaches an agent.
   */
  async function readTranscript(
    threadId: string,
    assistantName: string,
  ): Promise<TranscriptRead> {
    try {
      const rows: TranscriptRow[] = [];
      let beforeSeq: number | null = null;
      for (let page = 0; page < 2_000; page++) {
        const batch = await bb.sdk.threads.events.list({
          threadId,
          types: ["client/turn/requested", "item/completed"],
          order: "desc",
          limit: "100",
          ...(beforeSeq === null ? {} : { beforeSeq: String(beforeSeq) }),
        });
        for (const r of batch) rows.push({ seq: r.seq, type: r.type, createdAt: r.createdAt, data: r.data });
        if (batch.length < THREAD_EVENTS_PAGE_MAX) break;
        const lowest = Math.min(...batch.map((r) => r.seq));
        if (beforeSeq !== null && lowest >= beforeSeq) break;
        beforeSeq = lowest;
      }
      const messages = transcriptFromEvents(rows, { assistant: assistantName, sender: transcriptSenderName }).map((m) => ({
        ...m,
        text: scrubUntrusted(m.text).text,
      }));
      return { ok: true, messages };
    } catch (error) {
      bb.log.warn(`handover: could not read the transcript of ${threadId}: ${String(error)}`);
      return { ok: false, error: String(error) };
    }
  }

  /** The worker's last status block: from its newest message that carries one, else the stored report. */
  function carriedStatusBlock(worker: Worker, messages: readonly TranscriptMessage[]): { done: string | null; open: string | null; need: string | null } {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role !== "assistant") continue;
      const parsed = parseStatusBlock(messages[i]!.text);
      if (parsed.done !== null || parsed.open !== null || parsed.need !== null) return parsed;
    }
    const stored = parseStatusBlock(worker.lastReportText);
    return { done: stored.done, open: stored.open, need: stored.need };
  }

  /** Last task, last status report, open items and pending need, as every handover prints them. */
  function carriedStatusLines(worker: Worker, block: { done: string | null; open: string | null; need: string | null }): (string | null)[] {
    return [
      worker.lastTask ? `Your last delegated task: ${worker.lastTask}` : null,
      block.done || block.open || block.need
        ? [
            "Your last status report:",
            `  Done: ${block.done ?? "none recorded."}`,
            `  Open: ${block.open ?? "none recorded."}`,
            `  Need: ${block.need ?? "nothing"}`,
          ].join("\n")
        : worker.lastReportText
          ? `Your last status report:\n${truncate(worker.lastReportText.trim(), 1200)}`
          : null,
      block.open ? `Open items carried over: ${block.open}` : "Open items carried over: none recorded.",
      block.need ? `Pending need carried over: ${block.need}` : null,
    ];
  }

  type HandoverSection = HandoverTranscript & { readFailed: boolean };

  /** The transcript part of a handover, within `maxTokens`; a failed read says so instead. */
  async function handoverTranscriptSection(name: string, oldThreadId: string, read: TranscriptRead, maxTokens: number): Promise<HandoverSection> {
    if (!read.ok) {
      const text = `I could not read the old thread's messages (${truncate(read.error, 200)}), so none are carried over. Read them yourself with \`bb thread output ${oldThreadId}\` before you confirm what is open.`;
      return { text, messageCount: 0, keptCount: 0, omittedCount: 0, tokens: estimateTokens(text), readFailed: true };
    }
    const built = buildHandoverTranscript({ messages: read.messages, oldThreadId, maxTokens });
    if (built.omittedCount > 0) bb.log.info(`handover ${name}: ${built.omittedCount} older messages over the cap left out; sent the newest ${built.keptCount}`);
    return { ...built, readFailed: false };
  }

  function handoverSizeLine(t: HandoverSection): string {
    if (t.readFailed) return "old thread unreadable, no messages carried over";
    const omitted = t.omittedCount > 0 ? `, the older ${t.omittedCount} left out (said so in the handover)` : "";
    return `${t.keptCount} of ${t.messageCount} messages in full${omitted}, about ${t.tokens} tokens (estimate: characters / 4)`;
  }

  /** How long `bb cos move` waits for the thread's one-line move turn. */
  const FOLDER_MOVE_WAIT_SECONDS = 300;

  /**
   * `bb cos move <worker|chief> <absolute-path> [--dry-run]`. See `folderMoveRequest` in core.ts for why the
   * thread moves itself. Order: read the transcript (before the move turn, so
   * that turn is not in it), ask the idle thread to call
   * update_environment_directory, wait for the turn under PLUGIN_WAIT so its
   * one-line report goes to nobody, confirm the new path in bb, and only then
   * queue the handover (attributed, no sender, so its turn reports to nobody
   * unless it is loud). Chief-only; works for the chief, which has no worker row.
   */
  async function moveThreadFolder(input: { scope: Scope; ref: string; path: string; project?: string; dryRun: boolean }): Promise<{ ok: boolean; text: string }> {
    const gate = refuseUnlessChief(input.scope, "Moving a thread's folder");
    if (gate) return { ok: false, text: gate };
    let threadId: string;
    let name: string;
    let label: string;
    if (input.ref.trim().toLowerCase() === "chief") {
      if (!chiefThreadId) return { ok: false, text: "There is no chief thread." };
      threadId = chiefThreadId;
      name = "chief";
      label = "chief";
    } else {
      const projects = await listProjects();
      const resolved = resolveInScope(store, projects, input.ref, input.scope, input.project);
      if (!resolved.ok) return { ok: false, text: resolved.error };
      threadId = resolved.worker.threadId;
      name = resolved.worker.name;
      label = `${projects.find((p) => p.id === resolved.worker.projectId)?.name ?? resolved.worker.projectId}:${name}`;
    }
    const target = input.path.startsWith("~/") ? path.join(os.homedir(), input.path.slice(2)) : input.path;
    const read = await readThread(threadId);
    if (read.kind !== "ok") return { ok: false, text: `${label}: could not read its thread (${read.kind}). Nothing was moved.` };
    const env = read.thread.environmentId ? await environmentOrNull(read.thread.environmentId) : null;
    const oldPath = env?.path ?? null;
    let targetIsDirectory = false;
    try {
      targetIsDirectory = (await stat(target)).isDirectory();
    } catch {
      targetIsDirectory = false;
    }
    const refusal = folderMoveRefusal({
      busy: BUSY_STATUSES.has(read.thread.runtime.displayStatus) || waitedForBy(threadId, PLUGIN_WAIT),
      targetIsDirectory,
      currentPath: oldPath,
      targetPath: target,
    });
    if (refusal) return { ok: false, text: `${label}: ${refusal} Nothing was moved.` };

    const transcriptRead = await readTranscript(threadId, name);
    if (!transcriptRead.ok) return { ok: false, text: `${label}: could not read its conversation (${transcriptRead.error}), so it was not moved.` };
    const shell = folderMoveHandover({ name, oldPath, newPath: target, transcript: "" });
    const transcript = await handoverTranscriptSection(name, threadId, transcriptRead, HANDOVER_MAX_TOKENS - estimateTokens(shell));
    const body = folderMoveHandover({ name, oldPath, newPath: target, transcript: transcript.text });
    const size = `${handoverSizeLine(transcript)}; ${estimateTokens(body)} tokens in the whole message`;
    if (input.dryRun) {
      return { ok: true, text: `${label} (dry run, nothing moved): would move ${threadId} from ${oldPath ?? "(unknown)"} to ${target}, then queue its conversation. ${size}.` };
    }

    const release = addWaiter(threadId, PLUGIN_WAIT);
    try {
      await sendToThread({
        threadId,
        mode: "queue-if-active",
        input: [{ type: "text", text: folderMoveRequest(target), mentions: [] }],
        ...(await permissionFor(threadId)),
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        await bb.sdk.threads.wait({ threadId, status: "idle", timeoutMs: FOLDER_MOVE_WAIT_SECONDS * 1000 });
      } catch (error) {
        return { ok: false, text: `${label}: the move turn did not finish in ${FOLDER_MOVE_WAIT_SECONDS}s (${String(error)}). Check ${threadId} by hand; the handover was not queued.` };
      }
    } finally {
      release();
    }
    const after = await readThread(threadId);
    const afterEnv = after.kind === "ok" && after.thread.environmentId ? await environmentOrNull(after.thread.environmentId) : null;
    const norm = (p: string | null) => (p === null ? null : p.replace(/\/+$/, ""));
    if (norm(afterEnv?.path ?? null) !== norm(target)) {
      return {
        ok: false,
        text: `${label}: the thread did not move; bb shows ${afterEnv?.path ?? "an unreadable folder"}. The handover was not queued. Read ${threadId} for what its move turn said.`,
      };
    }
    await sendToThread({
      threadId,
      mode: "queue-if-active",
      input: [{ type: "text", text: body, mentions: [] }],
      ...(await permissionFor(threadId)),
    });
    record("forward", { threadId, excerpt: `Moved ${label} from ${oldPath ?? "(unknown)"} to ${target}; queued its conversation: ${size}` });
    changed();
    return { ok: true, text: `${label}: moved ${threadId} from ${oldPath ?? "(unknown)"} to ${target}, and queued its conversation as background. ${size}.` };
  }

  /**
   * `bb cos rehandover <worker>`: rebuild the full handover from the worker's
   * `previous_thread_id` and queue it into its current thread as one attributed
   * message, for a worker whose new thread was seeded with only its last few
   * messages. `queue-if-active`, so it never interrupts a running turn. Chief
   * only, like remodel. A dry run reads and measures and sends nothing.
   */
  async function rehandover(input: { scope: Scope; ref: string; project?: string; dryRun: boolean }): Promise<{ ok: boolean; text: string }> {
    const gate = refuseUnlessChief(input.scope, "Rebuilding a worker's handover");
    if (gate) return { ok: false, text: gate };
    const projects = await listProjects();
    const resolved = resolveInScope(store, projects, input.ref, input.scope, input.project);
    if (!resolved.ok) return { ok: false, text: resolved.error };
    const worker = resolved.worker;
    const projectName = projects.find((p) => p.id === worker.projectId)?.name ?? worker.projectId;
    const label = `${projectName}:${worker.name}`;
    const previous = worker.previousThreadId;
    if (!previous) return { ok: false, text: `${label} has no previous thread recorded, so there is no handover to rebuild.` };
    try {
      const result = await runRehandover({
        dryRun: input.dryRun,
        build: async () => {
          const read = await readTranscript(previous, worker.name);
          if (!read.ok) throw new Error(`could not read ${previous}: ${read.error}`);
          const thread = await threadOrNull(worker.threadId);
          const env = thread?.environmentId ? await environmentOrNull(thread.environmentId) : null;
          const head = [
            `Rebuilt handover for ${worker.role === "manager" ? "manager" : "worker"} "${worker.name}" in project "${projectName}". When this thread replaced ${previous}, it was given only the last few messages. Below is the old thread's whole conversation.`,
            worker.description ? `Topic: ${worker.description}` : null,
            env?.path ? `Your standing briefing is ${path.join(env.path, "CLAUDE.md")}.` : null,
            ...carriedStatusLines(worker, carriedStatusBlock(worker, read.messages)),
          ].filter((line): line is string => line !== null);
          const tail =
            "Read this as context for the work you are already doing. Do not start new work because of it. End this turn with Done / Open / Need; if it changes nothing, Need: nothing.";
          const transcript = await handoverTranscriptSection(
            worker.name,
            previous,
            read,
            HANDOVER_MAX_TOKENS - estimateTokens([PLUGIN_ATTRIBUTION, ...head, tail].join("\n\n")),
          );
          return { body: attributed([...head, transcript.text, tail].join("\n\n")), transcript };
        },
        send: async (body) => {
          await sendToThread({
            threadId: worker.threadId,
            mode: "queue-if-active",
            input: [{ type: "text", text: body, mentions: [] }],
            ...(await permissionFor(worker.threadId)),
          });
        },
      });
      const size = `${handoverSizeLine(result.transcript)}; ${estimateTokens(result.body)} tokens in the whole message`;
      if (!result.sent) return { ok: true, text: `${label} (dry run, nothing sent): would queue a rebuilt handover from ${previous} into ${worker.threadId}. ${size}.` };
      record("delegate", { workerName: worker.name, projectName, threadId: worker.threadId, excerpt: `rehandover from ${previous}: ${size}` });
      return { ok: true, text: `${label}: rebuilt handover from ${previous} queued into ${worker.threadId}. ${size}.` };
    } catch (error) {
      return { ok: false, text: `${label}: ${String(error)}. Nothing was sent.` };
    }
  }

  interface RemodelInput {
    /**
     * What the caller may act on. Remodel is chief-only as a TOOL, but the
     * `bb cos remodel` verb reaches the same function, so the check belongs
     * here rather than in the tool list.
     */
    scope: Scope;
    /** Worker reference, or null with `all`. */
    ref: string | null;
    project?: string;
    providerId?: string;
    model?: string;
    /** Reasoning level for the new thread, one of `WORKER_REASONING_LEVELS`. Blank means the workerReasoningLevel setting. */
    reasoningLevel?: string;
    dryRun: boolean;
    signal?: AbortSignal;
    /** When a tool caller must have its answer; see `TOOL_CALL_BUDGET_MS`. Null or absent on the CLI. */
    deadlineAt?: number | null;
    /** The thread that asked, told the outcome of an orientation that outlived the tool call. */
    callerThreadId?: string | null;
  }

  interface RemodelPlan {
    worker: Worker;
    projectName: string;
    fromProvider: string | null;
    fromModel: string | null;
    /** The level it was on when the plan was made, read from the thread. */
    fromLevel: string | null;
    /** The reasoning level this worker's replacement runs at; per worker, so an --all run does not level everyone. */
    level: WorkerReasoningLevel;
    reason: string | null;
  }

  /**
   * Move workers to a new thread on the target provider and model.
   *
   * For each worker whose thread differs from the target: spawn a new thread in
   * the same project (same environment when the old one still exists), seeded
   * with a handover (CLAUDE.md path, the old thread's conversation, Open items);
   * repoint the worker row (old id kept in previous_thread_id); brand it with
   * the same title and avatar; wait for one orientation turn; then archive the
   * old thread. A failed orientation leaves both threads and reports it.
   */
  async function remodel(input: RemodelInput): Promise<{ ok: boolean; text: string }> {
    const current = await settings.get();
    const wantedLevel = parseReasoningLevel(input.reasoningLevel);
    if (!wantedLevel.ok) return { ok: false, text: `${wantedLevel.error} Nothing was remodelled.` };
    const targetProvider = input.providerId?.trim() || current.workerProviderId || null;
    const targetModel =
      input.providerId?.trim() && input.providerId.trim() !== current.workerProviderId && !input.model?.trim()
        ? null
        : input.model?.trim() || current.workerModel || null;
    if (!targetProvider) return { ok: false, text: "No target provider: pass --provider or set the workerProviderId setting." };
    const targetCatalog = await loadCatalog({ providerId: targetProvider, environmentId: null });
    // A remodel always pins the level, so moving a worker and raising its
    // reasoning is one step instead of a follow-up `bb thread update`. Without
    // an explicit level a move within one model family keeps the worker's own,
    // and a move across families maps it: the level belongs to the model.
    const levelFor = (exec: { model: string | null; reasoningLevel: string | null }): WorkerReasoningLevel => {
      const mapped = levelForModelChange({
        requested: wantedLevel.level,
        current: exec.reasoningLevel,
        fromModel: exec.model,
        toModel: targetModel,
        setting: current.workerReasoningLevel,
        fallback: DEFAULT_WORKER_REASONING_LEVEL,
      });
      if (wantedLevel.level === null && targetModel) {
        const suffixMatch = /-(low|medium|high)$/.exec(targetModel);
        if (suffixMatch) {
          const parsed = parseReasoningLevel(suffixMatch[1]);
          if (parsed.ok && parsed.level !== null) return parsed.level;
        }
        if (targetCatalog.models.length > 0) {
          const clamped = reasoningForModel(mapped, targetModel, targetCatalog.models);
          if (clamped !== null) {
            const parsed = parseReasoningLevel(clamped);
            if (parsed.ok && parsed.level !== null) return parsed.level;
          }
        }
      }
      if (
        (targetProvider === "acp-omp" || targetProvider === "acp-antigravity") &&
        (mapped === "xhigh" || mapped === "ultracode" || mapped === "max")
      ) {
        return "high";
      }
      return mapped;
    };
    const projects = await listProjects();
    const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
    const protectedIds = await protectedThreadIds(input.ref !== null);

    let candidates: Worker[];
    if (input.ref === null) {
      // `--all` is the destructive path AND the disclosing one (--dry-run
      // prints every thread id, provider, model and level), so it is scoped
      // like the single-worker path: unscoped, an honest manager with its own
      // unforged BB_THREAD_ID could re-thread every worker in the fleet.
      switch (input.scope.kind) {
        case "chief":
        // `none` is a bare terminal, which is the user, and it gets the whole
        // fleet exactly as the chief does. Every other gate in this plugin
        // treats `none` that way (`refuseUnlessChief` returns null for it, and
        // the board guard says so in as many words). Refusing it here would
        // lock a bare terminal out of `bb cos remodel --all`.
        case "none":
          candidates = store.list();
          break;
        case "manager":
          candidates = store.team(input.scope.managerId);
          break;
        case "worker":
          return { ok: false, text: "You are a worker, not a manager. Remodelling is the chief's. Nothing was remodelled." };
        case "unreadable":
          return { ok: false, text: "Could not read the roster to check who is asking. Nothing was remodelled; try again." };
      }
    } else {
      const resolved = resolveInScope(store, projects, input.ref, input.scope, input.project);
      if (!resolved.ok) return { ok: false, text: resolved.error };
      candidates = [resolved.worker];
    }

    const plans: RemodelPlan[] = [];
    const skipped: string[] = [];
    for (const worker of candidates) {
      const pname = projectName(worker.projectId);
      const label = `${pname}:${worker.name}`;
      if (protectedIds.has(worker.threadId)) {
        skipped.push(`${label}: protected (a chief thread), never remodelled`);
        continue;
      }
      // Skipping is the safe direction either way, but the two reasons are not
      // the same and the chief acts on them differently: a gone thread means
      // retire the worker, an unreachable one means try the remodel again.
      const state = await threadState(worker.threadId);
      if (state.kind === "unreachable") {
        skipped.push(`${label}: could not read thread ${worker.threadId} (${state.error}); not remodelled, try again`);
        continue;
      }
      if (state.kind === "gone") {
        skipped.push(`${label}: thread ${worker.threadId} is gone or archived`);
        continue;
      }
      const thread = state.thread;
      if (thread.status !== "idle" && thread.status !== "error") {
        skipped.push(`${label}: thread is ${thread.runtime.displayStatus}, wait until it is idle`);
        continue;
      }
      const fromProvider = thread.providerId ?? worker.providerId;
      // From the thread. The roster keeps no model or level, because this
      // plugin is not their only writer and a copy would go stale.
      const planExec = await workerExecution(worker.threadId);
      // A null model here means the READ did not land, not that nothing is set:
      // defaultExecutionOptions always carries a model when it answers at all.
      // Left to fall through, `sameModel` would come out false and the worker
      // would be remodelled on the assumption it was on the wrong model, which for a
      // worker already on the target costs it its thread: a remodel archives
      // the predecessor and is not reversible. Skipping is the cheap direction.
      if (planExec.model === null) {
        skipped.push(`${label}: could not read what it is running now; not remodelled, try again`);
        continue;
      }
      const fromModel = planExec.model;
      const sameProvider = fromProvider === targetProvider;
      const sameModel = targetModel === null || fromModel === targetModel;
      // The level counts as part of the target: a worker on the right model at
      // the wrong level is exactly what an explicit --reasoning asks to fix.
      const level = levelFor(planExec);
      const sameLevel = wantedLevel.level === null || planExec.reasoningLevel === level;
      if (sameProvider && sameModel && sameLevel) {
        skipped.push(`${label}: already on ${executionLabel(fromProvider, fromModel, planExec.reasoningLevel)}`);
        continue;
      }
      plans.push({ worker, projectName: pname, fromProvider, fromModel, fromLevel: planExec.reasoningLevel, level, reason: null });
    }

    // No explicit level means each worker keeps its own, so the header does not
    // claim one; the per-worker lines below carry the real level.
    const target = executionLabel(targetProvider, targetModel, wantedLevel.level);
    if (input.dryRun) {
      const lines = [`Remodel dry run. Target: ${target}.`];
      if (plans.length === 0) lines.push("Nothing would change.");
      else {
        lines.push(`Would move ${plans.length} worker${plans.length === 1 ? "" : "s"}:`);
        for (const p of plans) {
          lines.push(
            `  ${p.projectName}:${p.worker.name}  ${p.worker.threadId}  ${executionLabel(p.fromProvider, p.fromModel, p.fromLevel) || "unknown"}  ->  ${executionLabel(targetProvider, targetModel, p.level)}  (new thread in project ${p.projectName}, same environment, handover seeded, old thread archived after one orientation turn)`,
          );
        }
      }
      if (skipped.length > 0) {
        lines.push("Skipped:");
        for (const s of skipped) lines.push(`  ${s}`);
      }
      return { ok: true, text: lines.join("\n") };
    }

    if (plans.length === 0) {
      return { ok: true, text: `Nothing to remodel. Target ${target}.${skipped.length ? `\nSkipped:\n  ${skipped.join("\n  ")}` : ""}` };
    }

    const results: string[] = [];
    const deadlineAt = input.deadlineAt ?? null;
    for (const [i, plan] of plans.entries()) {
      // Past the deadline a spawn would still be running when bb cuts the call
      // and the caller would learn nothing about it. Stop, and say which ones.
      // Running the same remodel again skips the workers already on the target.
      // A spawn, its pins and the first wait can take about a minute on a
      // slow bb, so one started close to the deadline would overrun the cut.
      if (deadlineAt !== null && deadlineAt - Date.now() < REMODEL_START_MARGIN_MS) {
        const left = plans.slice(i).map((p) => `${p.projectName}:${p.worker.name}`);
        results.push(
          `Not started, because one tool call cannot run long enough: ${left.join(", ")}. Run the same remodel again; the workers already moved are skipped.`,
        );
        break;
      }
      results.push(
        await remodelOne(plan, targetProvider, targetModel, plan.level, current, input.signal, deadlineAt, input.callerThreadId ?? null),
      );
    }
    if (skipped.length > 0) results.push(`Skipped:\n  ${skipped.join("\n  ")}`);
    return { ok: true, text: results.join("\n") };
  }

  async function remodelOne(
    plan: RemodelPlan,
    targetProvider: string,
    targetModel: string | null,
    targetLevel: WorkerReasoningLevel,
    current: Awaited<ReturnType<typeof settings.get>>,
    signal?: AbortSignal,
    deadlineAt: number | null = null,
    callerThreadId: string | null = null,
  ): Promise<string> {
    const { worker, projectName } = plan;
    const label = `${projectName}:${worker.name}`;
    const oldRead = await readThread(worker.threadId);
    if (oldRead.kind === "unreachable") {
      return `${label}: ${unreachableThreadNote(worker.threadId, oldRead.error)} The remodel was not started.`;
    }
    if (oldRead.kind === "gone") return `${label}: old thread vanished before remodel; nothing done.`;
    const oldThread = oldRead.thread;
    // The sidebar section the worker sits in. It belongs to the worker, not to
    // the thread, so it has to move with the remodel.
    const oldSection = oldThread.sectionId ?? null;

    // Handover material.
    const oldEnv = oldThread.environmentId ? await environmentOrNull(oldThread.environmentId) : null;
    const envPath = oldEnv?.path ?? null;
    // A failed environment read must not reach the handover as "this project
    // has no CLAUDE.md yet; create one", which is an instruction to write a
    // file on top of one the worker cannot see. Tell it what actually happened.
    const envUnreadable = oldThread.environmentId !== null && oldEnv === null;
    const claudeMd = envPath ? path.join(envPath, "CLAUDE.md") : null;
    const allProjects = await listProjects();
    const transcriptRead = await readTranscript(worker.threadId, worker.name);
    const block = carriedStatusBlock(worker, transcriptRead.ok ? transcriptRead.messages : []);
    const teamMembers = worker.role === "manager" ? store.team(worker.id) : [];
    const managerTeam = teamMembers.map((m) => m.name);
    let teamStatuses: WorkerStatus[] = [];
    if (worker.role === "manager" && teamMembers.length > 0) {
      try {
        teamStatuses = (await buildRosterStatus({ managerId: worker.id })).workers;
      } catch {
        teamStatuses = [];
      }
    }
    const teamDetails =
      teamMembers.length > 0
        ? teamMembers
            .map((m) => {
              const ms = teamStatuses.find((s) => s.id === m.id) ?? null;
              const mProj = ms?.projectName ?? allProjects.find((p) => p.id === m.projectId)?.name ?? m.projectId;
              const mNew = ms?.newTurns ?? store.turnsSince(m.threadId, m.chiefLastSeenAt);
              const storedBlock = parseStatusBlock(m.lastReportText);
              const done = ms?.lastDone ?? storedBlock.done;
              const open = ms?.lastOpen ?? storedBlock.open;
              const need = ms?.lastNeed ?? storedBlock.need;
              const rawStatus = ms ? (ms.missing ? "missing" : ms.displayStatus) : "idle";
              const waitingReason = ms?.pendingInteraction
                ? "blocked on prompt"
                : ms?.blockedUntil !== null && ms?.blockedUntil !== undefined
                  ? `rate-limited until ${formatClock(ms.blockedUntil)}`
                  : need && !ms?.needDismissed
                    ? `waiting on ${ms?.needAudience === "chief" ? "chief/manager" : "user"}: ${truncate(need, 200)}`
                    : null;
              const exec = executionLabel(ms?.providerId ?? m.providerId, ms?.model ?? null, ms?.reasoningLevel ?? null);
              const fallbackReport =
                !done && !open && !need && m.lastReportText ? truncate(m.lastReportText.trim(), 600) : null;
              const parts = [
                `- ${mProj}:${m.name} (${m.threadId}) [${rawStatus}${waitingReason ? ` - ${waitingReason}` : ""}]${exec ? ` on ${exec}` : ""}${mNew > 0 ? ` [new ${mNew}]` : ""}${m.description ? `: ${m.description}` : ""}`,
                m.lastTask ? `  last task: ${truncate(m.lastTask, 400)}` : null,
                done ? `  last done: ${truncate(done, 600)}` : null,
                open ? `  open: ${truncate(open, 600)}` : null,
                need ? `  need: ${truncate(need, 600)}` : null,
                fallbackReport ? `  last report: ${fallbackReport}` : null,
              ];
              return parts.filter((line): line is string => line !== null).join("\n");
            })
            .join("\n")
        : null;
    const isCommsChief = worker.name === "chief-of-comms" || (oldThread.title ?? "") === "Chief of Communications";
    // The companion plugin's skill is looked up in the same plugins folder as this one.
    const commsSkillMd = path.join(path.dirname(PLUGIN_DIR), "chief-of-comms", "skills", "chief-of-comms", "SKILL.md");
    const head = [
      `You are ${worker.role === "manager" ? "manager" : "worker"} "${worker.name}" in project "${projectName}", continuing on a new thread after a provider change (now ${executionLabel(targetProvider, targetModel, targetLevel)}). Your previous thread was ${worker.threadId}; its conversation is carried over below.`,
      worker.description ? `Topic: ${worker.description}` : null,
      isCommsChief
        ? `You are also the Chief of Communications thread for the \`chief-of-comms\` plugin. Read ${commsSkillMd} and ${claudeMd ?? path.join(HOME_DIR, "CLAUDE.md")} first. On \`acp-omp\`, native \`comms_*\` tools and the Claude \`Skill\` tool are not exposed directly; run the equivalent \`bb comms\` CLI commands via \`bash\` (\`bb comms inbox\`, \`bb comms open <key>\`, \`bb comms facts <key>\`, \`bb comms voice <key>\`, \`bb comms voice-note <key> [--note <text>] [--avoid <text>] [--about <text>] [--replace-about] [--reviewed]\`, \`bb comms mail draft/draft-update/draft-delete/drafts\`, \`bb comms wa draft/keep/drafts/discard\`, \`bb comms dismiss <key>\`).`
        : null,
      worker.role === "manager"
        ? managerTeam.length > 0
          ? `Your team (${managerTeam.length} workers): ${managerTeam.join(", ")}. On \`acp-omp\` or \`acp-antigravity\`, use the \`bb cos\` CLI (\`bb cos roster\`, \`bb cos delegate\`, \`bb cos read\`, \`bb cos wait\`) via bash when native \`cos_*\` tools are not exposed.\n\nTeam state carried over:\n${teamDetails}`
          : "You have no team assigned right now."
        : null,
      claudeMd
        ? `Your standing briefing is ${claudeMd}. Read it first; you own it.`
        : envUnreadable
          ? "I could not read this project's environment, so I cannot tell you where its briefing is. Look for a CLAUDE.md before assuming there is none, and do not create one on top of a file you have not read."
          : "This project has no CLAUDE.md. Do not create one for what you learn: notes go in memory/<topic>.md with a line in MEMORY.md, as your cos-worker skill says.",
      ...carriedStatusLines(worker, block),
    ].filter((line): line is string => line !== null);
    const orientation =
      worker.role === "manager"
        ? "Orientation turn only: read the briefing, confirm in three lines what this manager is for and what is open across your team, and end with the Team: line above the Done / Open / Need block. Do not start or delegate new work until the chief delegates it."
        : "Orientation turn only: read the briefing, confirm in three lines what this worker is for and what is open, and end with the Done / Open / Need block. Do not start new work until the chief delegates it.";
    const transcript = await handoverTranscriptSection(
      worker.name,
      worker.threadId,
      transcriptRead,
      HANDOVER_MAX_TOKENS - estimateTokens([...head, orientation].join("\n\n")),
    );
    const handover = [...head, transcript.text, orientation].join("\n\n");
    const handoverNote = `\nHandover: ${handoverSizeLine(transcript)}.`;

    // Spawn the replacement in the worker's (possibly moved) project. Reuse the
    // old environment only when bb would accept it: reuse across projects is
    // rejected, and a personal-project thread may only reuse a personal
    // workspace (an environment whose directory was moved becomes unmanaged).
    // When reuse is illegal but the old path is known, spawn at that same
    // directory as a fresh unmanaged environment; otherwise take the project
    // default.
    const personalProject = worker.projectId === PERSONAL_PROJECT_ID;
    // The real project, path and host included: `environmentFor` needs a path
    // that is null rather than undefined, or a non-personal worker with no old
    // environment path would reach `pathUnder(undefined, root)` and throw.
    const known = (await listProjects()).find((p) => p.id === worker.projectId);
    const project: ProjectRef = known ?? { id: worker.projectId, name: projectName, kind: personalProject ? "personal" : "standard", path: null, hostId: null };
    const reusable =
      oldEnv !== null &&
      oldEnv.projectId === worker.projectId &&
      (personalProject ? oldEnv.workspaceProvisionType === "personal" : oldEnv.workspaceProvisionType !== "personal");
    const environment = reusable
      ? ({ type: "reuse", environmentId: oldEnv.id } as const)
      : !personalProject && oldEnv?.path && oldEnv.hostId
        ? ({ type: "host", hostId: oldEnv.hostId, workspace: { type: "unmanaged", path: oldEnv.path } } as const)
        : await environmentFor(project);
    const title = oldThread.title ?? titleFor(worker.name);
    const key = spawnKey(worker.projectId, title);
    pendingSpawns.set(key, { kind: worker.role === "manager" ? "manager" : "worker", name: worker.name, projectName });
    let newThreadId: string;
    let newSection: string | null = null;
    try {
      const spawned = await bb.sdk.threads.spawn({
        projectId: worker.projectId,
        environment,
        prompt: defuseFileMentions(handover),
        title,
        visibility: current.workerVisibility === "hidden" ? "hidden" : "visible",
        permissionMode: permissionModeFor(targetProvider, current.workerPermissionMode),
        reasoningLevel: targetLevel,
        // The worker's own manager, else the chief, so remodelling a managed
        // worker keeps it on its team rather than flattening it under the chief.
        ...(() => {
          const mgr = worker.managerId === null ? null : (store.byId(worker.managerId)?.threadId ?? null);
          const parent = sidebarParentThread(mgr, chiefThreadId);
          return parent === null ? {} : { parentThreadId: parent };
        })(),
        ...NOTIFY_PARENT_OFF,
        providerId: targetProvider,
        ...(targetModel ? { model: targetModel } : {}),
        ...(oldSection ? { sectionId: oldSection } : {}),
      });
      newThreadId = spawned.id;
      newSection = spawned.sectionId ?? null;
    } catch (error) {
      pendingSpawns.delete(key);
      const raw = String(error);
      const pool = exhaustedPoolNote(raw);
      return `${label}: spawn on ${executionLabel(targetProvider, targetModel, targetLevel)} failed: ${raw}. Worker unchanged.${pool ? `\n${pool}` : ""}`;
    }
    // The same pin `delegate` does, and for the same reason: the spawn above
    // applies the level to its own turn and writes no override, so without this
    // a remodelled worker would go back to inheriting whatever its last turn ran at.
    const pinNote = (await pinExecution(newThreadId, targetLevel, targetModel)) + handoverNote;
    // Repoint at once so the report router and the roster see the new thread,
    // then brand: same slug, so the same title and the stored avatar key are kept.
    const oldThreadId = worker.threadId;
    store.repointThread(worker.id, newThreadId);
    if (isCommsChief) {
      await execFile("bb", ["comms", "set-chief", newThreadId], { timeout: 10_000 }).catch((error: unknown) =>
        bb.log.warn(`remodel comms set-chief ${label}: ${String(error)}`),
      );
    }
    // Anything parked FOR this worker follows it. A remodelled MANAGER archives
    // the thread its team's reports were queued against, and without this they
    // would sit there for OUTBOX_MAX_ATTEMPTS sweeps and then be escalated as
    // undeliverable although the manager is alive under a new thread id.
    const movedParked = store.retargetOutbox(oldThreadId, newThreadId);
    // And anything clicked on the board that has not been sent yet. An
    // unacked draft is text waiting to go into a composer; left parked against
    // the thread this remodel just archived, it would have nothing to move it
    // and nothing to expire it.
    store.retargetDrafts(oldThreadId, newThreadId);
    if (movedParked > 0) {
      record("remodel", {
        workerName: worker.name,
        threadId: newThreadId,
        excerpt: `${movedParked} parked report${movedParked === 1 ? "" : "s"} followed ${worker.name} to its new thread.`,
      });
    }
    // Only the provider. The model and the level live on the thread, pinned by
    // `pinExecution` above, and the roster keeps no copy of either, because
    // this plugin is not their only writer.
    store.setProvider(worker.id, targetProvider);
    // Attributed to nobody: the orientation turn's report is suppressed and the
    // remodel caller (who may not be the chief) is told the outcome directly.
    store.markDispatched(worker.id, null);
    pendingSpawns.delete(key);
    // The permission mode the picker chose lives under the thread id, so a
    // remodel would silently drop it and start the new thread on the default.
    await carryPermission(worker.threadId, newThreadId, targetProvider, current.workerPermissionMode).catch((error) =>
      bb.log.warn(`remodel permission carry ${label}: ${String(error)}`),
    );
    // Same for the sidebar section: a remodel that drops it knocks the worker
    // out of its section and leaves the archived predecessor sitting in it, so
    // a sidebar layout has to be redone by hand after every remodel.
    for (const move of sectionMoves(worker.threadId, oldSection, newThreadId, newSection)) {
      try {
        await bb.sdk.threads.update(move);
      } catch (error) {
        bb.log.warn(`remodel section carry ${label}: ${String(error)}`);
      }
    }
    const fresh = store.byId(worker.id) ?? worker;
    await brand(fresh, projectName, { title, force: true }).catch((error) => bb.log.warn(`remodel brand ${label}: ${String(error)}`));
    record("remodel", {
      workerName: worker.name,
      projectName,
      threadId: newThreadId,
      excerpt: `Remodelled ${label}: ${worker.threadId} (${executionLabel(plan.fromProvider, plan.fromModel, plan.fromLevel) || "unknown"}) -> ${newThreadId} (${executionLabel(targetProvider, targetModel, targetLevel)}).`,
    });

    // Wait for the orientation turn; the caller delivers the outcome, so
    // suppress the report. Null waiter: this is the plugin on its own behalf,
    // and a remodel's orientation turn has no audience waiting for it.
    const releaseOrientation = addWaiter(newThreadId, PLUGIN_WAIT);
    const settle = (outcome: OrientationOutcome): Promise<string> =>
      settleRemodel(label, worker.threadId, newThreadId, executionLabel(targetProvider, targetModel, targetLevel), outcome, pinNote);
    let handedOff = false;
    try {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const budget = waitBudget(ORIENTATION_WAIT_SECONDS, deadlineAt, Date.now());
      const outcome = await orientationOutcome(newThreadId, budget.seconds, signal);
      if (outcome.state !== "running" || !budget.capped) return await settle(outcome);
      // bb ends a tool call at 300s, and when it does the wait above is
      // aborted with it. Without a hand-off a remodel whose orientation
      // outlived the call would stop half done: the worker moved, the old
      // thread live, and the caller told only "terminated". So the rest
      // runs on its own and the caller is told when it lands.
      handedOff = true;
      // Written down before the detached task starts: a plugin reload kills the
      // task, and without this the worker would be left moved, its old thread
      // live and the promised [Remodel] message never sent.
      // The sweep finishes any record still here (finishPendingRemodels).
      const pending: PendingRemodel = {
        workerId: worker.id,
        workerName: worker.name,
        label,
        projectName,
        oldThreadId: worker.threadId,
        newThreadId,
        target: executionLabel(targetProvider, targetModel, targetLevel),
        pinNote,
        callerThreadId,
        at: Date.now(),
      };
      await bb.storage.kv.set(`${KV_PENDING_REMODEL_PREFIX}${newThreadId}`, pending).catch((error: unknown) => {
        bb.log.warn(`remodel ${label}: could not record the hand-off: ${String(error)}`);
      });
      void (async () => {
        try {
          const later = await orientationOutcome(newThreadId, Math.max(60, ORIENTATION_WAIT_SECONDS - budget.seconds));
          await finishRemodel(pending, later);
        } catch (error) {
          bb.log.warn(`remodel ${label}: finishing after the tool call failed: ${String(error)}`);
        } finally {
          releaseOrientation();
          store.markChiefSeen(worker.id);
        }
      })();
      return `${label}: moved to ${newThreadId} on ${executionLabel(targetProvider, targetModel, targetLevel)}. Its orientation turn is still running after ${budget.seconds}s, longer than one tool call can wait. The old thread ${worker.threadId} is archived when that turn finishes well, and you get a [Remodel] message with the outcome either way.${pinNote}`;
    } finally {
      if (!handedOff) {
        releaseOrientation();
        // Unconditional on purpose: this is the plugin's own orientation turn on
        // a thread it just created, not a report any audience is waiting for.
        store.markChiefSeen(worker.id);
      }
    }
  }

  /** How a remodel's orientation turn ended, or that it has not ended yet. */
  type OrientationOutcome = { state: "ok" | "failed" | "running"; text: string };

  /** How long a remodel waits for the replacement's first turn. */
  const ORIENTATION_WAIT_SECONDS = 600;

  /** Wait up to `waitSeconds` for the replacement's first turn and read how it ended. */
  async function orientationOutcome(newThreadId: string, waitSeconds: number, signal?: AbortSignal): Promise<OrientationOutcome> {
    try {
      await bb.sdk.threads.wait({ threadId: newThreadId, status: "idle", timeoutMs: Math.max(5, waitSeconds) * 1000, ...(signal ? { signal } : {}) });
    } catch (error) {
      // A wait that ended while the thread still works is "not yet", not a
      // failure; a thread that errored falls through to have its text read.
      const now = await threadOrNull(newThreadId);
      if (now === null || (now.status !== "idle" && now.status !== "error")) {
        return { state: "running", text: `orientation turn did not finish: ${String(error)}` };
      }
    }
    const after = await threadOrNull(newThreadId);
    let output: { output?: string | null };
    try {
      output = await bb.sdk.threads.output({ threadId: newThreadId });
    } catch (error) {
      // Could not look is not "said nothing"; either way the old thread stays.
      return { state: "failed", text: `orientation turn could not be read: ${String(error)}` };
    }
    const rawOutput = (output.output ?? "").trim();
    const ok = after?.status === "idle" && rawOutput !== "" && !isRawProviderError(rawOutput);
    // Print the failed orientation's own text, and name the cause when an
    // exhausted credential pool is what refused, so a 429 does not reach the
    // caller as "unknown error" with the real text left in the thread.
    // The replacement worker's own first turn, so it is worker text reaching
    // the chief and it gets the same treatment as cos_read: scrubbed, then
    // fenced with a per-message nonce so the chief can see where it ends.
    const clean = scrubUntrusted((output.output ?? "").trim());
    const text = clean.text;
    const pool = exhaustedPoolNote(text);
    const fenced =
      text === ""
        ? ""
        : fenceUntrusted(truncate(text, 1500), {
            nonce: fenceNonce(),
            label: "orientation turn",
            note: scrubNote(clean),
          });
    return ok
      ? { state: "ok", text: `orientation turn completed:\n${fenced}` }
      : {
          state: "failed",
          text: `orientation turn ended with status ${after?.runtime.displayStatus ?? "unknown"}${
            text === "" ? " and no output" : `:\n${fenced}`
          }${pool ? `\n${pool}` : ""}`,
        };
  }

  /** Archive the old thread after a good orientation, or keep both and say why. */
  /** A remodel whose orientation outlived the tool call, kept until it is settled. */
  interface PendingRemodel {
    workerId: string;
    workerName: string;
    label: string;
    projectName: string;
    oldThreadId: string;
    newThreadId: string;
    target: string;
    pinNote: string;
    callerThreadId: string | null;
    at: number;
  }
  const KV_PENDING_REMODEL_PREFIX = "remodel.pending.";

  /**
   * Settle a handed-off remodel and tell its caller. The kv record is deleted
   * before the slow part, so a second finisher that arrives later (a dying
   * instance's task and the new instance's sweep) finds nothing and stops. Two
   * that read it in the same instant can both settle: the archive is
   * idempotent and the cost is one duplicate [Remodel] line, never a lost one.
   */
  async function finishRemodel(pending: PendingRemodel, outcome: OrientationOutcome): Promise<void> {
    const key = `${KV_PENDING_REMODEL_PREFIX}${pending.newThreadId}`;
    if ((await bb.storage.kv.get<PendingRemodel>(key)) === undefined) return;
    await bb.storage.kv.delete(key);
    const text = await settleRemodel(pending.label, pending.oldThreadId, pending.newThreadId, pending.target, outcome, pending.pinNote);
    record("remodel", { workerName: pending.workerName, projectName: pending.projectName, threadId: pending.newThreadId, excerpt: text });
    const to = pending.callerThreadId ?? chiefThreadId;
    if (to) await sendUpWithRetry(to, `[Remodel] ${text}`, pending.newThreadId);
  }

  /**
   * Finish remodels whose detached task died with a reloaded instance. Each one
   * is only settled once its orientation turn is no longer running; a record
   * older than the orientation window is settled with whatever it shows then.
   */
  async function finishPendingRemodels(): Promise<void> {
    for (const key of await bb.storage.kv.list(KV_PENDING_REMODEL_PREFIX)) {
      const pending = await bb.storage.kv.get<PendingRemodel>(key);
      if (pending === undefined) continue;
      // This instance's own detached task is still on it.
      if (waitedForBy(pending.newThreadId, PLUGIN_WAIT)) continue;
      const outcome = await orientationOutcome(pending.newThreadId, 5);
      if (outcome.state === "running" && Date.now() - pending.at < ORIENTATION_WAIT_SECONDS * 1000) continue;
      await finishRemodel(pending, outcome);
      store.markChiefSeen(pending.workerId);
    }
  }

  async function settleRemodel(
    label: string,
    oldThreadId: string,
    newThreadId: string,
    target: string,
    outcome: OrientationOutcome,
    pinNote: string,
  ): Promise<string> {
    if (outcome.state !== "ok") {
      return `${label}: moved to ${newThreadId} on ${target}, but ${outcome.text}. Old thread ${oldThreadId} kept (not archived); check the new thread, then archive by hand or run remodel again after fixing.${pinNote}`;
    }
    try {
      await bb.sdk.threads.stop({ threadId: oldThreadId });
    } catch {
      // Already stopped is fine.
    }
    const movedWorker = store.byThread(newThreadId);
    if (movedWorker?.role === "manager") {
      const teamMembers = store.team(movedWorker.id);
      try {
        const teamSqlIds = teamMembers.map((m) => `'${m.threadId.replace(/'/g, "''")}'`);
        const whereClause =
          teamSqlIds.length > 0
            ? `(parent_thread_id = '${oldThreadId.replace(/'/g, "''")}' OR id IN (${teamSqlIds.join(",")}))`
            : `parent_thread_id = '${oldThreadId.replace(/'/g, "''")}'`;
        await execFile("sqlite3", [
          "-cmd",
          ".timeout 5000",
          path.join(BB_DATA_DIR, "bb.db"),
          `UPDATE threads SET parent_thread_id = '${newThreadId.replace(/'/g, "''")}' WHERE ${whereClause} AND id != '${newThreadId.replace(/'/g, "''")}' AND archived_at IS NULL AND deleted_at IS NULL;`,
        ]);
      } catch (error) {
        bb.log.warn(`remodel ${label}: could not reparent team threads in bb.db: ${String(error)}`);
      }
      for (const member of teamMembers) {
        try {
          await linkWorkerThread(member.threadId, newThreadId);
        } catch (error) {
          bb.log.warn(`remodel ${label}: could not sdk-reparent ${member.name}: ${String(error)}`);
        }
      }
    }
    let archived = true;
    try {
      await bb.sdk.threads.archive({ threadId: oldThreadId });
    } catch (error) {
      archived = false;
      bb.log.warn(`remodel ${label}: archive of ${oldThreadId} failed: ${String(error)}`);
    }
    changed();
    return `${label}: now thread ${newThreadId} on ${target}; ${outcome.text}\nOld thread ${oldThreadId} ${archived ? "archived" : "could not be archived, left as is"} (kept in previous_thread_id).${pinNote}`;
  }

  /** Set while a replacement chief thread is running its orientation turn. */
  let remodellingChiefThreadId: string | null = null;

  /**
   * Remodel the Chief of Staff thread onto a new provider/model/reasoning level
   * with a full handover note (live roster, active board items, and the last 10
   * finished [Prompt] -> [Response] turns). Repoints chiefThreadId, KV_CHIEF,
   * outbox, drafts, and bb.db child threads only after the replacement thread
   * completes its orientation turn.
   */
  async function remodelChief(input: {
    providerId?: string;
    model?: string;
    reasoningLevel?: string;
    dryRun?: boolean;
    signal?: AbortSignal;
  }): Promise<{ ok: boolean; text: string }> {
    const oldChiefId = chiefThreadId;
    if (!oldChiefId) {
      return { ok: false, text: "There is no chief thread to remodel. Run `bb cos start` first." };
    }
    const oldRead = await readThread(oldChiefId);
    if (oldRead.kind === "unreachable") {
      return { ok: false, text: `chief (${oldChiefId}): ${unreachableThreadNote(oldChiefId, oldRead.error)} Chief unchanged.` };
    }
    if (oldRead.kind === "gone") {
      return { ok: false, text: `chief (${oldChiefId}): its thread is missing or deleted. Chief unchanged.` };
    }
    const oldThread = oldRead.thread;

    const wantedLevel = parseReasoningLevel(input.reasoningLevel);
    if (!wantedLevel.ok) return { ok: false, text: wantedLevel.error };
    const current = await settings.get();
    const targetProvider = input.providerId?.trim() || current.chiefProviderId || DEFAULT_CHIEF_PROVIDER;
    if (!targetProvider) {
      return { ok: false, text: "No target provider: pass --provider or set the chiefProviderId setting. Chief unchanged." };
    }
    const targetModel = input.model?.trim() || current.chiefModel || DEFAULT_CHIEF_MODEL || null;
    const targetLevel: WorkerReasoningLevel = wantedLevel.level ?? "high";
    const fromExec = await workerExecution(oldChiefId);
    const fromLabel = executionLabel(oldThread.providerId, fromExec.model, fromExec.reasoningLevel) || "unknown";
    const targetLabel = executionLabel(targetProvider, targetModel, targetLevel);

    if (input.dryRun) {
      return { ok: true, text: `Dry run: chief (${oldChiefId}): ${fromLabel} -> ${targetLabel}` };
    }

    const oldSection = oldThread.sectionId ?? null;
    const oldEnv = oldThread.environmentId ? await environmentOrNull(oldThread.environmentId) : null;
    const projectId = oldThread.projectId;
    const personalProject = projectId === PERSONAL_PROJECT_ID;
    const reusable =
      oldEnv !== null &&
      oldEnv.projectId === projectId &&
      (personalProject ? oldEnv.workspaceProvisionType === "personal" : oldEnv.workspaceProvisionType !== "personal");
    const environment = reusable
      ? ({ type: "reuse", environmentId: oldEnv.id } as const)
      : ({ type: "project-default" } as const);

    const lastRead = await lastFinishedMessages(oldChiefId, 10);
    const lastMessages = lastRead.ok ? lastRead.messages : [];
    const lastReadOk = lastRead.ok;

    let liveRoster = "";
    try {
      liveRoster = await rosterText({ includeOthers: true });
    } catch (error) {
      liveRoster = `(could not read live roster: ${String(error)})`;
    }
    const liveBoard = boardText(boardList());

    const handover = [
      `You are the Chief of Staff thread, continuing on a new thread after a provider/model change (now ${targetLabel}). Your previous thread was ${oldChiefId}; its history is not in your context, so this handover carries your live state and recent turns.`,
      `Your standing instructions are ${path.join(HOME_DIR, "CLAUDE.md")}, ${path.join(HOME_DIR, ".bb", "AGENTS.md")}, and the chief-of-staff skill (${path.join(PLUGIN_DIR, "skills", "chief-of-staff", "SKILL.md")}).`,
      "On `acp-omp` or `acp-antigravity` (where `provider-acp` does not expose native `cos_*` tools), run every Chief of Staff operation via the `bb cos` CLI in bash (`bb cos brief`, `bb cos roster`, `bb cos delegate`, `bb cos read`, `bb cos wait`, `bb cos board`, `bb cos dismiss`, `bb cos retire`, `bb cos remodel`, `bb cos remodel-chief`, `bb cos spawn-manager`, `bb cos assign`, `bb cos projects`, `bb cos steer`, `bb cos stop`, `bb cos retry`, `bb cos decisions`, `bb cos answer`, `bb cos usage`). `BB_THREAD_ID` and `BB_PROJECT_ID` are set automatically in your shell environment.",
      `Provider & remodel operations: \`bb cos remodel\` and \`bb cos remodel-chief\` switch any worker, manager+team, or the chief thread between \`acp-omp\` (configured models: ${OMP_MODELS.map((m) => `\`${m}\``).join(", ")}), \`claude-code\`, and \`acp-antigravity\`.`,
      `Live roster and fleet status (managers, teams, urgent/attention workers, open and need items):\n\n${liveRoster}`,
      `The user's decision board ("For you" list):\n\n${liveBoard}`,
      lastMessages.length > 0
        ? `Your last ${lastMessages.length} finished turn${lastMessages.length === 1 ? "" : "s"} on the old chief thread (${oldChiefId}), oldest first:\n\n${lastMessages.map((m, i) => `--- turn ${i + 1} ---\n${truncate(m, 8000)}`).join("\n\n")}`
        : lastReadOk
          ? "The old chief thread has no finished turns."
          : `I could not read the old chief thread's turns, so none are carried over. You can inspect ${oldChiefId} with \`bb thread output ${oldChiefId}\` if needed.`,
      `Orientation turn only: read ${path.join(HOME_DIR, "CLAUDE.md")} and ${path.join(HOME_DIR, ".bb", "AGENTS.md")}, run \`bb cos brief\` via bash to confirm CLI access, and write a concise orientation summary of what is active across your managers and workers and what open decisions sit on the user's board. Do not delegate new work or mutate the board on this orientation turn.`,
    ].join("\n\n");

    const title = oldThread.title ?? CHIEF_TITLE;
    pendingSpawns.set(CHIEF_TITLE, { kind: "chief" });
    let newThreadId: string;
    let newSection: string | null = null;
    try {
      const spawned = await bb.sdk.threads.spawn({
        projectId,
        environment,
        prompt: defuseFileMentions(handover),
        title,
        providerId: targetProvider,
        ...(targetModel ? { model: targetModel } : {}),
        reasoningLevel: targetLevel,
        permissionMode: permissionModeFor(targetProvider, current.workerPermissionMode),
        ...(oldSection ? { sectionId: oldSection } : {}),
      });
      newThreadId = spawned.id;
      newSection = spawned.sectionId ?? null;
    } catch (error) {
      pendingSpawns.delete(CHIEF_TITLE);
      const raw = String(error);
      const pool = exhaustedPoolNote(raw);
      return {
        ok: false,
        text: `chief (${oldChiefId}): spawn on ${targetLabel} failed: ${raw}. Chief unchanged.${pool ? `\n${pool}` : ""}`,
      };
    }

    remodellingChiefThreadId = newThreadId;
    const pinNote = await pinExecution(newThreadId, targetLevel, targetModel);
    await carryPermission(oldChiefId, newThreadId, targetProvider, current.workerPermissionMode).catch((error) =>
      bb.log.warn(`remodel-chief permission carry: ${String(error)}`),
    );
    const releaseOrientation = addWaiter(newThreadId, PLUGIN_WAIT);
    let outcome: OrientationOutcome;
    try {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      outcome = await orientationOutcome(newThreadId, ORIENTATION_WAIT_SECONDS, input.signal);
    } finally {
      releaseOrientation();
      pendingSpawns.delete(CHIEF_TITLE);
      remodellingChiefThreadId = null;
    }

    if (outcome.state !== "ok") {
      return {
        ok: false,
        text: `chief: spawned replacement ${newThreadId} on ${targetLabel}, but ${outcome.text}. Old chief ${oldChiefId} kept active and unchanged; check ${newThreadId}, then run \`bb cos set-chief ${newThreadId}\`, archive it by hand, or run remodel-chief again.${pinNote}`,
      };
    }

    await setChief(newThreadId);
    const movedParked = store.retargetOutbox(oldChiefId, newThreadId);
    store.retargetDrafts(oldChiefId, newThreadId);

    for (const move of sectionMoves(oldChiefId, oldSection, newThreadId, newSection)) {
      try {
        await bb.sdk.threads.update(move);
      } catch (error) {
        bb.log.warn(`remodel-chief section carry: ${String(error)}`);
      }
    }

    const topLevelWorkers = store.list().filter((w) => w.managerId === null && w.threadId !== newThreadId);
    try {
      const topLevelIds = topLevelWorkers.map((w) => `'${w.threadId.replace(/'/g, "''")}'`);
      const whereClause =
        topLevelIds.length > 0
          ? `(parent_thread_id = '${oldChiefId.replace(/'/g, "''")}' OR id IN (${topLevelIds.join(",")}))`
          : `parent_thread_id = '${oldChiefId.replace(/'/g, "''")}'`;
      await execFile("sqlite3", [
        "-cmd",
        ".timeout 5000",
        path.join(BB_DATA_DIR, "bb.db"),
        `UPDATE threads SET parent_thread_id = '${newThreadId.replace(/'/g, "''")}' WHERE ${whereClause} AND id != '${newThreadId.replace(/'/g, "''")}' AND archived_at IS NULL AND deleted_at IS NULL;`,
      ]);
    } catch (error) {
      bb.log.warn(`remodel-chief: could not reparent child threads in bb.db: ${String(error)}`);
    }
    for (const w of topLevelWorkers) {
      try {
        await linkWorkerThread(w.threadId, newThreadId);
      } catch (error) {
        bb.log.warn(`remodel-chief: could not sdk-reparent ${w.name}: ${String(error)}`);
      }
    }

    try {
      await bb.sdk.threads.stop({ threadId: oldChiefId });
    } catch {
      // Already stopped is fine.
    }
    let archived = true;
    try {
      await bb.sdk.threads.archive({ threadId: oldChiefId });
    } catch (error) {
      archived = false;
      bb.log.warn(`remodel-chief: archive of ${oldChiefId} failed: ${String(error)}`);
    }

    record("remodel", {
      threadId: newThreadId,
      excerpt: `Remodelled chief: ${oldChiefId} (${fromLabel}) -> ${newThreadId} (${targetLabel})${movedParked > 0 ? `; ${movedParked} parked message${movedParked === 1 ? "" : "s"} followed` : ""}.`,
    });
    changed();
    return {
      ok: true,
      text: `chief: now thread ${newThreadId} on ${targetLabel}; ${outcome.text}\nOld chief thread ${oldChiefId} ${archived ? "archived" : "could not be archived, left as is"}.${pinNote}`,
    };
  }

  /**
   * Complete a chief thread cutover to an existing replacement thread: repoints
   * chiefThreadId, KV_CHIEF, outbox, drafts, and bb.db child threads,
   * then stops and archives the previous chief thread.
   */
  async function cutoverChief(targetThreadId: string): Promise<{ ok: boolean; text: string }> {
    const newThreadId = targetThreadId.trim();
    if (!newThreadId) {
      return { ok: false, text: "Usage: bb cos set-chief <threadId>" };
    }
    const existingWorker = store.byThread(newThreadId);
    if (existingWorker !== null && existingWorker.retiredAt === null) {
      return {
        ok: false,
        text: `chief (${newThreadId}): thread belongs to worker "${existingWorker.name}". Chief unchanged.`,
      };
    }
    const newState = await threadState(newThreadId);
    if (newState.kind === "unreachable") {
      return { ok: false, text: `chief (${newThreadId}): ${unreachableThreadNote(newThreadId, newState.error)} Chief unchanged.` };
    }
    if (newState.kind === "gone") {
      return { ok: false, text: `chief (${newThreadId}): thread is missing, deleted, or archived. Chief unchanged.` };
    }
    const newThread = newState.thread;
    const oldChiefId = chiefThreadId;
    if (oldChiefId === newThreadId) {
      return { ok: true, text: `chief: already ${newThreadId}.` };
    }
    const oldRead = oldChiefId ? await readThread(oldChiefId) : null;
    const oldThread = oldRead?.kind === "ok" ? oldRead.thread : null;
    const oldSection = oldThread?.sectionId ?? null;
    const newSection = newThread.sectionId ?? null;
    const newExec = await workerExecution(newThreadId);
    const targetLabel = executionLabel(newThread.providerId, newExec.model, newExec.reasoningLevel) || newThread.providerId || "unknown";
    const fromExec = oldChiefId ? await workerExecution(oldChiefId) : { model: null, reasoningLevel: null };
    const fromLabel =
      oldThread ? executionLabel(oldThread.providerId, fromExec.model, fromExec.reasoningLevel) || oldThread.providerId || "unknown" : "none";

    const currentSettings = await settings.get();
    if (oldChiefId) {
      await carryPermission(oldChiefId, newThreadId, newThread.providerId, currentSettings.workerPermissionMode).catch((error) =>
        bb.log.warn(`set-chief permission carry: ${String(error)}`),
      );
    } else {
      await bb.storage.kv
        .set(`${KV_PERMISSION_PREFIX}${newThreadId}`, permissionModeFor(newThread.providerId, currentSettings.workerPermissionMode))
        .catch(() => {});
    }
    await setChief(newThreadId);
    let movedParked = 0;
    if (oldChiefId) {
      movedParked = store.retargetOutbox(oldChiefId, newThreadId);
      store.retargetDrafts(oldChiefId, newThreadId);

      for (const move of sectionMoves(oldChiefId, oldSection, newThreadId, newSection)) {
        try {
          await bb.sdk.threads.update(move);
        } catch (error) {
          bb.log.warn(`set-chief section carry: ${String(error)}`);
        }
      }

      const topLevelWorkers = store.list().filter((w) => w.managerId === null && w.threadId !== newThreadId);
      try {
        const topLevelIds = topLevelWorkers.map((w) => `'${w.threadId.replace(/'/g, "''")}'`);
        const whereClause =
          topLevelIds.length > 0
            ? `(parent_thread_id = '${oldChiefId.replace(/'/g, "''")}' OR id IN (${topLevelIds.join(",")}))`
            : `parent_thread_id = '${oldChiefId.replace(/'/g, "''")}'`;
        await execFile("sqlite3", [
          "-cmd",
          ".timeout 5000",
          path.join(BB_DATA_DIR, "bb.db"),
          `UPDATE threads SET parent_thread_id = '${newThreadId.replace(/'/g, "''")}' WHERE ${whereClause} AND id != '${newThreadId.replace(/'/g, "''")}' AND archived_at IS NULL AND deleted_at IS NULL;`,
        ]);
      } catch (error) {
        bb.log.warn(`set-chief: could not reparent child threads in bb.db: ${String(error)}`);
      }
      for (const w of topLevelWorkers) {
        try {
          await linkWorkerThread(w.threadId, newThreadId);
        } catch (error) {
          bb.log.warn(`set-chief: could not sdk-reparent ${w.name}: ${String(error)}`);
        }
      }

      try {
        await bb.sdk.threads.stop({ threadId: oldChiefId });
      } catch {
        // Already stopped is fine.
      }
    }

    let archived = true;
    if (oldChiefId) {
      try {
        await bb.sdk.threads.archive({ threadId: oldChiefId });
      } catch (error) {
        archived = false;
        bb.log.warn(`set-chief: archive of ${oldChiefId} failed: ${String(error)}`);
      }
    }

    record("remodel", {
      threadId: newThreadId,
      excerpt: oldChiefId
        ? `Remodelled chief: ${oldChiefId} (${fromLabel}) -> ${newThreadId} (${targetLabel})${movedParked > 0 ? `; ${movedParked} parked message${movedParked === 1 ? "" : "s"} followed` : ""}.`
        : `Set chief thread to ${newThreadId} (${targetLabel}).`,
    });
    changed();
    return {
      ok: true,
      text: oldChiefId
        ? `chief: now thread ${newThreadId} on ${targetLabel}.\nOld chief thread ${oldChiefId} ${archived ? "archived" : "could not be archived, left as is"}.`
        : `chief: now thread ${newThreadId} on ${targetLabel}.`,
    };
  }

  /**
   * Where bb's file panel should open a local file a chat linked to. Same order
   * as bb's own thread view: the thread's storage, then its workspace, then the
   * bare file on bb's machine. A read that fails only drops that candidate.
   */
  async function fileTarget(
    threadId: string | null,
    absolutePath: string,
  ): Promise<
    | { kind: "thread-storage"; threadId: string; path: string }
    | { kind: "workspace"; environmentId: string; path: string }
    | { kind: "host"; hostId: string; path: string }
    | null
  > {
    const clean = path.posix.normalize(absolutePath);
    if (!path.posix.isAbsolute(clean) || clean !== absolutePath) return null;
    const under = (root: string | null | undefined): string | null => relativeUnder(root, clean);
    if (threadId !== null) {
      try {
        const storage = await bb.sdk.threads.storageLocation({ threadId });
        const rel = under(storage.storageRootPath);
        if (rel !== null) return { kind: "thread-storage", threadId, path: rel };
      } catch {
        // No storage for this thread; try its workspace.
      }
      const thread = await threadOrNull(threadId);
      const env = thread?.environmentId ? await environmentOrNull(thread.environmentId) : null;
      const rel = under(env?.path);
      if (env !== null && rel !== null) return { kind: "workspace", environmentId: env.id, path: rel };
    }
    try {
      const hostId = (await bb.sdk.system.config()).primaryHostId;
      return hostId === null ? null : { kind: "host", hostId, path: clean };
    } catch {
      return null;
    }
  }

  async function environmentOrNull(environmentId: string): Promise<{
    id: string;
    projectId: string | null;
    hostId: string | null;
    path: string | null;
    workspaceProvisionType: "managed-worktree" | "personal" | "unmanaged";
  } | null> {
    try {
      return (await bb.sdk.environments.get({ environmentId })) as {
        id: string;
        projectId: string | null;
        hostId: string | null;
        path: string | null;
        workspaceProvisionType: "managed-worktree" | "personal" | "unmanaged";
      };
    } catch {
      return null;
    }
  }

  // ---------- move: reassign a worker row to another project ----------

  /**
   * Point a worker row at another project. Only the roster row moves: bb
   * threads cannot change project, so the worker's thread stays where it is
   * until the next remodel spawns its replacement in the new project.
   */
  async function moveWorker(scope: Scope, ref: string, projectRef: string, projectHint?: string): Promise<{ ok: boolean; text: string }> {
    const projects = await listProjects();
    const resolved = resolveInScope(store, projects, ref, scope, projectHint);
    if (!resolved.ok) return { ok: false, text: resolved.error };
    const worker = resolved.worker;
    const target = findProject(projects, projectRef);
    if (!target) return { ok: false, text: `No project matches "${projectRef}". Run bb cos projects.` };
    const fromName = projects.find((p) => p.id === worker.projectId)?.name ?? worker.projectId;
    if (target.id === worker.projectId) return { ok: true, text: `${fromName}:${worker.name} is already in ${target.name}.` };
    store.setProject(worker.id, target.id);
    record("move", {
      workerName: worker.name,
      projectName: target.name,
      threadId: worker.threadId,
      excerpt: `Moved ${fromName}:${worker.name} to project ${target.name}. Thread ${worker.threadId} follows on the next remodel.`,
    });
    changed();
    return {
      ok: true,
      text: `${fromName}:${worker.name} is now ${target.name}:${worker.name}. Thread ${worker.threadId} stays in project ${fromName} until the next remodel spawns its replacement in ${target.name}.`,
    };
  }

  // ---------- messages to the chief ----------

  /**
   * Send one message to the chief thread. The chief may be "starting" another turn
   * (e.g. two workers finished at once); bb refuses a competing submit in that window,
   * so retry with a short backoff instead of dropping the message.
   */
  /**
   * Who reads this worker's reports: its manager's thread, or the chief's.
   *
   * A manager whose row is gone or retired falls back to the chief rather than
   * dropping the report, because losing one is worse than sending it a level
   * too high. `null` means there is nowhere at all to send, which the caller
   * reports instead of swallowing.
   */
  /**
   * workerId -> the Chief: line last forwarded for that worker, and when. In
   * memory: after a reload the next line is forwarded, the safe direction.
   */
  const lastChiefLine = new Map<string, { text: string; at: number }>();

  function noteChiefLineSent(worker: Worker, line: string): void {
    lastChiefLine.set(worker.id, { text: line, at: Date.now() });
  }

  /** Is this the line the chief already has from this worker (`chiefLineIsRepeat`)? */
  function chiefLineRepeats(worker: Worker, line: string): boolean {
    const last = lastChiefLine.get(worker.id) ?? null;
    const fresh = store.byId(worker.id) ?? worker;
    // The chief messaging the worker since resets it: it may have asked again.
    const chiefSpokeSince =
      last !== null && fresh.lastDispatchBy?.kind === "chief" && (fresh.lastDispatchAt ?? 0) > last.at;
    return chiefLineIsRepeat({ line, last, chiefSpokeSince, now: Date.now() });
  }

  /**
   * workerId -> when that worker's Chief: line last escalated past its manager
   * to the chief. In memory: after a reload nothing is known, and an unknown
   * escalation means the manager's line is forwarded, the safe direction.
   */
  const lastEscalationAt = new Map<string, number>();

  /**
   * The team member whose escalation this manager's turn restates, or null.
   * Only a turn that member's own report started can echo it
   * (`managerChiefLineIsEcho`).
   */
  async function managerEchoOf(
    manager: Worker,
    origin: { ok: true; sender: string | null; typedByOwner: boolean },
  ): Promise<{ member: string } | null> {
    const member =
      origin.sender === null ? null : (store.team(manager.id).find((m) => m.threadId === origin.sender) ?? null);
    const startedBy = member !== null ? "member" : origin.typedByOwner ? "owner" : "other";
    const at = member === null ? null : (lastEscalationAt.get(member.id) ?? null);
    return member !== null && managerChiefLineIsEcho({ startedBy, memberEscalatedAt: at, now: Date.now() })
      ? { member: member.name }
      : null;
  }

  /**
   * Give a project a full execution-defaults row if it has none
   * (`projectDefaultsPlaceholder`). Best effort: a failure is logged and the
   * spawn goes ahead, because a worker in an "Approve for me" project is
   * better than no worker. The placeholder thread is archived at once.
   */
  async function ensureProjectDefaults(project: ProjectRef): Promise<void> {
    let existing: { permissionMode: string } | null;
    try {
      existing = await bb.sdk.projects.defaultExecutionOptions({ projectId: project.id });
    } catch (error) {
      // Could not look: do nothing rather than act on a guess.
      bb.log.warn(`project defaults for ${project.name}: could not read them: ${String(error)}`);
      return;
    }
    const plan = projectDefaultsPlaceholder({ projectId: project.id, existing });
    if (plan === null) return;
    try {
      const placeholder = await bb.sdk.threads.spawn({
        projectId: plan.projectId,
        origin: plan.origin,
        environment: { type: "project-default" },
        permissionMode: plan.permissionMode,
        sendAt: plan.sendAt,
        title: plan.title,
        prompt: "Placeholder that records this project's execution defaults. It is never sent.",
      });
      await bb.sdk.threads.archive({ threadId: placeholder.id }).catch(() => undefined);
      bb.log.info(`project defaults for ${project.name}: none, so recorded full (placeholder ${placeholder.id}, archived)`);
    } catch (error) {
      bb.log.warn(`project defaults for ${project.name}: could not record full: ${String(error)}`);
    }
  }

  /** A managed worker's manager, by the names a Need may address it: slug and title. */
  function managerNames(worker: Worker): string[] {
    const manager = worker.managerId === null ? null : store.byId(worker.managerId);
    if (manager === null) return [];
    return [manager.name, titleFor(manager.name)];
  }

  function audienceFor(worker: Worker): { kind: "manager" | "chief"; threadId: string } | null {
    return reportAudience(
      worker,
      (managerId) => {
        const manager = store.byId(managerId);
        return manager !== null && manager.retiredAt === null ? manager.threadId : null;
      },
      chiefThreadId,
    );
  }

  /**
   * Is this reader the one whose unread marker `chief_last_seen_at` is?
   *
   * The column is ONE column with two possible readers. Marking it clears
   * it for whoever the worker's audience is, so only the audience may mark it:
   * a chief peeking at a managed worker would otherwise clear its MANAGER's
   * marker, and the manager would never learn the worker had finished.
   *
   * The READ path needs this as much as the report path: a manager running
   * cos_read on its own team member must not clear the chief's marker for a
   * turn the chief has not seen.
   */
  function readerIsAudience(worker: Worker, readerThreadId: string | null): boolean {
    if (readerThreadId === null) return false;
    const audience = audienceFor(worker);
    return audience !== null && audience.threadId === readerThreadId;
  }

  /** The same question asked from a scope, for callers that have one rather than a thread id. */
  function scopeIsAudience(worker: Worker, scope: Scope): boolean {
    const audience = audienceFor(worker);
    if (audience === null) return false;
    if (scope.kind === "chief") return audience.kind === "chief";
    if (scope.kind === "manager") {
      const manager = store.byId(scope.managerId);
      return manager !== null && audience.threadId === manager.threadId;
    }
    return false;
  }

  /**
   * Send to a thread, retrying, and park it rather than lose it.
   *
   * `target` is the audience's thread: a manager's for a managed worker, the
   * chief's otherwise. A parked message carries its target so the drain knows
   * where it was going; NULL in that column means the chief.
   */
  const recentPluginDeliveries = new Map<string, { senderThreadId: string; at: number }[]>();
  function notePluginDelivery(targetThreadId: string, senderThreadId: string, now = Date.now()): void {
    const list = (recentPluginDeliveries.get(targetThreadId) ?? []).filter((d) => now - d.at < PEER_LOOP_WINDOW_MS);
    list.push({ senderThreadId, at: now });
    recentPluginDeliveries.set(targetThreadId, list);
  }
  function wasPluginDelivery(targetThreadId: string, senderThreadId: string, requestedAt: number | null, now = Date.now()): boolean {
    const list = (recentPluginDeliveries.get(targetThreadId) ?? []).filter((d) => now - d.at < PEER_LOOP_WINDOW_MS);
    return list.some(
      (d) =>
        d.senderThreadId === senderThreadId &&
        (requestedAt === null || (requestedAt >= d.at - 5_000 && requestedAt <= d.at + 60_000)),
    );
  }
  async function sendUpWithRetry(target: string, body: string, senderThreadId: string): Promise<boolean> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await sendToThread({
          threadId: target,
          mode: "queue-if-active",
          input: [{ type: "text", text: body, mentions: [] }],
          senderThreadId,
          ...(await permissionFor(target)),
        });
        notePluginDelivery(target, senderThreadId);
        return true;
      } catch (error) {
        lastError = error;
        if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
      }
    }
    // The message would otherwise be gone: a report nobody sees is a worker
    // that looks stalled forever. Park it and let the sweep deliver it.
    bb.log.warn(`send to ${target} failed after retries, parked in outbox: ${String(lastError)}`);
    store.enqueueChiefMessage(body, senderThreadId, target === chiefThreadId ? null : target);
    changed();
    return false;
  }

  /** The chief's own queue, kept for the many callers that only ever write to it. */
  async function sendToChiefWithRetry(body: string, senderThreadId: string): Promise<boolean> {
    const chief = chiefThreadId;
    if (!chief) return false;
    return sendUpWithRetry(chief, body, senderThreadId);
  }

  /** Is this thread mid-turn right now? A failed read answers no, so the message is sent rather than held. */
  async function threadBusy(threadId: string): Promise<boolean> {
    const read = await readThread(threadId);
    return read.kind === "ok" && BUSY_STATUSES.has(read.thread.runtime.displayStatus);
  }

  /**
   * Deliver a REQUESTED report to the thread that asked for it. A requester
   * waiting on this worker in cos_wait gets it from the wait. A requester
   * mid-turn gets it after that turn ends: held in the outbox under its own
   * target and sent, merged with any others, by its idle event
   * (`drainHeldFor`), so one busy parent gets one message rather than several
   * queued turns. Returns true when the report is delivered or will be.
   */
  async function deliverRequestedReport(worker: Worker, target: string, body: string, route: "dispatcher" | "peer"): Promise<boolean> {
    const how = requestedReportDelivery({
      requesterWaiting: waitedForBy(worker.threadId, target),
      requesterBusy: await threadBusy(target),
    });
    bb.log.info(
      `requested report ${how === "send" ? "sent" : how === "hold" ? "held until the requester's turn ends" : "left to the requester's cos_wait"}: ${worker.name} (${worker.threadId}) to its ${route} ${target}`,
    );
    if (how === "skip") return true;
    if (how === "send") return sendUpWithRetry(target, body, worker.threadId);
    store.enqueueChiefMessage(body, worker.threadId, target === chiefThreadId ? null : target);
    changed();
    // The requester may have finished between the check and the park; its idle
    // event has then already passed, so drain now rather than wait for the sweep.
    if (!(await threadBusy(target))) await drainChiefOutboxOnce();
    return true;
  }

  /** After a thread's turn ends, deliver whatever was held for it. */
  async function drainHeldFor(threadId: string): Promise<void> {
    try {
      if (store.outboxTargets().some((t) => (t ?? chiefThreadId) === threadId)) await drainChiefOutboxOnce();
    } catch (error) {
      bb.log.warn(`held reports for ${threadId}: ${String(error)}`);
    }
  }

  /**
   * Deliver parked messages, per target, oldest first, all of one target's as
   * ONE message (`mergeParkedReports`), and only to a target that is not
   * mid-turn. A send that fails bumps every message's attempt count, and a
   * message past OUTBOX_MAX_ATTEMPTS is escalated or dropped so it cannot block
   * the ones behind it.
   */
  /**
   * One drain at a time.
   *
   * `drainChiefOutbox` reads the parked messages, then awaits a send per
   * message before dropping each one, so a second run that starts inside that
   * window reads the same rows and sends them again. Three callers can overlap:
   * the 5-minute sweep, the chief's own idle event, and Restart on the failed
   * chief card, which is not debounced and takes seconds. The chief receiving
   * the same worker report twice is exactly the single-source-of-truth
   * invariant this plugin exists to hold, so a caller arriving mid-drain waits
   * for the run in flight rather than starting another.
   */
  let draining: Promise<void> | null = null;
  function drainChiefOutboxOnce(): Promise<void> {
    if (draining === null) {
      draining = drainChiefOutbox().finally(() => {
        draining = null;
      });
    }
    return draining;
  }

  async function drainChiefOutbox(): Promise<void> {
    const chief = chiefThreadId;
    // Every destination with something parked, visited independently. A single
    // LIMIT over the whole table would let one unreachable manager fill the
    // window and starve the chief's own reports: the head-of-line return below
    // is per target for the same reason.
    let sent = false;
    for (const target of store.outboxTargets()) {
      // NULL target means the chief.
      const threadId = target ?? chief;
      if (!threadId) continue;
      const pending = store.pendingChiefMessages(20, target);
      if (pending.length === 0) continue;
      // A thread mid-turn gets its held messages when that turn ends (its idle
      // event drains again), all of them as one message.
      if (await threadBusy(threadId)) continue;
      const first = pending[0]!;
      let delivered = false;
      try {
        await sendToThread({
          threadId,
          mode: "queue-if-active",
          input: [{ type: "text", text: mergeParkedReports(pending.map((m) => m.body)), mentions: [] }],
          ...(first.senderThreadId ? { senderThreadId: first.senderThreadId } : {}),
          ...(await permissionFor(threadId)),
        });
        delivered = true;
      } catch (error) {
        for (const message of pending) {
          if (message.attempts >= OUTBOX_MAX_ATTEMPTS) {
            // ESCALATE RATHER THAN DELETE. Nothing is dropped, and for the
            // chief that is covered by the
            // Restart button; a manager has no equivalent. So a message that
            // has exhausted its attempts against a manager is re-parked for the
            // chief one level up, and an Activity row says so. A bb.log.warn is
            // not a surface. Only a message bound for the CHIEF is finally
            // dropped, because there is nowhere above it.
            // Re-park for the chief whenever this was NOT already the chief's
            // own queue. `chief` being null is not a reason to delete: NULL in
            // that column means "the chief, whenever there is one", so the
            // message waits for a chief to exist rather than being destroyed
            // because one does not yet.
            if (target !== null) {
              store.escalateChiefMessage(
                message.id,
                `[Escalated: this could not be delivered to its manager after ${message.attempts} attempts. If it was a failure or an escalation you already have a short copy of it.]\n\n${message.body}`,
                message.senderThreadId,
              );
              // "forward", not "failed": see the retire site. Both outbox rows
              // are stamped with the SENDING worker's thread, so under `failed`
              // an escalation would count as that worker's own finished turn.
              record("forward", {
                threadId: message.senderThreadId,
                excerpt: `A report could not be delivered to its manager after ${message.attempts} attempts and was escalated to the chief.`,
              });
            } else {
              bb.log.warn(`outbox message ${message.id} dropped after ${message.attempts} attempts: ${String(error)}`);
              store.dropChiefMessage(message.id);
              record("forward", {
                threadId: message.senderThreadId,
                excerpt: `A report to the chief was dropped after ${message.attempts} delivery attempts.`,
              });
            }
            continue;
          }
          store.bumpChiefMessage(message.id);
        }
      }
      // Outside the send's try: the message HAS gone out, so a failure to drop
      // the row must not count as a failed send, or a delivered message could
      // be escalated to the chief as undeliverable. A row left behind is sent
      // again next drain; a duplicate is visible, a lost report is not.
      if (delivered) {
        for (const message of pending) {
          // Each sender's report counts as a plugin delivery, so the reader's
          // turn that reads it does not report back to any of them.
          if (message.senderThreadId) notePluginDelivery(threadId, message.senderThreadId);
          try {
            store.dropChiefMessage(message.id);
          } catch (error) {
            bb.log.warn(`outbox message ${message.id} was delivered but not cleared: ${String(error)}`);
          }
        }
        if (pending.length > 1) bb.log.info(`held reports delivered: ${pending.length} merged into one message to ${threadId}`);
        sent = true;
      }
    }
    if (sent) changed();
  }

  /**
   * Bring a failed chief back. A chief turn that dies leaves the thread in
   * `error`, and everything workers report from then on parks in the outbox, so
   * the board goes quiet without anything being wrong with the workers. This is
   * the one button that ends that state: stop whatever is left of the dead
   * turn, deliver the parked messages, and when there were none, send one line
   * so the chief actually takes a turn and the thread leaves `error`.
   */
  async function restartChief(): Promise<{ ok: boolean; text: string }> {
    const chief = chiefThreadId;
    if (!chief) return { ok: false, text: "No chief thread. Run `bb cos start` to create one." };
    const parked = store.pendingChiefMessages().length;
    // Restarting a working chief is not recovery, it is an interruption: it
    // stops whatever turn is running and sends it a "your last turn failed"
    // line that is a lie. The board only offers the button on a failed chief;
    // the CLI has to say no itself. Parked reports are the exception, since
    // delivering them is what the chief is waiting for either way.
    const status = (await threadOrNull(chief))?.runtime.displayStatus ?? null;
    if (parked === 0 && status !== "error") {
      return {
        ok: false,
        text: `Chief is ${status ?? "unknown"}, not failed, and nothing is parked for it. Nothing to recover; send it work instead.`,
      };
    }
    const failure = store.lastChiefFailure();
    try {
      await bb.sdk.threads.stop({ threadId: chief });
    } catch {
      // Nothing was running: the failed turn is already over. Not an error.
    }
    await drainChiefOutboxOnce();
    const left = store.pendingChiefMessages().length;
    const delivered = parked - left;
    if (parked === 0) {
      const why = failure === null ? "an error" : truncate(failure.excerpt, 300);
      try {
        await sendToThread({
          threadId: chief,
          mode: "queue-if-active",
          input: [
            {
              type: "text",
              text: attributed(`Your last turn failed with: ${why}\n\nYou are back. Read the roster with cos_roster, then continue where that turn stopped. Do not repeat work that already finished.`),
              mentions: [],
            },
          ],
          ...(await permissionFor(chief)),
        });
      } catch (error) {
        return { ok: false, text: `Could not restart the chief: ${String(error)}` };
      }
      record("chief-restart", { threadId: chief, excerpt: `Restarted after: ${why}` });
      changed();
      return { ok: true, text: "Chief restarted; it is reading the roster now." };
    }
    record("chief-restart", {
      threadId: chief,
      excerpt: `Restarted; delivered ${delivered} of ${parked} parked message${parked === 1 ? "" : "s"}.`,
    });
    changed();
    return left === 0
      ? { ok: true, text: `Chief restarted; ${delivered} parked message${delivered === 1 ? "" : "s"} delivered.` }
      : { ok: false, text: `Chief still refusing messages: ${left} of ${parked} stayed in the outbox.` };
  }

  /**
   * Did the chief start the worker's latest turn? The thread event log is the
   * source of truth: every turn opens with a client/turn/requested event that
   * names the sender thread. A spawn's first turn has no sender, and the log
   * can be unreadable for a moment, so the dispatch row this plugin writes at
   * cos_delegate time is the fallback: it counts when it was written within a
   * short window of the turn request.
   */
  /**
   * Who started this worker's last turn, as a thread id.
   *
   * ONE read of the event log, and the answer is the sender rather than a
   * yes/no about one candidate. Asking "did the audience start it" would lose
   * reports: when the CHIEF dispatches a MANAGED worker the answer is no, so
   * the full report would go to nobody and the chief would never hear back
   * from a turn it asked for. The question is not "was it you", it is
   * "who was it", and the report goes to them.
   *
   * `ok: false` means the log could not be read AND the dispatch row does not
   * settle it. Distinct from `sender: null`, which is "read it, the user or
   * some other thread started this". A read that failed is never reported as
   * an absence.
   */
  async function turnOrigin(
    worker: Worker,
  ): Promise<
    | {
        ok: true;
        sender: string | null;
        typedByOwner: boolean;
        requestText?: string | null;
        pluginRelayed?: boolean;
      }
    | { ok: false }
  > {
    let requestedAt: number | null = null;
    let typedByOwner = false;
    let automationId: string | null = null;
    let logRead = false;
    try {
      const rows = await bb.sdk.threads.events.list({
        threadId: worker.threadId,
        types: ["client/turn/requested", "turn/started", "turn/completed"],
        order: "desc",
        limit: "60",
      });
      logRead = true;
      const typedRows = rows as unknown as TurnOriginEvent[];
      const latest = requestForEndedTurn(typedRows);
      // A turn bb resumed after a 429/503 names its original request; the
      // original's sender is the one that counts (turnOriginOf).
      const retryOf = latest?.data.retryOfRequestId ?? null;
      let original: TurnRequestRow | null = null;
      if (retryOf) {
        original =
          (typedRows.find(
            (row) => row.type === "client/turn/requested" && row.data.requestId === retryOf,
          ) as TurnRequestRow | undefined) ?? null;
      }
      const origin = turnOriginOf(latest, original);
      const resolvedRow =
        typeof latest?.data.retryOfRequestId === "string" && latest.data.retryOfRequestId !== "" && original !== null
          ? original
          : latest;
      const requestText = resolvedRow?.data.input?.[0]?.text ?? null;
      automationId = automationIdOf(latest?.data.input?.[0]?.text);
      if (origin.sender !== null) {
        const pluginRelayed =
          isPluginRelayedMessage(requestText) ||
          wasPluginDelivery(worker.threadId, origin.sender, origin.requestedAt);
        return { ok: true, sender: origin.sender, typedByOwner: false, requestText, pluginRelayed };
      }
      requestedAt = origin.requestedAt;
      typedByOwner = origin.typedByOwner;
    } catch (error) {
      bb.log.warn(`report routing for ${worker.name}: event log unreadable, using dispatch row: ${String(error)}`);
    }
    // No sender in the log: a spawn's first turn carries none, and so does a
    // turn the user typed. The dispatch row is the fallback for the first case.
    const fresh = store.byId(worker.id) ?? worker;
    const dispatcher = fresh.lastDispatchBy;
    const dispatcherThread =
      dispatcher === null
        ? null
        : dispatcher.kind === "chief"
          ? chiefThreadId
          : (store.byId(dispatcher.workerId)?.threadId ?? null);
    if (dispatcherThread === null || fresh.lastDispatchAt === null) {
      return logRead ? { ok: true, sender: null, typedByOwner } : { ok: false };
    }
    if (requestedAt !== null && fresh.lastDispatchAt < requestedAt - 15_000) {
      // The row is older than the turn: something else started this one,
      // unless it is an automation the worker set during that dispatch to
      // finish the job later, which reports to the dispatcher.
      if (automationId !== null && (await automationFollowsWorkerDispatch(fresh, automationId))) {
        return { ok: true, sender: dispatcherThread, typedByOwner: false };
      }
      return { ok: true, sender: null, typedByOwner };
    }
    return { ok: true, sender: dispatcherThread, typedByOwner: false };
  }

  /**
   * Did this worker set up the automation itself, during the dispatch it was
   * on? Read from the builtin automations plugin. A read that fails answers
   * no, which routes the turn as a note, never a lost report.
   */
  async function automationFollowsWorkerDispatch(worker: Worker, automationId: string): Promise<boolean> {
    try {
      const result = (await bb.sdk.plugins.callRpc({
        pluginId: "automations",
        method: "automations_get",
        input: { projectId: worker.projectId, automationId },
        outputSchema: automationGetSchema,
      })) as { createdByThreadId?: string | null; createdAt?: number | null };
      return automationFollowsDispatch({
        createdByThreadId: result.createdByThreadId ?? null,
        createdAt: result.createdAt ?? null,
        workerThreadId: worker.threadId,
        lastDispatchAt: worker.lastDispatchAt,
      });
    } catch (error) {
      bb.log.warn(`report routing for ${worker.name}: could not read automation ${automationId}: ${String(error)}`);
      return false;
    }
  }

  /** The chief-only form, for the callers that only ever ask about the chief. */
  async function latestTurnFromChief(worker: Worker): Promise<boolean> {
    const chief = chiefThreadId;
    if (!chief) return false;
    const answer = await turnOrigin(worker);
    return answer.ok && answer.sender === chief;
  }

  /**
   * Log a finished worker turn, then decide what the chief hears.
   *
   * Full report: only when the chief dispatched the turn. A reply to a message
   * the user sent the worker directly is an answer the chief never saw the
   * question for, and it would misread such turns as unilateral work.
   * Always: a Need: line that is not "nothing", and a Chief: escalation line,
   * because a decision must not sit unseen in a thread the user may not reopen.
   */
  /** Marker suffix for a fenced block, so a report cannot close the fence itself. */
  function fenceNonce(): string {
    return Math.random().toString(36).slice(2, 6);
  }

  /**
   * ONE MESSAGE PER TURN FOR A STEER.
   *
   * `cos_steer` interrupts a running turn, so bb emits idle twice and the
   * worker would report twice for what the reader experiences as one turn.
   *
   * The window is opened ONLY by a steer that actually landed mid-turn
   * (`delivery === "sent"`); a steer that arrived as an ordinary turn produces
   * one report and must not be delayed. So no ordinary report pays for this.
   *
   * A held report is flushed by a timer if the second never comes, which is the
   * safe direction: the worst case is one message, slightly late.
   * `chooseSteerReport` decides which of a pair survives, and it
   * keeps the escalating one rather than the last one.
   */
  const STEER_MERGE_MS = 2500;
  /** workerId -> when its steer stops merging reports. */
  const steerMergeUntil = new Map<string, number>();
  /** workerId -> the first report of a steered pair, waiting for its partner. */
  const heldReports = new Map<
    string,
    { kind: "idle" | "failed"; text: string | null; timer: ReturnType<typeof setTimeout> }
  >();

  /** How long dispose waits for one held report to go out before parking it. */
  const DISPOSE_FLUSH_MS = 3_000;

  /**
   * Park a held report in the chief's outbox, fenced like the full report, for
   * the next instance to deliver. Used only when dispose could not send it in
   * time. It may already have gone out after all; a duplicate is visible and
   * a lost report is not, which is the direction this plugin always takes.
   */
  function parkHeldReport(worker: Worker, kind: "idle" | "failed", text: string | null): void {
    const clean = scrubUntrusted(text ?? "");
    const note = scrubNote(clean);
    const who = `${worker.name} (thread ${worker.threadId})`;
    const body =
      kind === "idle"
        ? `[Worker report] ${who} finished a turn. Delivered late: the plugin reloaded while it was being sent.\n\n${fenceUntrusted(truncateReport(clean.text || "(no output)"), { nonce: fenceNonce(), note })}`
        : `[Worker report] ${who} FAILED. Delivered late: the plugin reloaded while it was being sent.\n${fenceUntrusted(truncateReport(clean.text || "unknown error"), { nonce: fenceNonce(), label: "failure text", note })}`;
    try {
      store.enqueueChiefMessage(body, worker.threadId, null);
    } catch (error) {
      bb.log.warn(`held report for ${worker.name}: could not park it: ${String(error)}`);
    }
  }

  /** Report, unless this worker was just steered and its partner is still coming. */
  async function reportMerged(worker: Worker, kind: "idle" | "failed", text: string | null) {
    const until = steerMergeUntil.get(worker.id) ?? 0;
    const held = heldReports.get(worker.id);
    if (held === undefined && Date.now() > until) {
      await reportToChief(worker, kind, text);
      return;
    }
    if (held === undefined) {
      const timer = setTimeout(() => {
        heldReports.delete(worker.id);
        steerMergeUntil.delete(worker.id);
        void reportToChief(worker, kind, text).catch((error: unknown) => {
          bb.log.warn(`held report for ${worker.name}: ${String(error)}`);
        });
      }, STEER_MERGE_MS);
      heldReports.set(worker.id, { kind, text, timer });
      return;
    }
    clearTimeout(held.timer);
    heldReports.delete(worker.id);
    steerMergeUntil.delete(worker.id);
    const winner =
      chooseSteerReport(
        { kind: held.kind, disposition: held.kind === "idle" ? parseDisposition(held.text) : null },
        { kind, disposition: kind === "idle" ? parseDisposition(text) : null },
      ) === "first"
        ? held
        : { kind, text };
    await reportToChief(worker, winner.kind, winner.text);
  }

  /**
   * QUOTA FAILURES DO NOT START A CHIEF TURN.
   *
   * One FAILED notice per thread when a quota runs out would spend a chief
   * turn each on the same 429, a fact the roster already shows.
   *
   * The roster is untouched. `record("failed", ...)` runs before this gate and
   * the roster derives FAILED from the activity table, so every row still reads
   * FAILED.
   *
   * `isQuotaFailure` matches narrowly on purpose: a missed quota failure costs
   * one forwarded message, while a real failure misread as quota is a dead
   * worker nobody hears about.
   */
  const QUOTA_WINDOW_MS = 5 * 60_000;
  /** "More than three threads", so the fourth inside the window is what boards it. */
  const QUOTA_BOARD_MIN = 4;
  const QUOTA_BOARD_DEDUPE_MS = 60 * 60_000;
  /** A non-quota failure still forwards, but not more often than this per thread. */
  const FAILURE_FORWARD_EVERY_MS = 10 * 60_000;
  const quotaFailureAt: number[] = [];
  let lastQuotaBoardAt = 0;
  const failureForwardState: FailureForwardState = { byOriginAt: new Map(), byAudienceText: new Map() };
  /**
   * The worker's questions, matched against the ones it raised before
   * (`observeNeed`). A store error is logged and
   * reads as "nothing on file": `needForNote` then passes the Need through
   * unmatched, so a failed read never suppresses a question.
   */
  function observeWorkerNeed(worker: Worker, need: string | null, typedByOwner: boolean): ObservedNeedItem[] {
    try {
      return store.observeNeed(worker.id, need, { typedByOwner });
    } catch (error) {
      bb.log.warn(`need ids for ${worker.name}: ${String(error)}`);
      return [];
    }
  }
  /** These questions reached the worker's audience. Logged and dropped on a store error. */
  function markNeedSent(worker: Worker, ids: readonly string[]): void {
    if (ids.length === 0) return;
    try {
      store.markNeedItemsSent(ids);
    } catch (error) {
      bb.log.warn(`need ids for ${worker.name}: could not mark sent: ${String(error)}`);
    }
  }
  /**
   * Whether a worker's current Need is dismissed: by its text (the stored
   * signature), or because every question in it was dismissed
   * under its id, so a reworded repeat of an answered question stays
   * dismissed. Also the ids on file. Read only: the roster must not move state,
   * and a store error reads as "no ids", never as a dismissal.
   */
  function needDismissal(
    worker: Worker,
    need: string | null,
  ): { dismissed: boolean; at: number | null; note: string | null; ids: string[] } {
    if (need === null) return { dismissed: false, at: null, note: null, ids: [] };
    let items: ObservedNeedItem[] = [];
    try {
      items = store.observeNeed(worker.id, need, { readOnly: true });
    } catch (error) {
      bb.log.warn(`need ids for ${worker.name}: ${String(error)}`);
    }
    const ids = needIdsOf(items);
    if (isNeedDismissed(worker, need)) return { dismissed: true, at: worker.needDismissedAt, note: worker.needDismissedNote, ids };
    if (items.length === 0 || items.some((item) => item.isNew || item.record.dismissedAt === null)) {
      return { dismissed: false, at: null, note: null, ids };
    }
    const latest = items.reduce((a, b) => ((b.record.dismissedAt ?? 0) > (a.record.dismissedAt ?? 0) ? b : a));
    return { dismissed: true, at: latest.record.dismissedAt, note: latest.record.dismissedNote, ids };
  }

  /** " [n1a2b3, n4c5d6]" after a Need's label, or "" when none is on file. */
  function needIdsLabel(ids: readonly string[]): string {
    return ids.length === 0 ? "" : ` [${ids.join(", ")}]`;
  }
  const lastNoteTextSent = new Map<string, string>();
  const peerLoopState: PeerLoopState = { byPair: new Map(), notifiedManagerAt: new Map() };

  /** Count one quota failure, and board a single line when the fleet is stalling. */
  function noteQuotaFailure(): void {
    const now = Date.now();
    quotaFailureAt.push(now);
    while (quotaFailureAt.length > 0 && now - (quotaFailureAt[0] ?? 0) > QUOTA_WINDOW_MS) quotaFailureAt.shift();
    if (quotaFailureAt.length < QUOTA_BOARD_MIN) return;
    // One item an hour, not one per burst. A burst would otherwise
    // write a dozen, which is the same flood one surface along.
    if (now - lastQuotaBoardAt < QUOTA_BOARD_DEDUPE_MS) return;
    lastQuotaBoardAt = now;
    store.boardAdd({
      headline: `${quotaFailureAt.length} threads stopped on a rate limit at ${formatClock(now)}; retry when quota returns`,
      context:
        "Every one refused with the same quota error, so this is one fact rather than N failures. The roster shows each thread as FAILED and nothing was lost: re-dispatch when the window rolls. `cos_usage` names the account actually in use.",
      area: "operations",
      sourceLabel: "the plugin",
    });
    changed();
  }

  async function reportToChief(worker: Worker, kind: "idle" | "failed", text: string | null) {
    // Every word below this line was written by a worker, and a worker quotes
    // untrusted text. Treat it as data from
    // here on: strip what is invisible, escape what impersonates the harness.
    const clean = scrubUntrusted(text ?? "");
    text = text === null ? null : clean.text;
    // Kept on the row so the roster still has this report's Need line when it
    // cannot read the thread (rosterReportText). First, before any return below,
    // so it is stored for every routing. Idle only: a failed turn's text is the
    // error, not a report, and must not replace the last real Need.
    if (kind === "idle") {
      try {
        store.setLastReportText(worker.id, text);
      } catch (error) {
        bb.log.warn(`report for ${worker.name}: could not store its text: ${String(error)}`);
      }
    }
    // A failed project read falls back to the id rather than throwing before
    // the record below, so a projects.list hiccup cannot make a finished turn
    // vanish from the roster and reach nobody.
    const projects = await listProjects().catch((error: unknown) => {
      bb.log.warn(`report for ${worker.name}: could not list projects: ${String(error)}`);
      return [] as ProjectRef[];
    });
    const projectName = projects.find((p) => p.id === worker.projectId)?.name ?? worker.projectId;
    const initialBlock = parseStatusBlock(text);
    const initialChiefLine = parseChiefLine(text);
    const initialFresh = store.byId(worker.id) ?? worker;
    const initialNeed =
      initialBlock.need !== null && needDismissal(initialFresh, initialBlock.need).dismissed ? null : initialBlock.need;
    const initialDisposition = kind === "idle" ? parseDisposition(text) : null;
    record(kind === "idle" ? "report" : "failed", {
      workerName: worker.name,
      projectName,
      threadId: worker.threadId,
      excerpt: kind === "idle" ? (text ?? "(no output)") : (text ?? "The turn ended without an error message."),
      unread: turnCountsAsUnread({
        kind,
        disposition: initialDisposition,
        need: initialNeed,
        chiefLine: initialChiefLine,
        sentToAudience: false,
      }),
    });
    // Gate the SENDS only. The activity row written just above is what the
    // roster reads, so every thread still shows FAILED.
    if (kind === "failed" && isQuotaFailure(text)) {
      noteQuotaFailure();
      return;
    }
    // WHO READS THIS. A managed worker reports to its manager, everyone else to
    // the chief. The disposition suppression and the fencing below are the
    // same for either reader.
    const audience = audienceFor(worker);
    if (audience === null) {
      // No manager and no chief YET. Park it rather than drop it: NULL target
      // means "the chief, whenever there is one", so this is delivered the
      // moment a chief exists. A report nobody sees is a worker that looks
      // stalled forever, and "there is no reader right now" is not the same
      // fact as "nobody needed to read this".
      const note = scrubNote(clean);
      store.enqueueChiefMessage(
        `[Worker report] ${projectName}:${worker.name} (thread ${worker.threadId}) finished a turn while no chief existed.\n\n${fenceUntrusted(truncateReport(text ?? "(no output)"), { nonce: fenceNonce(), note })}`,
        worker.threadId,
        null,
      );
      changed();
      return;
    }
    const who = `${projectName}:${worker.name} (thread ${worker.threadId})`;
    // A caller blocked in cos_wait delivers the result itself, so its own copy
    // is suppressed below. Only ITS copy: a manager waiting on a team member
    // must not suppress the chief's copy of a failure or a Chief: line,
    // which is a middle layer absorbing exactly what it must never absorb.

    // Parsed once, for both branches. A dismissed need was answered out of band
    // and must not keep pinging; the row is re-read
    // because the dismissal may be newer than the worker this handler loaded.
    const block = parseStatusBlock(text);
    const chiefLine = parseChiefLine(text);
    const fresh = store.byId(worker.id) ?? worker;
    const need = block.need !== null && isNeedDismissed(fresh, block.need) ? null : block.need;
    const disposition = kind === "idle" ? parseDisposition(text) : null;
    // Remembered on every finished turn, so `cos_roster` can name the workers
    // whose reports carry no disposition word. Null is a fact here, not an absence.
    // Written below, once the turn's origin is known, because only a dispatch
    // asks for the word.

    // The plugin waiting on its own turn: a remodel's orientation. Nobody is
    // owed that report, so it stops here rather than in one of the branches
    // below, where it would never arrive because a repointed thread has no
    // stored dispatcher and so no `fullTo` to match against.
    if (kind === "idle" && waitedForBy(worker.threadId, PLUGIN_WAIT)) {
      store.setLastDisposition(worker.id, disposition, null);
      return;
    }

    // WHO ASKED FOR THIS TURN, and therefore who gets the full report.
    //
    // Asking "did the AUDIENCE start it" would lose reports: when the CHIEF
    // dispatches a MANAGED worker the answer is no, so the full report would
    // go to nobody and the chief would never hear back from a turn it asked
    // for. A worker reassigned between dispatch and report would lose it the
    // same way. The question is not "was it you", it is "who was it".
    const origin = await turnOrigin(worker);
    if (kind === "idle") store.setLastDisposition(worker.id, disposition, origin.ok ? origin.sender !== null : null);
    // Every question in the Need, matched to the ones this worker raised
    // before, so a reworded repeat keeps its id; one first raised in a turn
    // the user typed waits NEED_HOLD_MS before it goes up.
    // Idle turns only: a failed turn's text is the error.
    const typedByOwner = origin.ok && origin.typedByOwner;
    const needItems = kind === "idle" ? observeWorkerNeed(worker, block.need, typedByOwner) : [];
    const managerThreadId =
      worker.managerId === null ? null : (store.byId(worker.managerId)?.threadId ?? null);
    const senderWorker = origin.ok && origin.sender !== null ? store.byThread(origin.sender) : null;
    const startedByTeamMember =
      worker.role === "manager" &&
      senderWorker !== null &&
      senderWorker.retiredAt === null &&
      senderWorker.managerId === worker.id;
    /**
     * WHO ASKED FOR THIS TURN gets the full report, whatever the disposition
     * word. The chief or the worker's manager is the
     * dispatcher; any other live thread that asked is a peer, under the pair
     * loop guard. Nobody asked: the quiet note path below.
     */
    const route = requestedReportRoute({
      workerThreadId: worker.threadId,
      workerIsManager: worker.role === "manager",
      sender: origin.ok ? origin.sender : null,
      pluginRelayed: origin.ok && origin.pluginRelayed === true,
      chiefThreadId,
      managerThreadId,
      senderIsTeamMember: startedByTeamMember,
      senderIsRetiredWorker: senderWorker !== null && senderWorker.retiredAt !== null,
    });
    const fullTo = route.kind === "dispatcher" ? route.threadId : null;
    const rawPeerTo = route.kind === "peer" ? route.threadId : null;
    const peerDecision = decidePeerRoute(peerLoopState, {
      workerThreadId: worker.threadId,
      peerThreadId: rawPeerTo,
      audienceThreadId: audience.threadId,
      requestText: origin.ok ? (origin.requestText ?? null) : null,
      recordedPluginDelivery: origin.ok ? origin.pluginRelayed === true : false,
      kind,
      disposition,
      need,
      chiefLine,
      now: Date.now(),
    });
    const peerTo =
      rawPeerTo !== null && peerDecision.reason !== "plugin-relayed" && peerDecision.reason !== "no-peer"
        ? rawPeerTo
        : null;
    const startedByWorker = peerTo !== null || startedByTeamMember;
    /** The chief also hears about a failure and an escalation, whoever the audience is. */
    const chiefAlso = chiefThreadId !== null && chiefThreadId !== (fullTo ?? audience.threadId);
    if (kind === "idle") {
      failureForwardState.byAudienceText.delete(`${worker.id}:${audience.threadId}`);
    } else {
      const originKey = !origin.ok
        ? "unknown"
        : origin.sender ?? (origin.typedByOwner ? "owner" : "other");
      const gate = shouldForwardFailure(failureForwardState, {
        workerId: worker.id,
        originKey,
        audienceThreadId: audience.threadId,
        text,
        now: Date.now(),
        throttleMs: FAILURE_FORWARD_EVERY_MS,
      });
      if (!gate.forward) return;
    }
    if (!origin.ok) {
      const body = statusNote({
        header: `[Worker note] ${who} finished a turn and its origin could not be determined: the thread event log was unreadable. The full reply is NOT forwarded; run cos_read to see it.`,
        done: block.done,
        // `Open:` is carried too, so the audience sees the same worker words
        // whichever failure this was.
        open: block.open,
        chiefLine,
        need,
        scrubNote: scrubNote(clean),
      });
      await sendUpWithRetry(audience.threadId, body, worker.threadId);
      if (chiefAlso) await sendToChiefWithRetry(body, worker.threadId);
      return;
    }

    // A MANAGER's report gets one extra check before the suppression below.
    // If any of its team reported Decision, Blocked or Changed-plan since it
    // last reported, and the manager still said Done, the suppression would
    // swallow the manager's report AND with it the only mention of the team
    // member's decision that ever reaches the chief. That is the one way this
    // tier can LOSE something rather than move it, so the gap un-suppresses the
    // report and says why.
    const gap =
      worker.role === "manager"
        ? managerReportGap(
            disposition,
            // Only members whose loud turn the manager has NOT read yet. The
            // rule says "since its last report" and `last_disposition` has no
            // time bound of its own: it keeps saying "blocked" until that
            // worker finishes something else, so an unbounded check would
            // un-suppress every manager report from here to the end of time on
            // the strength of one stale word. A member the manager has already
            // read has had its chance to pass the decision on.
            store
              .team(worker.id)
              .filter((member) => store.turnsSince(member.threadId, member.chiefLastSeenAt) > 0)
              .map((member) => member.lastDisposition),
          )
        : null;

    /**
     * A `Chief:` line reaches the chief whatever else happens to this report.
     *
     * Sent BEFORE any of the audience-side suppressions below, because two of
     * them would swallow it: the disposition suppression on an idle Done, and
     * the `waiterIsAudience` return when a manager is blocked in cos_wait. It
     * is addressed to the chief by name and escalation is a different channel
     * from reporting, so a middle layer must not be able to hold it. That
     * includes a turn the MANAGER dispatched: the manager gets the full
     * report, and the escalation still reaches the chief.
     */
    // A LEAF'S `Chief:` LINE GOES TO ITS MANAGER, and to the chief only when it
    // touches credentials, sending or spending.
    //
    // This branch only ever fires for a worker whose audience is a manager: a
    // worker reporting straight to the chief has `chiefAlso` false because the
    // chief IS its audience. So the manager already has this line, either in
    // the full report or in the note path, both of which carry it - which is
    // what makes gating the chief's copy safe rather than lossy.
    //
    // Keyword matching is a heuristic and is built so a miss costs nothing: the
    // manager sees every line and can forward, and a false positive costs one
    // message. See `chiefNeedsEscalation`.
    if (chiefAlso && chiefLine !== null && chiefNeedsEscalation(chiefLine)) {
      if (chiefLineRepeats(worker, chiefLine)) {
        bb.log.info(`worker note suppressed: repeats its own Chief: line (${worker.name}, escalation)`);
      } else {
        await sendToChiefWithRetry(
          `[Worker note] ${who} escalated past its manager.\nChief: ${chiefLine}`,
          worker.threadId,
        );
        noteChiefLineSent(worker, chiefLine);
      }
      // So the manager's echo of the same fact can be recognised (managerEchoOf).
      lastEscalationAt.set(worker.id, Date.now());
    }

    if (fullTo !== null) {
      // A REQUESTED TURN ALWAYS REPORTS BACK, Done included. Dropping a
      // dispatched `Done` / `Need: nothing` with no Chief: line would save the
      // reader a turn but leave a manager reporting finished work as still in
      // progress. The economy comes from merging instead: a reader mid-turn
      // gets its reports after that turn ends, several as one message
      // (`deliverRequestedReport`).
      // truncateReport, not truncate: the Done/Open/Need block is the last thing
      // a worker writes, so cutting only the head would throw away the part the
      // audience acts on. The failure text gets the same cap.
      const note = scrubNote(clean);
      // The team gap is stated above the report, because it is a fact about the
      // TEAM that is not in the manager's own words.
      const gapLine = gap === null ? "" : `\n[Team gap: ${gap}.]`;
      const body =
        kind === "idle"
          ? `[Worker report] ${who} finished a turn.${gapLine}\n\n${fenceUntrusted(truncateReport(text ?? "(no output)"), { nonce: fenceNonce(), note })}`
          : `[Worker report] ${who} FAILED:\n${fenceUntrusted(truncateReport(text ?? "unknown error"), { nonce: fenceNonce(), label: "failure text", note })}`;
      if (kind === "idle") {
        // A caller blocked in cos_wait delivers the result itself, so its own
        // copy is skipped. Only ITS copy: the chief's escalations go above.
        const delivered = await deliverRequestedReport(worker, fullTo, body, "dispatcher");
        // Only the audience marks it seen. `chief_last_seen_at` is one column
        // and, with the manager tier, two threads can read a worker; if a manager's
        // read cleared the chief's `[new N]` the chief would never learn the
        // worker had finished. A read by a non-audience caller is a peek.
        if (delivered) store.markChiefSeen(worker.id);
        // The audience has the whole Need now, so a later note does not send
        // its questions again. Not when the dispatcher is someone else (the
        // chief dispatching a managed worker): the manager has not had them.
        if (delivered && fullTo === audience.threadId) markNeedSent(worker, needIdsOf(needItems.filter((item) => item.record.dismissedAt === null)));
      } else {
        // A FAILURE goes out at once even when the reader is waiting on this
        // worker: a failed turn never reaches idle, so `cos_wait` would only
        // surface it at its own timeout, up to ten minutes later.
        const delivered = await sendUpWithRetry(fullTo, body, worker.threadId);
        if (delivered) store.markChiefSeen(worker.id);
      }
      // A DEAD WORKER IS NEVER ABSORBED BY A MIDDLE LAYER. The manager gets the
      // full failure above; the chief gets the short note, whoever was waiting.
      if (kind !== "idle" && chiefAlso) {
        await sendToChiefWithRetry(
          `[Worker note] ${who} FAILED. Its manager has the full text; run cos_read to see it.`,
          worker.threadId,
        );
      }
      return;
    }
    if (peerDecision.sendToPeer && peerTo !== null) {
      const note = scrubNote(clean);
      const peerBody =
        kind === "idle"
          ? `[Worker report] ${who} finished a turn.\n\n${fenceUntrusted(truncateReport(text ?? "(no output)"), { nonce: fenceNonce(), note })}`
          : `[Worker report] ${who} FAILED:\n${fenceUntrusted(truncateReport(text ?? "unknown error"), { nonce: fenceNonce(), label: "failure text", note })}`;
      if (kind === "idle") await deliverRequestedReport(worker, peerTo, peerBody, "peer");
      else await sendUpWithRetry(peerTo, peerBody, worker.threadId);
    } else if (peerDecision.reason === "loop-guard" && rawPeerTo !== null) {
      bb.log.warn(
        `peer route dropped: loop guard tripped between ${worker.name} (${worker.threadId}) and ${senderWorker?.name ?? rawPeerTo} (${rawPeerTo})`,
      );
      if (peerDecision.notifyManagerLoop) {
        await sendUpWithRetry(
          audience.threadId,
          `[Worker note] Peer routing loop guard tripped between ${who} and ${senderWorker?.name ?? rawPeerTo} (thread ${rawPeerTo}) after ${PEER_LOOP_MAX} peer-routed messages in 10 minutes; further peer reports between them are dropped.`,
          worker.threadId,
        );
      }
    }

    // A turn that died always reaches its audience AND the chief, whoever
    // started it. Otherwise a worker the user had messaged
    // directly could fail on a bad tool call or an exhausted credential pool
    // and produce one activity row and nothing else: the user waits for an answer
    // that is never coming and nobody learns the worker is down. The full text
    // is not forwarded, because the turn was not theirs to read; what they need
    // is that the worker stopped, and where to look.
    if (kind !== "idle") {
      const note = scrubNote(clean);
      const body = [
        `[Worker note] ${who} FAILED a turn started by someone other than you. The full reply is not forwarded; run cos_read to see it.`,
        fenceUntrusted(truncateReport(text ?? "unknown error"), {
          nonce: fenceNonce(),
          label: "failure text",
          note,
        }),
      ].join("\n\n");
      await sendUpWithRetry(audience.threadId, body, worker.threadId);
      if (chiefAlso) await sendToChiefWithRetry(body, worker.threadId);
      return;
    }
    // THE DOUBLE HOP. A manager whose turn a team member's note started, where
    // that member's turn was one the user typed: the user is answering in that thread
    // already, so its Need is not relayed to them again through the chief
    // (`doubleHopLines`). A failed turn never gets here.
    // The Need as the worker wrote it: `needForNote` below decides what of it
    // goes and says why when it holds it back, which is what keeps the Decision
    // word that came with it quiet. Nulling it here would lose that reason.
    let noteNeed = block.need;
    let noteChiefLine = chiefLine;
    let noteChiefLineHeld = false;
    if (worker.role === "manager" && origin.ok && origin.sender !== null) {
      const member = store.team(worker.id).find((m) => m.threadId === origin.sender) ?? null;
      if (member !== null) {
        const memberOrigin = await turnOrigin(member);
        const lines = doubleHopLines({
          memberTurnTypedByOwner: memberOrigin.ok && memberOrigin.typedByOwner,
          need: noteNeed,
          chiefLine,
        });
        noteNeed = lines.need;
        noteChiefLine = lines.chiefLine;
        noteChiefLineHeld = lines.droppedChiefLine;
      }
    }
    // A turn the audience did not dispatch notes only what is FOR the audience:
    // a Chief: line, or a Need addressed to the chief. A Need to the user, or to
    // nobody, stays in the worker's thread, where the user already is, and on the
    // roster; it does not start a turn up the chain
    // (`noteForUndispatchedTurn`). Otherwise the finish just bumps `[new N]`.
    // The decision is logged either way, so it can be checked later.
    // The chief and a manager alike: a Need addressed to the reader (the
    // chief's address, or the manager's own name) goes up, a Need for the user
    // does not. The team's open Needs are on the manager's roster.
    // And only a question the reader has not had: one already sent, on the
    // board, dismissed or waiting out its hold keeps the Need back, under any
    // wording (`needForNote`).
    const fromIds = needForNote({
      need: noteNeed,
      items: needItems,
      seen: noteNeed !== null && needSignature(noteNeed) === fresh.needSeenSig,
      now: Date.now(),
      liveBoardIds: new Set(store.boardList({ limit: 500 }).map((item) => item.id)),
    });
    // A Need dismissed by its text (`need` is null only then) stays kept back,
    // whatever its ids say: a dismissal stored without ids, or a store that failed.
    const needNote =
      noteNeed !== null && need === null && fromIds.need !== null
        ? { need: null, why: "its Need was dismissed", sendIds: [] }
        : fromIds;
    noteNeed = needNote.need;
    let noteDecision = noteForUndispatchedTurn({
      need: noteNeed,
      needAudience: block.needAudience,
      chiefLine: noteChiefLine,
      readerNames: audience.kind === "manager" ? managerNames(worker) : [],
      heldChiefLine: noteChiefLineHeld,
      disposition,
      gap,
      startedByWorker,
      needHeldWhy: needNote.why,
      typedByOwner,
    });
    // A MANAGER RESTATING ITS TEAM'S ESCALATION. The member's Chief: line
    // already reached the chief directly; the manager's copy of the same fact
    // is dropped, and a Need for the chief in the same note still goes.
    // THE SAME WORKER REPEATING ITSELF: a Chief: line identical
    // to the one this worker last had forwarded, with nothing from the chief
    // since, is dropped; a Need for the chief in the same note still goes.
    if (noteDecision.chiefLine !== null && chiefLineRepeats(worker, noteDecision.chiefLine)) {
      bb.log.info(`worker note suppressed: repeats its own Chief: line (${worker.name})`);
      noteDecision =
        noteDecision.need === null && gap === null && noteDecision.loudDisposition === null
          ? { send: false, need: null, chiefLine: null, why: "its Chief: line repeats the last one it sent", loudDisposition: null }
          : { ...noteDecision, chiefLine: null };
    }
    if (worker.role === "manager" && noteDecision.chiefLine !== null) {
      const echo = await managerEchoOf(worker, origin);
      if (echo !== null) {
        bb.log.info(`worker note suppressed: duplicate of ${echo.member} escalation (${worker.name}'s Chief: line)`);
        noteDecision =
          noteDecision.need === null && gap === null && noteDecision.loudDisposition === null
            ? { send: false, need: null, chiefLine: null, why: `its Chief: line repeats ${echo.member}'s escalation`, loudDisposition: null }
            : { ...noteDecision, chiefLine: null };
      }
    }
    const body = statusNote({
      header: `[Worker note] ${who} finished a turn started by someone other than you, so the full reply is not forwarded. Run cos_read to see it.`,
      done: block.done,
      open: block.open,
      chiefLine: noteDecision.chiefLine,
      need: noteDecision.need,
      disposition: noteDecision.loudDisposition,
      gap,
      scrubNote: scrubNote(clean),
    });
    if (noteDecision.send && lastNoteTextSent.get(worker.id) === body) {
      noteDecision = { send: false, need: null, chiefLine: null, why: "unchanged from the last note sent", loudDisposition: null };
    }
    bb.log.info(
      `worker note ${noteDecision.send ? "forwarded" : "suppressed"}: ${worker.name} (${worker.threadId}) to ${audience.kind}, ${noteDecision.why}`,
    );
    if (!noteDecision.send) return;
    if (noteDecision.chiefLine !== null) noteChiefLineSent(worker, noteDecision.chiefLine);
    const deliveredNote = await sendUpWithRetry(audience.threadId, body, worker.threadId);
    // Sent even when it was parked: the outbox delivers it.
    if (noteDecision.need !== null) markNeedSent(worker, needNote.sendIds);
    store.setLatestReportUnread(worker.threadId, !deliveredNote);
  }

  /**
   * A worker turn that ended on a model rate limit. Records the block on the
   * row and in Activity, and tells the chief in one line instead of the raw
   * error. Returns false when `text` is not a timed rate limit, so the caller
   * reports the turn the ordinary way.
   */
  /** Failure texts bb hands over when it has nothing: the real message is in the thread. */
  const EMPTY_FAILURES = new Set(["", "unknown error", "unknown", "error"]);

  /**
   * What actually killed a turn. bb reports a turn rejected before it started
   * (an exhausted credential pool, for one) as "unknown error" and leaves the
   * provider's own text as the thread's last output, so an empty error is
   * looked up rather than passed on. A pool exhaustion gets the plain
   * explanation appended, because neither the raw text nor "unknown error"
   * tells the chief which account is spent.
   */
  async function turnFailureText(threadId: string, given: string | null): Promise<string | null> {
    // bb's wrapper texts first: the failed turn's own provider error says why
    // (failureDetail). A failed read leaves bb's text as it was.
    let detailed = given;
    try {
      const events = (await bb.sdk.threads.events.list({
        threadId,
        types: ["client/turn/requested", "provider/error"],
        order: "desc",
        limit: "40",
      })) as unknown as FailureEvent[];
      detailed = failureDetail(given, events);
    } catch (error) {
      bb.log.warn(`failure detail of ${threadId}: ${String(error)}`);
    }
    let text = detailed?.trim() ?? "";
    if (EMPTY_FAILURES.has(text.toLowerCase())) {
      try {
        const output = await bb.sdk.threads.output({ threadId });
        text = (output.output ?? "").trim();
      } catch (error) {
        bb.log.warn(`failure text of ${threadId}: ${String(error)}`);
      }
    }
    if (text === "") return detailed;
    // Scrubbed here rather than at each caller: this is a worker's own thread
    // output read back after a failed turn, and it reaches the chief through
    // cos_wait's timeout branch and through every failure report. The pool note
    // is the plugin's own words and goes on after.
    const clean = scrubUntrusted(text).text;
    const pool = exhaustedPoolNote(clean);
    return pool ? `${clean}\n${pool}` : clean;
  }

  async function handleRateLimit(worker: Worker, text: string | null): Promise<boolean> {
    const waitMs = parseRateLimit(text);
    if (waitMs === null) return false;
    const until = Date.now() + waitMs;
    // Who the sweep will re-send AS. The event log is authoritative for the
    // chief; otherwise the stored dispatcher decides, so a manager's brief is
    // retried too. A dispatch by nobody stays null and is never re-sent.
    const dispatcher = (await latestTurnFromChief(worker))
      ? ({ kind: "chief" } as const)
      : (store.byId(worker.id) ?? worker).lastDispatchBy;
    const retry = shouldRetryAfterLimit(worker, dispatcher);
    store.markRateLimited(worker.id, until, retry);
    const projectName = projectNameFrom(await listProjectsOrEmpty(`rate limit for ${worker.name}`), worker.projectId);
    const clock = formatClock(until);
    record("rate-limited", {
      workerName: worker.name,
      projectName,
      threadId: worker.threadId,
      excerpt: `until ${clock}${retry ? ", the message is re-sent then" : ""}`,
    });
    changed();
    // Its MANAGER first, because that is who is waiting on this worker and who
    // must not re-delegate before the limit lifts. The chief hears too: a
    // rate-limited worker is a worker that is down, and a dead worker is never
    // absorbed by a middle layer. A manager that IS the one blocked gets an
    // extra sentence, because a whole team's reports are about to park behind
    // it and the one-line worker text does not say that.
    const teamNote =
      worker.role === "manager" && store.teamSize(worker.id) > 0
        ? ` It manages ${store.teamSize(worker.id)} worker${store.teamSize(worker.id) === 1 ? "" : "s"}, whose reports will park until it answers.`
        : "";
    const body = `[Worker note] worker ${projectName}:${worker.name} rate-limited until ${clock}, ${retry ? "will retry its last message then" : "no automatic retry (the turn was not one you dispatched, or it was already retried once)"}. Do not re-delegate before then.${teamNote}`;
    const audience = audienceFor(worker);
    if (audience !== null) await sendUpWithRetry(audience.threadId, body, worker.threadId);
    if (chiefThreadId !== null && (audience === null || audience.threadId !== chiefThreadId)) {
      await sendToChiefWithRetry(body, worker.threadId);
    }
    return true;
  }

  /**
   * The retry sweep: every worker whose limit has lifted is unblocked, and the
   * one message a lifted limit refused is re-sent, once. The send carries the
   * chief as sender so the worker's report routes to the chief as if the chief
   * had dispatched it.
   */
  async function sweepRateLimits(): Promise<void> {
    const now = Date.now();
    const due = store.unblockedBy(now);
    if (due.length === 0) return;
    const projects = await listProjectsOrEmpty("rate-limit sweep");
    for (const candidate of due) {
      // Re-read the row. `due` is one snapshot taken before the loop, and every
      // iteration awaits a thread read, a permission read and a send, so the
      // worker at the back of a fleet-wide quota burst is acted on many seconds
      // after it was read. Three things can happen in that window, and none of
      // them may be decided from the stale copy.
      //
      // The chief re-dispatches the worker: `markDispatched` clears
      // `retry_pending` and stores the NEW brief, but the snapshot still says
      // pending and still holds the old one, so the superseded brief would be
      // sent a second time and queued behind the live one.
      //
      // The worker is remodelled, which the rate-limit refusal text explicitly
      // suggests: `remodelOne` repoints `thread_id` and archives the
      // predecessor, so `threadState` on the snapshot's thread id would answer
      // "gone" and the branch below would RETIRE a worker that was just moved.
      //
      // Or it is blocked again, which `delegate` refuses and so must the sweep.
      const worker = store.byId(candidate.id);
      if (worker === null || worker.retiredAt !== null) continue;
      const projectName = projectNameFrom(projects, worker.projectId);
      if (worker.blockedUntil !== null && worker.blockedUntil > Date.now()) continue;
      if (!worker.retryPending || worker.lastDispatchMessage === null) {
        store.clearRateLimit(worker.id, null);
        changed();
        continue;
      }
      // A thread deleted or archived while it was blocked can never take the
      // retry; without this the sweep would re-send to it every round forever.
      const state = await threadState(worker.threadId);
      if (state.kind === "gone") {
        store.clearRateLimit(worker.id, null);
        retireWorker(worker, projectName, worker.threadId);
        record("retire", {
          workerName: worker.name,
          projectName,
          threadId: worker.threadId,
          excerpt: "Its thread is gone, so the queued retry was dropped.",
        });
        changed();
        continue;
      }
      // Who this brief was from. `lastDispatchBy` is the stored dispatcher and
      // is exactly what `shouldRetryAfterLimit` consulted to decide the retry
      // should happen at all.
      const dispatcher = worker.lastDispatchBy;
      const retrySender =
        dispatcher === null
          ? chiefThreadId
          : dispatcher.kind === "chief"
            ? chiefThreadId
            : (store.byId(dispatcher.workerId)?.threadId ?? chiefThreadId);
      try {
        await sendToThread({
          threadId: worker.threadId,
          mode: "queue-if-active",
          // Attributed, because this path has neither of the two things that
          // cover the others: `lastDispatchMessage` is the stored body WITHOUT
          // the dispatch trailer, and the sender is set only when a chief
          // exists. With no chief, a re-sent brief would arrive in the user's voice.
          input: [
            { type: "text", text: attributed(worker.lastDispatchMessage), mentions: [] },
          ],
          // AS THE ORIGINAL DISPATCHER, not always as the chief. The sender is
          // what decides where the retried turn's report goes, so re-sending a
          // manager's brief with the chief as sender would launder that worker's
          // full report into the chief's thread: a report the chief never asked
          // for, and the manager waiting for one that never comes.
          ...(retrySender ? { senderThreadId: retrySender } : {}),
          ...(await permissionFor(worker.threadId)),
        });
        store.clearRateLimit(worker.id, Date.now());
        record("retry", {
          workerName: worker.name,
          projectName,
          threadId: worker.threadId,
          excerpt: worker.lastDispatchMessage,
        });
      } catch (error) {
        // The thread may still be busy or the host down; the block stays and
        // the next sweep tries again. Nothing was sent, so the cap is intact.
        bb.log.warn(`rate-limit retry for ${worker.name} failed, will try next sweep: ${String(error)}`);
      }
      changed();
    }
  }

  /** Forward text to the chief as context: Mission's Ask chief (`send_to_chief`) and `bb cos forward`. */
  async function forwardToChief(
    text: string,
    sourceThreadId: string,
    note?: string,
  ): Promise<{ ok: boolean; text: string }> {
    const payload = text.trim();
    if (payload === "") return { ok: false, text: "Nothing to forward." };
    const chief = await ensureChief();
    const trimmedNote = note?.trim() ?? "";
    // Scrubbed and fenced like every other path that carries worker words into
    // the chief's context, and this is the shortest such path:
    // "Ask chief" on a decision row forwards a worker's own Need line, and
    // `bb cos forward` will carry whatever a worker's shell hands it. The note
    // is the caller's, so it stays outside the fence; the payload is the
    // worker's and goes inside it.
    const clean = scrubUntrusted(truncate(payload, REPORT_MAX_CHARS));
    const body = [
      `[Forwarded from thread ${sourceThreadId}]`,
      trimmedNote === "" ? null : trimmedNote,
      fenceUntrusted(clean.text, {
        nonce: fenceNonce(),
        label: "forwarded message",
        note: scrubNote(clean),
      }),
    ]
      .filter((line): line is string => line !== null)
      .join("\n\n");
    const delivered = await sendToChiefWithRetry(body, sourceThreadId);
    record("forward", {
      threadId: sourceThreadId,
      excerpt: trimmedNote === "" ? payload : `${trimmedNote} - ${payload}`,
    });
    return {
      ok: delivered,
      text: delivered
        ? `Forwarded to the chief thread ${chief.threadId}.`
        : `Could not deliver to the chief thread ${chief.threadId}; it is busy. Try again in a moment.`,
    };
  }

  // ---------- agent surfaces ----------

  bb.agents.registerTool({
    name: "cos_spawn_manager",
    description:
      "Create a manager: a middle-tier thread that runs a team of workers and reports to you. Use it when one area has enough workers that their reports are costing you turns. Not a flag on cos_delegate, because a manager's brief comes from its team rather than from the call. The manager cannot create, retire or reassign anyone; only you can.",
    parameters: z.object({
      name: z.string().min(1).describe("Worker name for the manager, e.g. 'ops-lead', 'desk-lead', 'tools-lead'."),
      team: z.array(z.string()).optional().describe("Workers to put on its team now, by name or project:name. They can also be assigned later with cos_assign."),
      project: z.string().optional().describe("Project to create it in. Defaults to the chief's own project, because a manager's team spans projects."),
    }),
    presentation: { label: { pending: "Creating a manager", completed: "Created a manager" } },
    async execute({ name, team, project }, { threadId }) {
      const result = await spawnManager(scopeOf(threadId), name, team ?? [], project, threadId ?? null);
      return result.ok ? result.text : { content: [{ type: "text" as const, text: result.text }], isError: true };
    },
  });

  bb.agents.registerTool({
    name: "cos_assign",
    description:
      "Move a worker onto a manager's team, or back onto yours. Pass manager: 'chief' to take one back. This is the only way a team changes shape: a manager cannot add to or remove from its own team.",
    parameters: z.object({
      worker: z.string().describe("Worker reference: name, project:name, worker id, or thr_ id."),
      manager: z.string().describe("Manager reference, or 'chief' to make the worker report to you directly."),
      project: z.string().optional().describe("Project hint when the worker name is ambiguous."),
    }),
    presentation: { label: { pending: "Assigning a worker", completed: "Assigned a worker" } },
    async execute({ worker, manager, project }, { threadId }) {
      const result = await assignWorker(scopeOf(threadId), worker, manager, project);
      return result.ok ? result.text : { content: [{ type: "text" as const, text: result.text }], isError: true };
    },
  });

  /**
   * The projects a caller may be told about, or null for "could not tell".
   *
   * The chief and a bare terminal see every project; a manager sees the ones
   * its own team is in; a worker sees its own and nothing else.
   *
   * One function because there are two doors, the `cos_projects` TOOL and the
   * `bb cos projects` CLI verb, and both must filter: otherwise a worker or a
   * manager could read every project name and id from its own honest
   * BB_THREAD_ID, the enumeration the team filter on cos_roster exists to
   * withhold. Every scope kind is decided here, so no kind falls through to
   * everything.
   */
  function visibleProjects<T extends { id: string }>(scope: Scope, projects: readonly T[]): T[] | null {
    switch (scope.kind) {
      case "chief":
      case "none":
        return [...projects];
      case "manager": {
        const allowed = new Set(store.team(scope.managerId).map((w) => w.projectId));
        return projects.filter((p) => allowed.has(p.id));
      }
      case "worker": {
        const own = store.byId(scope.workerId)?.projectId ?? null;
        return own === null ? [] : projects.filter((p) => p.id === own);
      }
      case "unreadable":
        return null;
    }
  }

  bb.agents.registerTool({
    name: "cos_projects",
    description: "List all bb projects (id, name, kind) the chief of staff can delegate into.",
    parameters: z.object({}),
    presentation: { label: { pending: "Listing projects", completed: "Listed projects" } },
    async execute(_input, { threadId }) {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      // A manager sees only the projects its own team is in, as MANAGER_TOOLS
      // says. This also bounds every other enumeration, since `--project` is
      // the input to them.
      const visible = visibleProjects(scopeOf(threadId), projects);
      if (visible === null) {
        return { content: [{ type: "text" as const, text: "Could not read the roster to check who is asking. Try again." }], isError: true };
      }
      if (visible.length === 0) return "No projects you can reach.";
      return visible
        .map((p) => `${p.id}  ${p.name}${p.kind === "personal" ? "  (personal)" : ""}  ${p.sources.find((s) => s.isDefault)?.path ?? p.sources[0]?.path ?? ""}`)
        .join("\n");
    },
  });

  bb.agents.registerTool({
    name: "cos_roster",
    description:
      "List worker threads managed by the chief of staff with live status. Rows marked [new N] have N finished turns you have not read; cos_read clears the marker. [new N] also covers reports that finished cleanly: a report whose first line is Done, with Need: nothing and no Chief: line, is not sent to you and is read here instead. The header names any workers whose last report carried no disposition word, so you can chase them onto the template. Set includeOtherThreads to also see every other active thread across projects.",
    parameters: z.object({
      project: z.string().optional().describe("Limit to one project (id or name)."),
      includeOtherThreads: z.boolean().optional().describe("Also list unmanaged threads."),
    }),
    presentation: { label: { pending: "Checking the roster", completed: "Checked the roster" } },
    async execute({ project, includeOtherThreads }, { threadId }) {
      let projectId: string | undefined;
      if (project) {
        const found = findProject(await listProjects(), project);
        if (!found) return { content: [{ type: "text", text: `Unknown project "${project}".` }], isError: true };
        projectId = found.id;
      }
      // A manager sees its own team. `includeOthers` is forced off for one:
      // unmanaged threads are not its business and listing them would hand it
      // the roster the scope exists to keep from it.
      const scope = scopeOf(threadId);
      if (scope.kind === "unreadable") {
        return { content: [{ type: "text", text: "Could not read the roster to check who is asking. Try again." }], isError: true };
      }
      const team = scope.kind === "manager" ? { managerId: scope.managerId } : {};
      return rosterText({
        projectId,
        includeOthers: scope.kind === "manager" ? false : (includeOtherThreads ?? false),
        ...team,
      });
    },
  });

  bb.agents.registerTool({
    name: "cos_delegate",
    description:
      "Delegate a task to a worker thread in a project. Reuses the worker with that name if it exists (keeps its context); a name the project does not have is an error unless spawn is true. Returns immediately unless wait is true.",
    parameters: z.object({
      project: z.string().describe("Project id, name, or 'personal'."),
      worker: z.string().describe("Worker name, by topic (e.g. 'billing-refactor'). Reused across tasks."),
      message: z.string().min(1).describe("The full brief: goal, constraints, definition of done, what to report."),
      description: z.string().optional().describe("One line. On a new worker it is the topic; on an existing one it is recorded as the last task and the topic is left alone (cos_adopt with a description changes a topic)."),
      wait: z.boolean().optional().describe("Block until the worker is idle and return its last message."),
      timeoutSeconds: z.number().int().positive().max(3600).optional().describe(WAIT_TIMEOUT_DESCRIPTION),
      providerId: z.string().optional().describe("Pin a NEW worker to this bb provider (e.g. claude-code). Default: the plugin's workerProviderId setting. Ignored when the worker already exists."),
      model: z.string().optional().describe("Pin a NEW worker to this model id. Default: the plugin's workerModel setting. Pass one only when the user named the model in their own words."),
      reasoningLevel: z
        .enum(WORKER_REASONING_LEVELS)
        .optional()
        .describe(
          "Reasoning level (low, medium, high, xhigh, ultracode, max). On a NEW worker it pins the thread; on an existing one it applies to THIS TURN ONLY and evaporates afterwards, so use cos_relevel to change what a worker actually runs at. Leave it unset and the default applies: the workerReasoningLevel setting, or a lower level the plugin picks for some models. Use low for routine legwork. Pass xhigh only when you have decided this particular task needs it, not because of what the worker is.",
        ),
      spawn: z.boolean().optional().describe("Create the worker when the project has no worker by that name. Default false, so a mistyped name is an error instead of a new thread."),
      fanoutHint: z.boolean().optional().describe("Tell the worker this brief has independent parts and to run two or three omp subagents (task and scout) in parallel rather than working them in sequence. Set it when you can name the parts; a hint on indivisible work just spends tokens."),
    }),
    presentation: { label: { pending: "Delegating to a worker", completed: "Delegated to a worker" } },
    async execute(input, { signal, threadId }) {
      const result = await delegate({ ...input, scope: scopeOf(threadId), signal, senderThreadId: threadId, deadlineAt: toolDeadline() });
      // A refusal is `threadId: null` (what `importSessions` checks) and goes
      // back as an error, so a caller that reads the result shape rather than
      // the prose does not take a refusal for a dispatch: unknown project,
      // unknown worker without --spawn, a scope refusal, a rate-limited
      // worker, a failed spawn.
      return result.threadId === null
        ? { content: [{ type: "text" as const, text: result.text }], isError: true }
        : result.text;
    },
  });

  bb.agents.registerTool({
    name: "cos_remodel",
    description:
      "Move a worker to a new thread on another provider and model (default: the plugin's worker provider and model settings). Spawns the new thread in the same project seeded with a handover (CLAUDE.md path, the old thread's conversation, open items), repoints the worker, keeps title and avatar, and archives the old thread only after the new one finishes an orientation turn. The chief thread and the comms chief are never remodelled. Use dryRun first.",
    parameters: z.object({
      worker: z.string().optional().describe("Worker reference: name, project:name, worker id, or thr_ id. Omit with all=true."),
      all: z.boolean().optional().describe("Remodel every live worker that is not already on the target."),
      project: z.string().optional().describe("Project hint when the name is ambiguous."),
      providerId: z.string().optional().describe("Target provider (default: the workerProviderId setting)."),
      model: z.string().optional().describe("Target model (default: the workerModel setting)."),
      reasoningLevel: z
        .enum(WORKER_REASONING_LEVELS)
        .optional()
        .describe(
          "Reasoning level for the new thread (low, medium, high, xhigh, ultracode, max). Left unset, the level follows the model: a move inside one model family keeps the worker's own level, and a move across families is remapped to the target family's usual level. Pass it here only to override that.",
        ),
      dryRun: z.boolean().optional().describe("List what would change without doing anything."),
    }),
    presentation: { label: { pending: "Remodelling a worker", completed: "Remodelled a worker" } },
    async execute({ worker, all, project, providerId, model, reasoningLevel, dryRun }, { signal, threadId }) {
      if (!worker && !all) return { content: [{ type: "text", text: "Give a worker reference or all=true." }], isError: true };
      const result = await remodel({ scope: scopeOf(threadId), ref: all ? null : worker!, project, providerId, model, reasoningLevel, dryRun: dryRun === true, signal, deadlineAt: toolDeadline(), callerThreadId: threadId });
      return result.ok ? result.text : { content: [{ type: "text", text: result.text }], isError: true };
    },
  });

  bb.agents.registerTool({
    name: "cos_move",
    description:
      "Move a worker to another project. Only the roster row moves: bb threads cannot change project, so the worker's thread stays where it is until the next cos_remodel spawns its replacement in the new project.",
    parameters: z.object({
      worker: z.string().describe("Worker reference: name, project:name, worker id, or thr_ id."),
      project: z.string().describe("Target project id, name, or 'personal'."),
      projectHint: z.string().optional().describe("Current-project hint when the name is ambiguous."),
    }),
    presentation: { label: { pending: "Moving a worker", completed: "Moved a worker" } },
    async execute({ worker, project, projectHint }, { threadId }) {
      const result = await moveWorker(scopeOf(threadId), worker, project, projectHint);
      return result.ok ? result.text : { content: [{ type: "text", text: result.text }], isError: true };
    },
  });

  bb.agents.registerTool({
    name: "cos_brand",
    description:
      "Set a worker thread's human title and unique avatar. Runs automatically on spawn and adopt; call it only to rename (title) or to brand a worker that has no avatar yet.",
    parameters: z.object({
      worker: z.string().describe("Worker reference: name, project:name, worker id, or thr_ id."),
      title: z.string().optional().describe("Override the title. Convention: a one or two word role in Title Case."),
      project: z.string().optional().describe("Project hint when the name is ambiguous."),
    }),
    presentation: { label: { pending: "Branding a worker", completed: "Branded a worker" } },
    async execute({ worker, title, project }, { threadId }) {
      const result = await brandRef(scopeOf(threadId), worker, { title, force: title !== undefined, project });
      return result.ok ? result.text : { content: [{ type: "text", text: result.text }], isError: true };
    },
  });

  bb.agents.registerTool({
    name: "cos_read",
    description: "Read a worker's current status and last message. Worker ref: name, project:name, worker id, or thr_ id.",
    parameters: z.object({
      worker: z.string(),
      project: z.string().optional(),
    }),
    presentation: { label: { pending: "Reading worker output", completed: "Read worker output" } },
    async execute({ worker, project }, { threadId }) {
      return readWorker(scopeOf(threadId), worker, project);
    },
  });

  bb.agents.registerTool({
    name: "cos_wait",
    description: "Wait until a worker is idle and return its last message.",
    parameters: z.object({
      worker: z.string(),
      project: z.string().optional(),
      timeoutSeconds: z.number().int().positive().max(3600).optional().describe(WAIT_TIMEOUT_DESCRIPTION),
    }),
    presentation: { label: { pending: "Waiting for a worker", completed: "Worker finished" } },
    async execute({ worker, project, timeoutSeconds }, { signal, threadId }) {
      const deadlineAt = toolDeadline();
      const resolved = resolveInScope(store, await listProjects(), worker, scopeOf(threadId), project);
      if (!resolved.ok) return { content: [{ type: "text", text: resolved.error }], isError: true };
      return waitForWorker(resolved.worker, timeoutSeconds ?? 600, signal, threadId ?? null, deadlineAt);
    },
  });

  bb.agents.registerTool({
    name: "cos_steer",
    description:
      "Interrupt a worker's running turn with a correction, instead of waiting for it to finish work you already know is wrong. cos_delegate queues behind the current turn; this one reaches it mid-flight. An idle worker takes it as an ordinary message. Worker ref: name, project:name, worker id, or thr_ id.",
    parameters: z.object({
      worker: z.string(),
      message: z.string().min(1).describe("The correction, in the same voice as a brief."),
      project: z.string().optional(),
    }),
    presentation: { label: { pending: "Steering a worker", completed: "Steered a worker" } },
    async execute({ worker, message, project }, { threadId }) {
      const result = await steerWorker(scopeOf(threadId), worker, message, project, threadId);
      return result.ok ? result.text : { content: [{ type: "text", text: result.text }], isError: true };
    },
  });

  bb.agents.registerTool({
    name: "cos_stop",
    description:
      "Stop a worker's current turn and keep the worker, its thread and its context. Use it for runaway or misaimed work; retire is for a topic that is closed. Pass brief to send the replacement instructions once the turn has stopped.",
    parameters: z.object({
      worker: z.string(),
      project: z.string().optional(),
      brief: z.string().optional().describe("What the worker should do instead. Sent after the stop."),
    }),
    presentation: { label: { pending: "Stopping a turn", completed: "Stopped a turn" } },
    async execute({ worker, project, brief }, { threadId }) {
      const result = await stopWorker(scopeOf(threadId), worker, project, brief, threadId);
      return result.ok ? result.text : { content: [{ type: "text", text: result.text }], isError: true };
    },
  });

  bb.agents.registerTool({
    name: "cos_retry",
    description:
      "Re-send the last brief you gave a worker, without retyping it. On a 429 or an exhausted pool, check cos_usage and wait for the window it reports rather than retrying. Pass model only when the user named the model in their own words; the reasoning level then follows the model for that one turn.",
    parameters: z.object({
      worker: z.string(),
      project: z.string().optional(),
      model: z.string().optional().describe("Run this one turn on another model id. The thread's pinned model is unchanged."),
    }),
    presentation: { label: { pending: "Retrying a brief", completed: "Retried a brief" } },
    async execute({ worker, project, model }, { threadId }) {
      const result = await retryWorker(scopeOf(threadId), worker, project, model, threadId);
      return result.ok ? result.text : { content: [{ type: "text", text: result.text }], isError: true };
    },
  });

  bb.agents.registerTool({
    name: "cos_fanout",
    description:
      "Dispatch several briefs at once, one per worker, in parallel. Use it whenever a job splits into independent parts: sequential cos_delegate calls make the work serial for no reason. Workers are reused by name; a name the project does not have is an error unless that task sets spawn. With waitAll, the call returns when the slowest leg is done.",
    parameters: z.object({
      tasks: z
        .array(
          z.object({
            project: z.string(),
            worker: z.string(),
            message: z.string().min(1),
            description: z.string().optional(),
            model: z.string().optional(),
            providerId: z.string().optional(),
            reasoningLevel: z
              .enum(WORKER_REASONING_LEVELS)
              .optional()
              .describe(
                "Leave unset unless this particular task needs a different level. The default applies otherwise: the workerReasoningLevel setting, or a lower level the plugin picks for some models.",
              ),
            spawn: z.boolean().optional(),
            fanoutHint: z.boolean().optional().describe("This leg has independent parts; tell the worker to run them as parallel omp subagents (task and scout)."),
          }),
        )
        .min(1)
        .max(12),
      waitAll: z.boolean().optional().describe("Block until every worker is idle and return all their last messages."),
      timeoutSeconds: z.number().int().positive().max(3600).optional().describe(`Per leg. ${WAIT_TIMEOUT_DESCRIPTION}`),
    }),
    presentation: { label: { pending: "Dispatching briefs", completed: "Dispatched briefs" } },
    async execute({ tasks, waitAll, timeoutSeconds }, { signal, threadId }) {
      return fanout(scopeOf(threadId), tasks, waitAll === true, timeoutSeconds ?? 600, signal, threadId, toolDeadline());
    },
  });

  /**
   * Set a worker's reasoning level so it stays set.
   *
   * The durable place is the bb thread's own `reasoning_level_override`.
   * bb's composer picker does not write it: the picker's level applies only to
   * the turns the user sends from that composer, so a turn started by any
   * other route runs at the stored override. Everything the plugin
   * dispatches, and every message from another thread, is such a route.
   */
  async function relevelWorker(
    scope: Scope,
    ref: string,
    level: ReasoningLevel,
    projectHint?: string,
  ): Promise<{ ok: boolean; text: string }> {
    const projects = await listProjects();
    const resolved = resolveInScope(store, projects, ref, scope, projectHint);
    if (!resolved.ok) return { ok: false, text: resolved.error };
    const { worker } = resolved;
    const before = (await workerExecution(worker.threadId)).reasoningLevel;
    if (before === level) {
      return { ok: true, text: `${worker.name} is already on ${level}.` };
    }
    try {
      await bb.sdk.threads.update({ threadId: worker.threadId, reasoningLevel: level });
    } catch (error) {
      return { ok: false, text: `Could not set ${worker.name} to ${level}: ${String(error)}` };
    }
    // Nothing to mirror: the level lives on the thread and has just been set there.
    record("remodel", {
      workerName: worker.name,
      threadId: worker.threadId,
      excerpt: `Reasoning level ${before ?? "unset"} -> ${level}`,
    });
    changed();
    return {
      ok: true,
      text: `${worker.name} now runs at ${level} (was ${before ?? "unset"}). This is the thread's own override, so it holds for every turn, not just the next one.`,
    };
  }

  bb.agents.registerTool({
    name: "cos_relevel",
    description:
      "Change a worker's reasoning level and make it stick. Use this rather than asking the user to change it in the composer picker: the picker applies to the turns the user sends from it and does not move the thread's stored level, so anything you or another thread dispatch still runs at the old one. Does not touch the model or start a turn.",
    parameters: z.object({
      worker: z.string().min(1).describe("Worker name, project:name, worker id, or thread id."),
      level: z.enum(WORKER_REASONING_LEVELS).describe("low, medium, high, xhigh, ultracode, or max. This is the STORED level: it holds for every turn until it is changed again, unlike the composer picker."),
      project: z.string().optional().describe("Constrain the lookup to one project."),
    }),
    presentation: { label: { pending: "Setting a reasoning level", completed: "Set a reasoning level" } },
    async execute({ worker, level, project }, { threadId }) {
      const result = await relevelWorker(scopeOf(threadId), worker, level, project);
      return result.ok ? result.text : { content: [{ type: "text" as const, text: result.text }], isError: true };
    },
  });

  bb.agents.registerTool({
    name: "cos_board_add",
    description:
      "Put one item on the user's decision board (the 'For you' tab). Use it for anything you want the user to decide, approve or read, instead of leaving it in the chat where it scrolls away. Write the headline as one imperative line and the context in your own two or three sentences, not as a worker quote. Nothing else ever lands on this board, so an item you do not add is an item the user will not see.",
    parameters: z.object({
      headline: z.string().min(1).describe("The ask itself, one line, imperative."),
      context: z.string().optional().describe("Your own two or three sentences: why it matters and what happens either way."),
      area: z.enum(BOARD_AREAS).describe("clients, consulting, or operations."),
      links: z
        .array(z.object({ label: z.string().min(1), href: z.string().min(1) }))
        .optional()
        .describe("Files, threads or URLs the user may want open while deciding."),
      // Required, not optional: an optional provenance field (like `links`)
      // tends to stay empty. "none" is the way to say there is no
      // source, which is a different answer from forgetting to say.
      from: z
        .string()
        .min(1)
        .describe("Where this came from: a worker name (e.g. \"copy-editor\", and the row then links straight to its thread), free words (\"your inbox\", \"an email\", \"my own read of the calendar\"), or the literal \"none\"."),
      priority: z
        .enum(BOARD_PRIORITIES)
        .describe("How soon the user has to deal with it. \"now\" = today or it costs something; \"soon\" = this week; \"whenever\" = no clock on it. Be honest: a list where everything is \"now\" is a list nobody can prioritise."),
      choices: z
        .array(z.object({ label: z.string().min(1).max(60) }))
        .max(4)
        .optional()
        .describe("Two to four things the user could decide, each under about 40 characters, e.g. [{label:\"Move the launch a week\"},{label:\"Ship without the export\"}]. They appear as words on the row and tapping one writes it into your composer as the user's decision. Give them whenever the item is a choice rather than a task."),
      expires: z
        .string()
        .optional()
        .describe("The day (YYYY-MM-DD) of the call, demo or workshop the item is about; it closes itself the day after. Never for a deadline: a task that is late has not gone away."),
    }),
    presentation: { label: { pending: "Adding a board item", completed: "Added a board item" } },
    execute({ headline, context, area, links, from, priority, choices, expires }) {
      const expiry = parseBoardExpiry(expires);
      if (!expiry.ok) return { content: [{ type: "text" as const, text: expiry.text }], isError: true };
      const item = boardAdd({ headline, context, area, links, from, priority, choices, expiresAt: expiry.at });
      return `Added to ${BOARD_PRIORITY_LABEL[item.priority]} / ${BOARD_AREA_LABEL[item.area]} on the user's board. Item id ${item.id}.${boardExpiryHint(item)}`;
    },
  });

  bb.agents.registerTool({
    name: "cos_board_list",
    description:
      "What is on the user's decision board right now, by area, newest first. An item marked 'in your draft' is in the composer but not sent; 'addressed' means the user actually sent a message about it and it is waiting for you to resolve.",
    parameters: z.object({
      area: z.enum(BOARD_AREAS).optional(),
      all: z.boolean().optional().describe("Include resolved and dismissed items too."),
    }),
    presentation: { label: { pending: "Reading the board", completed: "Read the board" } },
    execute({ area, all }) {
      const states = all === true ? (["open", "addressed", "resolved", "dismissed"] as const) : undefined;
      return boardText(boardList(states, area));
    },
  });

  bb.agents.registerTool({
    name: "cos_board_update",
    description:
      "Change how urgent an item on the user's list is, or what choices it offers. Use it when your first call was wrong, when something became urgent, or when you have worked out what the user's actual options are. The list is drawn in priority bands, so an item at the wrong level is one that gets sorted past.",
    parameters: z.object({
      id: z.string().min(1).describe("Item id from cos_board_list."),
      priority: z.enum(BOARD_PRIORITIES).optional().describe("now, soon, or whenever."),
      choices: z
        .array(z.object({ label: z.string().min(1).max(60) }))
        .max(4)
        .optional()
        .describe("Replaces the choices entirely. Pass [] to remove them."),
      expires: z
        .string()
        .optional()
        .describe("The event's day (YYYY-MM-DD): the item closes itself the day after. \"none\" takes it off."),
    }),
    presentation: { label: { pending: "Updating a board item", completed: "Updated a board item" } },
    execute({ id, priority, choices, expires }, { threadId }) {
      const result = boardUpdate(id, { priority, choices, expires }, moverFromThread(threadId ?? null, "tool"));
      return result.ok ? result.text : { content: [{ type: "text" as const, text: result.text }], isError: true };
    },
  });

  bb.agents.registerTool({
    name: "cos_board_resolve",
    description:
      "Close board items once the work behind them is actually done, or dismiss ones that stopped mattering, or put a dismissed item back. Nothing leaves the board on its own: an item the user sent you a message about is only marked 'addressed' and still waits for you here.",
    parameters: z.object({
      ids: z.array(z.string().min(1)).min(1).describe("Item ids from cos_board_list."),
      state: z.enum(["resolved", "dismissed", "open"]).describe("resolved when the work is done, dismissed when it stopped mattering, open to put one back."),
      note: z.string().optional().describe("One line on why, kept with the item."),
    }),
    presentation: { label: { pending: "Updating the board", completed: "Updated the board" } },
    execute({ ids, state, note }) {
      const result = boardSetState(ids, state, note, { kind: "chief", how: "tool" });
      return result.ok ? result.text : { content: [{ type: "text" as const, text: result.text }], isError: true };
    },
  });

  bb.agents.registerTool({
    name: "cos_decisions",
    description:
      "List every worker stopped on a permission prompt or a question. Such a worker is not idle and never reports a finished turn, so it looks silent rather than blocked. Answer one with cos_answer.",
    parameters: z.object({}),
    presentation: { label: { pending: "Checking blocked workers", completed: "Checked blocked workers" } },
    async execute(_input, { threadId }) {
      return listDecisions(scopeOf(threadId));
    },
  });

  bb.agents.registerTool({
    name: "cos_answer",
    description:
      "Answer the prompt a worker is stopped on so its turn continues. allow / allow-session / deny for a permission prompt, answer with the text for a question. Only answer what you are competent to decide; anything that commits the user goes to the user first.",
    parameters: z.object({
      worker: z.string(),
      decision: z.enum(["allow", "allow-session", "deny", "answer"]),
      answer: z.string().optional().describe("The answer text, required when decision is 'answer'."),
      project: z.string().optional(),
    }),
    presentation: { label: { pending: "Answering for a worker", completed: "Answered for a worker" } },
    async execute({ worker, decision, answer, project }, { threadId }) {
      const result = await answerDecision(scopeOf(threadId), worker, decision, answer, project);
      return result.ok ? result.text : { content: [{ type: "text", text: result.text }], isError: true };
    },
  });

  bb.agents.registerTool({
    name: "cos_usage",
    description:
      "How much plan quota each ACCOUNT has left, with the one the proxy is actually using marked [in use]. Check it before a fan-out or a long job. Only the in-use account can refuse a worker turn: the others are routinely at 100% and mean nothing until the proxy switches to one. The fix for an exhausted in-use account is to wait for the window it names, or to delegate on another model.",
    parameters: z.object({}),
    presentation: { label: { pending: "Checking quota", completed: "Checked quota" } },
    async execute() {
      return usageReport();
    },
  });

  bb.agents.registerTool({
    name: "cos_adopt",
    description: "Register an existing thread as a managed worker so it can be reused by name.",
    parameters: z.object({
      threadId: z.string().startsWith("thr_"),
      name: z.string().min(1),
      description: z.string().optional(),
    }),
    presentation: { label: { pending: "Adopting a thread", completed: "Adopted a thread" } },
    async execute({ threadId, name, description }) {
      const result = await adopt(threadId, name, description);
      return result.text;
    },
  });

  bb.agents.registerTool({
    name: "cos_retire",
    description: "Retire a worker whose topic is closed: stops and archives its thread. Retiring a MANAGER that still has a team needs `reassign`, and never retires the team itself.",
    parameters: z.object({
      worker: z.string(),
      project: z.string().optional(),
      reassign: z.string().optional().describe("Required when the worker is a manager with a live team: 'chief' to move them to you, or another manager's name."),
    }),
    presentation: { label: { pending: "Retiring a worker", completed: "Retired a worker" } },
    async execute({ worker, project, reassign }, { threadId }) {
      return (await retire(scopeOf(threadId), worker, project, reassign)).text;
    },
  });

  bb.agents.registerTool({
    name: "cos_dismiss",
    description:
      "Dismiss a worker's open Need line once it has been answered out of band, so it stops counting as a decision for the user. Each question in it is dismissed under its id: the same question asked again in other words stays dismissed, and a different question comes back on its own. A Need you put on the board is already dismissed, so this changes nothing for it: resolve the board item instead. undo: true restores it. Worker ref: name, project:name, worker id, or thr_ id.",
    parameters: z.object({
      worker: z.string(),
      project: z.string().optional(),
      note: z.string().optional(),
      undo: z.boolean().optional(),
    }),
    presentation: { label: { pending: "Dismissing a need", completed: "Dismissed a need" } },
    async execute({ worker, project, note, undo }, { threadId }) {
      const result = await dismissNeed(scopeOf(threadId), worker, { project, note, undo });
      return result.ok ? result.text : { content: [{ type: "text", text: result.text }], isError: true };
    },
  });

  bb.agents.registerTool({
    name: "cos_sessions",
    description:
      "List the Claude Code sessions running on the bb server machine outside bb (pre-existing terminal sessions). They are not bb threads and cannot be messaged; import one with cos_import_session.",
    parameters: z.object({}),
    presentation: { label: { pending: "Listing Claude sessions", completed: "Listed Claude sessions" } },
    async execute() {
      const { sessions } = await sessionsList();
      return formatSessionsTable(sessions);
    },
  });

  bb.agents.registerTool({
    name: "cos_session_digest",
    description:
      "Read a compact digest of an external Claude Code session transcript: title, session facts, first prompt, compaction summaries, and recent exchanges.",
    parameters: z.object({
      sessionId: z.string().describe("Session id from cos_sessions."),
      maxChars: z.number().int().positive().max(200_000).optional().describe("Digest size budget, default 60000."),
    }),
    presentation: { label: { pending: "Digesting a session", completed: "Digested a session" } },
    async execute({ sessionId, maxChars }) {
      const result = await sessionDigest(sessionId, maxChars);
      if (!result) {
        return { content: [{ type: "text", text: `No transcript found for session ${sessionId}.` }], isError: true };
      }
      // Fenced as well as scrubbed: this is a whole transcript of somebody
      // else's session, and the chief needs to see where it ends.
      return fenceUntrusted(result.digest, { nonce: fenceNonce(), label: "session transcript digest" });
    },
  });

  bb.agents.registerTool({
    name: "cos_import_session",
    description:
      "Import one or more external Claude Code sessions into a bb worker. The worker is spawned (or reused) in the matched project, seeded with the full digests, and asked to write a very detailed handover summary first. Group sessions that share a topic into one worker.",
    parameters: z.object({
      sessionIds: z.array(z.string()).min(1).describe("Session ids from cos_sessions; one topic per import."),
      worker: z.string().min(1).describe("Worker name, by topic."),
      project: z.string().optional().describe("Project id, name, or 'personal'. Default: the project matching the cwd."),
      description: z.string().optional(),
      createProject: z
        .boolean()
        .optional()
        .describe("When no project contains the session cwd, create a bb project from that cwd."),
    }),
    presentation: { label: { pending: "Importing a Claude session", completed: "Imported a Claude session" } },
    async execute(input) {
      const result = await importSessions(input);
      return result.ok ? result.text : { content: [{ type: "text", text: result.text }], isError: true };
    },
  });

  const CHIEF_TOOLS = [
    "cos_projects",
    "cos_roster",
    // The chief curates the "For you" list, so the board tools must be in
    // this array; without them the chief would have to shell out to
    // `bb cos board add`, and a surface nobody is instructed to fill stays empty.
    "cos_board_add",
    "cos_board_list",
    "cos_board_update",
    "cos_board_resolve",
    "cos_delegate",
    "cos_fanout",
    "cos_steer",
    "cos_stop",
    "cos_retry",
    "cos_decisions",
    "cos_answer",
    "cos_usage",
    "cos_brand",
    "cos_remodel",
    "cos_relevel",
    "cos_read",
    "cos_wait",
    "cos_adopt",
    "cos_retire",
    "cos_dismiss",
    "cos_sessions",
    "cos_session_digest",
    "cos_import_session",
    "cos_spawn_manager",
    "cos_assign",
  ];

  /**
   * What a manager gets. Scoped to its own team by the handlers, not by this
   * list: the list is which verbs exist, the scope check is which workers they
   * reach, and a tool allowlist alone is not a boundary while `bb cos` is a
   * second door to the same handlers.
   *
   * `cos_projects` is here on purpose. A
   * manager's team spans projects by design and `cos_delegate` requires a
   * project id or name, so without it a manager can be given a team it cannot
   * address. It is scoped to the projects its own team is in.
   *
   * Deliberately absent: the board tools (only the chief curates), and
   * every verb that would let a manager change who is on its team, which is
   * cos_retire, cos_remodel, cos_adopt, cos_brand, cos_move, cos_spawn_manager
   * and cos_assign.
   */
  const MANAGER_TOOLS = [
    "cos_projects",
    "cos_roster",
    "cos_read",
    "cos_delegate",
    "cos_fanout",
    "cos_steer",
    "cos_stop",
    "cos_retry",
    "cos_relevel",
    "cos_wait",
    "cos_decisions",
    "cos_answer",
    "cos_dismiss",
  ];

  bb.agents.configure((context) => {
    if (context.origin.pluginId === "side-chat") return { tools: [], skills: [] };
    const isChief =
      context.thread.id === chiefThreadId ||
      context.thread.id === remodellingChiefThreadId ||
      (context.origin.pluginId === bb.pluginId &&
        context.thread.title === CHIEF_TITLE &&
        pendingSpawns.get(CHIEF_TITLE)?.kind === "chief");
    if (isChief) {
      return {
        tools: CHIEF_TOOLS,
        skills: ["chief-of-staff"],
        instructions: chiefInstructions(context.thread.id || chiefThreadId) + memorySection("chief", context.environment?.path ?? null),
      };
    }
    // Everything below here reads the roster, and a database read can throw.
    // The chief is decided ABOVE this line from thread ids alone and never
    // reaches the db, which is what stops a bad read presenting as "the chief
    // lost all its tools" rather than as an error.
    try {
      const known = store.byThread(context.thread.id);
      if (known && known.retiredAt === null) {
        if (known.role === "manager") {
          return {
            tools: MANAGER_TOOLS,
            skills: ["cos-manager"],
            instructions: managerInstructions(
              { name: known.name },
              store.team(known.id).map((member) => member.name),
              chiefThreadId,
            ) + memorySection(known.name, context.environment?.path ?? null),
          };
        }
        return {
          tools: [],
          skills: ["cos-worker"],
          instructions: workerInstructions({ name: known.name, projectName: context.project.name }, chiefThreadId),
        };
      }
      const pending = context.thread.title
        ? pendingSpawns.get(spawnKey(context.project.id, context.thread.title))
        : undefined;
      if (pending?.kind === "manager" && context.origin.pluginId === bb.pluginId) {
        // A manager's FIRST turn, before its row is committed (or before a
        // remodel repoints the row). Look up any existing manager row so a
        // remodelled manager receives its real team on turn 1.
        const existing = store.byProjectName(context.project.id, pending.name);
        const team = existing ? store.team(existing.id).map((member) => member.name) : [];
        return {
          tools: MANAGER_TOOLS,
          skills: ["cos-manager"],
          instructions: managerInstructions(pending, team, chiefThreadId) + memorySection(pending.name, context.environment?.path ?? null),
        };
      }
      if (pending?.kind === "worker" && context.origin.pluginId === bb.pluginId) {
        return { tools: [], skills: ["cos-worker"], instructions: workerInstructions(pending, chiefThreadId) };
      }
    } catch (error) {
      // Fail toward FEWER powers, never more. A thread whose row could not be
      // read gets the worker skill and no tools, which is what a plain worker
      // gets anyway; it must never fall through to MANAGER_TOOLS on a failed
      // read, because that would hand a team's controls to a thread nobody
      // could confirm was a manager.
      bb.log.error(`agent config: could not read the roster for ${context.thread.id}: ${String(error)}`);
      return { tools: [], skills: ["cos-worker"] };
    }
    return { tools: [], skills: [] };
  });

  if (bb.providers?.experimental_contributeEnv) {
    for (const providerId of ["acp-omp", "acp-antigravity"] as const) {
      // bb also asks for this when it scans a provider's model catalog, with
      // no thread and no project (threadId and projectId null,
      // `resolveCatalogLaunch`). A null value fails bb's check of the whole
      // list, which drops the two ANTHROPIC_ overrides along with it and shows
      // the plugin's acp-omp provider environment as failed in `bb plugin
      // list`. So the ids go in only when bb has them.
      bb.providers.experimental_contributeEnv(providerId, (context) => [
        ...(context.threadId
          ? [{ name: "BB_THREAD_ID", value: context.threadId, reason: "Expose the thread id to ACP worker shells so bb cos CLI commands resolve scope" }]
          : []),
        ...(context.projectId
          ? [{ name: "BB_PROJECT_ID", value: context.projectId, reason: "Expose the project id to ACP worker shells so bb cos CLI commands resolve project" }]
          : []),
        {
          name: "ANTHROPIC_BASE_URL",
          value: "https://api.anthropic.com",
          reason: "Make ACP providers reach Anthropic directly instead of through an inherited base URL",
        },
        {
          name: "ANTHROPIC_AUTH_TOKEN",
          value: "",
          reason: "Clear an inherited auth token so ACP providers use their own login",
        },
      ]);
    }
  }

  /** The two fields of the automations plugin's `automations_get` this plugin reads. */
  const automationGetSchema = z
    .object({ createdByThreadId: z.string().nullable().optional(), createdAt: z.number().nullable().optional() })
    .passthrough();

  /**
   * Which sidebar rows carry a glyph, resolved. The table lives in `core.ts`;
   * this only feeds it the live roster and turns kinds into glyphs.
   */
  // ---------- the manager tier ----------

  /**
   * Put a worker on a manager's team, or back on the chief's.
   *
   * Chief-only. The invariants are the store's (`assign` refuses nesting,
   * self-management and a non-manager target against rows it reads in that
   * call); this adds the scope check, the names, and the activity row, because
   * a reassignment that leaves no trace is how a team silently changes shape.
   */
  /**
   * Everything a team change means beyond the row itself: the worker's
   * permission mode, and its place in the sidebar.
   *
   * `store.assign` changes who reports to whom and nothing else. Two other
   * things have to follow it at every caller: a caller that skipped them
   * would leave a team in the store and nowhere else, its members flat in
   * the sidebar under the chief and none of them on the manager's permission
   * mode. One function, so no caller can pick up half of it.
   *
   * The mode is copied rather than resolved at dispatch, so the answer does not
   * depend on the manager still being its manager later, and only when the
   * worker has made no choice of its own: an explicit accept-edits on one
   * worker survives being moved between teams. Assigning back to the chief
   * re-parents to the chief rather than clearing the parent, because a
   * parentless worker sits flat rather than under the chief.
   */
  async function applyTeamMove(worker: Worker, manager: Worker | null): Promise<void> {
    if (manager !== null) {
      const own = await storedPermissionMode(worker.threadId);
      if (own === null) {
        const managerMode = await storedPermissionMode(manager.threadId);
        if (managerMode !== null) {
          await bb.storage.kv.set(`${KV_PERMISSION_PREFIX}${worker.threadId}`, managerMode);
        }
      }
    }
    const parent = sidebarParentThread(manager === null ? null : manager.threadId, chiefThreadId);
    // Sidebar fact, not a reporting mode; see the spawn site.
    if (parent === null) return;
    try {
      await linkWorkerThread(worker.threadId, parent);
    } catch (error) {
      // Non-fatal and said out loud: the assignment IS done, and a sidebar that
      // lags is better reported than silently wrong.
      bb.log.warn(`team move: could not re-parent ${worker.name}: ${String(error)}`);
    }
  }

  /**
   * Put a worker or manager thread under `parent`, or leave its parent alone
   * when null, with bb's Notify parent off (`NOTIFY_PARENT_OFF`), in one
   * update. Every parent write of a worker goes through here, so none can move
   * a thread without also silencing bb's own copy of its reports. One update,
   * not two: bb sends the old parent its "no longer a child" message two
   * seconds after a move only while the child is still on auto, and reads the
   * setting when it sends. The "now a child" message to the NEW parent is not
   * covered by the setting at all (bb 0.48.1, `sendThreadOwnershipNotices`).
   * Throws on a failed write; each caller says what it was doing.
   */
  async function linkWorkerThread(threadId: string, parent: string | null): Promise<void> {
    await bb.sdk.threads.update({ threadId, ...(parent === null ? {} : { parentThreadId: parent }), ...NOTIFY_PARENT_OFF });
  }

  async function assignWorker(
    scope: Scope,
    ref: string,
    managerRef: string,
    projectHint?: string,
  ): Promise<{ ok: boolean; text: string }> {
    const gate = refuseUnlessChief(scope, "Assigning a worker to a manager");
    if (gate) return { ok: false, text: gate };
    const projects = await listProjects();
    const resolved = resolveInScope(store, projects, ref, scope, projectHint);
    if (!resolved.ok) return { ok: false, text: resolved.error };
    const worker = resolved.worker;
    const toChief = managerRef.trim().toLowerCase() === "chief";
    let manager: Worker | null = null;
    if (!toChief) {
      const found = resolveInScope(store, projects, managerRef, scope);
      if (!found.ok) {
        // Name the managers that DO exist. Safe here and nowhere else: this
        // path is chief-only, so it is a help rather than the enumeration
        // oracle the same list would be in a refusal a manager can trigger.
        const known = store.managers().map((m) => m.name);
        const hint =
          known.length === 0
            ? " No managers exist yet; create one with cos_spawn_manager."
            : ` Managers: ${known.join(", ")}, or "chief".`;
        return { ok: false, text: `${found.error}${hint}` };
      }
      manager = found.worker;
    }
    const result = store.assign(worker.id, manager === null ? null : manager.id);
    if (!result.ok) return { ok: false, text: result.text };
    await applyTeamMove(worker, manager);
    const where = manager === null ? "the chief" : manager.name;
    record("adopt", {
      workerName: worker.name,
      projectName: projects.find((p) => p.id === worker.projectId)?.name ?? worker.projectId,
      threadId: worker.threadId,
      excerpt: `${worker.name} now reports to ${where}.`,
    });
    return { ok: true, text: `${worker.name} now reports to ${where}.` };
  }

  /**
   * Create a manager and give it a team.
   *
   * Goes through `delegate` with `role: "manager"` rather than spawning its
   * own thread, so it inherits the per-name spawn lock, the two-call level and
   * model pin, `brand`, and the exhausted-pool message. Its first turn gets
   * MANAGER_TOOLS and the cos-manager skill via `pendingSpawns`.
   *
   * The team is assigned AFTER the spawn, and a member that cannot be assigned
   * is reported rather than skipped: a manager that silently came up with only
   * part of its team would look right and be wrong.
   */
  async function spawnManager(
    scope: Scope,
    name: string,
    team: string[],
    project?: string,
    /** The thread that asked. Null from a bare terminal, where the chief is the right sender. */
    callerThreadId: string | null = null,
  ): Promise<{ ok: boolean; text: string }> {
    const gate = refuseUnlessChief(scope, "Creating a manager");
    if (gate) return { ok: false, text: gate };
    const projects = await listProjects();
    // Hoisted: chiefThreadId is a mutable closure variable, so it does not
    // narrow inside the arrow below.
    const chiefId = chiefThreadId;
    const chiefProjectId = chiefId === null ? null : (store.byThread(chiefId)?.projectId ?? null);
    const home =
      (project ? findProject(projects, project) : null) ??
      (chiefProjectId === null ? null : (projects.find((p) => p.id === chiefProjectId) ?? null)) ??
      null;
    if (!home) {
      return { ok: false, text: "Could not work out which project to create the manager in. Pass one." };
    }
    // Resolved BEFORE the spawn, so a mistyped team member does not leave a
    // manager thread behind with nobody on it.
    const members: Worker[] = [];
    for (const ref of team) {
      const found = resolveInScope(store, projects, ref, scope);
      if (!found.ok) return { ok: false, text: `${found.error} No manager was created.` };
      if (found.worker.role === "manager") {
        return { ok: false, text: `${found.worker.name} is a manager; the tier is one level deep. No manager was created.` };
      }
      members.push(found.worker);
    }
    const roster =
      members.length === 0
        ? "You have no team yet. The chief will assign one; do not take work on yourself until it does."
        : `Your team is ${members.map((m) => m.name).join(", ")}. Run cos_roster for their projects.`;
    const brief = [
      `You are ${name}, a manager in the Chief of Staff plugin. ${roster}`,
      "",
      "This first turn is orientation, not work. Read your cos-manager skill, run cos_roster, and reply with the report it describes: the disposition word, a Team: line, any verbatim Decision/Blocked/Changed-plan lines, and a Judgement: sentence only if it adds something the chief cannot read off those lines. Do not dispatch anything yet.",
    ].join("\n");
    const spawned = await delegate({
      scope,
      project: home.id,
      worker: name,
      message: brief,
      description: `Manager of ${members.length} worker${members.length === 1 ? "" : "s"}`,
      spawn: true,
      role: "manager",
      // THE SENDER. A spawn's first turn carries no senderThreadId in bb's
      // event log, so `last_dispatch_by` is the only thing that can tell the
      // router who asked for it; without the sender that row would be NULL,
      // `turnOrigin` would report "somebody else started this", and the chief
      // would get the abbreviated note instead of the Team: line the whole
      // tier exists to deliver.
      //
      // The chief's own thread when a bare terminal ran the spawn: a manager
      // reports to the chief by definition (`manager_id` is null), so the chief
      // is the audience either way, and this makes the row say so.
      senderThreadId: callerThreadId ?? chiefThreadId,
    });
    if (spawned.threadId === null) return { ok: false, text: spawned.text };
    const created = store.byThread(spawned.threadId);
    if (!created) return { ok: false, text: `Manager ${name} was spawned but its row could not be read back.` };
    const failures: string[] = [];
    for (const member of members) {
      const result = store.assign(member.id, created.id);
      if (!result.ok) {
        failures.push(`${member.name}: ${result.text}`);
        continue;
      }
      // The sidebar and the permission mode, the same as cos_assign, so the
      // team is not in the store only.
      await applyTeamMove(member, created);
    }
    const lines = [`Manager ${name} created on thread ${created.threadId}.`];
    if (members.length > 0) {
      lines.push(`Team: ${store.team(created.id).map((w) => w.name).join(", ") || "(none assigned)"}`);
    }
    if (failures.length > 0) {
      lines.push(`Could not assign ${failures.length}: ${failures.join("; ")}`);
    }
    return { ok: failures.length === 0, text: lines.join("\n") };
  }

  /**
   * The status glyphs the sidebar should be painting right now.
   *
   * Fed from the same `WorkerStatus[]` the roster RPC returns rather than from
   * the worker rows: `failed`, `lastNeed`, `needAudience`, `needDismissed` and
   * `urgency` are all live facts computed there against the thread, and a
   * second derivation here would be a second answer to the same question.
   */
  /** When the "finished, not read" dot started; older unread reports are not news. */
  const KV_FINISHED_SINCE = "sidebar.finishedSince";

  /**
   * The sidebar polls every 5 seconds while a worker works, once per open
   * window, so the marks are shared for a few seconds between callers.
   */
  let threadMarksEpoch = 0;
  const currentThreadMarks = shortMemo((_: undefined) => buildThreadMarks(), () => String(threadMarksEpoch), THREAD_MARKS_TTL_MS);

  async function buildThreadMarks(): Promise<{ marks: ThreadStatusMark[]; faces: SidebarFace[] }> {
    const current = await settings.get();
    if (current.threadMarks !== "on") return { marks: [], faces: [] };
    const roster = await rosterStatus({ includeOthers: false, skipExecution: true });
    // bb's own last-read time per thread, so a finished mark clears when the
    // user opens the worker. The same memoized list the roster just read; a thread
    // it misses (archived) counts as read, because an archived worker is not
    // waiting to be read.
    // A failed list is not "everything read": it throws, the RPC fails, and
    // the sidebar keeps what it has painted rather than clearing every dot.
    const readAt = new Map<string, number | null>();
    for (const thread of await liveThreads(undefined)) {
      readAt.set(thread.id, (thread as { lastReadAt?: number | null }).lastReadAt ?? null);
    }
    // Stamped once, the first time the marks are built with the finished dot.
    let since = await bb.storage.kv.get<number>(KV_FINISHED_SINCE);
    if (typeof since !== "number") {
      since = Date.now();
      await bb.storage.kv.set(KV_FINISHED_SINCE, since);
    }
    const workers = roster.workers.map((worker) => ({
      ...worker,
      finishedSince: since,
      // Unknown read time: no finished mark, rather than one that never clears.
      readAt: readAt.has(worker.threadId) ? (readAt.get(worker.threadId) ?? null) : Number.MAX_SAFE_INTEGER,
    }));
    return { marks: threadStatusMarks(workers), faces: current.sidebarFaces === "on" ? sidebarFaces(roster.workers) : [] };
  }

  // ---------- thread lifecycle ----------

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    try {
      const worker = store.byThread(thread.id);
      if (worker && worker.retiredAt === null) {
        store.clearTurnStarted(worker.id);
        changed();
        // A compaction's own turn end, the overnight pass's or one anybody
        // typed: its idle text is the previous report, owed to nobody.
        if (await turnEndedOnCompaction(thread.id)) return;
        if (!(await turnProducedOutput(thread.id))) return;
        // Some bridges end a refused turn as an idle message carrying the error.
        // A long report that quotes a 429 is still a report, so only the tail of
        // a long message is tested: that is where a refusal lands.
        const refusal = lastAssistantText === null ? null : lastAssistantText.slice(-RATE_LIMIT_TAIL_CHARS);
        if (refusal !== null && (await handleRateLimit(worker, refusal))) return;
        const reportKind = isRawProviderError(lastAssistantText) ? "failed" : "idle";
        await reportMerged(worker, reportKind, lastAssistantText);
      } else if (thread.id === chiefThreadId) {
        changed();
        if (isRawProviderError(lastAssistantText)) {
          record("chief-failed", { threadId: chiefThreadId, excerpt: lastAssistantText ?? "unknown error" });
        } else {
          // The chief just finished a turn, so anything the outbox could not
          // deliver while it was busy goes in now.
          await drainChiefOutboxOnce();
        }
      }
    } catch (error) {
      bb.log.warn(`thread.idle handler for ${thread.id}: ${String(error)}`);
    } finally {
      // Reports held for this thread while it was mid-turn, merged into one.
      // After this thread's own report above, so the order stays turn, then reports.
      await drainHeldFor(thread.id);
    }
  });
  bb.events.on("thread.failed", async ({ thread, error }) => {
    try {
      const worker = store.byThread(thread.id);
      if (worker && worker.retiredAt === null) {
        store.clearTurnStarted(worker.id);
        changed();
        const detail = await turnFailureText(thread.id, error);
        if (await handleRateLimit(worker, detail)) return;
        await reportMerged(worker, "failed", detail);
      } else if (thread.id === chiefThreadId) {
        // A chief turn that dies is the loudest thing on the board, so it gets
        // a row. Its own kind, not "failed":
        // "failed" is a worker report, so it would count as a report in
        // latestActivityAt (which filters to report/failed) and open a worker tab
        // for a thread that has no worker.
        // The report body is not re-sent; it is already durable in the chief's
        // transcript, and re-submitting on a cooling-down 429 is an append loop.
        changed();
        record("chief-failed", { threadId: chiefThreadId, excerpt: (await turnFailureText(thread.id, error)) ?? "unknown error" });
      }
    } catch (handlerError) {
      bb.log.warn(`thread.failed handler for ${thread.id}: ${String(handlerError)}`);
    } finally {
      // A requester whose turn failed still gets what was held for it. Not the
      // chief: a failed chief's parked messages wait for Restart.
      if (thread.id !== chiefThreadId) await drainHeldFor(thread.id);
    }
  });

  // One sweep does both time-based chores: lifted rate limits get their one
  // re-send, and chief messages that could not be delivered are retried.
  // ---------- overnight compaction ----------

  /**
   * One thread as the overnight rules see it: its context reading, runtime
   * status, queued work and when the user last typed in it. Null when bb does
   * not have the thread or it is archived, so it is never compacted.
   */
  async function compactionCandidate(threadId: string, name: string): Promise<CompactionCandidate | null> {
    // The list, not `threads.get`: only a listed thread carries `queuedWork`.
    // Read past the 1s memo on purpose, since this is the read right before
    // acting. A failed read throws, and the caller skips the thread.
    const listed = await bb.sdk.threads.list({ archived: false, includeHidden: true, limit: 500 });
    const thread = listed.find((t) => t.id === threadId);
    if (thread === undefined) return null;
    const context = await contextUsage(threadId);
    return {
      threadId,
      name,
      usedTokens: context.used,
      contextWindow: context.window,
      displayStatus: thread.runtime.displayStatus,
      queuedWork: thread.queuedWork,
      lastTypedByOwnerAt: await lastTypedByOwnerAt(threadId),
    };
  }

  /**
   * When the user last typed a turn in a thread, from its recent turn requests:
   * see `lastTypedAt`. A read that fails answers "just now", so the thread is
   * skipped rather than compacted on a guess.
   */
  async function lastTypedByOwnerAt(threadId: string): Promise<number | null> {
    try {
      const rows = (await bb.sdk.threads.events.list({
        threadId,
        types: ["client/turn/requested"],
        order: "desc",
        limit: "30",
      })) as unknown as TurnRequestRow[];
      return lastTypedAt(rows);
    } catch {
      return Date.now();
    }
  }

  /** How long to wait for one compaction to finish before moving on. */
  const COMPACT_WAIT_MS = 10 * 60_000;

  /**
   * Was the thread's newest turn request a `/compact`? Checked rather than
   * assumed, so a brief that was queued behind the compaction and ran straight
   * after it still reports. A failed read answers no: a duplicate report is
   * visible, a lost one is not.
   */
  /**
   * Whether the turn that just ended was a compaction (`endedOnCompaction`). A
   * failed read answers false, so the report is routed: a duplicate is
   * visible, a lost report is not.
   */
  async function turnEndedOnCompaction(threadId: string): Promise<boolean> {
    try {
      const rows = await bb.sdk.threads.events.list({
        threadId,
        types: ["client/turn/requested", "thread/compacted"],
        order: "desc",
        limit: "10",
      });
      return endedOnCompaction(rows as unknown as CompactionEvent[]);
    } catch {
      return false;
    }
  }

  async function turnProducedOutput(threadId: string): Promise<boolean> {
    try {
      const rows = await bb.sdk.threads.events.list({
        threadId,
        types: ["turn/started", "turn/completed", "item/completed"],
        order: "desc",
        limit: "80",
      });
      return turnProducedAgentMessage(rows as unknown as TurnOriginEvent[]);
    } catch {
      return true;
    }
  }

  /** The newest event's sequence number on a thread, so a wait sees only what comes after. */
  async function newestSeq(threadId: string): Promise<string | null> {
    const rows = await bb.sdk.threads.events.list({
      threadId,
      order: "desc",
      limit: "1",
    });
    return rows[0] === undefined ? null : String(rows[0].seq);
  }

  /**
   * Wait for the compaction turn to END, not for "idle": right after the
   * request the thread may still read idle, and the next compaction would
   * start beside this one.
   */
  async function waitForTurnEnd(threadId: string, afterSeq: string | null, deadline: number): Promise<boolean> {
    while (Date.now() < deadline) {
      const waitMs = Math.min(55_000, deadline - Date.now());
      const row = await bb.sdk.threads.events.wait({
        threadId,
        type: "turn/completed",
        waitMs: String(Math.max(1, waitMs)),
        ...(afterSeq === null ? {} : { afterSeq }),
      });
      if (row !== null) return true;
    }
    return false;
  }

  /**
   * One overnight pass over the chief and every live worker, managers included
   * Compacts what `compactionDecision` allows, ONE AT A
   * TIME: each thread is read fresh right before it is compacted, because a
   * pass can take a while and the user may have started typing meanwhile, and the
   * next one starts only after this one's turn has ended. Each compaction, and
   * each one that failed, is a row in Activity.
   */
  async function compactIdleThreads(
    opts: { only?: ReadonlySet<string>; dryRun?: boolean; atPercent?: number } = {},
  ): Promise<{ compacted: string[]; skipped: { name: string; reason: string }[] }> {
    const only = opts.only;
    const roster = await rosterStatus({ includeOthers: false, skipExecution: true });
    const targets: { threadId: string; name: string }[] = [
      ...(chiefThreadId ? [{ threadId: chiefThreadId, name: "chief" }] : []),
      ...roster.workers.filter((w) => !w.retired && !w.missing).map((w) => ({ threadId: w.threadId, name: w.name })),
    ].filter((t) => only === undefined || only.has(t.threadId));
    const compacted: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const target of targets) {
      const candidate = await compactionCandidate(target.threadId, target.name).catch(() => null);
      if (candidate === null) {
        skipped.push({ name: target.name, reason: "could not read it, or it is archived" });
        continue;
      }
      const decision = compactionDecision(candidate, Date.now(), opts.atPercent);
      if (!decision.compact) {
        skipped.push({ name: target.name, reason: decision.reason });
        continue;
      }
      if (opts.dryRun === true) {
        compacted.push(`${target.name} (ctx ${decision.percent}%)`);
        continue;
      }
      const workerName = target.name === "chief" ? null : target.name;
      try {
        const afterSeq = await newestSeq(target.threadId);
        await bb.sdk.threads.compact({ threadId: target.threadId });
        const ended = await waitForTurnEnd(target.threadId, afterSeq, Date.now() + COMPACT_WAIT_MS);
        if (!ended) throw new Error(`the compaction had not finished after ${COMPACT_WAIT_MS / 60_000} minutes`);
        compacted.push(target.name);
        record("maintenance", {
          workerName,
          threadId: target.threadId,
          excerpt: `Overnight compaction of ${target.name}: context was ${decision.percent}% full. bb shows the new figure after its next turn.`,
        });
      } catch (error) {
        record("maintenance", {
          workerName,
          threadId: target.threadId,
          excerpt: `Overnight compaction of ${target.name} failed at ${decision.percent}% context: ${String((error as { message?: string } | null)?.message ?? error).slice(0, 200)}`,
        });
      }
    }
    return { compacted, skipped };
  }

  // 04:15 home time every night (HOME_TIME_ZONE). bb's schedules run in
  // server-local time, so the guard checks that the server's clock shows the
  // same wall clock as HOME_TIME_ZONE rather than assuming it: on a server in
  // another zone the pass refuses to run instead of running at the wrong hour.
  // It compares offsets, not zone names, so a zone renamed to another with the
  // same clock keeps the pass running.
  bb.background.schedule("overnight-compaction", "15 4 * * *", async () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!serverClockMatchesHome(zone, Date.now())) {
      record("maintenance", {
        excerpt: `Overnight compaction did not run: the server clock is ${zone}, which does not show ${HOME_TIME_ZONE} time.`,
      });
      return;
    }
    const result = await compactIdleThreads();
    bb.log.info(`overnight compaction: ${result.compacted.length} compacted, ${result.skipped.length} skipped`);
  });

  /**
   * A question raised in a turn the user typed goes up ONCE, `NEED_HOLD_MS`
   * later, if it is still open: never sent, not dismissed, and still asked
   * (the rule: if it is still open after 24 h, forward it once with its
   * age). The thread is read again first and recorded like a
   * report, so a turn the plugin missed cannot send a question already answered.
   */
  async function forwardHeldNeeds(): Promise<void> {
    const now = Date.now();
    const due = needItemsHeldDue(store.needItemsHeld(), now);
    if (due.length === 0) return;
    const projects = await listProjects().catch(() => [] as ProjectRef[]);
    for (const workerId of new Set(due.map((record) => record.workerId))) {
      const worker = store.byId(workerId);
      if (worker === null || worker.retiredAt !== null) continue;
      const audience = audienceFor(worker);
      if (audience === null) continue;
      const output = await lastOutput(worker.threadId);
      if (!output.ok) continue;
      const block = parseStatusBlock(scrubUntrusted(output.text ?? "").text);
      const open = needItemsHeldDue(observeWorkerNeed(worker, block.need, false).map((item) => item.record), now);
      if (open.length === 0 || block.need === null) continue;
      const ids = [...new Set(open.map((record) => record.id))];
      const age = relativeTime(Math.min(...open.map((record) => record.firstSeenAt)), now).replace(/\s+ago$/, "");
      const who = `${projectNameFrom(projects, worker.projectId)}:${worker.name} (thread ${worker.threadId})`;
      const body = [
        `[Worker note] ${who} asked this in a turn the user typed ${age} ago, and it is still open. It has not reached you before; run cos_read to see the thread.`,
        `Need: ${block.need} (${ids.join(", ")}, open ${age})`,
      ].join("\n");
      bb.log.info(`worker note forwarded: ${worker.name} (${worker.threadId}) to ${audience.kind}, a Need held since a turn the user typed ${age} ago (${ids.join(", ")})`);
      await sendUpWithRetry(audience.threadId, body, worker.threadId);
      markNeedSent(worker, ids);
    }
  }

  /**
   * Items whose day has passed close themselves, the day after.
   * Stamped automatic, so they are in the For you note, one Put back away.
   */
  function expireBoardItems(): void {
    const now = Date.now();
    for (const item of store.boardExpired(now)) {
      if (item.expiresAt === null) continue;
      const day = boardExpiryDay(item.expiresAt);
      if (!store.boardAutoDismiss(item.id, `Closed automatically: its day, ${day}, has passed.`, now)) continue;
      record("board-move", { excerpt: `The plugin closed an item whose day (${day}) had passed: ${excerptOf(item.headline, 120)}` });
    }
  }

  /** A question dropped 30 days ago is a new one if it comes back; its row goes. Every six hours at most. */
  const NEED_ITEMS_KEPT_MS = 30 * 86_400_000;
  let needItemsPrunedAt = 0;
  function pruneNeedItems(): void {
    const now = Date.now();
    if (now - needItemsPrunedAt < 6 * 3_600_000) return;
    needItemsPrunedAt = now;
    const pruned = store.pruneNeedItems(now - NEED_ITEMS_KEPT_MS);
    if (pruned > 0) bb.log.info(`need ids: forgot ${pruned} question${pruned === 1 ? "" : "s"} dropped more than 30 days ago`);
  }

  bb.background.service("cos-sweep", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await sweepRateLimits();
          await drainChiefOutboxOnce();
          await finishPendingRemodels();
          await forwardHeldNeeds();
          expireBoardItems();
          pruneNeedItems();
        } catch (error) {
          bb.log.warn(`cos sweep: ${String(error)}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, RATE_LIMIT_SWEEP_MS);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    },
  });
  bb.events.on("thread.active", ({ thread }) => {
    // Caught like every lifecycle handler: a store error here must be logged,
    // not thrown into bb's event loop.
    try {
      const worker = store.byThread(thread.id);
      // The board counts from here, so the mark is only taken when the worker was
      // not already counted as running: bb repeats thread.active during a turn.
      if (worker && worker.retiredAt === null && worker.turnStartedAt === null) {
        store.markTurnStarted(worker.id);
      }
      if (thread.id === chiefThreadId) {
        void observeChiefSend().catch((error) => bb.log.warn(`board send watch: ${String(error)}`));
      }
      if (worker || thread.id === chiefThreadId) changed();
    } catch (error) {
      bb.log.warn(`thread.active handler for ${thread.id}: ${String(error)}`);
    }
  });
  const forget = async (threadId: string) => {
    const worker = store.byThread(threadId);
    if (worker && worker.retiredAt === null) {
      // Its parked reports go to the chief before the row is retired: the
      // thread they were queued against has just disappeared.
      store.retargetOutbox(worker.threadId, null);
      retireWorker(worker, null, threadId);
      changed();
    }
    // The picker's choice is keyed by thread id and nothing else would ever
    // delete it, so a dead thread would otherwise leave its key behind for good.
    await bb.storage.kv.delete(`${KV_PERMISSION_PREFIX}${threadId}`).catch(() => {});
    if (threadId === chiefThreadId) await setChief(null);
  };
  bb.events.on("thread.archived", async ({ thread }) => {
    await forget(thread.id).catch((error) => bb.log.warn(`thread.archived handler for ${thread.id}: ${String(error)}`));
  });
  bb.events.on("thread.deleted", async ({ thread }) => {
    await forget(thread.id).catch((error) => bb.log.warn(`thread.deleted handler for ${thread.id}: ${String(error)}`));
  });

  // ---------- thread execution: what a thread runs with, and switching it ----------

  /** The permission mode the bar chose for a thread, by thread id. Per turn in bb, so it lives here. */
  const KV_PERMISSION_PREFIX = "permission.";

  async function storedPermissionMode(threadId: string): Promise<PermissionMode | null> {
    const value = await bb.storage.kv.get<string>(`${KV_PERMISSION_PREFIX}${threadId}`);
    return value === "full" || value === "auto" || value === "accept-edits" ? value : null;
  }

  /**
   * Move a thread's chosen permission mode to its replacement. A remodel makes a
   * new thread, and without this the worker silently drops from full permission
   * back to the default at the moment it is least expected.
   */
  async function carryPermission(
    oldThreadId: string,
    newThreadId: string,
    targetProvider: string | null = null,
    fallbackMode?: string | null,
  ): Promise<void> {
    const raw = (await storedPermissionMode(oldThreadId)) ?? fallbackMode ?? null;
    const mode = raw !== null ? permissionModeFor(targetProvider, raw) : null;
    if (mode !== null) await bb.storage.kv.set(`${KV_PERMISSION_PREFIX}${newThreadId}`, mode);
  }

  /** The provider's catalog for one thread, reduced to what the picker maps over. */
  interface ThreadCatalog {
    models: CatalogModel[];
    provider: CatalogProvider | null;
    ceiling: PermissionMode;
    /** Why the catalog is empty, when it is. */
    error: string | null;
  }

  async function loadCatalog(thread: { providerId: string; environmentId: string | null }): Promise<ThreadCatalog> {
    try {
      const catalog = await bb.sdk.system.executionOptions({
        providerId: thread.providerId,
        ...(thread.environmentId ? { environmentId: thread.environmentId } : {}),
      });
      return {
        models: catalog.models,
        provider: catalog.providers.find((p) => p.id === thread.providerId) ?? null,
        ceiling: catalog.permissionCeiling,
        error: catalog.modelLoadError ? `${catalog.modelLoadError.providerId}: ${catalog.modelLoadError.code}` : null,
      };
    } catch (error) {
      return { models: [], provider: null, ceiling: "full", error: String(error) };
    }
  }

  async function threadExecution(threadId: string): Promise<ThreadExecution | null> {
    const thread = await threadOrNull(threadId);
    if (!thread || thread.deletedAt !== null) return null;
    const current = await bb.sdk.threads.defaultExecutionOptions({ threadId });
    if (!current) return null;
    const catalog = await loadCatalog(thread);
    const permissionMode = (await storedPermissionMode(threadId)) ?? current.permissionMode;
    return {
      threadId,
      providerId: thread.providerId,
      model: current.model,
      reasoningLevel: current.reasoningLevel,
      permissionMode,
      models: modelChoices(current.model, catalog.models),
      reasoningLevels: reasoningChoices(current.reasoningLevel, current.model, catalog.models, catalog.provider),
      permissionModes: permissionChoices(
        permissionMode,
        catalog.provider,
        catalog.ceiling,
        NO_AUTO_PROVIDERS.has(thread.providerId),
      ),
      catalogError: catalog.error,
    };
  }

  /**
   * Model and reasoning level go to bb as the thread's sticky overrides
   * (threads.update, the PATCH the host's own picker makes). A model change
   * also sends the level to run it at when the current level is not in the
   * new model's list, so bb never has to reconcile. Permission mode is per
   * turn in bb, so the plugin stores it and sends it with every turn it
   * dispatches to that thread.
   */
  /**
   * Every thread the model and effort panel lists, read live.
   *
   * Two rules.
   *
   * It READS ONLY. No reconcile, no repair, no writing back a level it thinks
   * is wrong. When the thread and the roster disagree the disagreement is
   * reported, because the roster lagging is a fact about the roster and quietly
   * healing it here would hide the bug rather than fix it.
   *
   * A thread it cannot read is reported as unread (`readOk: false`) and never
   * as a thread with nothing set. `threadOrNull` swallows its throw and
   * `defaultExecutionOptions` can return null, so without this the panel would
   * print "no override" for a thread it never managed to look at.
   */
  /**
   * The newest context reading bb has for one thread, or nulls.
   *
   * Read fresh on every render and never written to the roster: a cached copy
   * of something this plugin cannot observe changing is a second source of
   * truth.
   *
   * A failed read returns nulls, which the panel renders as UNKNOWN rather than
   * as zero. That is deliberate and is the whole reason the cell exists: bb's
   * own ring draws nothing at 0%, so a thread with no reading looks exactly
   * like a thread that is fine.
   */
  async function contextUsage(threadId: string): Promise<{ used: number | null; window: number | null }> {
    try {
      const rows = await bb.sdk.threads.events.list({
        threadId,
        types: ["thread/contextWindowUsage/updated"],
        order: "desc",
        limit: "1",
      });
      const usage = (rows[0]?.data as { contextWindowUsage?: { usedTokens?: number | null; modelContextWindow?: number | null } } | undefined)
        ?.contextWindowUsage;
      if (!usage) return { used: null, window: null };
      return {
        used: typeof usage.usedTokens === "number" ? usage.usedTokens : null,
        window: typeof usage.modelContextWindow === "number" ? usage.modelContextWindow : null,
      };
    } catch {
      return { used: null, window: null };
    }
  }

  async function executionList(): Promise<{
    rows: ExecutionRowDto[];
    catalogs: ExecutionCatalogDto[];
  }> {
    const roster = await rosterStatus({ includeOthers: false, skipExecution: true });
    const specs: ExecutionRowSpec[] = [];
    if (roster.chiefThreadId !== null) {
      specs.push({
        threadId: roster.chiefThreadId,
        workerId: null,
        name: "Chief of Staff",
        project: null,
        kind: "chief",
        role: null,
        managerName: null,
      });
    }
    for (const worker of roster.workers) {
      if (worker.retired) continue;
      specs.push({
        threadId: worker.threadId,
        workerId: worker.id,
        name: worker.title ?? worker.name,
        project: worker.projectName,
        kind: "worker",
        role: worker.role === "manager" ? "manager" : "worker",
        // The manager's DISPLAY name, so the group heading reads like the rest
        // of the panel rather than like a database column.
        managerName:
          worker.managerId === null
            ? null
            : (() => {
                const manager = store.byId(worker.managerId);
                return manager === null ? null : (manager.name ?? null);
              })(),
      });
    }
    // Rows in parallel, catalogs shared per host and per body.
    const built = await buildExecutionList(specs, {
      context: contextUsage,
      thread: threadOrNull,
      storedPermission: storedPermissionMode,
      hostOf: async () => new Map((await bb.sdk.environments.list()).map((e) => [e.id, e.hostId])),
      current: (threadId) => bb.sdk.threads.defaultExecutionOptions({ threadId }),
      loadCatalog,
    });
    return built as { rows: ExecutionRowDto[]; catalogs: ExecutionCatalogDto[] };
  }

  async function setThreadExecution(input: {
    threadId: string;
    model?: string;
    reasoningLevel?: ReasoningLevel;
    permissionMode?: PermissionMode;
  }): Promise<ThreadExecution> {
    const read = await readThread(input.threadId);
    if (read.kind === "unreachable") throw new Error(unreachableThreadNote(input.threadId, read.error));
    if (read.kind === "gone" || read.thread.deletedAt !== null) throw new Error(`Thread ${input.threadId} is gone.`);
    const thread = read.thread;
    if (input.model !== undefined || input.reasoningLevel !== undefined) {
      let level = input.reasoningLevel ?? null;
      if (level === null && input.model !== undefined) {
        const current = await bb.sdk.threads.defaultExecutionOptions({ threadId: input.threadId });
        const catalog = await loadCatalog(thread);
        level = current ? reasoningForModel(current.reasoningLevel, input.model, catalog.models) : null;
      }
      await bb.sdk.threads.update({
        threadId: input.threadId,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(level !== null ? { reasoningLevel: level } : {}),
      });
      // Nothing to mirror onto the roster: bb's own composer also writes the
      // model and level, so a copy on `workers` would drift. Every surface
      // reads the thread.
    }
    if (input.permissionMode !== undefined) {
      await bb.storage.kv.set(`${KV_PERMISSION_PREFIX}${input.threadId}`, input.permissionMode);
    }
    changed();
    const after = await threadExecution(input.threadId);
    if (!after) throw new Error(`Thread ${input.threadId} is gone.`);
    return after;
  }

  /** The permission field for a plugin send: the bar's stored choice for that thread, when there is one. */
  /**
   * The mode a dispatch to this thread runs at: its own stored choice, else its
   * MANAGER's.
   *
   * Inheritance is what makes "and the same for all of its children" hold
   * without writing a row per worker and re-writing it whenever a team changes.
   * A worker's own choice always wins, so setting one worker to accept-edits is
   * not undone by its manager being full.
   *
   * Bounded to a real manager, which is what keeps the chief out of it: a
   * thread with no `manager_id` inherits from nobody, so the chief's own mode
   * stays its own and an unmanaged leaf keeps the setting default.
   */
  async function permissionFor(threadId: string): Promise<{ permissionMode: PermissionMode } | Record<string, never>> {
    // THROUGH `inheritedPermissionMode`, which is the tested rule, so the tests
    // that cover manager inheritance cover what a dispatch actually does. Do
    // not write the chain out by hand here.
    //
    // The short-circuit is kept: a worker with its own mode costs one kv read
    // rather than three. A retired manager is treated as no manager, which is
    // this caller's own guard and not part of the rule.
    const own = await storedPermissionMode(threadId);
    if (own !== null) return { permissionMode: own };
    const worker = store.byThread(threadId);
    const manager = worker === null || worker.managerId === null ? null : store.byId(worker.managerId);
    const live = manager !== null && manager.retiredAt === null ? manager : null;
    const inherited = inheritedPermissionMode(
      null,
      live === null ? null : await storedPermissionMode(live.threadId),
      live !== null,
    );
    return inherited === null ? {} : { permissionMode: inherited };
  }
  // ---------- rpc for app.tsx ----------

  bb.rpc.register(rpcContract, {
    sessions_list: () => sessionsList(),
    session_digest: async ({ sessionId, maxChars }) => {
      const result = await sessionDigest(sessionId, maxChars);
      if (!result) throw new Error(`No transcript found for session ${sessionId}.`);
      return result;
    },
    session_import: (input) => importSessions(input),
    chief_get: () => ({ threadId: chiefThreadId }),
    thread_marks: async () => currentThreadMarks(undefined),
    file_target: async (input) => ({ target: await fileTarget(input.threadId ?? chiefThreadId, input.path) }),
    thread_seen: async (input) => {
      // Only a live worker's thread: this is the finished dot's own clearing,
      // not a general "mark anything read" door.
      const worker = store.byThread(input.threadId);
      if (worker === null || worker.retiredAt !== null) return { ok: false };
      try {
        await bb.sdk.threads.markRead({ threadId: input.threadId });
        // The dot has to go on the refetch that follows, not after the memo lapses.
        threadMarksEpoch += 1;
        return { ok: true };
      } catch (error) {
        bb.log.warn(`thread_seen ${input.threadId}: ${String(error)}`);
        return { ok: false };
      }
    },
    board_list: (input) => ({ items: boardList(input?.states ?? undefined, input?.area ?? undefined) }),
    board_add: (input) => {
      const expiry = parseBoardExpiry(input.expires);
      if (!expiry.ok) throw new Error(expiry.text);
      return { item: boardAdd({ ...input, expiresAt: expiry.at }) };
    },
    board_close: (input) => boardClose(input),
    board_update: (input) =>
      // Named, like every other move: two people write this board from surfaces
      // neither can see, so a priority the user changed must not be logged as
      // if a shell did it.
      boardUpdate(
        input.id,
        input,
        input.by === "panel" ? { kind: "owner", how: "panel" } : { kind: "shell" },
      ),
    board_set_state: (input) =>
      boardSetState(input.ids, input.state, input.note, input.by === "panel" ? { kind: "owner", how: "panel" } : { kind: "shell" }),
    board_address: (input) =>
      boardAddress(
        input.ids,
        input.by === "panel" ? { kind: "owner", how: "panel" } : { kind: "shell" },
        input.picks,
        input.answers,
      ),
    need_answer_draft: (input) => needAnswerDraft(input.workerId, input.label),
    board_auto_dismissed: async () => {
      const since = (await bb.storage.kv.get<number>(KV_AUTO_REVIEWED)) ?? 0;
      return { items: store.boardAutoDismissedSince(since).map(scrubBoardItem), since };
    },
    board_auto_reviewed: async () => {
      await bb.storage.kv.set(KV_AUTO_REVIEWED, Date.now());
      changed();
      return { ok: true };
    },
    board_draft_take: (input) => boardDraftTake(input.threadId),
    board_drafts_recent: ({ threadId }) => ({
      drafts: store
        .boardRecentDrafts(threadId, Date.now() - BOARD_DRAFT_LOOKBACK_MS)
        .map((d) => ({ id: d.id, body: d.body, createdAt: d.createdAt, itemStates: d.itemStates })),
    }),
    board_draft_ack: (input) => {
      for (const id of input.ids) store.boardConsumeDraft(id);
      return { drafted: store.boardDrafted().length };
    },
    chief_ensure: () => ensureChief(),
    chief_restart: () => restartChief(),
    projects_list: async () => ({ projects: await listProjects() }),
    roster_list: async (input) => {
      const roster = await rosterStatus({ includeOthers: input?.includeOthers ?? true });
      return { chiefThreadId: roster.chiefThreadId, workers: roster.workers, others: roster.others };
    },
    summary: async () => {
      // includeOthers is what makes a blocked unmanaged thread countable; the
      // full threads.list is fetched either way, so the others array is free.
      const roster = await rosterStatus({ includeOthers: true });
      let busy = 0;
      let needsYou = 0;
      let decisions = 0;
      let routing = 0;
      let idle = 0;
      let failed = 0;
      let urgent = 0;
      for (const w of roster.workers) {
        if (w.failed) failed += 1;
        // Counted before the buckets below, which every urgent worker falls into.
        if (w.urgency === "urgent") urgent += 1;
        // Every branch here mirrors workerBucket in use-cos.ts, so a chip count
        // and the section it filters to can never disagree. A missing worker
        // belongs in this branch: it is in no busy set and MISSING_FACTS clears
        // pendingInteraction, so skipping it would count a gone thread as idle
        // and hide it from urgent as well.
        if (w.pendingInteraction || w.failed || w.missing) {
          needsYou += 1;
          continue;
        }
        // Not blocked, but the last Need line asks for something. A need the
        // worker addressed to the chief is routing, not a decision for the user.
        // A dismissed need falls through to the run state, like workerBucket.
        if (!w.retired && w.lastNeed !== null && !w.needDismissed) {
          if (w.needAudience === "chief") routing += 1;
          else decisions += 1;
          continue;
        }
        // The wide mid-flight set, not the three-entry one: a worker that is
        // stopping or waiting for its host is not idle, and an "N idle" chip that
        // counted it would filter to a board with no rows on it.
        if (isBusyStatus(w.displayStatus)) {
          busy += 1;
          continue;
        }
        idle += 1;
      }
      // The board puts a blocked unmanaged thread in "Needs you" too.
      needsYou += roster.others.filter((t) => t.pendingInteraction).length;
      // A broken session scan must not take the whole summary down.
      let externalCount = 0;
      let externalUnimported = 0;
      try {
        const sessions = await externalSessions();
        const imports = store.importsBySession();
        // An import outlives its worker, so "has been imported once" is not the
        // question; sessionsList asks whether the worker is still active, and the
        // count has to ask the same thing or the card and the table disagree. A
        // retired worker means the session is unattached and importable again.
        const active = new Set(store.list().map((w) => w.id));
        externalCount = sessions.length;
        externalUnimported = sessions.filter((s) => {
          const workerId = imports.get(s.sessionId);
          return workerId === undefined || !active.has(workerId);
        }).length;
      } catch (error) {
        bb.log.warn(`external session scan failed: ${String(error)}`);
      }
      return {
        chiefThreadId: roster.chiefThreadId,
        chiefStatus: roster.chiefStatus,
        busy,
        needsYou,
        decisions,
        routing,
        idle,
        failed,
        lastActivityAt: store.latestActivityAt(),
        externalSessions: externalCount,
        externalUnimported,
        urgent,
        // Only while the chief is down: an old failure under a working chief is
        // history, and the board would print it as if it were current.
        chiefFailure:
          roster.chiefStatus === "error" ? store.lastChiefFailure()?.excerpt ?? null : null,
        board: boardList(["open"]).length,
      };
    },
    activity_list: (input) => ({ events: store.listActivity(input?.limit ?? 100) }),
    // Scrubbed like every other path that carries worker words to a surface:
    // the excerpt is a report's first 300 characters, written by the worker.
    activity_day: ({ from, to }) => {
      const result = store.activityBetween(from, to);
      return {
        truncated: result.truncated,
        events: result.events.map((e) => ({ ...e, excerpt: scrubUntrusted(e.excerpt).text })),
      };
    },
    delegate: (input) => delegate({ ...input, scope: BOARD_SCOPE, wait: false }),
    adopt: ({ threadId, name, description }) => adopt(threadId, name, description),
    worker_retire: async ({ id }) => {
      const worker = store.byId(id);
      if (!worker) throw new Error(`No worker ${id}`);
      return retire(BOARD_SCOPE, worker.threadId);
    },
    worker_stop: async ({ id }) => {
      const worker = store.byId(id);
      if (!worker) throw new Error(`No worker ${id}`);
      return stopWorker(BOARD_SCOPE, worker.threadId);
    },
    worker_retry: async ({ id, model }) => {
      const worker = store.byId(id);
      if (!worker) throw new Error(`No worker ${id}`);
      return retryWorker(BOARD_SCOPE, worker.threadId, undefined, model);
    },
    // The user has looked at these needs. Called when a decision row is opened
    // or acted on, and for every visible decision when the user arrives from a count.
    need_mark_seen: async ({ workers }) => {
      const seen: { id: string; sig: string }[] = [];
      for (const entry of workers) {
        const worker = store.byId(entry.id);
        if (worker === null) continue;
        const shown = needSignature(entry.need);
        if (shown === null) continue;
        // Only mark what was actually on screen. The worker may have
        // finished another turn between the render and the click, and marking
        // its newer question as seen would bury an unread need on the one
        // surface that says a worker question is new.
        // A failed read marks nothing. Marking on a guess would bury an unseen
        // need, on the one surface that says a question is new.
        const output = await lastOutput(worker.threadId);
        if (!output.ok) continue;
        const block = parseStatusBlock(output.text);
        if (needSignature(block.need) !== shown) continue;
        seen.push({ id: worker.id, sig: shown });
      }
      store.markNeedSeen(seen);
      if (seen.length > 0) changed();
      return { marked: seen.length };
    },
    worker_dismiss_need: async ({ id, note, undo }) => {
      const worker = store.byId(id);
      if (!worker) throw new Error(`No worker ${id}`);
      return dismissNeed(BOARD_SCOPE, worker.threadId, { note, undo });
    },
    worker_for_thread: async ({ threadId }) => {
      const isChief = threadId === chiefThreadId;
      const known = store.byThread(threadId);
      if (!known) return { worker: null, isChief };
      const roster = await rosterStatus({ projectId: known.projectId, includeRetired: true });
      return { worker: roster.workers.find((w) => w.threadId === threadId) ?? null, isChief };
    },
    send_to_chief: ({ text, sourceThreadId, note }) => forwardToChief(text, sourceThreadId, note),
    execution_list: () => executionList(),
    thread_execution_get: ({ threadId }) => threadExecution(threadId),
    thread_execution_set: (input) => setThreadExecution(input),
  });

  // ---------- the decision board ----------

  /**
   * Items the chief has put in front of the user. This list is curated by hand:
   * nothing is copied here from a worker's Need line, because the Mission board
   * already shows those and a decision that appeared twice would be answered
   * once and left open in the other place.
   */
  /**
   * The scrub every board read applies on the way out, as well as on the way
   * in, so a row stored unscrubbed is covered too.
   *
   * Its own function because `boardList` is not the only reader:
   * `board_auto_dismissed` returns rows straight from the store, and those
   * rows carry a worker-written headline, context and note into the review
   * banner, so every reader goes through this.
   */
  function scrubBoardItem(item: BoardItem): BoardItem {
    return {
      ...item,
      headline: scrubUntrusted(item.headline).text,
      context: scrubUntrusted(item.context).text,
      sourceLabel: item.sourceLabel === null ? null : scrubUntrusted(item.sourceLabel).text,
      choices: item.choices.map((choice) => ({ label: scrubUntrusted(choice.label).text })),
      // Every free-text field on the row, not just the ones a worker was most
      // likely to reach. A link label prints as a word on the row and a note
      // prints as the reason a thing was closed.
      links: item.links.map((link) => ({ label: scrubUntrusted(link.label).text, href: link.href })),
      note: item.note === null ? null : scrubUntrusted(item.note).text,
    };
  }

  function boardList(states?: readonly BoardState[], area?: BoardArea): BoardItem[] {
    return store.boardList({ states, area, limit: 300 }).map(scrubBoardItem);
  }

  /**
   * Where an item came from, resolved once at write time.
   *
   * A worker name becomes the worker's own title and its thread, so the row can
   * link straight to the report the chief read. A name that matches nothing,
   * or matches in two projects, is still kept as words: knowing an item came
   * from "copy-editor" is worth more than knowing nothing, and a source that
   * cannot be linked is a normal case, not an error worth refusing the add
   * over. Anything that is not a worker goes in as the chief wrote it.
   */
  function resolveBoardSource(from: string): {
    sourceLabel: string | null;
    sourceThreadId: string | null;
  } {
    return boardSourceResolved(from, (name) => store.byName(name), titleFor);
  }

  /**
   * An expiry as the board surfaces take it: the event's day (YYYY-MM-DD), or
   * "none" for no expiry. A day already over is refused: an item about it
   * would close on the next sweep, which is never what the caller meant.
   */
  function parseBoardExpiry(raw: string | undefined, now = Date.now()): { ok: true; at: number | null } | { ok: false; text: string } {
    if (raw === undefined || raw.trim().toLowerCase() === "none") return { ok: true, at: null };
    const at = boardExpiresAt(raw);
    if (at === null) return { ok: false, text: `expires is the day of the event as YYYY-MM-DD, or none; got "${raw}".` };
    if (at <= now) return { ok: false, text: `${boardExpiryDay(at)} is over, so an item about it would close at once. Leave expires off, or resolve the item.` };
    return { ok: true, at };
  }

  /**
   * The add's last sentence about expiry. An item with one says when it
   * closes. One whose headline names a day gets a nudge, because only the
   * chief can tell an event (close the day after) from a deadline (stay until
   * done), which is why the plugin never sets this on its own.
   */
  function boardExpiryHint(item: BoardItem): string {
    if (item.expiresAt !== null) return ` It closes itself after ${boardExpiryDay(item.expiresAt)}.`;
    const due = parseDue(item.headline, item.createdAt);
    if (due === null) return "";
    const on = new Date(due.at);
    const day = `${on.getFullYear()}-${String(on.getMonth() + 1).padStart(2, "0")}-${String(on.getDate()).padStart(2, "0")}`;
    return ` The headline names ${due.hint}. If it is about something happening that day, set expires ${day} (bb cos board update ${item.id} --expires ${day}) so it closes itself the day after; leave it off for a deadline.`;
  }

  function boardAdd(input: {
    headline: string;
    context?: string;
    area: BoardArea;
    links?: { label: string; href: string }[];
    from?: string;
    priority?: BoardPriority;
    choices?: { label: string }[];
    /** Parsed by `parseBoardExpiry`. */
    expiresAt?: number | null;
  }): BoardItem {
    const source = resolveBoardSource(input.from ?? "");
    // `bb cos board add` is reachable from any thread, a worker's shell
    // included, and the chief reads this list back with cos_board_list. So the
    // text is scrubbed on the way in like every other path that carries worker
    // words into another agent's context, and anything removed is named in the
    // log rather than silently fixed.
    const headline = scrubUntrusted(collapseWhitespace(input.headline).trim());
    const context = scrubUntrusted((input.context ?? "").trim());
    const label = source.sourceLabel === null ? null : scrubUntrusted(source.sourceLabel);
    const item = store.boardAdd({
      headline: headline.text,
      context: context.text,
      area: input.area,
      links: input.links ?? [],
      sourceLabel: label === null ? null : label.text,
      sourceThreadId: source.sourceThreadId,
      priority: input.priority ?? "soon",
      choices: (input.choices ?? []).map((choice) => ({
        label: scrubUntrusted(collapseWhitespace(choice.label).trim()).text,
      })),
      expiresAt: input.expiresAt ?? null,
    });
    // The worker's Need is now on the user's list, so it stops counting as a
    // decision in the chip as well.
    const needWorker = boardNeedWorker(
      input.from ?? "",
      source.sourceThreadId,
      (name) => store.byName(name),
      (threadId) => store.byThread(threadId),
    );
    if (needWorker !== null && needWorker.retiredAt === null) void clearNeedForBoardItem(needWorker, item.id);
    const note = scrubNote({
      hidden: headline.hidden + context.hidden + (label?.hidden ?? 0),
      blocks: headline.blocks + context.blocks + (label?.blocks ?? 0),
    });
    record("board-add", {
      excerpt: `${BOARD_AREA_LABEL[item.area]}: ${excerptOf(item.headline, 160)}${note === null ? "" : ` [${note}]`}`,
    });
    return item;
  }

  /**
   * Put the worker's current questions on this item: each is linked to it
   * under its id and dismissed with a note naming the item, so a reworded
   * repeat reads as "on the board" rather than as a new decision, and closing
   * the item by its Need id works. A question already on another open item
   * stays with that one. Read from the thread like `dismissNeed`; a failed
   * read or no Need changes nothing.
   */
  async function clearNeedForBoardItem(worker: Worker, itemId: string): Promise<void> {
    try {
      const output = await lastOutput(worker.threadId);
      if (!output.ok) return;
      const need = parseStatusBlock(output.text).need;
      const sig = needSignature(need);
      if (need === null || sig === null) return;
      const items = observeWorkerNeed(worker, need, false).filter((item) => {
        const linked = item.record.boardItemId;
        return linked === null || linked === itemId || store.boardItem(linked)?.state !== "open";
      });
      store.linkNeedItemsToBoard(needIdsOf(items), itemId);
      const open = items.filter((item) => item.record.dismissedAt === null);
      const fresh = store.byId(worker.id) ?? worker;
      if (fresh.needDismissedSig === sig && open.length === 0) return;
      const note = `on the board as ${itemId.slice(0, 8)}`;
      const now = Date.now();
      store.dismissNeed(worker.id, sig, note, now);
      store.dismissNeedItems(needIdsOf(open), note, now);
      const ids = needIdsOf(items);
      record("dismiss", {
        workerName: worker.name,
        threadId: worker.threadId,
        excerpt: `Dismissed the need "${need}" (${note})${ids.length > 0 ? ` [${ids.join(", ")}]` : ""}`,
      });
    } catch (error) {
      bb.log.warn(`board add: could not clear ${worker.name}'s Need: ${String(error)}`);
    }
  }

  /**
   * Re-prioritise an item, change its choices, or set the day it closes itself
   * after (`expires`: YYYY-MM-DD, or "none" to take it off). Logged like any
   * other move: two people write this board from surfaces neither can see, so a
   * priority that changed under the user has to be traceable.
   */
  function boardUpdate(
    id: string,
    patch: { priority?: BoardPriority; choices?: { label: string }[]; expires?: string },
    mover: BoardMover = { kind: "shell" },
  ): { ok: boolean; text: string; item: BoardItem | null } {
    const before = store.boardItem(id);
    if (before === null) return { ok: false, text: "No board item with that id.", item: null };
    const expiry = patch.expires === undefined ? null : parseBoardExpiry(patch.expires);
    if (expiry !== null && !expiry.ok) return { ok: false, text: expiry.text, item: before };
    const choices =
      patch.choices === undefined
        ? undefined
        : patch.choices.map((choice) => ({
            label: scrubUntrusted(collapseWhitespace(choice.label).trim()).text,
          }));
    const item = store.boardUpdate(id, {
      priority: patch.priority,
      choices,
      ...(expiry === null ? {} : { expiresAt: expiry.at }),
    });
    const parts: string[] = [];
    if (patch.priority !== undefined && patch.priority !== before.priority) {
      parts.push(`${BOARD_PRIORITY_LABEL[before.priority]} to ${BOARD_PRIORITY_LABEL[patch.priority]}`);
    }
    if (choices !== undefined) parts.push(`${choices.length} choice${choices.length === 1 ? "" : "s"}`);
    if (expiry !== null && expiry.at !== before.expiresAt) {
      parts.push(expiry.at === null ? "no expiry" : `closes itself after ${boardExpiryDay(expiry.at)}`);
    }
    if (parts.length > 0) {
      record("board-move", {
        excerpt: `${boardMoverName(mover)} changed ${excerptOf(before.headline, 60)}: ${parts.join(", ")}`,
      });
    }
    return {
      ok: true,
      text: parts.length === 0 ? "Nothing to change." : `Updated: ${parts.join(", ")}.`,
      item,
    };
  }

  /** Headlines of the items a move touched, for the reply line and the log. */
  function boardNames(items: readonly BoardItem[]): string {
    return excerptOf(items.map((item) => excerptOf(item.headline, 60)).join("; "), 200);
  }

  /**
   * Who is acting, from the thread behind the call. A CLI run with no thread is
   * a shell and is named as one: the board would rather say it does not know
   * than put the chief's name on somebody else's dismissal.
   */
  /**
   * What the thread that called a tool or a CLI verb is allowed to reach.
   *
   * The roster read is wrapped so a database hiccup comes back as
   * `unreadable` rather than as `none`: refusing a manager its own team
   * because a read failed is at least honest about why, while answering "you
   * have no team" to a question nobody could answer would be a false answer.
   *
   * What this is NOT: a security boundary. `ctx.threadId` on the CLI is the
   * caller's own BB_THREAD_ID, so any agent that wants to can unset or forge
   * it; the bypass is trivial. This stops the honest path and the
   * accidental one, which is the case that actually happens.
   */
  function scopeOf(threadId: string | null | undefined): Scope {
    if (threadId && threadId === remodellingChiefThreadId) return { kind: "chief" };
    return teamScope(threadId, chiefThreadId, (id) => {
      try {
        const worker = store.byThread(id);
        return {
          ok: true,
          worker: worker === null ? null : { id: worker.id, role: worker.role, retiredAt: worker.retiredAt },
        };
      } catch (error) {
        bb.log.warn(`scope: could not read the roster for ${id}: ${String(error)}`);
        return { ok: false };
      }
    });
  }

  /**
   * The scope the plugin's own RPC surface acts with.
   *
   * These handlers back the board UI in app.tsx, which runs in the user's
   * browser, so full authority is correct for the caller they were built for.
   * They carry NO caller identity, which means anything on the bb host can
   * curl them; that is the same hole the CLI has and it is documented
   * rather than papered over here. Closing it means
   * sending a caller thread from app.tsx and requiring it, which is a change
   * to the app, not to this line.
   */
  const BOARD_SCOPE: Scope = { kind: "chief" };

  /**
   * Refuse a `bb cos` verb that is the chief's alone, or null to let it run.
   *
   * The scope check for the shapes that do not RESOLVE a named worker: verbs
   * that enumerate (`roster`, `activity`, `marks`), verbs that take
   * `--all` and so never resolve anything, and verbs that name no worker at
   * all (`reset-chief`, `adopt`, `import`). Without it every one would be
   * reachable by a manager on its own honest thread id, which is a different
   * gap from the known BB_THREAD_ID bypass.
   *
   * A bare terminal is still the user and still allowed, as everywhere else.
   */
  function refuseUnlessChief(scope: Scope, what: string): string | null {
    switch (scope.kind) {
      case "chief":
      case "none":
        return null;
      case "manager":
        return `${what} is the chief's, not a manager's. Ask it, or put it in a Chief: line.`;
      case "worker":
        return `${what} is the chief's. You are a worker; put it in your Need: line.`;
      case "unreadable":
        return `Could not read the roster to check who is asking. ${what} was not run; try again.`;
    }
  }

  /**
   * The dispatching thread as a live manager's worker id, or null.
   *
   * Passed to every `dispatchedBy` call. Without it that function defaults to
   * "no manager", every manager dispatch is stored as a dispatch by NOBODY,
   * and the rate-limit sweep silently stops re-sending any brief a manager
   * gave.
   */
  function managerWorkerId(threadId: string): string | null {
    const worker = store.byThread(threadId);
    return worker !== null && worker.retiredAt === null && worker.role === "manager" ? worker.id : null;
  }

  /**
   * The scope of a `bb cos` caller.
   *
   * The same Scope value means different things on the two doors, and that is
   * the whole reason this exists. A TOOL call always carries a calling thread,
   * so `none` there is a thread that is neither the chief nor on the roster: a
   * side chat, another plugin, something that has no business acting on a
   * worker, and refusing it is right. A CLI call with no thread id at all is a
   * bare terminal, which is the user, with full authority.
   *
   * The two must not be collapsed: `scopeRefusal` refuses `none` and
   * `refuseUnlessChief` allows it, and treating them alike would refuse a bare
   * terminal `remodel --all` and every worker-resolving verb. Two functions
   * disagreeing about one value is the shape to watch for.
   */
  function cliScopeOf(threadId: string | null | undefined): Scope {
    if (threadId === null || threadId === undefined || threadId === "") return { kind: "chief" };
    return scopeOf(threadId);
  }

  function moverFromThread(threadId: string | null, how: "cli" | "tool"): BoardMover {
    if (threadId === null || threadId === "") return { kind: "shell" };
    if (threadId === chiefThreadId || threadId === remodellingChiefThreadId) return { kind: "chief", how };
    const worker = store.byThread(threadId);
    return worker === null ? { kind: "shell" } : { kind: "worker", how, name: worker.name };
  }

  /**
   * Move items, and say which ones moved and who moved them.
   *
   * A count alone cannot be checked against what anyone asked for, and two
   * movers' counts in a row read like one command's. So the row names the
   * headlines and the mover, and a reopen says whose decision it is reversing.
   */
  function boardSetState(
    ids: readonly string[],
    state: BoardState,
    note?: string,
    mover: BoardMover = { kind: "shell" },
  ): { ok: boolean; changed: number; text: string } {
    const before = ids.map((id) => store.boardItem(id)).filter((item): item is BoardItem => item !== null);
    if (before.length === 0) return { ok: false, changed: 0, text: "No board item with that id." };
    const who = boardMoverName(mover);
    const changedRows = store.boardSetState(
      before.map((item) => item.id),
      state,
      Date.now(),
      note ?? null,
      who,
    );
    const names = boardNames(before);
    const count = `${changedRows} item${changedRows === 1 ? "" : "s"}`;
    const undone = state === "open" ? boardUndoneNote(before, who) : "";
    record("board-move", {
      excerpt: `${who} moved ${count} to ${state}: ${names}${undone}${note ? ` (${excerptOf(note, 80)})` : ""}`,
    });
    const missing = ids.length - before.length;
    return {
      ok: true,
      changed: changedRows,
      text: `${count} ${state}: ${names}${undone}${missing > 0 ? ` ${missing} id${missing === 1 ? " was" : "s were"} unknown.` : ""}`,
    };
  }

  /**
   * `board_close`: another plugin closes board items (for example an issue
   * tracker's row actions). By `id`, that item; by `needId`, the open or
   * addressed item carrying that worker question (one at most: a question is
   * on one item), and the question itself is dismissed, so a reworded repeat
   * of it does not come back as a decision; by `match`, see `boardCloseMatch`.
   * An item already closed moves nothing and is not an error. Logged under
   * the caller's name, as the caller gives it.
   */
  function boardClose(input: {
    id?: string;
    needId?: string;
    match?: { refs: string[]; threadId?: string };
    state?: "resolved" | "dismissed";
    note?: string;
    by: string;
  }): BoardCloseResult {
    const refuse = (text: string): BoardCloseResult => ({ ok: false, closed: [], skipped: [], needIds: [], text });
    const by = input.by.trim().toLowerCase();
    if (!PLUGIN_NAME_RE.test(by)) return refuse(`by is the calling plugin's id (letters, digits and dashes); got "${input.by}".`);
    if ([input.id, input.needId, input.match].filter((selector) => selector !== undefined).length !== 1) {
      return refuse("Give exactly one of id (a board item), needId (a worker question) and match (refs from another plugin's row).");
    }
    const state = input.state ?? "resolved";
    const note = input.note?.trim() || undefined;
    const mover: BoardMover = { kind: "plugin", name: by };
    if (input.match !== undefined) return boardCloseMatch(input.match, state, note, mover);
    const isLive = (item: BoardItem): boolean => item.state === "open" || item.state === "addressed";
    let targets: BoardItem[];
    let needIds: string[] = [];
    if (input.id !== undefined) {
      const item = store.boardItem(input.id);
      if (item === null) return refuse(`No board item with id ${input.id}.`);
      if (!isLive(item)) return { ok: true, closed: [], skipped: [], needIds: [], text: `${excerptOf(item.headline, 80)} is already ${item.state}; nothing moved.` };
      targets = [item];
    } else {
      const question = store.needItem(input.needId!.trim());
      if (question === null) return refuse(`No Need with id ${input.needId}.`);
      store.dismissNeedItems([question.id], `closed by the ${by} plugin${note ? `: ${note}` : ""}`);
      needIds = [question.id];
      const owner = store.byId(question.workerId);
      // Like every dismissal, it leaves a row, so the chief can see who closed it.
      record("dismiss", {
        workerName: owner?.name ?? null,
        threadId: owner?.threadId ?? null,
        excerpt: `${boardMoverName(mover)} dismissed Need ${question.id}: "${excerptOf(question.text, 160)}"${note ? ` (${note})` : ""}`,
      });
      const linked = question.boardItemId === null ? null : store.boardItem(question.boardItemId);
      if (linked === null || !isLive(linked)) {
        return { ok: true, closed: [], skipped: [], needIds, text: `No open board item carries Need ${question.id}; the Need is dismissed, nothing else moved.` };
      }
      targets = [linked];
    }
    const result = boardSetState(targets.map((item) => item.id), state, note, mover);
    return {
      ok: result.ok,
      closed: targets.map((item) => ({ id: item.id, headline: item.headline })),
      skipped: [],
      needIds,
      text: result.text,
    };
  }

  type BoardCloseResult = {
    ok: boolean;
    closed: { id: string; headline: string }[];
    skipped: { id: string; headline: string; why: string }[];
    needIds: string[];
    text: string;
  };

  /**
   * `board_close` by `match`: what another plugin's row knows. Its refs
   * are marked done; an open or addressed item closes when its
   * headline names one of them and every ref it names is done
   * (`boardRefDecision`), stamped automatic so it is in the For you note with a
   * Put back. Open questions of the row's worker and of its manager close by
   * the same rule. An item the click touched and left open is in `skipped`.
   */
  function boardCloseMatch(
    match: { refs: string[]; threadId?: string },
    state: "resolved" | "dismissed",
    note: string | undefined,
    mover: BoardMover,
  ): BoardCloseResult {
    const refs = [...new Set(match.refs.map(boardRef).filter((ref): ref is string => ref !== null))];
    const ignored = match.refs.filter((raw) => boardRef(raw) === null);
    const ignoredText = ignored.length === 0 ? "" : ` Ignored, not a ref: ${ignored.map((raw) => `"${raw}"`).join(", ")}.`;
    if (refs.length === 0) {
      return {
        ok: false,
        closed: [],
        skipped: [],
        needIds: [],
        text: `No ref to match on, so nothing moved. A ref is two or more capital letters, an optional hyphen and five or more digits (ISSUE-20417).${ignoredText}`,
      };
    }
    const now = Date.now();
    const who = boardMoverName(mover);
    const done = store.boardDoneRefs(now - BOARD_DONE_REF_MS);
    const closed: BoardItem[] = [];
    const skipped: { id: string; headline: string; why: string }[] = [];
    for (const item of store.boardList({ states: ["open", "addressed"], limit: 500 })) {
      const decision = boardRefDecision({ lead: item.headline, body: item.context, since: item.createdAt }, refs, done);
      if (decision.touched.length === 0) continue;
      if (decision.close) {
        const named = boardRefsIn(`${item.headline}\n${item.context}`);
        const reason = `Closed automatically: ${named.join(", ")} marked done by ${who}${note ? ` (${note})` : ""}.`;
        if (store.boardInferredClose(item.id, state, reason, who, now)) closed.push(item);
        continue;
      }
      skipped.push({
        id: item.id,
        headline: item.headline,
        why: !decision.inLead
          ? `names ${decision.touched.join(", ")} only in its context`
          : `also names ${decision.missing.join(", ")}, not marked done since it was added`,
      });
    }
    // The row's worker, and its manager, which relays its questions.
    const owner = match.threadId === undefined ? null : store.byThread(match.threadId);
    const manager = owner?.managerId ? store.byId(owner.managerId) : null;
    const needIds: string[] = [];
    for (const asker of [owner, manager]) {
      if (asker === null || asker === undefined || asker.retiredAt !== null) continue;
      const answered = store
        .needItems(asker.id)
        .filter((question) => question.droppedAt === null && question.dismissedAt === null)
        .filter((question) => boardRefDecision({ lead: question.text, body: "", since: question.firstSeenAt }, refs, done).close);
      if (answered.length === 0) continue;
      const ids = answered.map((question) => question.id);
      store.dismissNeedItems(ids, `${refs.join(", ")} marked done by ${who}${note ? `: ${note}` : ""}`, now);
      needIds.push(...ids);
      record("dismiss", {
        workerName: asker.name,
        threadId: asker.threadId,
        excerpt: `${who} dismissed Need ${ids.join(", ")}: ${refs.join(", ")} marked done${note ? ` (${note})` : ""}`,
      });
    }
    store.markBoardRefsDone(refs, now);
    if (closed.length > 0) {
      record("board-move", { excerpt: `${who} closed ${closed.length} item${closed.length === 1 ? "" : "s"}, every number in ${closed.length === 1 ? "it" : "them"} done (${refs.join(", ")}): ${boardNames(closed)}` });
    }
    changed();
    const parts = [
      `Marked done: ${refs.join(", ")}.`,
      closed.length > 0 ? `Closed ${closed.length}: ${boardNames(closed)}.` : "No board item closed.",
      skipped.length > 0 ? `Left open ${skipped.length}: ${skipped.map((s) => `${excerptOf(s.headline, 60)} (${s.why})`).join("; ")}.` : "",
      needIds.length > 0 ? `Dismissed Need ${needIds.join(", ")}.` : "",
    ].filter((part) => part !== "");
    return {
      ok: true,
      closed: closed.map((item) => ({ id: item.id, headline: item.headline })),
      skipped,
      needIds,
      text: `${parts.join(" ")}${ignoredText}`,
    };
  }

  /**
   * Compose the numbered draft for these items and park it for the chief
   * thread's composer to insert. Nothing is sent here and no state moves: the
   * items are only stamped as drafted, so a draft cleared without sending
   * leaves them exactly where they were.
   */
  function boardAddress(
    ids: readonly string[],
    mover: BoardMover = { kind: "shell" },
    /** The choice tapped, per item id. Only ever a label the chief wrote. */
    picks?: readonly { id: string; label: string }[],
    /** What the user typed on an item, per item id. The user's own words, so they are scrubbed like any other text going into a composer. */
    answers?: readonly { id: string; text: string }[],
  ): { ok: boolean; threadId: string | null; body: string; text: string } {
    // The same boundary as the CLI case, at the function rather than at one
    // caller: this is the only path in the plugin that writes text into a
    // composer the user is looking at.
    if (mover.kind === "worker") {
      return { ok: false, threadId: null, body: "", text: "A worker cannot address board items." };
    }
    // Scrubbed, because this text goes straight into the chief's composer and
    // then into its context. `boardList` scrubs on the way out, but this path
    // reads the rows directly, so it scrubs them itself.
    const items = ids
      .map((id) => store.boardItem(id))
      .filter((item): item is BoardItem => item !== null)
      .map((item) => ({
        ...item,
        headline: scrubUntrusted(item.headline).text,
        context: scrubUntrusted(item.context).text,
        choices: item.choices.map((choice) => ({ label: scrubUntrusted(choice.label).text })),
      }));
    if (items.length === 0) return { ok: false, threadId: null, body: "", text: "No board item with that id." };
    // Only a label the chief actually put on that item can reach the draft. The
    // pick arrives from the panel, so taking it on trust would let anything
    // that can call the RPC write a line into the chief's composer that reads
    // as the user's decision.
    const picked = new Map<string, string>();
    for (const pick of picks ?? []) {
      const item = items.find((candidate) => candidate.id === pick.id);
      const match = item?.choices.find((choice) => choice.label === pick.label);
      if (match !== undefined) picked.set(pick.id, match.label);
    }
    const written = new Map<string, string>();
    for (const answer of answers ?? []) {
      if (!items.some((item) => item.id === answer.id)) continue;
      const text = scrubUntrusted(answer.text).text.trim();
      if (text !== "") written.set(answer.id, text);
    }
    const body = composeAddressDraft(items, picked, written);
    const target = chiefThreadId;
    // The stamp goes on only once there is somewhere for the draft to go:
    // stamped first, an Address with no chief thread would leave every item
    // reading "in your composer, not sent" about a composer that never
    // received anything.
    if (target === null) {
      return {
        ok: false,
        threadId: null,
        body,
        text: "There is no chief thread to draft into. Run bb cos start, then Address again.",
      };
    }
    store.boardMarkDrafted(items.map((item) => item.id));
    store.boardStageDraft(target, items.map((item) => item.id), body);
    // Address leaves a row like any other move. Without one, an item wearing
    // the draft stamp would have no trace of how it got there.
    record("board-move", {
      excerpt: `${boardMoverName(mover)} put ${items.length} item${items.length === 1 ? "" : "s"} in a draft, not sent: ${boardNames(items)}`,
      threadId: target,
    });
    changed();
    return {
      ok: true,
      threadId: target,
      body,
      text: `${items.length} item${items.length === 1 ? "" : "s"} put in the chief thread's composer. Nothing was sent.`,
    };
  }

  /** The composer surface in `threadId` takes its parked draft, once. */
  /**
   * Hand the parked text to whichever composer mount asks first, and tell every
   * mount how many items are currently in a draft. The two are separate because
   * the composer that takes the draft is often unmounted a moment later, when
   * Address navigates to the chief thread: only the count survives that, so
   * only the count can carry the line saying nothing has been sent.
   */
  /**
   * One of a worker's offered answers, parked as a draft for its composer.
   *
   * The same mechanism as the board's Address: the text is staged server-side
   * and the composer banner mounted in that thread takes it once. It never
   * sends. And it takes only a label the worker offered in its CURRENT Need,
   * re-read from the thread here rather than trusted from the panel, because a
   * label that reaches a composer reads as the user's decision and this RPC is
   * callable by anything that can reach the plugin.
   */
  async function needAnswerDraft(
    workerId: string,
    label: string,
  ): Promise<{ ok: boolean; threadId: string | null; text: string }> {
    const worker = store.byId(workerId);
    if (worker === null || worker.retiredAt !== null) {
      return { ok: false, threadId: null, text: "No live worker with that id." };
    }
    const output = await lastOutput(worker.threadId);
    if (!output.ok) {
      return { ok: false, threadId: worker.threadId, text: "Could not read the worker's last message. Try again." };
    }
    const block = parseStatusBlock(output.text);
    const offered = block.needChoices.find((choice) => choice === label.trim());
    if (block.need === null || offered === undefined) {
      return {
        ok: false,
        threadId: worker.threadId,
        text: "That is not one of the answers the worker offered, so nothing was drafted.",
      };
    }
    const body = scrubUntrusted(offered).text;
    store.boardStageDraft(worker.threadId, [], body);
    changed();
    return { ok: true, threadId: worker.threadId, text: `Drafted "${body}" into the worker's composer. Nothing is sent until you send it.` };
  }

  /** How far back the composer looks for board text it may still hold. */
  const BOARD_DRAFT_LOOKBACK_MS = 30 * 86_400_000;

  function boardDraftTake(threadId: string): {
    draft: { body: string; itemIds: string[] } | null;
    draftIds: number[];
    parts: { id: number; body: string }[];
    drafted: number;
  } {
    // Every parked draft, oldest first, in one handover. Taking only the newest
    // would strand the older one's text, including any tapped "Decision: ..."
    // line, while the board goes on saying those items are in the composer.
    const drafts = store.boardPendingDrafts(threadId);
    // NOT consumed here. The caller acks once it can see the words in its own
    // draft; until then this stays parked and is offered again. A handover is
    // not a delivery, and treating it as one silently loses the drafted text.
    return {
      draft:
        drafts.length === 0
          ? null
          : {
              body: drafts.map((draft) => draft.body).join("\n\n"),
              itemIds: drafts.flatMap((draft) => draft.itemIds),
            },
      draftIds: drafts.map((draft) => draft.id),
      parts: drafts.map((draft) => ({ id: draft.id, body: draft.body })),
      drafted: store.boardDrafted().length,
    };
  }

  /**
   * Did the user actually send a message carrying drafted items? Address
   * cannot know: it writes a draft and stops. So the send is observed instead,
   * on the chief thread's next turn, by reading back the prompt that was sent and
   * matching the headlines in it. Only a turn typed by hand counts; a turn
   * this plugin sent the chief carries a sender thread and might be quoting the
   * board back at it.
   */
  async function observeChiefSend(): Promise<void> {
    const chief = chiefThreadId;
    if (chief === null) return;
    const drafted = store.boardDrafted();
    if (drafted.length === 0) return;
    let sent = "";
    try {
      const rows = await bb.sdk.threads.events.list({
        threadId: chief,
        types: ["client/turn/requested"],
        order: "desc",
        limit: "1",
      });
      const latest = rows[0];
      if (!latest) return;
      // Only a request that can be a send by the user: not another thread's, not a
      // system notice, and not a process's (a remodel handover quoting board
      // headlines would otherwise move items to addressed). This does not
      // make the remaining case trustworthy: see the `observed-send` mover.
      const text = boardSendText(latest.data as Parameters<typeof boardSendText>[0]);
      if (text === null) return;
      sent = text;
    } catch (error) {
      bb.log.warn(`board: could not read the chief's last prompt: ${String(error)}`);
      return;
    }
    const addressed = boardItemsAddressedBy(sent, drafted);
    if (addressed.length === 0) return;
    const matched = drafted.filter((item) => addressed.includes(item.id));
    // Not "The user, by sending it". The event cannot name its sender, and this
    // is the only path in the plugin that turns one into a claim about who
    // decided something. What it can still say is true and is most of the
    // value: the items were drafted by Address and then a message carrying
    // their headlines went to the chief.
    const who = boardMoverName({ kind: "observed-send" });
    store.boardSetState(addressed, "addressed", Date.now(), null, who);
    record("board-move", {
      excerpt: `${addressed.length} item${addressed.length === 1 ? "" : "s"} addressed by ${who}: ${boardNames(matched)}`,
      threadId: chief,
    });
  }

  /** `bb cos board` output: the groups, in order, with an age and a state word. */
  function boardText(items: readonly BoardItem[]): string {
    if (items.length === 0) return "Nothing on the board.";
    const groups = groupBoardItems(items);
    return groups
      .map((group) => {
        const lines = group.items.map((item) => {
          const age = relativeTime(item.createdAt).padStart(8);
          const state =
            item.state === "open" ? (item.draftedAt === null ? "" : "  (in your draft)") : `  (${item.state})`;
          const context = item.context.trim() === "" ? "" : `\n            ${excerptOf(collapseWhitespace(item.context), 160)}`;
          // The source prints on the id line so the chief can see whether it
          // recorded one. An item with no source is one the user has to ask
          // about, which is the thing this board exists to avoid.
          const source = item.sourceLabel === null ? "" : `  from ${item.sourceLabel}`;
          const band = `  [${BOARD_PRIORITY_LABEL[item.priority].toLowerCase()}]`;
          const choices =
            item.choices.length === 0
              ? ""
              : `\n            choices: ${item.choices.map((choice) => choice.label).join(" | ")}`;
          // What the chief needs so as not to board a question twice, and
          // when the item goes on its own.
          const needs = item.needIds.length === 0 ? "" : `  Need ${item.needIds.join(", ")}`;
          const expiry = item.expiresAt === null ? "" : `  closes itself after ${boardExpiryDay(item.expiresAt)}`;
          return `${age}  ${item.headline}${band}${state}${context}${choices}\n            ${item.id}${source}${needs}${expiry}`;
        });
        return `${group.label}\n${lines.join("\n")}`;
      })
      .join("\n\n");
  }

  // ---------- http: avatar files ----------

  // bb plugin routes match literal paths only, so the worker id is a query parameter.
  bb.http.route("GET", "/avatar", async (c) => {
    const workerId = (c.req.query("worker") ?? "").replace(/\.svg$/, "");
    const worker = store.byId(workerId);
    const avatar = worker ? parseAvatarKey(worker.avatar) : null;
    if (!worker || avatar === null) return new Response("not found", { status: 404 });
    return new Response(avatarSvg(avatar), {
      status: 200,
      headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" },
    });
  });

  // ---------- cli ----------

  const usage = [
    "Usage:",
    "  bb cos start                      create or resume the chief thread",
    "  bb cos projects",
    "  bb cos roster [--project X] [--all] [--retired] [--json]",
    "  bb cos delegate <project> <worker> <message...> [--spawn] [--fanout] [--wait] [--timeout S] [--desc TEXT] [--reasoning L]",
    "  bb cos read <worker> [--project X]",
    "  bb cos wait <worker> [--timeout S] [--project X]",
    "  bb cos steer <worker> <message...> [--project X]   interrupt a running turn",
    "  bb cos stop <worker> [--project X] [--brief TEXT]  stop the turn, keep the worker",
    "  bb cos retry <worker> [--project X] [--model X]    re-send the last brief",
    "  bb cos decisions                  workers stopped on a prompt or a question",
    "  bb cos answer <worker> <allow|allow-session|deny|answer> [--text TEXT] [--project X]",
    "  bb cos usage                      plan quota left per provider",
    "  bb cos adopt <thr_id> <name> [--desc TEXT]",
    "  bb cos retire <worker> [--project X]",
    "  bb cos dismiss <worker> [--project X] [--note TEXT] [--undo]   clear an answered Need line",
    "  bb cos brand <worker> [--title TEXT] [--project X]   set title and unique avatar (automatic on spawn/adopt)",
    "  bb cos brand --all [--force]      brand every live worker; --force also rewrites titles",
    "  bb cos remodel <worker>|--all [--provider X --model Y] [--reasoning L] [--dry-run] [--project X]",
    "                                    move a worker to a new thread on another provider/model/reasoning level (default: the plugin's worker defaults)",
    "  bb cos remodel-chief [--provider X --model Y] [--reasoning L] [--dry-run]",
    "                                    move the chief thread to another provider/model/reasoning level with a full handover",
    "  bb cos rehandover <worker> [--dry-run] [--project X]",
    "                                    queue the whole conversation of the worker's previous thread into its current one",
    "  bb cos set-chief <thr_id>         complete chief cutover to an existing replacement thread and archive the old chief",
    "  bb cos move <worker> <project> [--project X]   move a worker to another project (its thread follows on the next remodel)",
    "  bb cos move <worker|chief> <absolute-folder> [--dry-run] [--project X]",
    "                                    move an idle thread's working folder and queue its own conversation into it",
    "  bb cos delegate ... [--provider X --model Y --reasoning L]   pin a NEW worker to a provider/model/level",
    "                                    --reasoning is one of low, medium, high, xhigh, ultracode, max; on an existing worker it lasts one turn, so use `bb cos relevel` to change what it runs at",
    "  bb cos relevel <worker> low|medium|high|xhigh|max [--project X]   set the reasoning level so it holds for every turn",
    "  bb cos board [list] [--area clients|consulting|operations] [--all] [--json]   what the chief has put in front of the user",
    "  bb cos board add <headline...> --area X --priority now|soon|whenever --from WORKER|WORDS|none",
    "                                   [--context TEXT] [--choice 'A|B|C'] [--link LABEL=HREF] [--expires YYYY-MM-DD]",
    "                                   --expires: the day of the event it is about; it closes itself the day after",
    "  bb cos board update <id> [--priority now|soon|whenever] [--choice 'A|B|C'] [--expires YYYY-MM-DD|none]",
    "  bb cos board priority <id> now|soon|whenever   move an item between the bands",
    "  bb cos board resolve|done|dismiss|drop|reopen <id> [<id>...] [--note TEXT]",
    "  bb cos board address|draft <id> [<id>...]   put the numbered draft in the chief thread's composer (never sends)",
    "  bb cos activity [--limit N] [--json]",
    "  bb cos forward <thr_id> <text...> [--note TEXT]",
    "  bb cos sessions [--json]          Claude sessions on this machine outside bb",
    "  bb cos session-digest <sessionId> [--max N]",
    "  bb cos import <sessionId>[,<sessionId>...] <worker> [--project X] [--desc TEXT] [--create-project]",
    "  bb cos brief [--retired]          roster plus other active threads and external sessions",
    "  bb cos restart-chief              recover a failed chief: stop it, deliver parked reports, nudge it back",
    "  bb cos reset-chief                forget the chief thread",
  ].join("\n");

  bb.cli.register({
    name: "cos",
    summary: "Chief of Staff: delegate work to reusable worker threads across projects",
    commands: [
      { name: "start", summary: "Create or resume the chief thread", usage: "bb cos start" },
      { name: "projects", summary: "List projects", usage: "bb cos projects" },
      {
        name: "spawn-manager",
        summary: "Create a manager thread and give it a team",
        usage: "bb cos spawn-manager <name> [--team a,b,c] [--project X]",
      },
      {
        name: "assign",
        summary: "Move a worker onto a manager's team, or back to the chief",
        usage: "bb cos assign <worker> <manager|chief> [--project X]",
      },
      { name: "roster", summary: "List managed workers with status", usage: "bb cos roster [--project X] [--all] [--retired] [--json]" },
      {
        name: "delegate",
        summary: "Send a task to a worker (reused by name; --spawn to create a new one)",
        usage: "bb cos delegate <project> <worker> <message...> [--spawn] [--wait] [--timeout S] [--desc TEXT] [--reasoning L]",
      },
      { name: "read", summary: "Worker status and last message", usage: "bb cos read <worker> [--project X]" },
      { name: "wait", summary: "Wait for a worker to go idle", usage: "bb cos wait <worker> [--timeout S]" },
      { name: "steer", summary: "Interrupt a worker's running turn", usage: "bb cos steer <worker> <message...> [--project X]" },
      { name: "stop", summary: "Stop the current turn and keep the worker", usage: "bb cos stop <worker> [--brief TEXT]" },
      { name: "retry", summary: "Re-send a worker's last brief", usage: "bb cos retry <worker> [--model X]" },
      { name: "decisions", summary: "Workers stopped on a prompt or question", usage: "bb cos decisions" },
      {
        name: "answer",
        summary: "Answer the prompt a worker is stopped on",
        usage: "bb cos answer <worker> <allow|allow-session|deny|answer> [--text TEXT]",
      },
      { name: "usage", summary: "Plan quota left per provider", usage: "bb cos usage" },
      { name: "adopt", summary: "Register an existing thread as a worker", usage: "bb cos adopt <thr_id> <name> [--desc TEXT]" },
      { name: "retire", summary: "Archive a finished worker", usage: "bb cos retire <worker> [--reassign chief|<manager>]" },
      {
        name: "dismiss",
        summary: "Dismiss a worker's answered Need line so it stops counting as a decision",
        usage: "bb cos dismiss <worker> [--project X] [--note TEXT] [--undo]",
      },
      {
        name: "brand",
        summary: "Set a worker's human title and unique avatar (automatic on spawn and adopt)",
        usage: "bb cos brand <worker> [--title TEXT] [--project X] | bb cos brand --all [--force]",
      },
      {
        name: "remodel",
        summary: "Move a worker to a new thread on another provider and model, with a handover",
        usage: "bb cos remodel <worker>|--all [--provider X --model Y] [--reasoning L] [--dry-run] [--project X]",
      },
      {
        name: "rehandover",
        summary: "Queue a worker the full handover from its previous thread (for workers remodelled with the short one)",
        usage: "bb cos rehandover <worker> [--dry-run] [--project X]",
      },
      {
        name: "remodel-chief",
        summary: "Move the chief thread to a new thread on another provider and model, with a handover",
        usage: "bb cos remodel-chief [--provider X --model Y] [--reasoning L] [--dry-run]",
      },
      {
        name: "set-chief",
        summary: "Complete chief cutover to an existing replacement thread and archive the old chief",
        usage: "bb cos set-chief <thr_id>",
      },
      {
        name: "move",
        summary: "Move a worker to another project, or move a worker's or the chief's working folder (an absolute path) and queue its conversation into it",
        usage: "bb cos move <worker> <project> | bb cos move <worker|chief> <absolute-folder> [--dry-run] [--project X]",
      },
      {
        name: "board",
        summary: "The user's decision board: what the chief has put in front of the user",
        usage: "bb cos board [list] [--area X] [--all] [--json] | add <headline...> --area X [--context TEXT] [--expires YYYY-MM-DD] | update <id> [--priority P] [--choice C] [--expires DAY|none] | resolve|done|dismiss|drop|reopen|address|draft <id>...",
      },
      { name: "activity", summary: "Recent chief of staff activity", usage: "bb cos activity [--limit N] [--json]" },
      {
        name: "forward",
        summary: "Forward text from a thread to the chief",
        usage: "bb cos forward <thr_id> <text...> [--note TEXT]",
      },
      {
        name: "sessions",
        summary: "Claude Code sessions on this machine outside bb",
        usage: "bb cos sessions [--json]",
      },
      {
        name: "session-digest",
        summary: "Digest of an external Claude session transcript",
        usage: "bb cos session-digest <sessionId> [--max N]",
      },
      {
        name: "import",
        summary: "Import external Claude sessions into a worker",
        usage: "bb cos import <sessionId>[,<sessionId>...] <worker> [--project X] [--desc TEXT] [--create-project]",
      },
      { name: "brief", summary: "Roster plus all other active threads", usage: "bb cos brief" },
      {
        name: "restart-chief",
        summary: "Recover a failed chief thread",
        usage: "bb cos restart-chief",
      },
      { name: "reset-chief", summary: "Forget the chief thread", usage: "bb cos reset-chief" },
      {
        name: "marks",
        summary: "Sidebar rows carrying a status glyph: which workers failed or are waiting on you",
        usage: "bb cos marks [--json]",
      },
      {
        name: "compact",
        summary: "The overnight compaction pass, now: --dry-run lists what it would do, --thread limits it to one thread, --at sets the threshold (75)",
        usage: "bb cos compact [--dry-run] [--thread <threadId>] [--at <percent>]",
      },
    ],
    async run(argv, ctx) {
      const { positional, flags } = parseArgs(argv);
      const [command, ...args] = positional;
      const json = flags.json === true;
      const ok = (text: string) => ({ exitCode: 0, stdout: text });
      const fail = (text: string) => ({ exitCode: 1, stderr: text });
      const projectFlag = flagString(flags, "project");
      switch (command) {
        case undefined:
        case "help":
          return ok(usage);
        case "start": {
          // ensureChief throws rather than replacing a chief it could not read.
          // On a terminal that has to read as a refusal, not a stack trace.
          try {
            const result = await ensureChief();
            return ok(`${result.created ? "Created" : "Resumed"} chief thread ${result.threadId}. Open it in bb or run: bb thread open ${result.threadId}`);
          } catch (error) {
            return fail(String((error as { message?: string } | null)?.message ?? error));
          }
        }
        case "chief": {
          // A worker or a manager does not get the chief's thread id. It is the
          // one value that forges the highest scope: every `ctx.threadId` check
          // in this plugin, including the board guard a few lines below and the
          // team scope on every worker-resolving verb, is satisfied by setting
          // BB_THREAD_ID to it, so it is not handed out on request.
          //
          // A bare terminal still gets it. That is the user; the comment on
          // the board guard says the
          // same thing. An agent can reach the bare-terminal case by unsetting
          // the variable, which makes this a narrowing rather than a boundary.
          const scope = scopeOf(ctx.threadId ?? null);
          if (scope.kind === "manager" || scope.kind === "worker") {
            return fail(
              "The chief's thread id is not yours to read. Report to the chief in the ordinary way; a Chief: line always reaches it.",
            );
          }
          if (scope.kind === "unreadable") {
            return fail("Could not read the roster to check who is asking. Nothing was returned; try again.");
          }
          return ok(chiefThreadId ?? "(no chief thread; run bb cos start)");
        }
        case "restart-chief": {
          const result = await restartChief();
          return result.ok ? ok(result.text) : fail(result.text);
        }
        case "reset-chief": {
          const gate = refuseUnlessChief(cliScopeOf(ctx.threadId), "Forgetting the chief thread");
          if (gate) return fail(gate);
          await setChief(null);
          return ok("Chief thread forgotten. The next `bb cos start` creates a new one.");
        }
        case "spawn-manager": {
          if (!args[0]) return fail(usage);
          const teamFlag = flagString(flags, "team");
          const team = teamFlag ? teamFlag.split(",").map((t) => t.trim()).filter((t) => t !== "") : [];
          const result = await spawnManager(cliScopeOf(ctx.threadId), args[0], team, projectFlag, ctx.threadId ?? null);
          return result.ok ? ok(result.text) : fail(result.text);
        }
        case "assign": {
          const [workerRef, managerRef] = args;
          if (!workerRef || !managerRef) return fail(usage);
          const result = await assignWorker(cliScopeOf(ctx.threadId), workerRef, managerRef, projectFlag);
          return result.ok ? ok(result.text) : fail(result.text);
        }
        case "projects": {
          const all = await bb.sdk.projects.list({ includePersonal: true });
          // Scoped, like the tool, because `--project` is the input to every
          // other enumeration.
          const projects = visibleProjects(cliScopeOf(ctx.threadId), all);
          if (projects === null) return fail("Could not read the roster to check who is asking. Nothing was returned; try again.");
          if (json) return ok(JSON.stringify(projects.map((p) => ({ id: p.id, name: p.name, kind: p.kind }))));
          if (projects.length === 0) return ok("No projects you can reach.");
          return ok(projects.map((p) => `${p.id}  ${p.name}${p.kind === "personal" ? "  (personal)" : ""}`).join("\n"));
        }
        case "roster":
        case "brief": {
          let projectId: string | undefined;
          if (projectFlag) {
            const found = findProject(await listProjects(), projectFlag);
            if (!found) return fail(`Unknown project "${projectFlag}".`);
            projectId = found.id;
          }
          // Retired workers are hidden by default because the roster is a list of
          // who is available to take work. --retired is how you look one up again
          // to revive or read it.
          // Scoped exactly like the cos_roster TOOL: unscoped, this door would
          // serve the whole fleet, plus every unmanaged thread under
          // `brief`/`--all`, plus chiefThreadId as a field under `--json`, which
          // would undo the tool's team filter from an honest thread id.
          const scope = cliScopeOf(ctx.threadId);
          if (scope.kind === "unreadable") {
            return fail("Could not read the roster to check who is asking. Nothing was returned; try again.");
          }
          // A plain worker gets nothing. It has no cos_* tools at all, so the
          // CLI is its only door, and it must not fall through to the chief's
          // unfiltered branch just because it is not a manager.
          if (scope.kind === "worker") {
            return fail("The roster is the chief's. You are a worker; ask it, or put it in your Need: line.");
          }
          const team = scope.kind === "manager" ? { managerId: scope.managerId } : {};
          const includeOthers =
            scope.kind === "manager" ? false : command === "brief" || flags.all === true;
          const includeRetired = flags.retired === true;
          const opts = { projectId, includeOthers, includeRetired, ...team };
          if (json) {
            const payload = await rosterStatus(opts);
            // chiefThreadId is the value that forges the highest scope, and
            // `bb cos chief` already refuses to hand it to a worker or a
            // manager. Left in this JSON, it would go straight back to them.
            const safe =
              scope.kind === "chief" || scope.kind === "none"
                ? payload
                : { ...payload, chiefThreadId: null };
            return ok(JSON.stringify(safe));
          }
          return ok(await rosterText(opts));
        }
        case "sessions": {
          const { sessions, note } = await sessionsList();
          if (json) return ok(JSON.stringify({ sessions, note }));
          return ok(formatSessionsTable(sessions));
        }
        case "session-digest": {
          if (!args[0]) return fail(usage);
          const maxFlag = flagString(flags, "max");
          const max = maxFlag ? Number(maxFlag) : DIGEST_MAX_CHARS;
          if (!Number.isFinite(max) || max <= 0) return fail("--max must be a positive number.");
          // Keep CLI output well under the 1 MB pipe limit.
          const result = await sessionDigest(args[0], Math.min(200_000, Math.trunc(max)));
          if (!result) return fail(`No transcript found for session ${args[0]}.`);
          if (json) return ok(JSON.stringify(result));
          return ok(result.digest);
        }
        case "import": {
          const gate = refuseUnlessChief(cliScopeOf(ctx.threadId), "Importing a session");
          if (gate) return fail(gate);
          const [idList, worker] = args;
          if (!idList || !worker) return fail(usage);
          const result = await importSessions({
            sessionIds: idList.split(",").map((id) => id.trim()).filter((id) => id !== ""),
            worker,
            project: projectFlag,
            description: flagString(flags, "desc"),
            createProject: flags["create-project"] === true,
          });
          return result.ok ? ok(result.text) : fail(result.text);
        }
        case "delegate": {
          const [project, worker, ...rest] = args;
          if (!project || !worker || rest.length === 0) return fail(usage);
          const result = await delegate({
            scope: cliScopeOf(ctx.threadId),
            project,
            worker,
            message: rest.join(" "),
            description: flagString(flags, "desc"),
            wait: flags.wait === true,
            timeoutSeconds: parseTimeout(flagString(flags, "timeout"), 600),
            signal: ctx.signal,
            providerId: flagString(flags, "provider"),
            model: flagString(flags, "model"),
            reasoningLevel: flagString(flags, "reasoning"),
            spawn: flags.spawn === true,
            fanoutHint: flags.fanout === true || flags["fanout-hint"] === true,
            senderThreadId: ctx.threadId ?? null,
          });
          // Non-zero on a refusal, like every other verb in this switch.
          // A refusal exits non-zero, so a shell chain such as
          // `bb cos delegate example billing 'do it' && next-step` stops there.
          return result.threadId === null ? fail(result.text) : ok(result.text);
        }
        case "remodel": {
          const target = args[0];
          if (!target && flags.all !== true) return fail(usage);
          const result = await remodel({
            scope: cliScopeOf(ctx.threadId),
            ref: flags.all === true ? null : target!,
            project: projectFlag,
            providerId: flagString(flags, "provider"),
            model: flagString(flags, "model"),
            reasoningLevel: flagString(flags, "reasoning"),
            dryRun: flags["dry-run"] === true,
            signal: ctx.signal,
          });
          return result.ok ? ok(result.text) : fail(result.text);
        }
        case "rehandover": {
          if (!args[0]) return fail(usage);
          const result = await rehandover({
            scope: cliScopeOf(ctx.threadId),
            ref: args[0],
            project: projectFlag,
            dryRun: flags["dry-run"] === true,
          });
          return result.ok ? ok(result.text) : fail(result.text);
        }
        case "remodel-chief": {
          const gate = refuseUnlessChief(cliScopeOf(ctx.threadId), "Remodelling the chief thread");
          if (gate) return fail(gate);
          const result = await remodelChief({
            providerId: flagString(flags, "provider"),
            model: flagString(flags, "model"),
            reasoningLevel: flagString(flags, "reasoning"),
            dryRun: flags["dry-run"] === true,
            signal: ctx.signal,
          });
          return result.ok ? ok(result.text) : fail(result.text);
        }
        case "set-chief": {
          const gate = refuseUnlessChief(cliScopeOf(ctx.threadId), "Setting the chief thread");
          if (gate) return fail(gate);
          if (!args[0]) return fail("Usage: bb cos set-chief <thr_id>");
          const result = await cutoverChief(args[0]);
          return result.ok ? ok(result.text) : fail(result.text);
        }
        case "move": {
          const [workerRef, destination] = args;
          if (!workerRef || !destination) return fail(usage);
          // A path moves the thread's working folder; anything else is the
          // project ref, which moves the worker row to another project.
          if (isFolderMovePath(destination)) {
            const moved = await moveThreadFolder({
              scope: cliScopeOf(ctx.threadId),
              ref: workerRef,
              path: destination,
              project: projectFlag,
              dryRun: flags["dry-run"] === true,
            });
            return moved.ok ? ok(moved.text) : fail(moved.text);
          }
          const result = await moveWorker(cliScopeOf(ctx.threadId), workerRef, destination, projectFlag);
          return result.ok ? ok(result.text) : fail(result.text);
        }
        case "read": {
          if (!args[0]) return fail(usage);
          return ok(await readWorker(cliScopeOf(ctx.threadId), args[0], projectFlag));
        }
        case "wait": {
          if (!args[0]) return fail(usage);
          const resolved = resolveInScope(store, await listProjects(), args[0], cliScopeOf(ctx.threadId), projectFlag);
          if (!resolved.ok) return fail(resolved.error);
          return ok(await waitForWorker(resolved.worker, parseTimeout(flagString(flags, "timeout"), 600), ctx.signal, ctx.threadId ?? null));
        }
        case "steer": {
          const [ref, ...rest] = args;
          if (!ref || rest.length === 0) return fail(usage);
          const result = await steerWorker(cliScopeOf(ctx.threadId), ref, rest.join(" "), projectFlag, ctx.threadId ?? null);
          return result.ok ? ok(result.text) : fail(result.text);
        }
        case "stop": {
          if (!args[0]) return fail(usage);
          const result = await stopWorker(cliScopeOf(ctx.threadId), args[0], projectFlag, flagString(flags, "brief"), ctx.threadId ?? null);
          return result.ok ? ok(result.text) : fail(result.text);
        }
        case "retry": {
          if (!args[0]) return fail(usage);
          const result = await retryWorker(cliScopeOf(ctx.threadId), args[0], projectFlag, flagString(flags, "model"), ctx.threadId ?? null);
          return result.ok ? ok(result.text) : fail(result.text);
        }
        case "decisions":
          return ok(await listDecisions(cliScopeOf(ctx.threadId)));
        case "answer": {
          const [ref, decision] = args;
          if (!ref || !decision) return fail(usage);
          if (decision !== "allow" && decision !== "allow-session" && decision !== "deny" && decision !== "answer") {
            return fail("Decision must be one of: allow, allow-session, deny, answer.");
          }
          const result = await answerDecision(cliScopeOf(ctx.threadId), ref, decision, flagString(flags, "text"), projectFlag);
          return result.ok ? ok(result.text) : fail(result.text);
        }
        case "usage":
          return ok(await usageReport());
        case "adopt": {
          const gate = refuseUnlessChief(cliScopeOf(ctx.threadId), "Adopting a thread");
          if (gate) return fail(gate);
          const [threadId, name] = args;
          if (!threadId || !name) return fail(usage);
          const result = await adopt(threadId, name, flagString(flags, "desc"));
          return result.ok ? ok(result.text) : fail(result.text);
        }
        case "retire": {
          if (!args[0]) return fail(usage);
          // A retirement whose archive failed exits non-zero so a script notices;
          // the row is retired either way, and the text says what to do by hand.
          const result = await retire(cliScopeOf(ctx.threadId), args[0], projectFlag, flagString(flags, "reassign"));
          return result.ok ? ok(result.text) : fail(result.text);
        }
        case "dismiss": {
          if (!args[0]) return fail(usage);
          const result = await dismissNeed(cliScopeOf(ctx.threadId), args[0], {
            project: projectFlag,
            note: flagString(flags, "note"),
            undo: flags.undo === true,
          });
          return result.ok ? ok(result.text) : fail(result.text);
        }
        case "brand": {
          if (flags.all === true) {
            const gate = refuseUnlessChief(cliScopeOf(ctx.threadId), "Rebranding every worker");
            if (gate) return fail(gate);
            return ok(await brandAll(flags.force === true));
          }
          if (!args[0]) return fail(usage);
          const title = flagString(flags, "title");
          const result = await brandRef(cliScopeOf(ctx.threadId), args[0], { title, force: title !== undefined || flags.force === true, project: projectFlag });
          return result.ok ? ok(result.text) : fail(result.text);
        }
        case "relevel": {
          const [ref, level] = args;
          if (ref === undefined || level === undefined || !(WORKER_REASONING_LEVELS as readonly string[]).includes(level)) {
            return fail(`bb cos relevel <worker> ${WORKER_REASONING_LEVELS.join("|")}`);
          }
          const result = await relevelWorker(cliScopeOf(ctx.threadId), ref, level as ReasoningLevel, flagString(flags, "project"));
          return result.ok ? ok(result.text) : fail(result.text);
        }
        case "board": {
          // A worker's own bash reaches this CLI. The board is curated by the
          // chief and worked by the user, and `board address` in particular
          // stages text straight into the user's composer in the chief thread, where
          // it appears unattributed next to whatever was already typed; if it were
          // sent, the log would record the user as having decided it. The chief has the
          // three cos_board_* tools and a worker has none, so a worker here is
          // either confused or being driven, and neither wants an item on the user's
          // list. A bare terminal is `shell` and is still allowed: that is
          // the user, and it is how this board is written from a shell.
          const caller = moverFromThread(ctx.threadId ?? null, "cli");
          if (caller.kind === "worker") {
            return fail(
              `A worker cannot write the user's board. Put it in your Need: line and the chief decides whether it belongs there.`,
            );
          }
          const [action, ...rest] = args;
          const areaFlag = flagString(flags, "area");
          const area = areaFlag === undefined ? undefined : (parseBoardArea(areaFlag) ?? undefined);
          if (areaFlag !== undefined && area === undefined) {
            return fail(`--area is one of ${BOARD_AREAS.join(", ")}.`);
          }
          if (action === "add") {
            if (area === undefined) return fail(`bb cos board add needs --area (${BOARD_AREAS.join(", ")}).`);
            const headline = rest.join(" ").trim();
            if (headline === "") return fail("bb cos board add <headline...> --area X [--context TEXT]");
            const linkFlag = flagString(flags, "link");
            const at = linkFlag === undefined ? -1 : linkFlag.indexOf("=");
            const links =
              linkFlag === undefined || at <= 0
                ? []
                : [{ label: linkFlag.slice(0, at).trim(), href: linkFlag.slice(at + 1).trim() }];
            // `--from` is one flag for both kinds of source: a worker name if it
            // matches one, the words themselves if it does not.
            const from = flagString(flags, "from");
            if (from === undefined || from.trim() === "") {
              return fail('bb cos board add needs --from (a worker name, free words, or "none").');
            }
            const priorityFlag = flagString(flags, "priority");
            if (priorityFlag === undefined || !(BOARD_PRIORITIES as readonly string[]).includes(priorityFlag)) {
              return fail(`bb cos board add needs --priority (${BOARD_PRIORITIES.join(", ")}).`);
            }
            // `--choice` repeats: the parser keeps the last value for a repeated
            // flag, so the several-choices form is one flag with "|" between.
            const choiceFlag = flagString(flags, "choice");
            const choices =
              choiceFlag === undefined
                ? []
                : choiceFlag
                    .split("|")
                    .map((label) => ({ label: label.trim() }))
                    .filter((choice) => choice.label !== "");
            const expiry = parseBoardExpiry(flagString(flags, "expires"));
            if (!expiry.ok) return fail(expiry.text);
            const item = boardAdd({
              headline,
              context: flagString(flags, "context"),
              area,
              links,
              from,
              priority: priorityFlag as BoardPriority,
              choices,
              expiresAt: expiry.at,
            });
            return ok(`Added to ${BOARD_PRIORITY_LABEL[item.priority]} / ${BOARD_AREA_LABEL[item.area]}. Item id ${item.id}.${boardExpiryHint(item)}`);
          }
          if (action === "priority" || action === "update") {
            const [id, positionalLevel] = rest;
            const priorityRaw = positionalLevel ?? flagString(flags, "priority");
            const choiceFlag = flagString(flags, "choice");
            const expiresFlag = flagString(flags, "expires");
            if (
              id === undefined ||
              (priorityRaw !== undefined && !(BOARD_PRIORITIES as readonly string[]).includes(priorityRaw)) ||
              (priorityRaw === undefined && choiceFlag === undefined && expiresFlag === undefined)
            ) {
              return fail(
                action === "priority"
                  ? `bb cos board priority <id> ${BOARD_PRIORITIES.join("|")}`
                  : `bb cos board update <id> [--priority ${BOARD_PRIORITIES.join("|")}] [--choice 'A|B|C'] [--expires YYYY-MM-DD|none]`,
              );
            }
            const choices =
              choiceFlag === undefined
                ? undefined
                : choiceFlag
                    .split("|")
                    .map((label) => ({ label: label.trim() }))
                    .filter((choice) => choice.label !== "");
            const result = boardUpdate(
              id,
              {
                ...(priorityRaw !== undefined ? { priority: priorityRaw as BoardPriority } : {}),
                ...(choices !== undefined ? { choices } : {}),
                ...(expiresFlag !== undefined ? { expires: expiresFlag } : {}),
              },
              moverFromThread(ctx.threadId ?? null, "cli"),
            );
            return result.ok ? ok(result.text) : fail(result.text);
          }
          if (
            action === "resolve" ||
            action === "done" ||
            action === "dismiss" ||
            action === "drop" ||
            action === "reopen" ||
            action === "address" ||
            action === "draft"
          ) {
            if (rest.length === 0) return fail(`bb cos board ${action} <id> [<id>...]`);
            if (action === "address" || action === "draft") {
              const result = boardAddress(rest, moverFromThread(ctx.threadId ?? null, "cli"));
              return result.ok ? ok(`${result.text}\n\n${result.body}`) : fail(result.text);
            }
            const state: BoardState =
              action === "reopen" ? "open" : action === "resolve" || action === "done" ? "resolved" : "dismissed";
            const result = boardSetState(rest, state, flagString(flags, "note"), moverFromThread(ctx.threadId ?? null, "cli"));
            return result.ok ? ok(result.text) : fail(result.text);
          }
          if (action !== undefined && action !== "list") return fail(usage);
          const stateFlag = flagString(flags, "state");
          const one = stateFlag === undefined ? null : parseBoardState(stateFlag);
          if (stateFlag !== undefined && one === null) return fail(`--state is one of ${BOARD_STATES.join(", ")}.`);
          const states =
            one !== null
              ? ([one] as const)
              : flags.all === true
                ? (["open", "addressed", "resolved", "dismissed"] as const)
                : undefined;
          const items = boardList(states, area);
          if (json) return ok(JSON.stringify(items));
          return ok(boardText(items));
        }
        case "activity": {
          const gate = refuseUnlessChief(cliScopeOf(ctx.threadId), "The activity log");
          if (gate) return fail(gate);
          const limitFlag = flagString(flags, "limit");
          const parsed = limitFlag ? Number(limitFlag) : 100;
          if (!Number.isFinite(parsed) || parsed <= 0) return fail("--limit must be a positive number.");
          const events = store.listActivity(Math.min(500, Math.trunc(parsed)));
          if (json) return ok(JSON.stringify(events));
          if (events.length === 0) return ok("No activity yet.");
          return ok(
            events
              .map((e) => {
                const who = e.workerName ? `${e.projectName ?? "?"}:${e.workerName}  ` : "";
                return `${relativeTime(e.at).padStart(8)}  ${e.kind.padEnd(13)}  ${who}${e.excerpt}`;
              })
              .join("\n"),
          );
        }
        case "marks": {
          const gate = refuseUnlessChief(cliScopeOf(ctx.threadId), "The sidebar marks");
          if (gate) return fail(gate);
          const { marks, faces } = await currentThreadMarks(undefined);
          if (json) return ok(JSON.stringify({ marks, faces }));
          const working = faces.filter((f) => f.working).length;
          const faceLine = `Faces: ${faces.length} worker rows get an avatar, ${working} of them Bloom while working.`;
          if (marks.length === 0) {
            return ok(
              `No rows marked: no worker has failed, is waiting on you, is rate-limited or has finished unread. (If that is a surprise, check the threadMarks setting.)\n${faceLine}`,
            );
          }
          const lines = marks.map((m) => `  ${m.threadId}  ${m.kind.padEnd(8)}  ${m.label}`);
          return ok(`Marked rows:\n${lines.join("\n")}\n${faceLine}`);
        }
        case "compact": {
          const gate = refuseUnlessChief(cliScopeOf(ctx.threadId), "The compaction pass");
          if (gate) return fail(gate);
          const only = flagString(flags, "thread");
          const dryRun = flags["dry-run"] === true;
          const atFlag = flagString(flags, "at");
          const atPercent = atFlag === undefined ? undefined : Number(atFlag);
          if (atPercent !== undefined && !(Number.isInteger(atPercent) && atPercent >= 1 && atPercent <= 100)) {
            return fail("--at must be a whole percent from 1 to 100.");
          }
          const result = await compactIdleThreads({
            ...(only ? { only: new Set([only]) } : {}),
            ...(atPercent !== undefined ? { atPercent } : {}),
            dryRun,
          });
          if (only && result.compacted.length === 0 && result.skipped.length === 0) {
            return fail(`${only} is not the chief or a live worker, so the pass does not cover it.`);
          }
          const lines = [
            `${dryRun ? "Would compact" : "Compacted"}: ${result.compacted.length === 0 ? "nothing" : result.compacted.join(", ")}`,
            ...result.skipped.map((s) => `  skipped ${s.name}: ${s.reason}`),
          ];
          return ok(lines.join("\n"));
        }
        case "forward": {
          const [threadId, ...rest] = args;
          if (!threadId || rest.length === 0) return fail(usage);
          const result = await forwardToChief(rest.join(" "), threadId, flagString(flags, "note"));
          return result.ok ? ok(result.text) : fail(result.text);
        }
      }
      return fail(usage);
    },
  });

  bb.onDispose(async () => {
    // A report held for a steer's partner (reportMerged) is waiting on a timer
    // that would otherwise fire into this disposed instance after a reload.
    // Sent now instead: the safe direction, one message slightly early.
    //
    // Bounded. bb awaits each dispose hook with no timeout of its own, and a
    // send that fails backs off for about half a minute in sendUpWithRetry, so
    // an unbounded flush would hold the whole reload. A report the flush does
    // not finish in time is parked in the outbox instead, which the next
    // instance drains on its first sweep: late, never lost.
    const held = [...heldReports.entries()];
    heldReports.clear();
    steerMergeUntil.clear();
    for (const [workerId, report] of held) {
      clearTimeout(report.timer);
      const worker = store.byId(workerId);
      if (worker === null) continue;
      const sent = reportToChief(worker, report.kind, report.text).then(
        () => true,
        (error: unknown) => {
          bb.log.warn(`held report for ${worker.name} on dispose: ${String(error)}`);
          return false;
        },
      );
      const finished = await Promise.race([
        sent,
        new Promise<false>((resolve) => setTimeout(() => resolve(false), DISPOSE_FLUSH_MS)),
      ]);
      if (!finished) parkHeldReport(worker, report.kind, report.text);
    }
    bb.log.info("disposed");
  });
}
